import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const officePackageRoot = path.resolve(path.dirname(require.resolve('@bitclub.ai/opendesk-office/hap')), '..');

test('OpenDesk Office exposes an npm-like host package boundary', () => {
    for (const subpath of [
        'main',
        'word-main',
        'host-security',
        'preload',
        'word-preload',
        'renderer',
        'word-renderer',
        'vite',
        'hap',
        'hap-manifest',
        'engine',
        'word-engine'
    ]) {
        assert.ok(require.resolve(`@bitclub.ai/opendesk-office/${subpath}`));
    }
});

test('OpenDesk Office declares every HAP runtime dependency and asset', async () => {
    const manifest = JSON.parse(await readFile(path.join(officePackageRoot, 'hap-manifest.json'), 'utf8')) as {
        artifacts: string[];
        legalArtifacts: string[];
        prebundledPackages: string[];
        runtimePackages: string[];
        wasmAssets: string[];
    };

    assert.deepEqual(manifest.artifacts.sort(), [
        'dist/preload/slidesPreload.js',
        'dist/preload/wordPreload.js',
        'dist/renderer/slides_editor.html',
        'dist/renderer/word_editor.html'
    ]);
    assert.deepEqual(manifest.wasmAssets, ['dist/main/chunks/harfbuzz-*.wasm']);
    assert.deepEqual(manifest.legalArtifacts, [
        'third_party_licenses/opendesk-office/LICENSE',
        'third_party_licenses/opendesk-office/NOTICE',
        'third_party_licenses/opendesk-office/UPSTREAM.md'
    ]);

    for (const releasePath of [...manifest.artifacts, ...manifest.wasmAssets]) {
        assert.match(releasePath, /^dist\//);
        assert.doesNotMatch(releasePath, /(?:^|\/)(?:src|test|tests|vendor)(?:\/|$)/);
    }

    assert.deepEqual(manifest.runtimePackages, []);
    assert.deepEqual(manifest.prebundledPackages, ['@bitclub.ai/opendesk-office']);
});
