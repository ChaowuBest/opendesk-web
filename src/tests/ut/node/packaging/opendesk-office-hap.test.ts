import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const require = createRequire(import.meta.url);
const { assertOpenDeskOfficeHapPayload, getOpenDeskOfficePrebundledPackages } =
    require('@bitclub.ai/opendesk-office/hap') as {
        assertOpenDeskOfficeHapPayload(appDir: string): void;
        getOpenDeskOfficePrebundledPackages(): string[];
    };
const manifestPath = require.resolve('@bitclub.ai/opendesk-office/hap-manifest');

const { stageOpenDeskOfficeForOhos } = require(path.join(projectRoot, 'scripts/stage-opendesk-office-ohos.cjs')) as {
    stageOpenDeskOfficeForOhos(appDir: string): void;
};

async function createFakePayload(): Promise<{ appDir: string; cleanup(): Promise<void> }> {
    const appDir = await mkdtemp(path.join(os.tmpdir(), 'opendesk-opendesk-office-hap-'));
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { runtimePackages: string[] };

    await mkdir(path.join(appDir, 'dist/preload'), { recursive: true });
    await mkdir(path.join(appDir, 'dist/renderer/assets'), { recursive: true });
    await mkdir(path.join(appDir, 'dist/main/chunks'), { recursive: true });
    await writeFile(path.join(appDir, 'dist/main/ohos-compat.js'), 'export {};');
    await writeFile(path.join(appDir, 'dist/preload/slidesPreload.js'), 'module.exports = {};');
    await writeFile(
        path.join(appDir, 'dist/renderer/slides_editor.html'),
        '<script type="module" src="./assets/slides-entry.js"></script>'
    );
    await writeFile(path.join(appDir, 'dist/renderer/assets/slides-entry.js'), 'export {};');
    await writeFile(path.join(appDir, 'dist/main/chunks/harfbuzz-test.wasm'), new Uint8Array([0]));

    for (const packageName of manifest.runtimePackages) {
        await mkdir(path.join(appDir, 'node_modules', packageName), { recursive: true });
        await writeFile(
            path.join(appDir, 'node_modules', packageName, 'package.json'),
            JSON.stringify({ name: packageName })
        );
    }

    return {
        appDir,
        cleanup: () => rm(appDir, { recursive: true, force: true })
    };
}

test('HAP payload validation accepts the complete Slides editor runtime', async () => {
    const payload = await createFakePayload();
    try {
        assert.doesNotThrow(() => assertOpenDeskOfficeHapPayload(payload.appDir));
    } finally {
        await payload.cleanup();
    }
});

test('HAP packaging excludes the prebundled Slides package from the npm runtime closure', () => {
    assert.deepEqual(getOpenDeskOfficePrebundledPackages(), ['@bitclub.ai/opendesk-office']);
});

test('PPT stage only overlays release output after the official OHOS sync', async () => {
    const payload = await createFakePayload();
    try {
        stageOpenDeskOfficeForOhos(payload.appDir);
        const staged = await stat(path.join(payload.appDir, 'dist/preload/slidesPreload.js'));
        assert.ok(staged.size > 0);
        assert.doesNotThrow(() => assertOpenDeskOfficeHapPayload(payload.appDir));
    } finally {
        await payload.cleanup();
    }
});

test('the baseline OHOS packaging script remains independent of the PPT feature', async () => {
    const baselineScript = await readFile(path.join(projectRoot, 'scripts/package-ohos.cjs'), 'utf8');
    assert.doesNotMatch(baselineScript, /GenOffice|genoffice/i);
});

test('HAP payload validation fails when the HarfBuzz WASM is absent', async () => {
    const payload = await createFakePayload();
    try {
        await unlink(path.join(payload.appDir, 'dist/main/chunks/harfbuzz-test.wasm'));
        assert.throws(() => assertOpenDeskOfficeHapPayload(payload.appDir), /harfbuzz-\*\.wasm/);
    } finally {
        await payload.cleanup();
    }
});

test('HAP payload validation fails when the Slides preload is absent', async () => {
    const payload = await createFakePayload();
    try {
        await rm(path.join(payload.appDir, 'dist/preload/slidesPreload.js'), { force: true });
        assert.throws(() => assertOpenDeskOfficeHapPayload(payload.appDir), /slidesPreload\.js/);
    } finally {
        await payload.cleanup();
    }
});
