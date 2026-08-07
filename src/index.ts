import { type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { register_lsp_command } from './commands.js';
import {
	InlineDiagnosticsController,
	type InlineDiagnosticsOptions,
} from './inline-diagnostics.js';
import {
	append_lsp_system_prompt,
	should_inject_lsp_prompt,
} from './prompt.js';
import {
	LspServerManager,
	type CreateLspServerManagerOptions,
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
		const manager = new LspServerManager(options);
		const inline_diagnostics = new InlineDiagnosticsController(
			pi,
			manager,
			options,
		);

		register_lsp_tools(pi, manager);
		inline_diagnostics.register();

		pi.on('before_agent_start', async (event) => {
			if (!should_inject_lsp_prompt(event)) return {};
			return {
				systemPrompt: append_lsp_system_prompt(event.systemPrompt),
			};
		});

		register_lsp_command(pi, manager);

		pi.on('session_shutdown', async () => {
			inline_diagnostics.shutdown();
			await manager.clear_language_state();
		});
	};
}

export default create_lsp_extension();
