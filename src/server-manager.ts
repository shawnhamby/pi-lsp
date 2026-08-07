import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { resolve_project_trust } from '@spences10/pi-project-trust';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
	file_uri_to_path,
	file_path_to_uri,
	LspClient,
	type LspClientOptions,
	type LspDiagnostic,
	type LspDiagnosticsSnapshot,
	type LspDiagnosticsWaitOptions,
	type LspDocumentSymbol,
	type LspHover,
	type LspLocation,
	type LspPosition,
} from './client.js';
import {
	LspToolError,
	to_lsp_tool_error,
	type LspToolErrorDetails,
} from './format.js';
import {
	detect_language as default_detect_language,
	find_workspace_root as default_find_workspace_root,
	get_server_config as default_get_server_config,
	language_id_for_file as default_language_id_for_file,
	list_supported_languages as default_list_supported_languages,
	type LspServerConfig,
} from './servers.js';
import {
	create_lsp_binary_trust_subject,
	default_lsp_trust_store_path,
	is_lsp_binary_trusted,
} from './trust.js';

const LSP_PROJECT_BINARY_ENV = 'MY_PI_LSP_PROJECT_BINARY';

export interface LspClientLike {
	start(): Promise<void>;
	stop(): Promise<void>;
	is_ready(): boolean;
	ensure_document_open(uri: string, text: string): Promise<void>;
	close_document(uri: string): Promise<void>;
	open_document_count?(): number;
	hover(uri: string, position: LspPosition): Promise<LspHover | null>;
	definition(
		uri: string,
		position: LspPosition,
	): Promise<LspLocation[]>;
	references(
		uri: string,
		position: LspPosition,
		include_declaration: boolean,
	): Promise<LspLocation[]>;
	document_symbols(uri: string): Promise<LspDocumentSymbol[]>;
	wait_for_diagnostics(
		uri: string,
		timeout_ms?: number,
		options?: LspDiagnosticsWaitOptions,
	): Promise<LspDiagnostic[]>;
	diagnostics_snapshot?(): LspDiagnosticsSnapshot;
	notify_watched_file?(uri: string, change_type: 1 | 2 | 3): void;
}

export interface ServerState {
	client: LspClientLike;
	key: string;
	language: string;
	workspace_root: string;
	root_uri: string;
	command: string;
	install_hint?: string;
	active_request_count: number;
	last_used_at?: number;
	open_documents: Map<string, number>;
	idle_timer?: NodeJS.Timeout;
}

interface StartingServerState {
	cancelled: boolean;
	promise: Promise<ServerState | undefined>;
}

export interface FileState {
	abs: string;
	uri: string;
	state: ServerState;
}

export interface MutationDiagnosticsEntry {
	file: string;
	diagnostics: LspDiagnostic[];
}

export type MutationDiagnosticsResult =
	| {
			ok: true;
			file: string;
			entries: MutationDiagnosticsEntry[];
	  }
	| { ok: false; error: LspToolErrorDetails };

export interface MutationDiagnosticsOptions {
	timeout_ms: number;
	settle_ms: number;
	signal?: AbortSignal;
}

export type ResolveFileStateResult =
	| { ok: true; result: FileState }
	| { ok: false; error: LspToolErrorDetails };

export interface CreateLspServerManagerOptions {
	create_client?: (options: LspClientOptions) => LspClientLike;
	read_file?: (path: string) => Promise<string>;
	cwd?: () => string;
	idle_timeout_ms?: number;
	detect_language?: (file: string) => string | undefined;
	find_workspace_root?: (file: string, fallback: string) => string;
	get_server_config?: (
		language: string,
		workspace_root: string,
	) => LspServerConfig | undefined;
	language_id_for_file?: (file: string) => string | undefined;
	list_supported_languages?: () => string[];
	path_allowed?: (
		absolute_path: string,
		cwd: string,
	) => boolean | Promise<boolean>;
	validate_result_uris?: (
		uris: string[],
		workspace_root: string,
	) => void | Promise<void>;
}

class LspStartupCancelledError extends Error {
	constructor(language: string, workspace_root: string) {
		super(
			`Startup cancelled for ${language} LSP in ${workspace_root}`,
		);
		this.name = 'LspStartupCancelledError';
	}
}

