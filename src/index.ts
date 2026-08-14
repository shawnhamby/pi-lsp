import { type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { register_lazy_lsp_command } from './lazy-command.js';
import type { InlineDiagnosticsOptions } from './inline-diagnostics.js';
import {
	append_lsp_system_prompt,
	should_inject_lsp_prompt,
} from './prompt.js';
import type {
	CreateLspServerManagerOptions,
	LspServerManager,
} from './server-manager.js';
import { register_lsp_tools } from './tools.js';

export { should_inject_lsp_prompt } from './prompt.js';
export type {
	LspDiagnosticsSnapshot,
	LspDiagnosticsWaitOptions,
} from './client.js';
export type { InlineDiagnosticsOptions } from './inline-diagnostics.js';
export type {
	CreateLspServerManagerOptions,
	LspClientLike,
	MutationDiagnosticsEntry,
	MutationDiagnosticsOptions,
	MutationDiagnosticsResult,
} from './server-manager.js';
export type { LspServerConfig } from './servers.js';

export interface CreateLspExtensionOptions
	extends CreateLspServerManagerOptions,
		InlineDiagnosticsOptions {}

export function create_lsp_extension(
	options: CreateLspExtensionOptions = {},
) {
	return async function lsp(pi: ExtensionAPI) {
		let manager: LspServerManager | undefined;
		let manager_promise: Promise<LspServerManager> | undefined;
		let inline_diagnostics_promise:
			| Promise<import('./inline-diagnostics.js').InlineDiagnosticsController>
			| undefined;

		const load_manager = (): Promise<LspServerManager> => {
			manager_promise ??= import('./server-manager.js').then(
				({ LspServerManager }) => {
					manager = new LspServerManager(options);
					return manager;
				},
			);
			return manager_promise;
		};
		const load_inline_diagnostics = async () => {
			inline_diagnostics_promise ??= Promise.all([
				import('./inline-diagnostics.js'),
				load_manager(),
			]).then(([{ InlineDiagnosticsController }, loaded_manager]) =>
				new InlineDiagnosticsController(pi, loaded_manager, options),
			);
			return inline_diagnostics_promise;
		};

		register_lsp_tools(pi, load_manager);
		register_lazy_lsp_command(pi, load_manager, () => manager);

		pi.on('tool_call', async (event) => {
			const enabled =
				(event.toolName === 'write' || event.toolName === 'readSeek_write')
					? options.diagnostics_on_write ?? true
					: (event.toolName === 'edit' || event.toolName === 'readSeek_edit') &&
						(options.diagnostics_on_edit ?? false);
			if (!enabled) return;
			(await load_inline_diagnostics()).handle_tool_call(event);
		});
		pi.on('tool_result', async (event, ctx) => {
			if (!inline_diagnostics_promise) return undefined;
			return (await inline_diagnostics_promise).handle_tool_result(event, ctx);
		});

		pi.on('before_agent_start', async (event) => {
			if (!should_inject_lsp_prompt(event)) return {};
			return {
				systemPrompt: append_lsp_system_prompt(event.systemPrompt),
			};
		});

		pi.on('session_shutdown', async () => {
			if (inline_diagnostics_promise) {
				(await inline_diagnostics_promise).shutdown();
			}
			if (manager_promise) {
				await (await manager_promise).clear_language_state();
			}
		});
	};
}

export default create_lsp_extension();
