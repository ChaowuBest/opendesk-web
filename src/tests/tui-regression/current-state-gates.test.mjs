import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const oldPackage = '@mariozechner/pi-tui';
const targetPackage = '@earendil-works/pi-tui';

function read(relativePath) {
    return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function rg(pattern, paths) {
    const result = spawnSync('rg', ['-n', pattern, ...paths, '-g', '!src/tests/pi-tui-migration-only/**'], {
        cwd: repoRoot,
        encoding: 'utf8'
    });
    if (result.status === 0) return result.stdout.trim().split('\n').filter(Boolean);
    if (result.status === 1) return [];
    throw new Error(result.stderr || `rg failed with status ${result.status}`);
}

test('package dependency has migrated from old pi-tui scope to target scope', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.dependencies?.[oldPackage], undefined, `old dependency still exists: ${oldPackage}`);
    assert.ok(pkg.dependencies?.[targetPackage], `target dependency missing: ${targetPackage}`);
});

test('source and test code no longer import the old pi-tui package directly', () => {
    const hits = rg(`from ['"]${oldPackage}['"]|import\\(['"]${oldPackage}['"]\\)`, ['src/main', 'src/tests/ut']);
    assert.deepEqual(hits, [], `old pi-tui imports remain:\n${hits.join('\n')}`);
});

test('runtime pi-tui imports use the target package directly without a local adapter', () => {
    assert.equal(existsSync(path.join(repoRoot, 'src/main/tui/pi-tui.ts')), false, 'local pi-tui adapter still exists');

    const localAdapterHits = rg(`pi-tui\\.js|from ['"][.][^'"]*pi-tui['"]|from ['"][.][^'"]*pi-tui\\.js['"]`, [
        'src/main',
        'src/tests/ut'
    ]);
    assert.deepEqual(localAdapterHits, [], `local pi-tui adapter imports remain:\n${localAdapterHits.join('\n')}`);

    const targetHits = rg(`from ['"]${targetPackage}['"]|import\\(['"]${targetPackage}['"]\\)`, [
        'src/main',
        'src/tests/ut'
    ]);
    assert.ok(targetHits.length > 0, `no direct target pi-tui imports found for ${targetPackage}`);
});

test('Jest module resolution points at the migrated pi-tui package', () => {
    const hits = rg(oldPackage, ['jest.config.ts']);
    assert.deepEqual(hits, []);
});

test('CLI build carries pi-tui native helpers required for terminal key modifiers', () => {
    const buildConfig = read('esbuild.config.ts');
    assert.match(buildConfig, /@earendil-works\/pi-tui\/native/);
    assert.match(buildConfig, /copyPiTuiNativeModules/);
    assert.match(buildConfig, /dist\/cli\/native/);

    const debugCli = path.join(repoRoot, 'dist/cli/opendesk-debug');
    if (existsSync(debugCli)) {
        assert.ok(
            existsSync(path.join(repoRoot, 'dist/cli/native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node')),
            'missing bundled darwin arm64 pi-tui modifier helper'
        );
        assert.ok(
            existsSync(path.join(repoRoot, 'dist/cli/native/darwin/prebuilds/darwin-x64/darwin-modifiers.node')),
            'missing bundled darwin x64 pi-tui modifier helper'
        );
    }
});

test('OpenDesk preserves Shift+Enter as an explicit multiline input shortcut', () => {
    const entry = read('src/main/tui/entry.ts');
    assert.match(entry, /matchesKey\(data, shortcuts\.endline\)/);
    assert.match(entry, /matchesKey\(data, Key\.shift\(Key\.enter\)\)/);
    assert.match(entry, /return \{ data: '\\n' \}/);
});

test('public documentation does not teach the old pi-tui package as the current API', () => {
    const hits = rg(oldPackage, [
        'README.md',
        'README_EN.md',
        'docs/readmes',
        'docs/appguide.md',
        'docs/cliguide.md',
        'docs/cliguide_en.md'
    ]);
    const allowedHistoricalHits = hits.filter((line) => /migration|迁移|history|历史|旧/.test(line));
    assert.equal(
        allowedHistoricalHits.length,
        hits.length,
        `old package appears in current-facing docs:\n${hits.join('\n')}`
    );
});

test('verification record exists before migration can be closed', () => {
    const recordPath = path.join(
        repoRoot,
        'docs/reports/pi_tui_migration_pl_review/artifacts/tui_migration_verification_record.md'
    );
    assert.ok(existsSync(recordPath), `missing verification record: ${recordPath}`);
});
