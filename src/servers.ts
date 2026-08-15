import {
	accessSync,
	constants,
	existsSync,
	readFileSync,
	realpathSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
	delimiter,
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
} from 'node:path';
import { create_child_process_env } from './env.js';

export interface LspServerConfig {
	language: string;
	command: string;
	args: string[];
	initialization_options?: Record<string, unknown>;
	install_hint?: string;
	is_project_local?: boolean;
	resolution_error?: string;
}

const EXTENSION_LANGUAGES: Record<string, string> = {
	'.ts': 'typescript',
	'.tsx': 'typescript',
	'.mts': 'typescript',
	'.cts': 'typescript',
	'.js': 'typescript',
	'.jsx': 'typescript',
	'.mjs': 'typescript',
	'.cjs': 'typescript',
	'.py': 'python',
	'.rs': 'rust',
	'.go': 'go',
	'.rb': 'ruby',
	'.java': 'java',
	'.lua': 'lua',
	'.svelte': 'svelte',
	'.c': 'clangd',
	'.cc': 'clangd',
	'.cpp': 'clangd',
	'.cxx': 'clangd',
	'.h': 'clangd',
	'.hh': 'clangd',
	'.hpp': 'clangd',
	'.m': 'clangd',
	'.mm': 'clangd',
	'.swift': 'swift',
};

const EXTENSION_LANGUAGE_IDS: Record<string, string> = {
	'.ts': 'typescript',
	'.tsx': 'typescriptreact',
	'.mts': 'typescript',
	'.cts': 'typescript',
	'.js': 'javascript',
	'.jsx': 'javascriptreact',
	'.mjs': 'javascript',
	'.cjs': 'javascript',
	'.py': 'python',
	'.rs': 'rust',
	'.go': 'go',
	'.rb': 'ruby',
	'.java': 'java',
	'.lua': 'lua',
	'.svelte': 'svelte',
	'.c': 'c',
	'.cc': 'cpp',
	'.cpp': 'cpp',
	'.cxx': 'cpp',
	'.h': 'c',
	'.hh': 'cpp',
	'.hpp': 'cpp',
	'.m': 'objective-c',
	'.mm': 'objective-cpp',
	'.swift': 'swift',
};

const LANGUAGE_SERVERS: Record<string, LspServerConfig> = {
	typescript: {
		language: 'typescript',
		command: 'tsc',
		args: ['--lsp', '--stdio'],
		install_hint:
			'Install a TypeScript version with native LSP support, then expose tsc through the project or pnpm global bin directory.',
	},
	python: {
		language: 'python',
		command: 'pyright-langserver',
		args: ['--stdio'],
		install_hint:
			'Install Pyright in the canonical pnpm global environment.',
	},
	rust: {
		language: 'rust',
		command: 'rust-analyzer',
		args: [],
		install_hint:
			'Install Rust Analyzer and ensure the rust-analyzer binary is on PATH.',
	},
	go: {
		language: 'go',
		command: 'gopls',
		args: ['serve'],
		install_hint:
			'Install Go LSP with: go install golang.org/x/tools/gopls@latest',
	},
	ruby: {
		language: 'ruby',
		command: 'solargraph',
		args: ['stdio'],
		install_hint: 'Install Ruby LSP with: gem install solargraph',
	},
	java: {
		language: 'java',
		command: 'jdtls',
		args: [],
		install_hint:
			'Install Eclipse JDT Language Server and ensure the jdtls binary is on PATH.',
	},
	lua: {
		language: 'lua',
		command: 'lua-language-server',
		args: [],
		install_hint:
			'Install Lua LSP and ensure the lua-language-server binary is on PATH.',
	},
	svelte: {
		language: 'svelte',
		command: 'svelteserver',
		args: ['--stdio'],
		install_hint:
			'Install Svelte LSP with: pnpm add -D svelte-language-server (or volta install svelte-language-server)',
	},
	clangd: {
		language: 'clangd',
		command: 'clangd',
		args: [],
		install_hint:
			'Install clangd and ensure the clangd binary is on PATH.',
	},
	swift: {
		language: 'swift',
		command: 'sourcekit-lsp',
		args: [],
		install_hint:
			'Install the Swift toolchain and ensure sourcekit-lsp is on PATH.',
	},
};

const WORKSPACE_MARKERS = [
	'svelte.config.js',
	'svelte.config.ts',
	'tsconfig.json',
	'jsconfig.json',
	'package.json',
	'pyproject.toml',
	'Cargo.toml',
	'go.mod',
	'Gemfile',
	'pom.xml',
	'build.gradle',
	'build.gradle.kts',
	'compile_commands.json',
	'CMakeLists.txt',
	'Package.swift',
];

const REPOSITORY_MARKERS = [
	'pnpm-workspace.yaml',
	'package-lock.json',
	'yarn.lock',
	'bun.lockb',
	'bun.lock',
	'.git',
];

export function detect_language(
	file_path: string,
): string | undefined {
	return EXTENSION_LANGUAGES[extname(file_path).toLowerCase()];
}

export function list_supported_languages(): string[] {
	return Object.keys(LANGUAGE_SERVERS).sort();
}

