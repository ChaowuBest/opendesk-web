import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    hasPreviewedReleaseNotes,
    markReleaseNotesSeen,
    readWhatsNewSeen
} from '../../../../main/updater/whats-new.js';

function createStateDirectory() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-updater-whats-new-'));
    return { root, seenPath: path.join(root, 'whats-new-seen.json') };
}

test('mark appends the version to an empty history', async (t) => {
    const { root, seenPath } = createStateDirectory();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    await markReleaseNotesSeen(root, '0.4.1');

    assert.deepEqual(await readWhatsNewSeen(root), ['0.4.1']);
    // 原子写：不能留下 tmp 残留
    assert.equal(fs.existsSync(`${seenPath}.tmp`), false);
});

test('mark keeps earlier versions and appends the new one', async (t) => {
    const { root } = createStateDirectory();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    await markReleaseNotesSeen(root, '0.4.0');
    await markReleaseNotesSeen(root, '0.4.1');

    // seen 历史只增不删
    assert.deepEqual(await readWhatsNewSeen(root), ['0.4.0', '0.4.1']);
});

test('mark stays idempotent for the same version', async (t) => {
    const { root } = createStateDirectory();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    await markReleaseNotesSeen(root, '0.4.1');
    await markReleaseNotesSeen(root, '0.4.1');

    assert.deepEqual(await readWhatsNewSeen(root), ['0.4.1']);
});

test('read returns an empty history when no file exists', async (t) => {
    const { root } = createStateDirectory();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    assert.deepEqual(await readWhatsNewSeen(root), []);
});

test('read removes a corrupted history file and returns an empty history', async (t) => {
    const { root, seenPath } = createStateDirectory();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(seenPath, '{not-json');

    assert.deepEqual(await readWhatsNewSeen(root), []);
    assert.equal(fs.existsSync(seenPath), false);
});

test('read discards a history whose seen field is not an array', async (t) => {
    const { root, seenPath } = createStateDirectory();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(seenPath, JSON.stringify({ seen: '0.4.1' }));

    assert.deepEqual(await readWhatsNewSeen(root), []);
    assert.equal(fs.existsSync(seenPath), false);
});

test('read keeps only valid SemVer entries', async (t) => {
    const { root, seenPath } = createStateDirectory();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    // 手工篡改出的坏条目不能污染 includes 判定，也不能挤掉合法历史
    fs.writeFileSync(seenPath, JSON.stringify({ seen: ['0.4.1', 'latest', 42] }));

    assert.deepEqual(await readWhatsNewSeen(root), ['0.4.1']);
});

test('hasPreviewed is only true for a strict current-version match', async (t) => {
    const { root } = createStateDirectory();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    await markReleaseNotesSeen(root, '0.4.1');

    assert.equal(await hasPreviewedReleaseNotes(root, '0.4.1'), true);
    // 严格"当前版本 ∈ seen"才跳过：相邻版本都不算已预览
    assert.equal(await hasPreviewedReleaseNotes(root, '0.4.2'), false);
    assert.equal(await hasPreviewedReleaseNotes(root, '0.4.0'), false);
});

test('hasPreviewed returns false when the history is empty', async (t) => {
    const { root } = createStateDirectory();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    assert.equal(await hasPreviewedReleaseNotes(root, '0.4.1'), false);
});

test('mark creates the state directory when it does not exist yet', async (t) => {
    const { root } = createStateDirectory();
    // seen 历史与更新流程解耦：从未进入更新流程的安装，缓存目录可能尚未创建
    const nested = path.join(root, 'Cache');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    await markReleaseNotesSeen(nested, '0.4.1');

    assert.deepEqual(await readWhatsNewSeen(nested), ['0.4.1']);
});
