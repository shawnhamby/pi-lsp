import type { BeforeAgentStartEvent } from '@earendil-works/pi-coding-agent';

export const LSP_TOOL_NAMES = new Set([
	'lsp_diagnostics',
	'lsp_diagnostics_many',
	'lsp_find_symbol',
	'lsp_hover',
	'lsp_definition',
	'lsp_references',
	'lsp_document_symbols',
]);

export const LSP_SYSTEM_PROMPT = `

## Language server support via LSP tools

You have access to Language Server Protocol tools for diagnostics, hover/type information, definitions, references, and document symbols. Use them when:
- Debugging TypeScript, JavaScript, Svelte, or other language-server-supported errors
- Checking types, symbol definitions, or API documentation from code
- Finding references more precisely than text search

Successful writes already receive automatic, bounded LSP diagnostics. Do not run an explicit diagnostic sweep after every edit or before routine completion. Use lsp_diagnostics or lsp_diagnostics_many only when investigating a type error, following up on an inline warning, or performing an explicitly requested diagnostic check.

Prefer LSP diagnostics over guessing from build output when a file-level check is enough. Use text search for broad discovery, then LSP tools for precise type and symbol questions.`;

export function should_inject_lsp_prompt(event: {
	systemPromptOptions?: Pick<
		BeforeAgentStartEvent['systemPromptOptions'],
		'selectedTools'
	>;
}): boolean {
	const selected_tools = event.systemPromptOptions?.selectedTools;
	return (
		!selected_tools ||
		selected_tools.some((tool) => LSP_TOOL_NAMES.has(tool))
	);
}

export function append_lsp_system_prompt(
	system_prompt: string,
): string {
	return system_prompt + LSP_SYSTEM_PROMPT;
}
