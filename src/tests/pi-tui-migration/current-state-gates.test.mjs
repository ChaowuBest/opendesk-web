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
    const result = spawnSync('rg', ['-n', pattern, ...paths, '-g', '!src/tests/pi-tui-migration/**'], {
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

test('source and test module resolution no longer point at the old pi-tui package', () => {
    const hits = rg(oldPackage, ['src', 'jest.config.ts', 'package.json']);
    assert.deepEqual(hits, []);
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
        'docs/reports/pi_tui_migration_inventory/20260706/tui_migration_verification_record.md'
    );
    assert.ok(existsSync(recordPath), `missing verification record: ${recordPath}`);
});
