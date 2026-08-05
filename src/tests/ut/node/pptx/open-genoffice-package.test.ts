import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const require = createRequire(import.meta.url);
const slidesPackageRoot = path.resolve(path.dirname(require.resolve('@bitclub.ai/open-genoffice/hap')), '..');

const OPEN_GENOFFICE_ONLY_RUNTIME_PACKAGES = [
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

test('Open GenOffice exposes an npm-like host package boundary', async () => {
    const packageJson = JSON.parse(await readFile(path.join(slidesPackageRoot, 'package.json'), 'utf8')) as {
        name: string;
        exports: Record<string, string>;
    };

    assert.equal(packageJson.name, '@bitclub.ai/open-genoffice');
    assert.equal(packageJson.exports['./main'], './dist/main.js');
    assert.equal(packageJson.exports['./preload'], './src/preload.ts');
    assert.equal(packageJson.exports['./renderer'], './src/renderer.ts');
    assert.equal(packageJson.exports['./vite'], './dist/vite.js');
    assert.equal(packageJson.exports['./hap'], './src/hap.cjs');
    assert.equal(packageJson.exports['./hap-manifest'], './hap-manifest.json');

    const hostAdapter = await readFile(path.join(projectRoot, 'src/main/office/openGenOfficeSlidesHost.ts'), 'utf8');
    const rendererEntry = await readFile(path.join(projectRoot, 'src/renderer/slidesEditorEntry.ts'), 'utf8');

    assert.match(hostAdapter, /import\('@bitclub\.ai\/open-genoffice\/main'\)/);
    assert.match(hostAdapter, /slides-host:prepare/);
    assert.match(rendererEntry, /from '@bitclub\.ai\/open-genoffice\/renderer'/);
    assert.doesNotMatch(hostAdapter, /vendor\/genoffice\/apps\/slides/);
    assert.doesNotMatch(rendererEntry, /vendor\/genoffice\/apps\/slides/);
});

test('Open GenOffice is installed from the immutable GitCode release commit', async () => {
    const hostPackage = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as {
        devDependencies: Record<string, string>;
    };

    assert.equal(
        hostPackage.devDependencies['@bitclub.ai/open-genoffice'],
        'git+https://gitcode.com/IntelliOS/GenOffice.git#2179b6e398cc1e90874af32c6f67d396908c2bff'
    );
});

test('Open GenOffice-only dependencies are owned by the embedded package, not the host', async () => {
    const hostPackage = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>;
    };
    const slidesPackage = JSON.parse(await readFile(path.join(slidesPackageRoot, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>;
    };

    for (const packageName of OPEN_GENOFFICE_ONLY_RUNTIME_PACKAGES) {
        assert.equal(
            hostPackage.dependencies[packageName],
            undefined,
            `${packageName} must not expand the host HAP dependency closure`
        );
        assert.ok(
            slidesPackage.dependencies[packageName],
            `${packageName} must be declared by @bitclub.ai/open-genoffice`
        );
    }
});

test('Open GenOffice declares every HAP runtime dependency and asset', async () => {
    const manifest = JSON.parse(await readFile(path.join(slidesPackageRoot, 'hap-manifest.json'), 'utf8')) as {
        artifacts: string[];
        prebundledPackages: string[];
        runtimePackages: string[];
        wasmAssets: string[];
    };

    assert.deepEqual(manifest.artifacts.sort(), ['dist/preload/slidesPreload.js', 'dist/renderer/slides_editor.html']);
    assert.deepEqual(manifest.wasmAssets, ['dist/main/chunks/harfbuzz-*.wasm']);

    for (const releasePath of [...manifest.artifacts, ...manifest.wasmAssets]) {
        assert.match(releasePath, /^dist\//);
        assert.doesNotMatch(releasePath, /(?:^|\/)(?:src|test|tests|vendor)(?:\/|$)/);
    }

    assert.deepEqual(manifest.runtimePackages, []);
    assert.deepEqual(manifest.prebundledPackages, ['@bitclub.ai/open-genoffice']);
});

test('Open GenOffice main dependencies are isolated from the host build policy', async () => {
    const viteConfig = await readFile(path.join(projectRoot, 'electron.vite.config.ts'), 'utf8');
    const openGenOfficeVite = await readFile(path.join(slidesPackageRoot, 'src/vite.ts'), 'utf8');

    assert.match(viteConfig, /openGenOfficeSlidesMainBuildPlugin/);
    assert.match(viteConfig, /plugins:\s*\[openGenOfficeSlidesMainBuildPlugin/);
    assert.match(viteConfig, /open-genoffice-main/);
    assert.match(viteConfig, /@bitclub\.ai\/open-genoffice\/dist\/main\.js/);
    assert.match(viteConfig, /createOpenGenOfficeSlidesRendererViteConfig/);
    assert.doesNotMatch(viteConfig, /externalizeDeps:\s*false/);
    assert.doesNotMatch(viteConfig, /externalizeDeps:\s*\{\s*exclude:/);
    assert.doesNotMatch(viteConfig, /esmShimBoundaryPlugin|ohos-bootstrap\.ts|OPENDESK_OHOS/);
    assert.match(
        viteConfig,
        /warning\.code === 'UNUSED_EXTERNAL_IMPORT'[\s\S]*?@bitclub\.ai\/open-genoffice\/dist\/main\.js/
    );
    assert.match(openGenOfficeVite, /export const openGenOfficeSlidesMainBuildPlugin/);
    assert.match(openGenOfficeVite, /jsx:\s*'automatic'/);
    assert.match(openGenOfficeVite, /harfbuzz-wasm\?asset/);
    assert.doesNotMatch(openGenOfficeVite, /externalizeDeps:\s*false/);
    const packageMain = await readFile(path.join(slidesPackageRoot, 'src/main.ts'), 'utf8');
    assert.match(packageMain, /createOpenGenOfficeSlidesHost/);
    assert.doesNotMatch(packageMain, /GSK_CLI_PATH|GSK_NO_AUTO_UPDATE|genoffice-gsk\.cjs/);
});
