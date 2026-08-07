import {
	accessSync,
	constants,
	existsSync,
	readFileSync,
	realpathSync,
} from 'node:fs';
import {
	delimiter,
	dirname,
	extname,
	isAbsolute,
	join,
	resolve,
} from 'node:path';

export interface LspServerConfig {
	language: string;
	command: string;
	args: string[];
	initialization_options?: Record<string, unknown>;
	install_hint?: string;
	is_project_local?: boolean;
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
		command: 'typescript-language-server',
		args: ['--stdio'],
		install_hint:
			'Install TypeScript LSP with: pnpm add -D typescript typescript-language-server',
	},
	python: {
		language: 'python',
		command: 'pyright-langserver',
		args: ['--stdio'],
		install_hint:
			'Install Pyright and ensure pyright-langserver is on PATH.',
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
	const resolved = resolve_server_command_info(base.command, cwd);
	const typescript_lib =
		language === 'typescript'
			? resolve_typescript_lib(cwd)
			: undefined;
	return {
		...base,
		command: resolved.command,
		is_project_local: resolved.is_project_local,
		...(typescript_lib
			? {
					initialization_options: {
						tsserver: { path: typescript_lib },
					},
				}
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

function resolve_typescript_lib(cwd: string): string | undefined {
	for (const dir of ancestor_directories(cwd)) {
		const local_server = join(
			dir,
			'node_modules',
			'typescript',
			'lib',
			'tsserver.js',
		);
		if (existsSync(local_server)) return dirname(local_server);
	}

	const tsc = resolve_path_executable('tsc');
	if (!tsc) return undefined;
	for (const target of executable_targets(tsc)) {
		const server = resolve(dirname(target), '..', 'lib', 'tsserver.js');
		if (existsSync(server)) return dirname(server);
	}
	return undefined;
}

function resolve_path_executable(command: string): string | undefined {
	for (const directory of (process.env.PATH ?? '').split(delimiter)) {
		if (!directory) continue;
		const candidate = join(directory, command);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Continue through PATH.
		}
	}
	return undefined;
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