export interface ResolvedServerCommand {
	command: string;
	is_project_local: boolean;
}

export function resolve_server_command_info(
	command: string,
	cwd: string = process.cwd(),
): ResolvedServerCommand {
	if (
		!command ||
		isAbsolute(command) ||
		command.includes('/') ||
		command.includes('\\')
	) {
		return { command, is_project_local: false };
	}

	for (const dir of ancestor_directories(cwd)) {
		const local_bin = resolve_local_binary(dir, command);
		if (local_bin) {
			return { command: local_bin, is_project_local: true };
		}
	}

	return { command, is_project_local: false };
}

export function resolve_server_command(
	command: string,
	cwd: string = process.cwd(),
): string {
	return resolve_server_command_info(command, cwd).command;
}

export function get_server_config(
	language: string,
	cwd: string = process.cwd(),
): LspServerConfig | undefined {
	const base = LANGUAGE_SERVERS[language];
	if (!base) return undefined;
	const resolved: ResolvedServerCommand & { resolution_error?: string } =
		language === 'python'
			? resolve_pyright_command(cwd)
			: resolve_server_command_info(base.command, cwd);
	return {
		...base,
		command: resolved.command,
		is_project_local: resolved.is_project_local,
		...('resolution_error' in resolved
			? { resolution_error: resolved.resolution_error }
			: {}),
	};
}

export function language_id_for_file(
	file_path: string,
): string | undefined {
	return EXTENSION_LANGUAGE_IDS[extname(file_path).toLowerCase()];
}

export function find_workspace_root(
	file_path: string,
	fallback: string = process.cwd(),
): string {
	const start = resolve(dirname(file_path));
	const project_root = find_nearest_marker_directory(
		start,
		WORKSPACE_MARKERS,
	);
	if (project_root) return project_root;

	const repo_root = find_nearest_marker_directory(
		start,
		REPOSITORY_MARKERS,
	);
	if (repo_root) return repo_root;

	return resolve(fallback);
}

function find_nearest_marker_directory(
	start: string,
	markers: string[],
): string | undefined {
	for (const dir of ancestor_directories(start)) {
		if (markers.some((marker) => existsSync(join(dir, marker)))) {
			return dir;
		}
	}
	return undefined;
}

function ancestor_directories(start: string): string[] {
	const dirs: string[] = [];
	let current = resolve(start);
	while (true) {
		dirs.push(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs;
}

function resolve_local_binary(
	directory: string,
	command: string,
): string | undefined {
	const candidates = [
		join(directory, 'node_modules', '.bin', command),
		join(directory, 'node_modules', '.bin', `${command}.cmd`),
	];
	return candidates.find((candidate) => existsSync(candidate));
}

function resolve_pyright_command(cwd: string):
	ResolvedServerCommand & { resolution_error?: string } {
	for (const dir of ancestor_directories(cwd)) {
		const local = resolve_local_binary(dir, 'pyright-langserver');
		if (local) return { command: local, is_project_local: true };
	}

	const canonical = resolve_verified_pnpm_global_binary(
		'pyright-langserver',
		'pyright',
	);
	if (canonical) {
		return { command: canonical, is_project_local: false };
	}
	return {
		command: 'pyright-langserver',
		is_project_local: false,
		resolution_error:
			'No verified pnpm-global Pyright language server was found. Install Pyright with pnpm globally and ensure `pnpm bin --global` names its canonical executable directory.',
	};
}

function resolve_verified_pnpm_global_binary(
	command: string,
	package_name: string,
): string | undefined {
	try {
		const env = create_child_process_env();
		const global_bin = execFileSync('pnpm', ['bin', '--global'], {
			encoding: 'utf8',
			env,
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 2_000,
		}).trim();
		const global_root = execFileSync('pnpm', ['root', '--global'], {
			encoding: 'utf8',
			env,
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 2_000,
		}).trim();
		if (!isAbsolute(global_bin) || !isAbsolute(global_root)) return undefined;

		const executable = [
			join(global_bin, command),
			join(global_bin, `${command}.cmd`),
		].find((candidate) => {
			try {
				accessSync(candidate, constants.X_OK);
				return true;
			} catch {
				return false;
			}
		});
		if (!executable) return undefined;

		const global_store = dirname(global_root);
		const package_segment = `/node_modules/${package_name}/`;
		const verified = executable_targets(executable).some((target) => {
			const normalized = target.replaceAll('\\', '/');
			return (
				existsSync(target) &&
				is_within(global_store, target) &&
				normalized.includes(package_segment)
			);
		});
		return verified ? executable : undefined;
	} catch {
		return undefined;
	}
}

function is_within(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function executable_targets(executable: string): string[] {
	const targets = new Set<string>();
	try {
		targets.add(realpathSync(executable));
	} catch {
		targets.add(executable);
	}

	try {
		const shim = readFileSync(executable, 'utf8');
		const target = /^# cmd-shim-target=(.+)$/m.exec(shim)?.[1]?.trim();
		if (target && isAbsolute(target)) targets.add(target);
	} catch {
		// Native executables and unreadable shims have no embedded target.
	}
	return Array.from(targets);
}
