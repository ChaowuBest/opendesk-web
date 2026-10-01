# Sandbox functional tests

This directory contains the native sandbox policy fixtures and command
fixtures used by the Windows integration tests. The Node test entry points are
`runtime.test.ts` and the env-gated `windows-sandbox-runtime.test.ts`; run
them from the repository root with:

```powershell
npx tsx --test native/windows/sandbox/tests/runtime.test.ts

$env:OPENDESK_SANDBOX_INTEGRATION = '1'   # required by windows-sandbox-runtime.test.ts
npx tsx --test native/windows/sandbox/tests/windows-sandbox-runtime.test.ts
```

The optional JavaScript fixture dependency is installed with:

```powershell
npm install --prefix native/windows/sandbox/tests --ignore-scripts
```

The Python fixture uses `python-pptx` and `numpy` from the active interpreter;
`requirements.txt` lists them. The test also verifies PptxGenJS (`pptxgenjs`);
the name `genpptxjs` is not published on npm.

The tests require Windows 10/11 and the sandbox runtime (`runtime/sandbox.exe`
plus `sandbox_hook.dll`, built by `node scripts/build-windows-sandbox.cjs`).
No driver or admin rights are needed (Detours implementation). They cover child
stdout/stderr forwarding, stdin, exit codes, authorization, Python scripts,
Node.js scripts, and Windows console commands such as `chcp`.

`runtime.test.ts`, `cross-shell-runtime.test.ts` and `sandbox-coverage.test.ts`
validate the Detours implementation. OpenDesk integration tests remain under
`src/tests/ut/terminal/`.
