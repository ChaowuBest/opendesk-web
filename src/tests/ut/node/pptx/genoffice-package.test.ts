import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

const GENOFFICE_ONLY_RUNTIME_PACKAGES = [
    '@genspark/cli',
    'bidi-js',
    'fast-xml-parser',
    'harfbuzzjs',
    'jszip',
    'konva',
    'opentype.js',
    'pdfjs-dist',
    'pngjs',
    'react',
    'react-dom',
    'react-konva',
    'utif2'
];

test('GenOffice Slides exposes an npm-like host package boundary', async () => {
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'vendor/genoffice/package.json'), 'utf8')) as {
        name: string;
        exports: Record<string, string>;
    };

    assert.equal(packageJson.name, '@opendesk/genoffice-slides');
    assert.equal(packageJson.exports['./main'], './dist/main.js');
    assert.equal(packageJson.exports['./preload'], './src/preload.ts');
    assert.equal(packageJson.exports['./renderer'], './src/renderer.ts');
    assert.equal(packageJson.exports['./vite'], './src/vite.ts');
    assert.equal(packageJson.exports['./hap'], './src/hap.cjs');
    assert.equal(packageJson.exports['./hap-manifest'], './hap-manifest.json');

    const hostAdapter = await readFile(path.join(projectRoot, 'src/main/office/genofficeSlidesHost.ts'), 'utf8');
    const rendererEntry = await readFile(path.join(projectRoot, 'src/renderer/slidesEditorEntry.ts'), 'utf8');

    assert.doesNotMatch(hostAdapter, /from '@opendesk\/genoffice-slides\/main'/);
    assert.doesNotMatch(hostAdapter, /@opendesk\/genoffice-slides/);
    assert.match(hostAdapter, /import\('@opendesk-slides\/main'\)/);
    assert.match(hostAdapter, /slides-host:prepare/);
    assert.doesNotMatch(rendererEntry, /@opendesk\/genoffice-slides/);
    assert.match(rendererEntry, /from '@opendesk-slides\/renderer'/);
    assert.doesNotMatch(hostAdapter, /vendor\/genoffice\/apps\/slides/);
    assert.doesNotMatch(rendererEntry, /vendor\/genoffice\/apps\/slides/);
});

test('GenOffice-only dependencies are owned by the embedded package, not the host', async () => {
    const hostPackage = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>;
    };
    const slidesPackage = JSON.parse(
        await readFile(path.join(projectRoot, 'vendor/genoffice/package.json'), 'utf8')
    ) as {
        dependencies: Record<string, string>;
    };

    for (const packageName of GENOFFICE_ONLY_RUNTIME_PACKAGES) {
        assert.equal(
            hostPackage.dependencies[packageName],
            undefined,
            `${packageName} must not expand the host HAP dependency closure`
        );
        assert.ok(
            slidesPackage.dependencies[packageName],
            `${packageName} must be declared by @opendesk/genoffice-slides`
        );
    }
});

test('GenOffice Slides declares every HAP runtime dependency and asset', async () => {
    const manifest = JSON.parse(
        await readFile(path.join(projectRoot, 'vendor/genoffice/hap-manifest.json'), 'utf8')
    ) as {
        artifacts: string[];
        prebundledPackages: string[];
        runtimePackages: string[];
        wasmAssets: string[];
    };

    assert.deepEqual(manifest.artifacts.sort(), [
        'dist/main/genoffice-gsk.cjs',
        'dist/preload/slidesPreload.js',
        'dist/renderer/slides_editor.html'
    ]);
    assert.deepEqual(manifest.wasmAssets, ['dist/main/chunks/harfbuzz-*.wasm']);

    for (const releasePath of [...manifest.artifacts, ...manifest.wasmAssets]) {
        assert.match(releasePath, /^dist\//);
        assert.doesNotMatch(releasePath, /(?:^|\/)(?:src|test|tests|vendor)(?:\/|$)/);
    }

    assert.deepEqual(manifest.runtimePackages, []);
    assert.deepEqual(manifest.prebundledPackages, ['@opendesk/genoffice-slides']);
});

test('GenOffice main dependencies are isolated from the host build policy', async () => {
    const viteConfig = await readFile(path.join(projectRoot, 'electron.vite.config.ts'), 'utf8');
    const genOfficeVite = await readFile(path.join(projectRoot, 'vendor/genoffice/src/vite.ts'), 'utf8');

    assert.match(viteConfig, /genOfficeSlidesMainBuildPlugin/);
    assert.match(viteConfig, /plugins:\s*\[genOfficeSlidesMainBuildPlugin/);
    assert.match(viteConfig, /genoffice-slides-main/);
    assert.match(viteConfig, /vendor\/genoffice\/dist\/main\.js/);
    assert.doesNotMatch(viteConfig, /externalizeDeps:\s*false/);
    assert.doesNotMatch(viteConfig, /externalizeDeps:\s*\{\s*exclude:/);
    assert.doesNotMatch(viteConfig, /esmShimBoundaryPlugin|ohos-bootstrap\.ts|OPENDESK_OHOS/);
    assert.match(viteConfig, /warning\.code === 'UNUSED_EXTERNAL_IMPORT'[\s\S]*?vendor\/genoffice\/dist\/main\.js/);
    assert.match(genOfficeVite, /from 'esbuild'/);
    assert.match(genOfficeVite, /export const genOfficeSlidesMainBuildPlugin/);
    assert.match(genOfficeVite, /external:\s*\['electron', '@genspark\/cli'\]/);
    assert.match(genOfficeVite, /genspark-cli\.cjs/);
    assert.match(genOfficeVite, /require\.resolve\('@genspark\/cli'\)/);
    assert.match(genOfficeVite, /'import\.meta\.url': '__import_meta_url__'/);
    assert.match(genOfficeVite, /harfbuzz-wasm\?asset/);
    assert.doesNotMatch(genOfficeVite, /externalizeDeps:\s*false/);
    const packageMain = await readFile(path.join(projectRoot, 'vendor/genoffice/src/main.ts'), 'utf8');
    assert.match(packageMain, /GSK_CLI_PATH/);
    assert.match(packageMain, /GSK_NO_AUTO_UPDATE/);
    assert.match(packageMain, /dist['"], ['"]main['"], ['"]genoffice-gsk\.cjs/);
});
