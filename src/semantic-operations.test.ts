import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
	create_mock_client,
	create_test_lsp_extension,
	dirs,
} from '../test/support.js';

const range = {
	start: { line: 0, character: 13 },
	end: { line: 0, character: 18 },
};

function create_typescript_workspace() {
	const root = mkdtempSync(join(tmpdir(), 'my-pi-lsp-'));
	const file = join(root, 'src', 'main.ts');
	dirs.push(root);
	mkdirSync(join(root, 'src'), { recursive: true });
	writeFileSync(join(root, 'package.json'), '{}\n');
	writeFileSync(file, 'export const value = 1;\n');
	return { root, file };
}

describe('semantic LSP operations', () => {
	it('finds implementations and workspace symbols through the same manager', async () => {
		const { root, file } = create_typescript_workspace();
		const implementation = vi.fn().mockResolvedValue([
			{ uri: pathToFileURL(file).href, range },
		]);
		const workspace_symbols = vi.fn().mockResolvedValue([
			{
				name: 'value',
				kind: 13,
				containerName: 'main',
				location: { uri: pathToFileURL(file).href, range },
			},
		]);
		const client = create_mock_client({ implementation, workspace_symbols });
		const { tools } = await create_test_lsp_extension({
			create_client: () => client,
			read_file: async () => readFileSync(file, 'utf8'),
			cwd: () => root,
		});

		const implementation_result = await tools
			.get('lsp_implementation')
			.execute('1', { file, line: 0, character: 13 });
		const symbol_result = await tools
			.get('lsp_workspace_symbols')
			.execute('2', { file, query: 'value' });

		expect(implementation_result.content[0].text).toBe(`${file}:1:14`);
		expect(symbol_result.content[0].text).toContain(
			`variable value in main @ ${file}:1:14`,
		);
		expect(implementation).toHaveBeenCalledTimes(1);
		expect(workspace_symbols).toHaveBeenCalledWith('value');
	});

	it('previews only in-root text edits and never writes them', async () => {
		const { root, file } = create_typescript_workspace();
		const original = readFileSync(file, 'utf8');
		const prepare_rename = vi.fn().mockResolvedValue(range);
		const rename = vi.fn().mockResolvedValue({
			changes: {
				[pathToFileURL(file).href]: [{ range, newText: 'renamed' }],
			},
		});
		const client = create_mock_client({ prepare_rename, rename });
		const { tools } = await create_test_lsp_extension({
			create_client: () => client,
			read_file: async () => original,
			cwd: () => root,
		});

		const result = await tools.get('lsp_rename_preview').execute('1', {
			file,
			line: 0,
			character: 13,
			new_name: 'renamed',
		});

		expect(prepare_rename).toHaveBeenCalledBefore(rename);
		expect(result.content[0].text).toContain('Rename preview only: 1 text edit');
		expect(result.content[0].text).toContain('No files were changed.');
		expect(readFileSync(file, 'utf8')).toBe(original);
	});

	it('rejects rename resource operations', async () => {
		const { root, file } = create_typescript_workspace();
		const client = create_mock_client({
			prepare_rename: vi.fn().mockResolvedValue(range),
			rename: vi.fn().mockResolvedValue({
				documentChanges: [
					{
						kind: 'rename',
						oldUri: pathToFileURL(file).href,
						newUri: pathToFileURL(join(root, 'src', 'other.ts')).href,
					},
				],
			}),
		});
		const { tools } = await create_test_lsp_extension({
			create_client: () => client,
			read_file: async () => readFileSync(file, 'utf8'),
			cwd: () => root,
		});

		const result = await tools.get('lsp_rename_preview').execute('1', {
			file,
			line: 0,
			character: 13,
			new_name: 'renamed',
		});

		expect(result.content[0].text).toContain(
			'rejected resource operation: rename',
		);
	});

	it('rejects rename text edits outside the workspace', async () => {
		const { root, file } = create_typescript_workspace();
		const client = create_mock_client({
			prepare_rename: vi.fn().mockResolvedValue(range),
			rename: vi.fn().mockResolvedValue({
				changes: {
					'file:///outside.ts': [{ range, newText: 'renamed' }],
				},
			}),
		});
		const { tools } = await create_test_lsp_extension({
			create_client: () => client,
			read_file: async () => readFileSync(file, 'utf8'),
			cwd: () => root,
		});

		const result = await tools.get('lsp_rename_preview').execute('1', {
			file,
			line: 0,
			character: 13,
			new_name: 'renamed',
		});

		expect(result.content[0].text).toContain('outside the workspace');
	});
});
