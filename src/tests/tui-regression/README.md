# TUI Regression Candidate Tests

This directory contains TUI behavior scenarios that are good candidates for a future regular regression matrix.
They remain isolated for now because they require a built CLI, PTY behavior, optional credentials, or longer-running fake-model flows.

Runner scripts live in `scripts/tui-regression-tests/`.

Suites:

- `behavior-smoke-scenarios.json`: Gate 4-7 PTY behavior scenarios for input, overlays, app entrypoints, resizing, and crash-free repeated runs.
- `acceptance-scenarios.json`: reviewer-requested complex task UI, resize, autocomplete, shortcut, and overlay acceptance scenarios.
- `current-state-gates.test.mjs`: static and build-output gates that protect the migrated pi-tui dependency, direct imports, native helper packaging, and Shift+Enter multiline behavior.
