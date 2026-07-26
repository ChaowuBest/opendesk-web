import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskManagerState } from '../../../../main/aikernel/task/manager.js';
import { TaskState } from '../../../../main/aikernel/states/tasks.js';

test('pasted images saved in the same millisecond use distinct artifact files', () => {
    const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-pasted-images-'));
    const originalConfigDirectory = process.env.OPENDESK_CONFIG_DIRECTORY;
    const originalNow = Date.now;
    process.env.OPENDESK_CONFIG_DIRECTORY = configDirectory;
    Date.now = () => 1_785_055_555_000;

    try {
        const task = new TaskState(new TaskManagerState());
        task.task_id = 'same-millisecond-images';
        const saveImage = (task as any).savePastedImageToArtifacts.bind(task) as (dataUri: string) => string;

        const firstPath = saveImage('data:image/png;base64,Zmlyc3Q=');
        const secondPath = saveImage('data:image/png;base64,c2Vjb25k');

        assert.notEqual(firstPath, secondPath);
        assert.equal(fs.readFileSync(firstPath, 'utf8'), 'first');
        assert.equal(fs.readFileSync(secondPath, 'utf8'), 'second');
    } finally {
        Date.now = originalNow;
        if (originalConfigDirectory === undefined) {
            delete process.env.OPENDESK_CONFIG_DIRECTORY;
        } else {
            process.env.OPENDESK_CONFIG_DIRECTORY = originalConfigDirectory;
        }
        fs.rmSync(configDirectory, { recursive: true, force: true });
    }
});
