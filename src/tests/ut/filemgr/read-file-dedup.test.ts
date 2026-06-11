import fs from 'fs';
import os from 'os';
import path from 'path';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';
import { ReadFileTool } from '../../../main/applications/filemgr/tools';

let tempRootDir: string | undefined;

function createTempDir(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-read-file-dedup-'));
    return tempRootDir;
}

function cleanupTempDir(): void {
    if (tempRootDir && fs.existsSync(tempRootDir)) {
        fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    tempRootDir = undefined;
}

function createTask(workspace: string): TaskState {
    const task = new TaskState(new TaskManagerState(), null);
    task.workspace = workspace;
    return task;
}

async function readFile(
    tool: ReadFileTool,
    filePath: string,
    task?: TaskState,
    range: { offset?: number; limit?: number } = {}
): Promise<any> {
    return JSON.parse(
        await tool.executeCommand(
            {
                file_path: filePath,
                ...range
            },
            task
        )
    );
}

describe('ReadFileTool range-aware dedup', () => {
    afterEach(() => {
        cleanupTempDir();
    });

    test('returns file_unchanged for a repeated read of the same file and range', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'sample.txt');
        fs.writeFileSync(filePath, 'alpha\nbeta\ngamma', 'utf8');
        const task = createTask(tempDir);
        const tool = new ReadFileTool();

        const firstResult = await readFile(tool, filePath, task);
        const secondResult = await readFile(tool, filePath, task);

        expect(firstResult.type).toBe('text');
        expect(secondResult).toMatchObject({
            type: 'file_unchanged',
            file: {
                filePath: filePath.replace(/\\/g, '/')
            }
        });
        expect(secondResult.message).toContain('earlier readFile tool result');
    });

    test('returns text and refreshes state after the file mtime changes', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'changed.txt');
        fs.writeFileSync(filePath, 'before', 'utf8');
        const task = createTask(tempDir);
        const tool = new ReadFileTool();

        const firstResult = await readFile(tool, filePath, task);
        fs.writeFileSync(filePath, 'after', 'utf8');
        const future = new Date(Date.now() + 2000);
        fs.utimesSync(filePath, future, future);

        const secondResult = await readFile(tool, filePath, task);
        const thirdResult = await readFile(tool, filePath, task);

        expect(firstResult.type).toBe('text');
        expect(secondResult.type).toBe('text');
        expect(secondResult.file.content).toContain('after');
        expect(thirdResult.type).toBe('file_unchanged');
    });

    test('does not dedup when offset differs', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'offset.txt');
        fs.writeFileSync(filePath, 'one\ntwo\nthree', 'utf8');
        const task = createTask(tempDir);
        const tool = new ReadFileTool();

        const firstResult = await readFile(tool, filePath, task, { offset: 1 });
        const secondResult = await readFile(tool, filePath, task, { offset: 2 });

        expect(firstResult.type).toBe('text');
        expect(secondResult.type).toBe('text');
        expect(secondResult.file.content).toContain('     2\ttwo');
    });

    test('does not dedup when limit differs', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'limit.txt');
        fs.writeFileSync(filePath, 'one\ntwo\nthree\nfour', 'utf8');
        const task = createTask(tempDir);
        const tool = new ReadFileTool();

        const firstResult = await readFile(tool, filePath, task, { offset: 1, limit: 2 });
        const secondResult = await readFile(tool, filePath, task, { offset: 1, limit: 3 });

        expect(firstResult.type).toBe('text');
        expect(secondResult.type).toBe('text');
        expect(secondResult.file.numLines).toBe(3);
    });

    test('does not dedup partial read state', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'partial.txt');
        fs.writeFileSync(filePath, 'one\ntwo', 'utf8');
        const task = createTask(tempDir);
        const tool = new ReadFileTool();
        const stat = fs.statSync(filePath);

        task.getFileReadState().set(filePath, {
            content: 'cached partial',
            timestamp: Math.floor(stat.mtimeMs),
            offset: 1,
            isPartialView: true
        });

        const result = await readFile(tool, filePath, task);

        expect(result.type).toBe('text');
        expect(result.file.content).toContain('one');
    });

    test('does not dedup without taskState', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'no-task.txt');
        fs.writeFileSync(filePath, 'one\ntwo', 'utf8');
        const tool = new ReadFileTool();

        const firstResult = await readFile(tool, filePath);
        const secondResult = await readFile(tool, filePath);

        expect(firstResult.type).toBe('text');
        expect(secondResult.type).toBe('text');
    });

    test('renders file_unchanged in CLI output', () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'render.txt');
        const tool = new ReadFileTool();
        const lines = tool.renderToolCallCli(
            {
                args_object: { file_path: filePath },
                status: 'success',
                result: JSON.stringify({
                    type: 'file_unchanged',
                    file: { filePath },
                    message: 'reuse previous result'
                })
            } as any,
            120
        );

        expect(lines?.join('\n')).toContain('未变化，复用上次读取内容');
    });
});
