# pi-lsp standalone fork plan

## Goal

Turn the extracted `@spences10/pi-lsp` package into a standalone Pi extension
that preserves its strong navigation, process isolation, and project-binary
trust behavior while adding fast, low-noise diagnostics after supported file
mutations.

The extension should feel like the useful part of OMP's integrated LSP:
diagnostics arrive with the edit result when they are fast, arrive later when
the server is still working, and never report an older file version as current.
It must remain an extension, not a second coding harness or a replacement for
repository lint, typecheck, and test commands.

## Baseline

- Source baseline: `@spences10/pi-lsp@0.0.44`, extracted with history from
  `spences10/my-pi/packages/pi-lsp`.
- Pi target: `@earendil-works/pi-coding-agent` 0.84.x.
- Existing capabilities retained: diagnostics, batched diagnostics, hover,
  definitions, implementations, references, document/workspace symbols,
  preview-only rename, server status/restart, idle shutdown, restricted child
  environments, and confirmation before running an untrusted project-local
  language-server binary.
- Existing architecture retained: one manager and at most one server process
  per language/workspace within a Pi session.

## Decisions

1. **One extension and one server manager.** Do not stack `pi-lsp-lite`, a
   second diagnostic watcher, or another language-server process.
2. **Bounded inline work.** A mutation may wait at most 500 ms for useful
   diagnostics. The extension then returns the original tool result without
   delay.
3. **Deferred diagnostics.** Work that misses the inline budget may continue
   for up to 12 seconds. A fresh, non-empty result is delivered as a visible
   custom Pi message without starting another agent turn.
4. **Freshness before speed.** Every mutation gets a monotonically increasing
   per-file version. A newer mutation cancels or suppresses every older pending
   result for that file.
5. **Notify before checking.** Running servers receive
   `workspace/didChangeWatchedFiles` for harness-authored creates, changes, and
   deletes. The directly changed document is also synchronized through
   `didOpen`/`didChange` before diagnostics are accepted.
6. **Quiet defaults.** Match OMP's current default policy: diagnostics after
   `write` are on; diagnostics after `edit` are off until explicitly enabled.
   Clean results do not add transcript noise. We can enable edit diagnostics in
   a consumer profile only after measuring acceptable latency.
7. **No automatic installation.** The extension detects configured server
   binaries and explains what is missing; it never downloads or installs a
   language server.
8. **Repository gates remain authoritative.** Inline LSP is a fast feedback
   layer. The agent still uses the repository's normal lint, typecheck, build,
   and test gates at the appropriate completion boundary.

## Phase 1: make the extracted package genuinely standalone

- Rename the package and repository metadata for the standalone fork while
  preserving upstream attribution and MIT licensing.
- Replace monorepo-only `workspace:*` and `catalog:` dependency declarations
  with published compatible versions.
- Replace monorepo-only Vite+ scripts with ordinary package-local build,
  typecheck, and focused test commands.
- Add a lockfile, public-safe ignore rules, license/notice files, and a README
  that distinguishes the upstream baseline from this fork's additions.
- Keep `upstream-monorepo` as a read-only reference. Upstream synchronization is
  a deliberate package-diff/cherry-pick operation; do not add subtree or
  generated-sync machinery until repeated updates prove it is needed.

Acceptance: a clean checkout installs, typechecks, builds, and loads in Pi
0.84.x without any file from the original monorepo.

## Phase 2: server configuration and coverage

- Replace the fixed one-server-per-language table with a small validated
  configuration layer while keeping secure defaults.
- Preserve project-local binary trust prompts and the restricted child
  environment.
- Support exact custom-harness server definitions and policy callbacks without
  changing the normal direct-plugin load path.
- Ship sensible public defaults for the high-value server families already in
  the upstream package, then add:
  - Python: Pyright first, `pylsp` as an explicit alternative;
  - C, C++, and Objective-C: `clangd`;
  - Swift: `sourcekit-lsp`.
- Keep TypeScript/JavaScript, Svelte, Go, Rust, Ruby, Java, and Lua support.
- Select exactly one configured server for a language/workspace. Never start
  competing Python or TypeScript servers implicitly.

Acceptance: server selection is deterministic, missing binaries are harmless,
and custom harnesses can narrow the public catalog without forking the manager.

### F-012: native TypeScript ownership and semantic operations

- Use trusted project-local `tsc --lsp --stdio` when available and the same
  native compiler command globally. Surface the compiler's unsupported `--lsp`
  error clearly when a project pins an older TypeScript version; do not add
  `typescript-language-server` or start a second process as a fallback.
- Keep project-local Pyright under the existing binary-trust decision. For the
  global default, resolve the executable from `pnpm bin --global` and verify
  that its shim target belongs to the pnpm-global Pyright package. Do not fall
  through to a duplicate shared-venv executable on `PATH`.
