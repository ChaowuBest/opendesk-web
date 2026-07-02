import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setCustomOpendeskDirectory } from '../../../../../main/utils/setting.js';
import type { logger as Logger } from '../../../../../main/utils/logger.js';
import type * as StoragePlatform from '../../../../../main/services/storage/platform.js';

const isolatedOpendeskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-platform-test-'));
setCustomOpendeskDirectory(isolatedOpendeskDir);

let createWithNativeSqliteFallback: typeof StoragePlatform.createWithNativeSqliteFallback;
let isNativeSqliteUnavailable: typeof StoragePlatform.isNativeSqliteUnavailable;
let logger: typeof Logger;

async function loadModules(): Promise<void> {
    const platform = await import('../../../../../main/services/storage/platform.js');
    const loggerModule = await import('../../../../../main/utils/logger.js');
    createWithNativeSqliteFallback = platform.createWithNativeSqliteFallback;
    isNativeSqliteUnavailable = platform.isNativeSqliteUnavailable;
    logger = loggerModule.logger;
}

function captureLogs(): { infos: string[]; warns: string[]; restore: () => void } {
    const infos: string[] = [];
    const warns: string[] = [];
    const originalInfo = logger.info.bind(logger);
    const originalWarn = logger.warn.bind(logger);
    (logger as any).info = (msg: string) => infos.push(msg);
    (logger as any).warn = (msg: string) => warns.push(msg);
    return {
        infos,
        warns,
        restore: () => {
            (logger as any).info = originalInfo;
            (logger as any).warn = originalWarn;
        }
    };
}

async function testLogsNativeSuccess(): Promise<void> {
    const capture = captureLogs();
    try {
        const result = await createWithNativeSqliteFallback(
            async () => 'native-result',
            async () => 'wasm-result',
            { forceWasm: false }
        );
        assert.equal(result, 'native-result');
        assert.ok(
            capture.infos.some((m) => m.includes('[storage-backend] using native')),
            `expected a 'using native' info log, got: ${JSON.stringify(capture.infos)}`
        );
    } finally {
        capture.restore();
    }
    console.log('  ✅ testLogsNativeSuccess');
}

async function testLogsForcedWasm(): Promise<void> {
    const capture = captureLogs();
    try {
        const result = await createWithNativeSqliteFallback(
            async () => 'native-result',
            async () => 'wasm-result',
            { forceWasm: true }
        );
        assert.equal(result, 'wasm-result');
        assert.ok(
            capture.infos.some((m) => m.includes('[storage-backend] using wasm (platform forced)')),
            `expected a forced-wasm info log, got: ${JSON.stringify(capture.infos)}`
        );
    } finally {
        capture.restore();
    }
    console.log('  ✅ testLogsForcedWasm');
}

async function testLogsFallbackWithOriginalErrorAndThrownString(): Promise<void> {
    const capture = captureLogs();
    try {
        const result = await createWithNativeSqliteFallback(
            async () => {
                const err: any = new Error('Could not locate the bindings file');
                err.code = 'MODULE_NOT_FOUND';
                throw err;
            },
            async () => 'wasm-result',
            { forceWasm: false }
        );
        assert.equal(result, 'wasm-result');
        assert.ok(
            capture.warns.some(
                (m) =>
                    m.includes('[storage-backend] native unavailable, falling back to wasm') &&
                    m.includes('MODULE_NOT_FOUND') &&
                    m.includes('Could not locate the bindings file')
            ),
            `expected a fallback warn log containing the original error, got: ${JSON.stringify(capture.warns)}`
        );

        capture.warns.length = 0;
        const stringResult = await createWithNativeSqliteFallback(
            async () => {
                throw 'sqlite-vec extension missing';
            },
            async () => 'wasm-result',
            { forceWasm: false }
        );
        assert.equal(stringResult, 'wasm-result');
        assert.ok(
            capture.warns.some(
                (m) =>
                    m.includes('[storage-backend] native unavailable, falling back to wasm') &&
                    m.includes('code=') &&
                    m.includes('message=sqlite-vec extension missing')
            ),
            `expected a fallback warn log containing the thrown string, got: ${JSON.stringify(capture.warns)}`
        );
    } finally {
        capture.restore();
    }
    console.log('  ✅ testLogsFallbackWithOriginalErrorAndThrownString');
}

async function testNonSqliteErrorStillThrowsAndIsNotLoggedAsFallback(): Promise<void> {
    const capture = captureLogs();
    try {
        await assert.rejects(
            () =>
                createWithNativeSqliteFallback(
                    async () => {
                        throw new Error('totally unrelated failure');
                    },
                    async () => 'wasm-result',
                    { forceWasm: false }
                ),
            /totally unrelated failure/
        );
        assert.ok(!capture.warns.some((m) => m.includes('[storage-backend]')));
    } finally {
        capture.restore();
    }
    console.log('  ✅ testNonSqliteErrorStillThrowsAndIsNotLoggedAsFallback');
}

async function testIsNativeSqliteUnavailableUnchanged(): Promise<void> {
    assert.equal(isNativeSqliteUnavailable(new Error('better_sqlite3.node missing')), true);
    assert.equal(isNativeSqliteUnavailable(new Error('totally unrelated')), false);
    console.log('  ✅ testIsNativeSqliteUnavailableUnchanged');
}

async function main(): Promise<void> {
    await loadModules();
    assert.ok(
        fs.existsSync(path.join(isolatedOpendeskDir, 'logs', 'app.log')),
        'logger should initialize its file transport under the isolated OpenDesk directory'
    );
    console.log('=== platform.ts backend logging tests ===\n');
    const tests = [
        testLogsNativeSuccess,
        testLogsForcedWasm,
        testLogsFallbackWithOriginalErrorAndThrownString,
        testNonSqliteErrorStillThrowsAndIsNotLoggedAsFallback,
        testIsNativeSqliteUnavailableUnchanged
    ];
    let passed = 0,
        failed = 0;
    for (const test of tests) {
        try {
            await test();
            passed++;
        } catch (e: any) {
            console.error(`  FAIL ${test.name}: ${e.message}`);
            failed++;
        }
    }
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
    console.error('Fatal error:', e);
    process.exit(1);
});
