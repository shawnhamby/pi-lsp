import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	LspClient,
	LspClientStartError,
	normalize_document_symbol_result,
	normalize_location_result,
} from './client.js';

describe('LspClient.start', () => {
	it('rejects quickly with a typed error when the server binary is missing', async () => {
		const client = new LspClient({
			command: '__my_pi_missing_lsp_binary__',
			args: ['--stdio'],
			root_uri: 'file:///repo',
			language_id_for_uri: () => 'typescript',
			request_timeout_ms: 50,
		});

		await expect(client.start()).rejects.toMatchObject({
			name: 'LspClientStartError',
			command: '__my_pi_missing_lsp_binary__',
			code: 'ENOENT',
		});
		await expect(client.start()).rejects.toBeInstanceOf(
			LspClientStartError,
		);
	});

	it('explains when a project compiler lacks native LSP support', async () => {
		const root = mkdtempSync(join(tmpdir(), 'my-pi-lsp-'));
		const tsc = join(root, 'tsc');
		writeFileSync(
			tsc,
			"#!/bin/sh\necho \"error TS5023: Unknown compiler option '--lsp'.\" >&2\nexit 1\n",
			{ mode: 0o755 },
		);
		try {
			const client = new LspClient({
				command: tsc,
				args: ['--lsp', '--stdio'],
				root_uri: 'file:///repo',
				language_id_for_uri: () => 'typescript',
				request_timeout_ms: 500,
			});

			await expect(client.start()).rejects.toThrow(
				'does not support native LSP (--lsp)',
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('LspClient diagnostics', () => {
	it('pulls diagnostics from servers that advertise diagnosticProvider', async () => {
		const root = mkdtempSync(join(tmpdir(), 'my-pi-lsp-'));
		const file = join(root, 'main.ts');
		const source =
			'export function greet(name: string) { return `Hi ${name}`; }\ngreet(42);\n';
		writeFileSync(file, source);
		const server = join(
			dirname(fileURLToPath(import.meta.url)),
			'../test/pull-diagnostics-server.mjs',
		);
		const client = new LspClient({
			command: process.execPath,
			args: [server],
			root_uri: pathToFileURL(root).href,
			language_id_for_uri: () => 'typescript',
			request_timeout_ms: 1_000,
		});

		try {
			await client.start();
			const uri = pathToFileURL(file).href;
			await client.ensure_document_open(uri, source);
			await expect(client.wait_for_diagnostics(uri, 1_000)).resolves.toEqual([
				expect.objectContaining({
					code: 2345,
					source: 'ts',
					message:
						"Argument of type 'number' is not assignable to parameter of type 'string'.",
				}),
			]);
		} finally {
			await client.stop();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('normalize_location_result', () => {
	it('keeps regular locations as-is', () => {
		expect(
			normalize_location_result({
				uri: 'file:///repo/a.ts',
				range: {
					start: { line: 1, character: 2 },
					end: { line: 1, character: 3 },
				},
			}),
		).toEqual([
			{
				uri: 'file:///repo/a.ts',
				range: {
					start: { line: 1, character: 2 },
					end: { line: 1, character: 3 },
				},
			},
		]);
	});

	it('converts location links to regular locations using targetSelectionRange', () => {
		expect(
			normalize_location_result([
				{
					targetUri: 'file:///repo/b.ts',
					targetRange: {
						start: { line: 10, character: 0 },
						end: { line: 20, character: 0 },
					},
					targetSelectionRange: {
						start: { line: 12, character: 4 },
						end: { line: 12, character: 10 },
					},
				},
			]),
		).toEqual([
			{
				uri: 'file:///repo/b.ts',
				range: {
					start: { line: 12, character: 4 },
					end: { line: 12, character: 10 },
				},
			},
		]);
	});
});

describe('normalize_document_symbol_result', () => {
	it('converts SymbolInformation-like entries into document symbols', () => {
		expect(
			normalize_document_symbol_result([
				{
					name: 'thing',
					kind: 13,
					containerName: 'module',
					location: {
						uri: 'file:///repo/c.ts',
						range: {
							start: { line: 4, character: 1 },
							end: { line: 4, character: 6 },
						},
					},
				},
			]),
		).toEqual([
			{
				name: 'thing',
				kind: 13,
				containerName: 'module',
				uri: 'file:///repo/c.ts',
				range: {
					start: { line: 4, character: 1 },
					end: { line: 4, character: 6 },
				},
				selectionRange: {
					start: { line: 4, character: 1 },
					end: { line: 4, character: 6 },
				},
			},
		]);
	});
});