- Add `textDocument/implementation` and `workspace/symbol` through the existing
  lazy client and manager.
- Add rename preview through `textDocument/prepareRename` followed by
  `textDocument/rename`. Accept only `file:` text edits whose targets remain
  inside the selected workspace, reject resource operations, and never apply
  the returned edits.

Acceptance: one lazy manager still owns at most one server per
language/workspace; project binaries remain trust-gated; child environments
remain restricted; missing or incompatible servers fail without installation;
and rename is a read-only preview across in-root files.

## Phase 3: fast mutation diagnostics

### Mutation intake

- Observe successful Pi `write` and `edit` tool results.
- Ignore failed tools, unsupported files, and paths outside the active
  workspace.
- Normalize paths once and assign the new per-file mutation version before any
  asynchronous work begins.

### Server synchronization

- Announce created, changed, or deleted files to every already-running server
  whose workspace contains the path.
- Open or update the directly mutated document with its current on-disk text.
- Snapshot existing diagnostics for the target and any affected open files.

### Result timing

- Wait for diagnostic publications to settle briefly rather than accepting the
  first partial publication. Start with a 200 ms quiescence window inside the
  500 ms inline budget.
- If fresh diagnostics settle in time, append only new or changed errors and
  warnings to the tool result.
- If they do not settle, return the tool result immediately and continue under
  the 12-second deferred budget.
- Deliver a deferred result only when its file version is still current and it
  adds useful information. Delivery must not trigger an autonomous model turn.

### Noise control

- Deduplicate by file, range, severity, code, source, and message.
- Report cross-file diagnostics only when they changed after the mutation.
- Do not emit a message for clean, unsupported, superseded, or ordinary timeout
  results.
- Preserve explicit `lsp_diagnostics` and `lsp_diagnostics_many` tools for
  requested checks and final changed-file sweeps.

Acceptance: slow servers cannot hold a mutation result beyond 500 ms; a second
edit suppresses the first edit's late result; clean edits stay silent; and a
late diagnostic appears once without starting a new turn.

## Phase 4: direct Pi integration

- Install this repository as a normal Pi Git plugin and let Pi load its declared
  package entry directly. Do not add a workspace loader or adapter.
- Switch Pi atomically from the upstream package to this fork. Never load both.
- Treat reviewed fork `main` as the Git release channel. The dedicated Pi
  maintenance workflow resolves and stages its exact SHA, pushes accepted fork
  changes, refreshes Pi's Git checkout, verifies the installed SHA, and retains
  the prior SHA plus upstream package identity for rollback.
- Keep inline diagnostics separate from the advisor: LSP reports deterministic
  compiler/server facts; the advisor may interpret them but does not run or
  duplicate LSP checks.
- Keep orchestration separate from Herdr. Each visible runtime session owns its
  own manager; Herdr may expose session status, but it does not broker or share
  language-server processes in the first release.

Acceptance: one Pi session loads one direct Git LSP plugin and can roll back
without changing project files.

## Verification kept intentionally small

Retain the upstream focused tests and add only behavior that protects the new
contract:

- watched-file notification and direct document synchronization;
- 500 ms inline cutoff and 12-second deferred cutoff;
- stale-result suppression after a second mutation;
- diagnostic deduplication and clean-result silence;
- deferred delivery does not trigger another agent turn;
- project-local binary trust and restricted environment still hold.
- native TypeScript startup failure and canonical pnpm-global Pyright selection;
- implementation/workspace-symbol URI confinement and rename-preview edit
  confinement, resource-operation rejection, and no-write behavior.

Run one TypeScript and one Python live smoke after package-level checks. Broader
language matrices are server-admission work, not a prerequisite for the inline
diagnostic mechanism.

## Deferred work

- shared LSP daemons across Pi or Herdr sessions;
- format-on-write;
- automatic code actions or rename application;
- debugger (DAP) integration;
- language-server installation;
- a broad structural/AST editing layer.

These can be reconsidered only after the core diagnostic path is reliable and a
real workflow gap remains.

## References

- Upstream package: <https://github.com/spences10/my-pi/tree/main/packages/pi-lsp>
- OMP settings and defaults: <https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md>
- OMP deferred diagnostics: <https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/lsp/deferred-diagnostics.ts>
- OMP diagnostic deduplication: <https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/lsp/diagnostics-ledger.ts>
- OMP watched-file freshness fix: <https://github.com/can1357/oh-my-pi/pull/4462>
- `pi-lsp-lite` mutation flow and quiescence reference: <https://github.com/mcphailtom/pi-lsp-lite/blob/main/docs/ARCHITECTURE.md>
