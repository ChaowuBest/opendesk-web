import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPackageWithOptions, statFile } from '@electron/asar';
import { setCustomOpendeskDirectory } from '../../../../../main/utils/setting.js';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-vec-extension-profile-'));
setCustomOpendeskDirectory(profile);
const {
    loadSqliteVec,
    resolveSqliteVecExtensionPath,
    SqliteVecLoadError,
    createWithNativeSqliteFallback,
    isNativeSqliteUnavailable
} = await import('../../../../../main/services/storage/platform.js');
after(() => fs.rmSync(profile, { recursive: true, force: true }));

test('maps packaged extension paths on macOS, Windows and Linux', () => {
    for (const [input, expected] of [
        [
            '/Applications/OpenDesk.app/Contents/Resources/app.asar/node_modules/sqlite-vec-darwin-arm64/vec0.dylib',
            '/Applications/OpenDesk.app/Contents/Resources/app.asar.unpacked/node_modules/sqlite-vec-darwin-arm64/vec0.dylib'
        ],
        [
            String.raw`D:\opendesk\resources\app.asar\node_modules\sqlite-vec-windows-x64\vec0.dll`,
            String.raw`D:\opendesk\resources\app.asar.unpacked\node_modules\sqlite-vec-windows-x64\vec0.dll`
        ],
        [
            '/opt/OpenDesk/resources/app.asar/node_modules/sqlite-vec-linux-x64/vec0.so',
            '/opt/OpenDesk/resources/app.asar.unpacked/node_modules/sqlite-vec-linux-x64/vec0.so'
        ]
    ]) {
        assert.equal(resolveSqliteVecExtensionPath(input), expected);
    }
});

test('preserves development, unpacked and similarly named directory paths', () => {
    for (const input of [
        '/project/node_modules/sqlite-vec-darwin-arm64/vec0.dylib',
        '/resources/app.asar.unpacked/node_modules/vec0.dylib',
        '/project/myapp.asar/node_modules/vec0.dylib',
        '/project/app.asar.backup/node_modules/vec0.dylib'
    ]) {
        assert.equal(resolveSqliteVecExtensionPath(input), input);
    }
});

test('loads the resolved development extension into the supplied database', () => {
    let loaded = '';
    loadSqliteVec({
        loadExtension(extensionPath: string) {
            loaded = extensionPath;
        }
    });
    assert.match(loaded, /vec0\.(dll|dylib|so)$/);
});

test('Forge unpack rule extracts each sqlite-vec platform library', async () => {
    // unpack 规则由 agent-runtime-unpack.cjs 按依赖闭包计算得出，不再是配置里的字面量，
    // 故直接 require 配置取值，而不是用正则去解析源码文本。
    const forgeConfig = createRequire(import.meta.url)('../../../../../../forge.config.cjs') as {
        packagerConfig: { asar: { unpack: string } };
    };
    const unpack = forgeConfig.packagerConfig.asar.unpack;
    assert.ok(unpack);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-vec-unpack-'));
    try {
        const libraries = [
            'sqlite-vec-windows-x64/vec0.dll',
            'sqlite-vec-darwin-arm64/vec0.dylib',
            'sqlite-vec-linux-x64/vec0.so'
        ];
        for (const library of libraries) {
            const target = path.join(root, 'source/node_modules', library);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, 'packaging fixture');
        }
        const archive = path.join(root, 'app.asar');
        await createPackageWithOptions(path.join(root, 'source'), archive, { unpack });
        for (const library of libraries) {
            assert.equal((statFile(archive, `node_modules/${library}`) as { unpacked?: boolean }).unpacked, true);
            assert.ok(fs.existsSync(path.join(`${archive}.unpacked`, 'node_modules', library)));
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('localized extension load errors retain their cause and trigger WASM fallback', async () => {
    for (const message of ['找不到指定的模块。', 'The specified module could not be found.']) {
        const cause = Object.assign(new Error(message), { code: 'SQLITE_ERROR' });
        let fallbackCalls = 0;
        const result = await createWithNativeSqliteFallback(
            async () => {
                try {
                    loadSqliteVec({
                        loadExtension() {
                            throw cause;
                        }
                    });
                } catch (error) {
                    assert.ok(error instanceof SqliteVecLoadError);
                    assert.equal(error.cause, cause);
                    assert.ok(error.message.includes(message));
                    throw error;
                }
                assert.fail('extension loading must fail');
            },
            async () => {
                fallbackCalls++;
                return 'wasm';
            },
            { forceWasm: false }
        );
        assert.equal(result, 'wasm');
        assert.equal(fallbackCalls, 1);
    }
});

test('extension path resolution failures receive the same error type', () => {
    const require = createRequire(import.meta.url);
    const sqliteVec = require('sqlite-vec') as typeof import('sqlite-vec');
    const original = sqliteVec.getLoadablePath;
    const cause = new Error('extension path unavailable');
    try {
        sqliteVec.getLoadablePath = () => {
            throw cause;
        };
        assert.throws(
            () =>
                loadSqliteVec({
                    loadExtension() {
                        assert.fail('must not load without a path');
                    }
                }),
            (error: unknown) => error instanceof SqliteVecLoadError && error.cause === cause
        );
    } finally {
        sqliteVec.getLoadablePath = original;
    }
});

test('the same unwrapped localized error outside extension loading does not trigger fallback', async () => {
    const cause = new Error('找不到指定的模块。');
    await assert.rejects(
        () =>
            createWithNativeSqliteFallback(
                async () => {
                    throw cause;
                },
                async () => {
                    assert.fail('unclassified errors must not trigger fallback');
                },
                { forceWasm: false }
            ),
        (error: unknown) => error === cause
    );
});

test('the wrapper message alone classifies the failure when instanceof cannot', () => {
    const wrapped = new SqliteVecLoadError(new Error('找不到指定的模块。'));
    assert.ok(isNativeSqliteUnavailable(new Error(wrapped.message)));
});
