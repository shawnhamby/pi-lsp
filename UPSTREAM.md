# Upstream maintenance

This repository is an agent-managed fork of
`spences10/my-pi/packages/pi-lsp`. It is not updated by blindly merging the
upstream monorepo or by replacing the installed package with the latest
`@spences10/pi-lsp` release.

## Authority

- `origin` is this standalone fork.
- `upstream-monorepo` is a read-only reference to `spences10/my-pi`.
- `NOTICE.md` records the last fully incorporated upstream package version.
- The live Pi configuration references this Git repository directly. Reviewed
  `main` is the release channel, and maintenance records the resolved SHA for
  verification and rollback.
- Generic package automation may report that either upstream changed, but it
  must not advance the fork baseline, push fork changes, or refresh the live
  checkout.

## Agent-managed update flow

1. Fetch `upstream-monorepo` without changing the working tree.
2. Compare only `packages/pi-lsp` since the baseline recorded in `NOTICE.md`.
   Ignore unrelated monorepo releases and tags.
3. Classify each upstream package change as already present, applicable,
   conflicting with the fork's diagnostic contract, or irrelevant.
4. Port applicable changes onto a dedicated fork branch. Prefer a small manual
   port or a focused cherry-pick whose diff is understandable; never merge the
   upstream monorepo history wholesale.
5. Preserve the fork invariants: one manager, bounded diagnostic latency,
   stale-result suppression, project-binary trust, restricted child
   environment, no automatic server installation, and custom harness seams.
6. Run the package's single admission gate: typecheck, the existing focused
   suite, build/package verification, and one Pi load smoke. Add a regression
   check only when an upstream change exposes a real uncovered failure.
7. Update `NOTICE.md` and `CHANGELOG.md`, review the cumulative fork diff, then
   land and push the fork commit.
8. In the Pi maintenance flow, stage the resolved fork `main` SHA as a normal
   direct Git plugin alongside the complete active extension graph. Push the
   accepted fork change, refresh Pi's Git package, and verify that the installed
   checkout matches that SHA; retain the prior SHA and upstream package identity
   for rollback.

Upstream discovery and live deployment are separate decisions. A newer
upstream version is input to an agent review, not authorization to update. The
plugin contains no updater or upstream-sync behavior.
