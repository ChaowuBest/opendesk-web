import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from '@jest/globals';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

let tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return predicate();
}

describe('throttled task save directory snapshot', () => {
    afterEach(() => {
        setCustomOpendeskDirectory(undefined);
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        tempDirs = [];
    });

    test('pending throttled save writes to the directory captured at schedule time', async () => {
        const scheduledDir = makeTempDir('opendesk-save-snapshot-a-');
        const resetDir = makeTempDir('opendesk-save-snapshot-b-');
        const taskId = `task-save-snapshot-${process.pid}-${Date.now()}`;

        setCustomOpendeskDirectory(scheduledDir);
        const manager = new TaskManagerState();
        const task = new TaskState(manager);
        task.task_id = taskId;
        manager.tasks.push(task);
        // setSystemPrompt -> persistLater() 会调度一个 2s 的节流保存定时器
        task.setSystemPrompt('directory-snapshot-probe');

        // 模拟 teardown / 下一个用例把任务目录切走
        setCustomOpendeskDirectory(resetDir);

        const scheduledTaskFile = path.join(scheduledDir, 'tasks', `${taskId}.json`);
        const landed = await waitFor(() => fs.existsSync(scheduledTaskFile), 8000);
        // 等写入完全结束后再交给 afterEach 清理目录
        await manager.flushAllPendingSaves();

        expect(landed).toBe(true);
        expect(fs.existsSync(scheduledTaskFile)).toBe(true);
        // 切换后的目录不允许被调度时就已存在的保存触达
        expect(fs.existsSync(path.join(resetDir, 'tasks', `${taskId}.json`))).toBe(false);
        const resetIndexFile = path.join(resetDir, 'tasks', 'task_list.json');
        if (fs.existsSync(resetIndexFile)) {
            const entries = JSON.parse(fs.readFileSync(resetIndexFile, 'utf8'));
            expect(entries.some((entry) => entry.task_id === taskId)).toBe(false);
        }
    }, 20000);
});