async function should_use_project_lsp_binary(
	server_config: LspServerConfig,
	ctx?: ExtensionContext,
): Promise<boolean> {
	if (!server_config.is_project_local) return true;
	if (is_lsp_binary_trusted(server_config.command)) return true;

	const subject = {
		...create_lsp_binary_trust_subject(server_config.command),
		prompt_title:
			'Project-local language server binaries can execute code.\nTrust this LSP binary?',
		summary_lines: [
			`Language: ${server_config.language}`,
			`Binary: ${server_config.command}`,
		],
		headless_warning: `Skipping untrusted project-local LSP binary: ${server_config.command}. Set ${LSP_PROJECT_BINARY_ENV}=allow to enable it for this run.`,
	};
	const decision = await resolve_project_trust(subject, {
		env: process.env,
		has_ui: ctx?.hasUI,
		select: ctx?.hasUI
			? async (message, choices) =>
					(await ctx.ui.select(message, choices)) ?? ''
			: undefined,
		warn: console.warn,
		trust_store_path: default_lsp_trust_store_path(),
	});

	return (
		decision.action === 'allow-once' ||
		decision.action === 'trust-persisted'
	);
}

export class LspServerManager {
	readonly cwd: string;
	readonly clients_by_server = new Map<string, ServerState>();
	readonly failed_servers = new Map<string, LspToolErrorDetails>();

