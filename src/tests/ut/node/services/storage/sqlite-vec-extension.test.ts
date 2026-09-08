import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPackageWithOptions, statFile } from '@electron/asar';
import { setCustomOpendeskDirectory } from '../../../../../main/utils/setting.js';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-vec-extension-profile-'));
setCustomOpendeskDirectory(profile);
const { loadSqliteVec, resolveSqliteVecExtensionPath } =
    await import('../../../../../main/services/storage/platform.js');
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
    const config = fs.readFileSync(new URL('../../../../../../forge.config.cjs', import.meta.url), 'utf8');
    const unpack = config.match(/unpack: '([^']+)'/)?.[1];
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
