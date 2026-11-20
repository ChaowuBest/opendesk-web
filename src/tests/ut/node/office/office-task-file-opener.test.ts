import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OfficeTaskSessionRegistry } from '../../../../main/office/officeTaskSessions.js';
import { OfficeTaskFileOpener } from '../../../../main/office/officeTaskFiles.js';

test('shared Office opening waits for a matching bound task editor and preserves cancellation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'office-opener-'));
    try {
        const file = path.join(root, '文稿.pptx');
        await writeFile(file, 'presentation');
        const sessions = new OfficeTaskSessionRegistry<any>();
        const contents = { id: 3, isDestroyed: () => false, once() {} };
        let opener: OfficeTaskFileOpener<any>;
        let cancel = false;
        let requests = 0;
        opener = new OfficeTaskFileOpener(sessions, {
            send(request) {
                requests++;
                queueMicrotask(() =>
                    cancel
                        ? opener.report(request.requestId, 'not_opened')
                        : sessions.bind(request.kind, request.taskId, request.filePath, contents)
                );
                return true;
            }
        });
        assert.deepEqual(await opener.open('slides', 'task', file), { status: 'opened', filePath: file });
        await opener.open('slides', 'task', file);
        assert.equal(requests, 1);
        cancel = true;
        assert.equal((await opener.open('slides', 'other', file)).status, 'not_opened');
        await assert.rejects(opener.open('word', 'task', file));
        assert.equal(sessions.get('slides', 'task')?.contents, contents);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('missing renderer and failed open are failures shared by every GUI host', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'office-opener-fail-'));
    try {
        const file = path.join(root, 'a.docx');
        await writeFile(file, 'document');
        const unavailable = new OfficeTaskFileOpener(new OfficeTaskSessionRegistry<any>(), { send: () => false });
        await assert.rejects(unavailable.open('word', 'task', file));
        let opener: OfficeTaskFileOpener<any>;
        opener = new OfficeTaskFileOpener(new OfficeTaskSessionRegistry<any>(), {
            send(request) {
                queueMicrotask(() => opener.report(request.requestId, 'failed'));
                return true;
            }
        });
        await assert.rejects(opener.open('word', 'task', file));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
