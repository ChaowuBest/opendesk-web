#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const structureOnly = process.argv.includes('--structure-only');

const tests = structureOnly
    ? ['src/tests/pi-tui-migration/matrix-structure.test.mjs']
    : [
          'src/tests/pi-tui-migration/matrix-structure.test.mjs',
          'src/tests/pi-tui-migration/current-state-gates.test.mjs',
          'src/tests/pi-tui-migration/behavior-evidence.test.mjs'
      ];

const child = spawn(process.execPath, ['--test', ...tests], {
    cwd: repoRoot,
    stdio: 'inherit'
});

child.on('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code ?? 1);
});
