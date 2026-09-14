# Sandbox functional tests

This directory contains the native sandbox policy fixtures and command
fixtures used by the Windows integration tests. The Node test entry point is
`runtime.test.ts`; run it from the repository root with:

```powershell
npx tsx --test native/windows/sandbox/tests/runtime.test.ts
```

The optional JavaScript fixture dependency is installed with:

```powershell
npm install --prefix native/windows/sandbox/tests --ignore-scripts
```

The Python fixture uses `python-pptx` and `numpy` from the active interpreter;
`requirements.txt` lists them. The test also verifies PptxGenJS (`pptxgenjs`);
the name `genpptxjs` is not published on npm.

The tests require Windows and an installed Dokany driver. They cover child
stdout/stderr forwarding, stdin, exit codes, authorization, Python scripts,
Node.js scripts, and Windows console commands such as `chcp`.

`runtime.test.ts` and `NativeRegression/` validate the standalone Dynobox
implementation. OpenDesk integration tests remain under `src/tests/ut/terminal/`.
