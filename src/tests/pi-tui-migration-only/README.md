# pi-tui Migration-Only Test Matrix

This directory contains migration-only checks for the `pi-tui` dependency upgrade.
These files validate replacement-map completeness, before/after evidence, and migration closure rules.
They are intentionally not part of the regular Jest or node runner matrix.

Longer-running TUI behavior suites that are good candidates for future regression coverage live in
`src/tests/tui-regression/`, with runners in `scripts/tui-regression-tests/`.

Commands:

- `npm run test:pi-tui-migration:structure`: validates matrix structure and scenario coverage.
- `npm run test:pi-tui-migration`: validates structure, current migration gates, and behavior evidence.
- `npm run test:pi-tui-migration:behavior:baseline`: runs the PTY behavior matrix on the current dependency version and writes baseline evidence.
- `npm run test:pi-tui-migration:behavior:post`: runs the same PTY behavior matrix after migration and writes post-migration evidence.
- `npm run test:pi-tui-migration:behavior`: compares baseline and post-migration evidence.
- `npm run test:pi-tui-migration:channel-fixture`: installs a local no-network Channel plugin fixture into a temporary config directory and exercises `/channels list`, `/channels status`, `/plugins list`, `/plugins disable`, and `/plugins enable` through the real TUI.
- `npm run test:pi-tui-migration:mailbox-real`: with a local env file or environment variables, validates real mailbox connectivity and Mailbox TUI list/filter/sync/close flows through the real TUI.
- `npm run test:pi-tui-migration:acceptance`: runs the reviewer-requested blocking fake-model TUI acceptance gate for complex streamed output, dynamic resize, `/command` and `/skillname` autocomplete, shortcuts, and overlay focus.
- `npm run test:pi-tui-migration:acceptance:real`: optionally runs the minimal real-model complex streamed output smoke. It reads `OPENDESK_REVIEW_MODEL_BASE_URL`, `OPENDESK_REVIEW_MODEL_API_KEY`, and `OPENDESK_REVIEW_MODEL_NAME`, or `/tmp/opendesk-review-real-model.env`.

Policy:

- Static/API checks are not sufficient to claim TUI usability.
- Gate 4 to Gate 7 require real behavior evidence from a terminal or PTY harness.
- The behavior runner requires `dist/cli/opendesk-debug`; run `npm run build-cli` first.
- The automated runner is a no-external-service PTY smoke harness. It covers startup,
  rendering, editor keys, help/task overlays, app-entry open/close flows, focus return,
  and repeated crash-free execution.
- Deep application workflows that need real accounts or business data remain part of
  the matrix and must be recorded in `tui_migration_verification_record.md`.
- Real mailbox credentials must never be committed or pasted into chat. The mailbox
  E2E runner reads `OPENDESK_TEST_MAIL_EMAIL`, `OPENDESK_TEST_MAIL_AUTH_CODE`,
  and `OPENDESK_TEST_MAIL_PROTOCOL`, or `/tmp/opendesk-mail-test.env` by default.
  Raw PTY output is kept in a temporary directory and removed by default; repository
  evidence is redacted.
- Channel Manager has an additional local fixture E2E because real online plugins
  need business credentials. The fixture proves OpenDesk can load a channel plugin,
  show channel state, and toggle plugin enablement without relying on external services.
- review acceptance has an additional fake OpenAI-compatible model server because complex
  task rendering must be deterministic, cheap, and repeatable before the adapter is
  removed. The optional real-model smoke is supplemental evidence; failures there
  should be converted into deterministic fake-model regressions before changing the
  blocking gate.
- Gate 6 performs dynamic PTY resize inside the same running TUI process and requires
  both actual PTY dimensions and `PI_DEBUG_REDRAW` full-redraw evidence in the result
  JSON.
- Gate 6 uses `controlledTermination: true` after rendering assertions because the
  test leaves CJK/ANSI text in the editor and should not submit it to an LLM.
- A rule may not be marked `verified` only because code compiles.
- Migration-only checks in this directory can be deleted after migration closure if review owner decides the report evidence no longer needs to be regenerated.
- Stable behavior checks in `src/tests/tui-regression/` should be assessed separately before being moved into the regular matrix.
