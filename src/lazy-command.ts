import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import type { LspServerManager } from './server-manager.js';

const SUBCOMMANDS = ['status', 'list', 'restart'];

export function register_lazy_lsp_command(
	pi: ExtensionAPI,
	load_manager: () => Promise<LspServerManager>,
	peek_manager: () => LspServerManager | undefined,
): void {
	pi.registerCommand('lsp', {
		description: 'Show or manage language server state',
		getArgumentCompletions: (prefix) => {
			const parts = prefix.trim().split(/\s+/);
			if (!prefix.trim()) {
				return SUBCOMMANDS.map((value) => ({ value, label: value }));
			}
			if (parts.length <= 1) {
				return SUBCOMMANDS.filter((value) => value.startsWith(parts[0])).map(
					(value) => ({ value, label: value }),
				);
			}
			if (parts[0] !== 'restart') return null;
			const candidate = parts[1] ?? '';
			const languages = peek_manager()?.list_supported_languages() ?? [];
			return ['all', ...languages]
				.filter((value) => value.startsWith(candidate))
				.map((value) => ({ value: `restart ${value}`, label: value }));
		},
		handler: async (args, ctx) => {
			const [{ handle_lsp_command }, manager] = await Promise.all([
				import('./commands.js'),
				load_manager(),
			]);
			await handle_lsp_command(
				args,
				ctx as ExtensionCommandContext,
				manager,
			);
		},
	});
}
