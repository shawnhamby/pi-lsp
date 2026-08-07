# @shawnhamby/pi-lsp

Language Server Protocol tools and bounded inline diagnostics for the
[Pi coding agent](https://pi.dev). This is a focused fork of
[`@spences10/pi-lsp`](https://github.com/spences10/my-pi/tree/main/packages/pi-lsp)
that retains its secure language-server process handling and adds an
OMP-style diagnostic feedback loop after file mutations.

## Install

Install the Git repository directly:

```bash
pi install git:github.com/shawnhamby/pi-lsp
```

The repository's reviewed `main` branch is the release channel. Fork
maintenance and pushes happen outside Pi; Pi only loads or refreshes the Git
package.

For local development or a one-run smoke test:

```bash
pi -e /absolute/path/to/pi-lsp
```

Pi loads the checked-in TypeScript extension directly for Git installs. The
compiled `dist` entry remains available to package consumers.

## What it provides

The extension registers tools for:

- diagnostics, including batched diagnostics;
- hover information;
- definitions and references;
- document symbols.

It also watches successful Pi `write` operations by default. Fresh errors and
warnings that arrive within 500 ms are appended to the tool result. Slower
diagnostics may arrive for up to 12 seconds as a non-turn-triggering steering
message. Newer edits supersede older pending diagnostics, unchanged findings
are deduplicated, clean results stay silent, and watched-file notifications keep
language servers current when files are created or changed.

Automatic diagnostics after `edit` are off by default because frequent patch
operations can create noisy intermediate states. A custom harness can enable
them:

```ts
import { create_lsp_extension } from '@shawnhamby/pi-lsp';

export default create_lsp_extension({
  diagnostics_on_write: true,
  diagnostics_on_edit: true,
  inline_budget_ms: 500,
  deferred_budget_ms: 12_000,
  settle_ms: 200,
});
```

## Language servers

The fork discovers these installed servers; it never installs a server or
executes a repository-controlled binary without the inherited trust check.

| Languages | Server |
| --- | --- |
| TypeScript, JavaScript | `typescript-language-server` |
| Svelte | `svelteserver` |
| Python | `pyright-langserver` |
| Go | `gopls` |
| Rust | `rust-analyzer` |
| C, C++, Objective-C | `clangd` |
| Swift | `sourcekit-lsp` |
| Ruby | `solargraph` |
| Java | `jdtls` |
| Lua | `lua-language-server` |

Project-local binaries in `node_modules/.bin` are resolved before global
binaries. They are untrusted by default because repositories can control them.
Interactive sessions ask before execution; headless sessions skip them unless
`MY_PI_LSP_PROJECT_BINARY=allow` or `MY_PI_LSP_PROJECT_BINARY=trust` is set.
Language-server child processes receive a restricted environment. Additional
variables can be admitted through `MY_PI_LSP_ENV_ALLOWLIST` or the shared
`MY_PI_CHILD_ENV_ALLOWLIST`.

## Commands

```text
/lsp status
/lsp list
/lsp restart all
/lsp restart <language>
```

## Custom harness options

`create_lsp_extension` accepts callbacks for language detection, workspace-root
selection, server configuration, supported-language reporting, file-path
authorization, and returned-URI validation. The defaults confine tool targets
to the current working directory and definition/reference results to the
resolved workspace root. Normal Pi installations load the package entry
directly and do not need any workspace wrapper.

The package exports `CreateLspExtensionOptions`,
`CreateLspServerManagerOptions`, `LspServerConfig`, `LspClientLike`, mutation
diagnostic types, and diagnostic snapshot/wait types for custom harnesses.

## Development

```bash
pnpm install --ignore-scripts
pnpm run check
pnpm run test
pnpm run build
```

## Attribution

The original implementation is Copyright Scott Spence and contributors and is
used under the MIT License. See [NOTICE.md](NOTICE.md) for the fork baseline and
attribution details. See [UPSTREAM.md](UPSTREAM.md) for the agent-managed
upstream update and Git-refresh process.

## License

MIT
