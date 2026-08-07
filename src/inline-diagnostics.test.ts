import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import {
	create_deferred,
	create_mock_client,
	create_test_lsp_extension,
} from '../test/support.js';
import type {
	LspDiagnostic,
	LspDiagnosticsSnapshot,
} from './client.js';

const diagnostic: LspDiagnostic = {
	range: {
		start: { line: 1, character: 2 },
		end: { line: 1, character: 7 },
	},
	severity: 1,
	source: 'ts',
	message: 'Broken value',
};

const context = {} as ExtensionContext;

describe('inline diagnostics', () => {
	it('appends fresh diagnostics to a successful write result', async () => {
		const snapshots: LspDiagnosticsSnapshot[] = [
			{ revision: 0, by_uri: new Map() },
			{
				revision: 1,
				by_uri: new Map([
					['file:///repo/src/a.ts', [diagnostic]],
				]),
			},
		];
		const client = create_mock_client({
			diagnostics_snapshot: vi.fn(() => snapshots.shift()!),
			notify_watched_file: vi.fn(),
			wait_for_diagnostics: vi.fn().mockResolvedValue([diagnostic]),
		});
		const { events } = await create_test_lsp_extension({
			create_client: () => client,
			read_file: async () => 'export const value = missing;\n',
			cwd: () => '/repo',
			settle_ms: 0,
		});

		await events.get('tool_call')(
			{
				toolCallId: 'write-1',
				toolName: 'write',
				input: { path: 'src/a.ts', content: 'ignored' },
			},
			context,
		);
		const result = await events.get('tool_result')(
			{
				toolCallId: 'write-1',
				toolName: 'write',
				input: { path: 'src/a.ts', content: 'ignored' },
				content: [{ type: 'text', text: 'Wrote src/a.ts' }],
				isError: false,
			},
			context,
		);

		expect(result.content[0].text).toBe('Wrote src/a.ts');
		expect(result.content[1].text).toContain('LSP diagnostics');
		expect(result.content[1].text).toContain('Broken value');
		expect(client.notify_watched_file).toHaveBeenCalledWith(
			'file:///repo/src/a.ts',
			1,
		);
	});

	it('delivers slow diagnostics without starting another turn', async () => {
		const deferred = create_deferred<LspDiagnostic[]>();
		let revision = 0;
		const client = create_mock_client({
			diagnostics_snapshot: vi.fn(() => ({
				revision,
				by_uri: new Map(
					revision
						? [['file:///repo/src/a.ts', [diagnostic]]]
						: [],
				),
			})),
			wait_for_diagnostics: vi.fn(() => deferred.promise),
		});
		const { events, messages } = await create_test_lsp_extension({
			create_client: () => client,
			read_file: async () => 'export const value = missing;\n',
			cwd: () => '/repo',
			inline_budget_ms: 1,
			deferred_budget_ms: 1000,
			settle_ms: 0,
		});

		await events.get('tool_call')(
			{
				toolCallId: 'write-2',
				toolName: 'write',
				input: { path: 'src/a.ts', content: 'ignored' },
			},
			context,
		);
		const inline = await events.get('tool_result')(
			{
				toolCallId: 'write-2',
				toolName: 'write',
				input: { path: 'src/a.ts', content: 'ignored' },
				content: [{ type: 'text', text: 'Wrote src/a.ts' }],
				isError: false,
			},
			context,
		);
		expect(inline).toBeUndefined();

		revision = 1;
		deferred.resolve([diagnostic]);
		await vi.waitFor(() => expect(messages).toHaveLength(1));
		expect(messages[0].message).toMatchObject({
			customType: 'pi-lsp-late-diagnostics',
			display: true,
		});
		expect(messages[0].options).toEqual({
			triggerTurn: false,
			deliverAs: 'steer',
		});
	});
});
