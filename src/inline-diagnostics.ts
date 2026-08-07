import type {
	ExtensionAPI,
	ExtensionContext,
	ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { existsSync } from 'node:fs';
import type { LspDiagnostic } from './client.js';
import { format_diagnostics } from './format.js';
import {
	LspServerManager,
	type MutationDiagnosticsEntry,
	type MutationDiagnosticsResult,
} from './server-manager.js';

const DEFAULT_INLINE_BUDGET_MS = 500;
const DEFAULT_DEFERRED_BUDGET_MS = 12_000;
const DEFAULT_SETTLE_MS = 200;
const DIAGNOSTICS_MESSAGE = 'pi-lsp-diagnostics';

export interface InlineDiagnosticsOptions {
	diagnostics_on_write?: boolean;
	diagnostics_on_edit?: boolean;
	inline_budget_ms?: number;
	deferred_budget_ms?: number;
	settle_ms?: number;
}

interface PendingDiagnostics {
	version: number;
	controller: AbortController;
}

interface ResolvedInlineDiagnosticsOptions {
	diagnostics_on_write: boolean;
	diagnostics_on_edit: boolean;
	inline_budget_ms: number;
	deferred_budget_ms: number;
	settle_ms: number;
}

export class InlineDiagnosticsController {
	readonly #options: ResolvedInlineDiagnosticsOptions;
	readonly #change_type_by_call = new Map<string, 1 | 2>();
	readonly #pending_by_file = new Map<string, PendingDiagnostics>();
	readonly #version_by_file = new Map<string, number>();
	readonly #seen_by_file = new Map<string, Set<string>>();

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly manager: LspServerManager,
		options: InlineDiagnosticsOptions = {},
	) {
		this.#options = {
			diagnostics_on_write: options.diagnostics_on_write ?? true,
			diagnostics_on_edit: options.diagnostics_on_edit ?? false,
			inline_budget_ms:
				options.inline_budget_ms ?? DEFAULT_INLINE_BUDGET_MS,
			deferred_budget_ms:
				options.deferred_budget_ms ?? DEFAULT_DEFERRED_BUDGET_MS,
			settle_ms: options.settle_ms ?? DEFAULT_SETTLE_MS,
		};
	}

	register(): void {
		this.pi.on('tool_call', (event) => {
			const mutation = mutation_tool_kind(event.toolName);
			if (!mutation || !this.#is_enabled_tool(mutation)) return;
			const path = input_path(event.input);
			if (!path) return;
			this.#change_type_by_call.set(
				event.toolCallId,
				mutation === 'write' && !existsSync(this.manager.resolve_abs(path))
					? 1
					: 2,
			);
		});

		this.pi.on('tool_result', async (event, ctx) =>
			this.#handle_tool_result(event, ctx),
		);
	}

	shutdown(): void {
		for (const pending of this.#pending_by_file.values()) {
			pending.controller.abort();
		}
		this.#pending_by_file.clear();
		this.#change_type_by_call.clear();
	}

	async #handle_tool_result(
		event: ToolResultEvent,
		ctx: ExtensionContext,
	): Promise<{ content: ToolResultEvent['content'] } | undefined> {
		const change_type = this.#change_type_by_call.get(event.toolCallId);
		this.#change_type_by_call.delete(event.toolCallId);
		const mutation = mutation_tool_kind(event.toolName);
		if (!change_type || event.isError || !mutation || !this.#is_enabled_tool(mutation)) {
			return undefined;
		}

		const path = input_path(event.input);
		if (!path) return undefined;
		const absolute_path = this.manager.resolve_abs(path);
		if (!(await this.manager.is_path_allowed(absolute_path))) {
			return undefined;
		}

		const previous = this.#pending_by_file.get(absolute_path);
		previous?.controller.abort();
		const version = (this.#version_by_file.get(absolute_path) ?? 0) + 1;
		this.#version_by_file.set(absolute_path, version);
		const controller = new AbortController();
		const pending = { version, controller };
		this.#pending_by_file.set(absolute_path, pending);
		const timeout_signal = AbortSignal.timeout(
			this.#options.deferred_budget_ms,
		);
		const signal = AbortSignal.any([controller.signal, timeout_signal]);
		const work = this.manager
			.collect_mutation_diagnostics(absolute_path, change_type, ctx, {
				timeout_ms: this.#options.deferred_budget_ms,
				settle_ms: this.#options.settle_ms,
				signal,
			})
			.catch(() => undefined);

		const inline = await race_with_timeout(
			work,
			this.#options.inline_budget_ms,
		);
		if (!inline.timed_out) {
			this.#clear_pending(absolute_path, pending);
			if (!inline.value || signal.aborted) return undefined;
			const text = this.#format_fresh(inline.value);
			if (!text) return undefined;
			this.#send_diagnostics(absolute_path, version, text);
			return undefined;
		}

		void work.then((result) => {
			this.#clear_pending(absolute_path, pending);
			if (!result || signal.aborted || !this.#is_current(absolute_path, version)) {
				return;
			}
			const text = this.#format_fresh(result);
			if (!text) return;
			this.#send_diagnostics(absolute_path, version, text);
		});
		return undefined;
	}

	#send_diagnostics(file: string, version: number, text: string): void {
		this.pi.sendMessage(
			{
				customType: DIAGNOSTICS_MESSAGE,
				content: `LSP diagnostics\n${text}`,
				display: true,
				details: { file, version, text },
			},
			{ triggerTurn: false, deliverAs: 'steer' },
		);
	}

	#is_enabled_tool(tool_name: MutationToolKind): boolean {
		return (
			(tool_name === 'write' && this.#options.diagnostics_on_write) ||
			(tool_name === 'edit' && this.#options.diagnostics_on_edit)
		);
	}

	#is_current(file: string, version: number): boolean {
		return this.#version_by_file.get(file) === version;
	}

	#clear_pending(file: string, pending: PendingDiagnostics): void {
		if (this.#pending_by_file.get(file) === pending) {
			this.#pending_by_file.delete(file);
		}
	}

	#format_fresh(result: MutationDiagnosticsResult): string | undefined {
		if (!result.ok) return undefined;
		const rendered: string[] = [];
		for (const entry of result.entries) {
			const fresh = this.#fresh_diagnostics(entry);
			if (fresh.length === 0) continue;
			rendered.push(format_diagnostics(entry.file, fresh));
		}
		return rendered.length > 0 ? rendered.join('\n\n') : undefined;
	}

	#fresh_diagnostics(entry: MutationDiagnosticsEntry): LspDiagnostic[] {
		const relevant = entry.diagnostics.filter(
			(diagnostic) =>
				diagnostic.severity === undefined || diagnostic.severity <= 2,
		);
		const previous = this.#seen_by_file.get(entry.file) ?? new Set<string>();
		const current = new Set(relevant.map(diagnostic_identity));
		if (current.size === 0) {
			this.#seen_by_file.delete(entry.file);
		} else {
			this.#seen_by_file.set(entry.file, current);
		}
		return relevant.filter(
			(diagnostic) => !previous.has(diagnostic_identity(diagnostic)),
		);
	}
}

