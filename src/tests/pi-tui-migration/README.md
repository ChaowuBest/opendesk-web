# pi-tui Migration Test Matrix

This directory contains the isolated test matrix for the `pi-tui` dependency upgrade.
It is intentionally not part of the regular Jest or node runner matrix.

Commands:

- `npm run test:pi-tui-migration:structure`: validates matrix structure and scenario coverage.
- `npm run test:pi-tui-migration`: validates structure, current migration gates, and behavior evidence.
- `npm run test:pi-tui-migration:behavior:baseline`: runs the PTY behavior matrix on the current dependency version and writes baseline evidence.
- `npm run test:pi-tui-migration:behavior:post`: runs the same PTY behavior matrix after migration and writes post-migration evidence.
- `npm run test:pi-tui-migration:behavior`: compares baseline and post-migration evidence.

Policy:

- Static/API checks are not sufficient to claim TUI usability.
- Gate 4 to Gate 7 require real behavior evidence from a terminal or PTY harness.
- The behavior runner requires `dist/cli/opendesk-debug`; run `npm run build-cli` first.
- The automated runner is a no-external-service PTY smoke harness. It covers startup,
  rendering, editor keys, help/task overlays, app-entry open/close flows, focus return,
  and repeated crash-free execution.
- Deep application workflows that need real accounts or business data remain part of
  the matrix and must be recorded in `tui_migration_verification_record.md`.
- Gate 6 uses `controlledTermination: true` after rendering assertions because the
  test leaves CJK/ANSI text in the editor and should not submit it to an LLM.
- A rule may not be marked `verified` only because code compiles.
- These tests must remain isolated until a separate assessment moves stable cases into the regular matrix.
