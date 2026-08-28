import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const localRequire = createRequire(import.meta.url);
const { pruneNativeBuildFilesInDeps } = localRequire('../../../../../scripts/package-ohos-prune.cjs');
const packageScript = fs.readFileSync(localRequire.resolve('../../../../../scripts/package-ohos.cjs'), 'utf8');

function createPackageFixture(files, packageName = 'future-native-addon') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-ohos-prune-'));
    const packageRoot = path.join(directory, 'node_modules', packageName);
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: packageName, version: '99.0.0', main: 'index.js' })
    );
    for (const [relativePath, content] of Object.entries(files)) {
        const target = path.join(packageRoot, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
    return { directory, packageRoot };
}

function removeFixture(directory) {
    fs.rmSync(directory, { recursive: true, force: true });
}

test('preserves a runtime deps directory when its package has no native build configuration', () => {
    const fixture = createPackageFixture({
        'deps/encoding/encoding.js': 'module.exports = {};',
        'deps/encoding/indexes.json': '{}'
    });
    try {
        const depsDir = path.join(fixture.packageRoot, 'deps');

        const result = pruneNativeBuildFilesInDeps(depsDir);

        assert.equal(result.pruned, false);
        assert.equal(result.removedFiles, 0);
        assert.equal(fs.existsSync(path.join(depsDir, 'encoding', 'encoding.js')), true);
        assert.equal(fs.existsSync(path.join(depsDir, 'encoding', 'indexes.json')), true);
    } finally {
        removeFixture(fixture.directory);
    }
});

test('removes only native build inputs from a referenced deps directory of an unknown future package', () => {
    const fixture = createPackageFixture({
        'binding.gyp': "{'targets':[{'dependencies':['deps/native.gyp:native']}]}",
        'deps/native.gyp': "{'targets':[{'target_name':'native'}]}",
        'deps/src/addon.cc': 'void addon() {}',
        'deps/include/addon.h': 'void addon();',
        'deps/build.obj': 'object',
        'deps/patches/fix.patch': 'patch',
        'deps/CMakeLists.txt': 'add_library(native)',
        'deps/runtime/loader.js': 'module.exports = {};',
        'deps/runtime/data.json': '{}',
        'deps/runtime/module.wasm': 'wasm',
        'deps/runtime/addon.node': 'native',
        'deps/runtime/helper': 'executable'
    });
    try {
        const depsDir = path.join(fixture.packageRoot, 'deps');

        const result = pruneNativeBuildFilesInDeps(depsDir);

        assert.equal(result.pruned, true);
        assert.equal(result.removedFiles, 6);
        assert.equal(fs.existsSync(path.join(depsDir, 'native.gyp')), false);
        assert.equal(fs.existsSync(path.join(depsDir, 'src', 'addon.cc')), false);
        assert.equal(fs.existsSync(path.join(depsDir, 'include', 'addon.h')), false);
        assert.equal(fs.existsSync(path.join(depsDir, 'build.obj')), false);
        assert.equal(fs.existsSync(path.join(depsDir, 'patches', 'fix.patch')), false);
        assert.equal(fs.existsSync(path.join(depsDir, 'CMakeLists.txt')), false);
        assert.equal(fs.existsSync(path.join(depsDir, 'runtime', 'loader.js')), true);
        assert.equal(fs.existsSync(path.join(depsDir, 'runtime', 'data.json')), true);
        assert.equal(fs.existsSync(path.join(depsDir, 'runtime', 'module.wasm')), true);
        assert.equal(fs.existsSync(path.join(depsDir, 'runtime', 'addon.node')), true);
        assert.equal(fs.existsSync(path.join(depsDir, 'runtime', 'helper')), true);
        assert.equal(fs.existsSync(path.join(depsDir, 'src')), true);
        assert.equal(fs.existsSync(path.join(depsDir, 'include')), true);
    } finally {
        removeFixture(fixture.directory);
    }
});

test('preserves deps when native build configuration does not reference it', () => {
    const fixture = createPackageFixture({
        'binding.gyp': "{'targets':[{'sources':['src/addon.cc']}]}",
        'deps/payload.c': 'runtime payload'
    });
    try {
        const depsDir = path.join(fixture.packageRoot, 'deps');

        const result = pruneNativeBuildFilesInDeps(depsDir);

        assert.equal(result.pruned, false);
        assert.equal(fs.existsSync(path.join(depsDir, 'payload.c')), true);
    } finally {
        removeFixture(fixture.directory);
    }
});

test('finds the nearest package root for a nested deps directory', () => {
    const fixture = createPackageFixture({
        'binding.gyp': "{'targets':[{'dependencies':['resources/deps/native.gyp:native']}]}",
        'resources/deps/native.gyp': "{'targets':[{'target_name':'native'}]}",
        'resources/deps/source.c': 'void native() {}'
    });
    try {
        const depsDir = path.join(fixture.packageRoot, 'resources', 'deps');

        const result = pruneNativeBuildFilesInDeps(depsDir);

        assert.equal(result.pruned, true);
        assert.equal(result.packageName, 'future-native-addon');
        assert.equal(result.relativePath, 'resources/deps');
        assert.equal(fs.existsSync(path.join(depsDir, 'source.c')), false);
    } finally {
        removeFixture(fixture.directory);
    }
});

test('OpenHarmony packaging delegates deps to the conservative pruner', () => {
    const branchStart = packageScript.indexOf("if (e.name === 'deps') {");
    const branchEnd = packageScript.indexOf('if (JUNK_DIRS.has(e.name))', branchStart);
    assert.notEqual(branchStart, -1, 'package-ohos.cjs must handle deps before generic junk directories');
    assert.notEqual(branchEnd, -1, 'the deps branch must precede generic junk directory handling');

    const depsBranch = packageScript.slice(branchStart, branchEnd);
    assert.match(depsBranch, /pruneNativeBuildFilesInDeps\(fp\)/);
    assert.match(depsBranch, /continue;/);
});
