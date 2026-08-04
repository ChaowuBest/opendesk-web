import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const require = createRequire(import.meta.url);
const { assertGenOfficeSlidesHapPayload, getGenOfficeSlidesPrebundledPackages } = require(
    path.join(projectRoot, 'vendor/genoffice/src/hap.cjs')
) as {
    assertGenOfficeSlidesHapPayload(appDir: string): void;
    getGenOfficeSlidesPrebundledPackages(): string[];
};

const { stageGenOfficeSlidesForOhos } = require(path.join(projectRoot, 'scripts/stage-genoffice-slides-ohos.cjs')) as {
    stageGenOfficeSlidesForOhos(appDir: string): void;
};

async function createFakePayload(): Promise<{ appDir: string; cleanup(): Promise<void> }> {
    const appDir = await mkdtemp(path.join(os.tmpdir(), 'opendesk-genoffice-hap-'));
    const manifest = JSON.parse(
        await readFile(path.join(projectRoot, 'vendor/genoffice/hap-manifest.json'), 'utf8')
    ) as { runtimePackages: string[] };

    await mkdir(path.join(appDir, 'dist/preload'), { recursive: true });
    await mkdir(path.join(appDir, 'dist/renderer/assets'), { recursive: true });
    await mkdir(path.join(appDir, 'dist/main/chunks'), { recursive: true });
    await writeFile(path.join(appDir, 'dist/main/ohos-compat.js'), 'export {};');
    await writeFile(path.join(appDir, 'dist/main/genoffice-gsk.cjs'), 'module.exports = {};');
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
        assert.doesNotThrow(() => assertGenOfficeSlidesHapPayload(payload.appDir));
    } finally {
        await payload.cleanup();
    }
});

test('HAP packaging excludes the prebundled Slides package from the npm runtime closure', () => {
    assert.deepEqual(getGenOfficeSlidesPrebundledPackages(), ['@opendesk/genoffice-slides']);
});

test('PPT stage only overlays release output after the official OHOS sync', async () => {
    const payload = await createFakePayload();
    try {
        stageGenOfficeSlidesForOhos(payload.appDir);
        const staged = await stat(path.join(payload.appDir, 'dist/main/genoffice-gsk.cjs'));
        assert.ok(staged.size > 0);
        assert.doesNotThrow(() => assertGenOfficeSlidesHapPayload(payload.appDir));
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
        assert.throws(() => assertGenOfficeSlidesHapPayload(payload.appDir), /harfbuzz-\*\.wasm/);
    } finally {
        await payload.cleanup();
    }
});

test('HAP payload validation fails when the bundled Genspark CLI is absent', async () => {
    const payload = await createFakePayload();
    try {
        await rm(path.join(payload.appDir, 'dist/main/genoffice-gsk.cjs'), { force: true });
        assert.throws(() => assertGenOfficeSlidesHapPayload(payload.appDir), /genoffice-gsk\.cjs/);
    } finally {
        await payload.cleanup();
    }
});
