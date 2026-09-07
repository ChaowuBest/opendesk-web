import fs from 'fs';
import os from 'os';
import path from 'path';
import { exportTaskJsonToFile } from '../../../main/utils/export.js';

type ExportSource = Parameters<typeof exportTaskJsonToFile>[0];

function createStubTask(json: Record<string, unknown>, hooks: { ensureLoadedCalls: number[] }): ExportSource {
    return {
        ensureLoaded: () => {
            hooks.ensureLoadedCalls.push(1);
        },
        toJSON: () => json
    } as unknown as ExportSource;
}

describe('exportTaskJsonToFile', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-export-json-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('序列化任务 JSON 并写盘（与任务文件一致的 4 空格缩进）', async () => {
        const taskJson = { task_id: 'task-1', task_name: 'demo', chat_context: { messages: [] } };
        const hooks = { ensureLoadedCalls: [] as number[] };
        const target = path.join(tempDir, 'task-1.json');

        await exportTaskJsonToFile(createStubTask(taskJson, hooks), target);

        expect(hooks.ensureLoadedCalls).toHaveLength(1);
        expect(fs.readFileSync(target, 'utf-8')).toBe(JSON.stringify(taskJson, null, 4));
    });

    test('目标父目录不存在时自动创建', async () => {
        const taskJson = { task_id: 'task-2' };
        const target = path.join(tempDir, 'nested', 'dir', 'task-2.json');

        await exportTaskJsonToFile(createStubTask(taskJson, { ensureLoadedCalls: [] }), target);

        expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual(taskJson);
    });

    test('目标文件已存在时覆盖写入', async () => {
        const taskJson = { task_id: 'task-3' };
        const target = path.join(tempDir, 'task-3.json');
        fs.writeFileSync(target, 'stale content');

        await exportTaskJsonToFile(createStubTask(taskJson, { ensureLoadedCalls: [] }), target);

        expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual(taskJson);
    });

    test('非法路径抛出错误', async () => {
        const taskJson = { task_id: 'task-4' };
        await expect(exportTaskJsonToFile(createStubTask(taskJson, { ensureLoadedCalls: [] }), '')).rejects.toThrow(
            'invalid export file path'
        );
    });
});