type MutationToolKind = 'write' | 'edit';

function mutation_tool_kind(tool_name: string): MutationToolKind | undefined {
	switch (tool_name) {
		case 'write':
		case 'readSeek_write':
			return 'write';
		case 'edit':
		case 'readSeek_edit':
			return 'edit';
		default:
			return undefined;
	}
}

function diagnostic_identity(diagnostic: LspDiagnostic): string {
	return JSON.stringify([
		diagnostic.range.start.line,
		diagnostic.range.start.character,
		diagnostic.range.end.line,
		diagnostic.range.end.character,
		diagnostic.severity,
		diagnostic.code,
		diagnostic.source,
		diagnostic.message,
	]);
}

function input_path(input: object): string | undefined {
	return 'path' in input && typeof input.path === 'string'
		? input.path
		: undefined;
}

async function race_with_timeout<T>(
	promise: Promise<T>,
	timeout_ms: number,
): Promise<{ timed_out: false; value: T } | { timed_out: true }> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<{ timed_out: true }>((resolve) => {
		timer = setTimeout(() => resolve({ timed_out: true }), timeout_ms);
	});
	const result = await Promise.race([
		promise.then((value) => ({ timed_out: false as const, value })),
		timeout,
	]);
	if (timer) clearTimeout(timer);
	return result;
}
