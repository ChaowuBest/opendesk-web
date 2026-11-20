import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

function runFreshScenario(source: string): Record<string, unknown> {
    // Resource caches must start empty: other suites and the test runner may already import business modules.
    const environment = { ...process.env };
    delete environment.OPENDESK_CONFIG_DIRECTORY;
    delete environment.OPENDDESK_CONFIG_DIRECTORY;
    const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--import', './src/tests/test-env.ts', '--input-type=module', '-'],
        { cwd: repositoryRoot, env: environment, input: source, encoding: 'utf8', timeout: 15_000 }
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    const result = child.stdout.split('\n').find((line) => line.startsWith('RESOURCE_RESULT '));
    assert.ok(result, `Missing scenario result: ${child.stdout}\n${child.stderr}`);
    return JSON.parse(result.slice('RESOURCE_RESULT '.length));
}

test('a real spreadsheet is parsed on retry after temporary host resource failure', () => {
    const result = runFreshScenario(`
        import fs from 'node:fs';
        import os from 'node:os';
        import path from 'node:path';
        import { createRequire } from 'node:module';
        import { configureHostRuntime } from './src/platforms/runtime.ts';
        const XLSX = createRequire(import.meta.url)('xlsx');
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spreadsheet-resource-retry-'));
        const filePath = path.join(directory, 'valid.xlsx');
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['resource recovery', 42]]), 'Sheet');
        XLSX.writeFile(workbook, filePath);
        let prepareCalls = 0;
        const restore = configureHostRuntime({ prepareResource: async (resource) => {
            if (resource !== 'spreadsheet-parser') return;
            prepareCalls++;
            if (prepareCalls === 1) throw new Error('resource not ready yet');
        }});
        try {
            const { extractText } = await import('./src/main/applications/filemgr/parser/extract.js');
            const first = await extractText(filePath);
            const retry = await Promise.all([extractText(filePath), extractText(filePath)]);
            console.log('RESOURCE_RESULT ' + JSON.stringify({ first, retry, prepareCalls }));
        } finally {
            restore();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    `);
    assert.equal(result.first, null);
    assert.deepEqual(result.retry, ['1\tresource recovery\t42', '1\tresource recovery\t42']);
    assert.equal(result.prepareCalls, 2);
});

test('code rendering retries highlighting in the background while preserving plain fallback and single-flight loading', () => {
    const result = runFreshScenario(`
        import { setTimeout as delay } from 'node:timers/promises';
        import { configureHostRuntime } from './src/platforms/runtime.ts';
        let prepareCalls = 0;
        let release;
        const ready = new Promise((resolve) => { release = resolve; });
        const restore = configureHostRuntime({ prepareResource: async (resource) => {
            if (resource !== 'syntax-highlighting') return;
            prepareCalls++;
            if (prepareCalls === 1) throw new Error('resource not ready yet');
            await ready;
        }});
        try {
            const { parseMarkdownSafe } = await import('./src/main/aikernel/messages.ts');
            await delay(0);
            const code = '\u0060\u0060\u0060javascript\\nconst answer = 42;\\n\u0060\u0060\u0060';
            const first = await parseMarkdownSafe(code);
            const second = await parseMarkdownSafe(code);
            const callsWhilePending = prepareCalls;
            release();
            let recovered = '';
            if (callsWhilePending === 2) {
                const deadline = Date.now() + 5000;
                while (Date.now() < deadline) {
                    await delay(10);
                    recovered = await parseMarkdownSafe(code);
                    if (recovered.includes('hljs-keyword')) break;
                }
            }
            console.log('RESOURCE_RESULT ' + JSON.stringify({
                firstPlain: first.includes('const answer = 42;') && !first.includes('hljs-keyword'),
                secondPlain: second.includes('const answer = 42;') && !second.includes('hljs-keyword'),
                callsWhilePending, recovered: recovered.includes('hljs-keyword'), prepareCalls
            }));
        } finally { restore(); }
    `);
    assert.equal(result.firstPlain, true);
    assert.equal(result.secondPlain, true);
    assert.equal(result.callsWhilePending, 2);
    assert.equal(result.recovered, true);
    assert.equal(result.prepareCalls, 2);
});