	readonly #create_client: (
		options: LspClientOptions,
	) => LspClientLike;
	readonly #read_file: (path: string) => Promise<string>;
	readonly #starting_servers = new Map<string, StartingServerState>();
	readonly #idle_timeout_ms?: number;
	readonly #detect_language: NonNullable<
		CreateLspServerManagerOptions['detect_language']
	>;
	readonly #find_workspace_root: NonNullable<
		CreateLspServerManagerOptions['find_workspace_root']
	>;
	readonly #get_server_config: NonNullable<
		CreateLspServerManagerOptions['get_server_config']
	>;
	readonly #language_id_for_file: NonNullable<
		CreateLspServerManagerOptions['language_id_for_file']
	>;
	readonly #list_supported_languages: NonNullable<
		CreateLspServerManagerOptions['list_supported_languages']
	>;
	readonly #path_allowed: NonNullable<
		CreateLspServerManagerOptions['path_allowed']
	>;
	readonly #validate_result_uris: NonNullable<
		CreateLspServerManagerOptions['validate_result_uris']
	>;

	constructor(options: CreateLspServerManagerOptions = {}) {
		this.cwd = options.cwd?.() ?? process.cwd();
		this.#create_client =
			options.create_client ??
			((client_options: LspClientOptions) =>
				new LspClient(client_options));
		this.#read_file =
			options.read_file ??
			((path: string) => readFile(path, 'utf-8'));
		this.#detect_language = options.detect_language ?? default_detect_language;
		this.#find_workspace_root =
			options.find_workspace_root ?? default_find_workspace_root;
		this.#get_server_config =
			options.get_server_config ?? default_get_server_config;
		this.#language_id_for_file =
			options.language_id_for_file ?? default_language_id_for_file;
		this.#list_supported_languages =
			options.list_supported_languages ?? default_list_supported_languages;
		this.#path_allowed = options.path_allowed ?? default_path_allowed;
		this.#validate_result_uris =
			options.validate_result_uris ?? default_validate_result_uris;
		const env_idle_timeout = process.env.MY_PI_LSP_IDLE_TIMEOUT_MS
			? Number(process.env.MY_PI_LSP_IDLE_TIMEOUT_MS)
			: undefined;
		const idle_timeout_ms =
			options.idle_timeout_ms ?? env_idle_timeout;
		this.#idle_timeout_ms =
			idle_timeout_ms &&
			Number.isFinite(idle_timeout_ms) &&
			idle_timeout_ms > 0
				? idle_timeout_ms
				: undefined;
	}

	resolve_abs(file: string): string {
		return isAbsolute(file) ? file : resolve(this.cwd, file);
	}

	list_supported_languages(): string[] {
		return this.#list_supported_languages();
	}

	async is_path_allowed(file: string): Promise<boolean> {
		return await this.#path_allowed(this.resolve_abs(file), this.cwd);
	}

	async validate_result_uris(
		uris: string[],
		workspace_root: string,
	): Promise<void> {
		await this.#validate_result_uris(uris, workspace_root);
	}

	async clear_language_state(language?: string): Promise<void> {
		const states = language
			? Array.from(this.clients_by_server.entries()).filter(
					([, state]) => state.language === language,
				)
			: Array.from(this.clients_by_server.entries());
		const starting = language
			? Array.from(this.#starting_servers.entries()).filter(([key]) =>
					key.startsWith(`${language}\u0000`),
				)
			: Array.from(this.#starting_servers.entries());
		for (const [key, startup] of starting) {
			startup.cancelled = true;
			this.#starting_servers.delete(key);
		}
		await Promise.allSettled(
			states.map(([, state]) => {
				this.#clear_idle_timer(state);
				return state.client.stop();
			}),
		);
		for (const [key] of states) {
			this.clients_by_server.delete(key);
		}

		if (!language) {
			this.failed_servers.clear();
			return;
		}
		for (const [key, failure] of this.failed_servers.entries()) {
			if (failure.language === language) {
				this.failed_servers.delete(key);
			}
		}
	}

	async resolve_file_state(
		file: string,
		ctx?: ExtensionContext,
	): Promise<ResolveFileStateResult> {
		const abs = this.resolve_abs(file);
		try {
			if (!(await this.is_path_allowed(abs))) {
				return {
					ok: false,
					error: {
						kind: 'tool_execution_failed',
						file: abs,
						message: `LSP path is outside the active workspace: ${abs}`,
					},
				};
			}
			const result = await this.#get_file_state(abs, ctx);
			if (!result) {
				return {
					ok: false,
					error: {
						kind: 'unsupported_language',
						file: abs,
						message: `No language server configured for ${abs}`,
					},
				};
			}
			return { ok: true, result };
		} catch (error) {
			if (error instanceof LspToolError) {
				return { ok: false, error: error.details };
			}
			return {
				ok: false,
				error: {
					kind: 'tool_execution_failed',
					file: abs,
					message:
						error instanceof Error ? error.message : String(error),
				},
			};
		}
	}

	async release_file_state(file_state: FileState): Promise<void> {
		const { state, uri } = file_state;
		const count = state.open_documents.get(uri) ?? 0;
		if (count <= 1) {
			state.open_documents.delete(uri);
			await state.client.close_document(uri);
		} else {
			state.open_documents.set(uri, count - 1);
		}
		state.active_request_count = Math.max(
			0,
			state.active_request_count - 1,
		);
		state.last_used_at = Date.now();
		this.#schedule_idle_stop(state);
	}

	async collect_mutation_diagnostics(
		file: string,
		change_type: 1 | 2,
		ctx: ExtensionContext | undefined,
		options: MutationDiagnosticsOptions,
	): Promise<MutationDiagnosticsResult> {
		const abs = this.resolve_abs(file);
		let file_state: FileState | undefined;
		try {
			if (!(await this.is_path_allowed(abs))) {
				return {
					ok: false,
					error: {
						kind: 'tool_execution_failed',
						file: abs,
						message: `LSP path is outside the active workspace: ${abs}`,
					},
				};
			}
			const state = await this.#get_or_start_client(abs, ctx);
			if (!state) {
				return {
					ok: false,
					error: {
						kind: 'unsupported_language',
						file: abs,
						message: `No language server configured for ${abs}`,
					},
				};
			}

			this.#clear_idle_timer(state);
			state.active_request_count += 1;
			const uri = file_path_to_uri(abs);
			file_state = { abs, uri, state };
			const before = state.client.diagnostics_snapshot?.();
			this.#notify_running_clients(abs, change_type);
			const text = await this.#read_file(abs);
			await state.client.ensure_document_open(uri, text);
			state.open_documents.set(
				uri,
				(state.open_documents.get(uri) ?? 0) + 1,
			);
			const diagnostics = await state.client.wait_for_diagnostics(
				uri,
				options.timeout_ms,
				{
					after_revision: before?.revision,
					settle_ms: options.settle_ms,
					signal: options.signal,
				},
			);
			const entries: MutationDiagnosticsEntry[] = [
				{ file: abs, diagnostics },
			];
			const after = state.client.diagnostics_snapshot?.();
			if (before && after) {
				for (const [related_uri, related_diagnostics] of after.by_uri) {
					if (related_uri === uri) continue;
					const previous = before.by_uri.get(related_uri) ?? [];
					if (
						JSON.stringify(previous) ===
						JSON.stringify(related_diagnostics)
					) {
						continue;
					}
					try {
						const related_file = file_uri_to_path(related_uri);
						if (!is_within(state.workspace_root, related_file)) continue;
						entries.push({
							file: related_file,
							diagnostics: related_diagnostics,
						});
					} catch {
						// Ignore non-file diagnostic URIs.
					}
				}
			}

			return { ok: true, file: abs, entries };
		} catch (error) {
			if (options.signal?.aborted) throw error;
			const language = this.#detect_language(abs) ?? 'unknown';
			const workspace_root = this.#find_workspace_root(abs, this.cwd);
			const config = this.#get_server_config(language, workspace_root);
			return {
				ok: false,
				error: to_lsp_tool_error(
					abs,
					language,
					workspace_root,
					config?.command ?? language,
					config?.install_hint,
					error,
				),
			};
		} finally {
			if (file_state) await this.release_file_state(file_state);
		}
	}

	async #get_file_state(
		file: string,
		ctx?: ExtensionContext,
	): Promise<FileState | undefined> {
		const abs = this.resolve_abs(file);
		const state = await this.#get_or_start_client(abs, ctx);
		if (!state) return undefined;
		this.#clear_idle_timer(state);
		state.active_request_count += 1;
		try {
			const uri = await this.#open_file(state, abs);
			state.open_documents.set(
				uri,
				(state.open_documents.get(uri) ?? 0) + 1,
			);
			return { abs, uri, state };
		} catch (error) {
			state.active_request_count = Math.max(
				0,
				state.active_request_count - 1,
			);
			this.#schedule_idle_stop(state);
			throw error;
		}
	}

	async #get_or_start_client(
		file_path: string,
		ctx?: ExtensionContext,
	): Promise<ServerState | undefined> {
		const language = this.#detect_language(file_path);
		if (!language) return undefined;
		const workspace_root = this.#find_workspace_root(file_path, this.cwd);
		const key = `${language}\u0000${workspace_root}`;
		const existing = this.clients_by_server.get(key);
		if (existing) return existing;
		const failed = this.failed_servers.get(key);
		if (failed) {
			throw new LspToolError(failed);
		}
		const in_flight = this.#starting_servers.get(key);
		if (in_flight) return in_flight.promise;

		let server_config = this.#get_server_config(language, workspace_root);
		if (!server_config) return undefined;
		if (
			server_config.is_project_local &&
			!(await should_use_project_lsp_binary(server_config, ctx))
		) {
			server_config = this.#get_server_config(language, '/');
			if (!server_config) return undefined;
		}
		const root_uri = file_path_to_uri(workspace_root);

		const startup: StartingServerState = {
			cancelled: false,
			promise: Promise.resolve<ServerState | undefined>(undefined),
		};
		const start_promise = (async () => {
			const client = this.#create_client({
				command: server_config.command,
				args: server_config.args,
				root_uri,
				language_id_for_uri: (uri) => {
					try {
						return this.#language_id_for_file(file_uri_to_path(uri));
					} catch {
						return undefined;
					}
				},
			});

			try {
				await client.start();
			} catch (error) {
				if (startup.cancelled) {
					throw new LspStartupCancelledError(
						language,
						workspace_root,
					);
				}
				const failure = to_lsp_tool_error(
					file_path,
					language,
					workspace_root,
					server_config.command,
					server_config.install_hint,
					error,
				);
				this.failed_servers.set(key, failure);
				throw new LspToolError(failure);
			}

			if (startup.cancelled) {
				await Promise.allSettled([client.stop()]);
				throw new LspStartupCancelledError(language, workspace_root);
			}

			const state: ServerState = {
				client,
				key,
				language,
				workspace_root,
				root_uri,
				command: server_config.command,
				install_hint: server_config.install_hint,
				active_request_count: 0,
				last_used_at: Date.now(),
				open_documents: new Map(),
			};
			this.clients_by_server.set(key, state);
			this.failed_servers.delete(key);
			return state;
		})();

		startup.promise = start_promise;
		this.#starting_servers.set(key, startup);
		try {
			return await start_promise;
		} finally {
			if (this.#starting_servers.get(key) === startup) {
				this.#starting_servers.delete(key);
			}
		}
	}

	async #open_file(
		state: ServerState,
		abs_path: string,
	): Promise<string> {
		const text = await this.#read_file(abs_path);
		const uri = file_path_to_uri(abs_path);
		await state.client.ensure_document_open(uri, text);
		return uri;
	}

	#notify_running_clients(file: string, change_type: 1 | 2): void {
		const uri = file_path_to_uri(file);
		for (const state of this.clients_by_server.values()) {
			if (!is_within(state.workspace_root, file)) continue;
			try {
				state.client.notify_watched_file?.(uri, change_type);
			} catch {
				// A failed advisory notification must not block the file result.
			}
		}
	}

	#clear_idle_timer(state: ServerState): void {
		if (!state.idle_timer) return;
		clearTimeout(state.idle_timer);
		state.idle_timer = undefined;
	}

	#schedule_idle_stop(state: ServerState): void {
		this.#clear_idle_timer(state);
		if (!this.#idle_timeout_ms) return;
		state.idle_timer = setTimeout(() => {
			if (
				state.active_request_count > 0 ||
				Date.now() - (state.last_used_at ?? 0) <
					this.#idle_timeout_ms!
			) {
				this.#schedule_idle_stop(state);
				return;
			}
			void (async () => {
				this.#clear_idle_timer(state);
				await state.client.stop();
				this.clients_by_server.delete(state.key);
			})();
		}, this.#idle_timeout_ms);
		state.idle_timer.unref?.();
	}
}

function is_within(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function default_path_allowed(absolute_path: string, cwd: string): boolean {
	return is_within(cwd, absolute_path);
}

function default_validate_result_uris(
	uris: string[],
	workspace_root: string,
): void {
	for (const uri of uris) {
		let file: string;
		try {
			file = file_uri_to_path(uri);
		} catch {
			throw new Error(`LSP returned a non-file URI: ${uri}`);
		}
		if (!is_within(workspace_root, file)) {
			throw new Error(`LSP returned a path outside the workspace: ${file}`);
		}
	}
}
