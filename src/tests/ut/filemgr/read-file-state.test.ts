import fs from 'fs';
import os from 'os';
import path from 'path';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';
import { ReadFileTool } from '../../../main/applications/filemgr/tools';

let tempRootDir: string | undefined;

function createTempDir(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-read-file-state-'));
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
    task: TaskState,
    filePath: string,
    range: { offset?: number; limit?: number } = {}
): Promise<any> {
    try {
        return JSON.parse(
            await tool.executeCommand(
                {
                    file_path: filePath,
                    ...range
                },
                task
            )
        );
    } catch (err) {
        return { type: 'error', message: err instanceof Error ? err.message : String(err) };
    }
}

describe('ReadFileTool file read state recording', () => {
    afterEach(() => {
        cleanupTempDir();
    });

    test('records read state after reading a whole text file', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'sample.txt');
        fs.writeFileSync(filePath, 'alpha\nbeta\ngamma', 'utf8');
        const task = createTask(tempDir);
        const tool = new ReadFileTool();

        const result = await readFile(tool, task, filePath);
        const state = task.getFileReadState().get(filePath);
        const stat = fs.statSync(filePath);

        expect(result.type).toBe('text');
        expect(state).toMatchObject({
            content: result.file.content,
            timestamp: Math.floor(stat.mtimeMs),
            offset: 1,
            isPartialView: false
        });
        expect(state?.limit).toBeUndefined();
    });

    test('records offset and limit after reading a line range', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'range.txt');
        fs.writeFileSync(filePath, 'one\ntwo\nthree\nfour\nfive', 'utf8');
        const task = createTask(tempDir);
        const tool = new ReadFileTool();

        const result = await readFile(tool, task, filePath, { offset: 2, limit: 3 });
        const state = task.getFileReadState().get(filePath);

        expect(result.type).toBe('text');
        expect(result.file.content).toContain('     2\ttwo');
        expect(state).toMatchObject({
            content: result.file.content,
            offset: 2,
            limit: 3,
            isPartialView: false
        });
    });

    test('records empty files as successful reads', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'empty.txt');
        fs.writeFileSync(filePath, '', 'utf8');
        const task = createTask(tempDir);
        const tool = new ReadFileTool();

        const result = await readFile(tool, task, filePath);
        const state = task.getFileReadState().get(filePath);

        expect(result.type).toBe('text');
        expect(result.file.content).toBe('');
        expect(state).toMatchObject({
            content: '',
            offset: 1,
            isPartialView: false
        });
        expect(state?.limit).toBeUndefined();
    });

    test('does not record directories, binary files, missing files, or out-of-range reads', async () => {
        const tempDir = createTempDir();
        const task = createTask(tempDir);
        const tool = new ReadFileTool();
        const directoryPath = path.join(tempDir, 'directory');
        const binaryPath = path.join(tempDir, 'binary.bin');
        const textPath = path.join(tempDir, 'short.txt');
        const missingPath = path.join(tempDir, 'missing.txt');

        fs.mkdirSync(directoryPath);
        fs.writeFileSync(binaryPath, Buffer.from([0, 1, 2, 3]));
        fs.writeFileSync(textPath, 'only one line', 'utf8');

        const directoryResult = await readFile(tool, task, directoryPath);
        const binaryResult = await readFile(tool, task, binaryPath);
        const missingResult = await readFile(tool, task, missingPath);
        const outOfRangeResult = await readFile(tool, task, textPath, { offset: 99, limit: 5 });

        expect(directoryResult.type).toBe('error');
        expect(binaryResult.type).toBe('error');
        expect(missingResult.type).toBe('error');
        expect(outOfRangeResult.type).toBe('text');
        expect(task.getFileReadState().get(directoryPath)).toBeUndefined();
        expect(task.getFileReadState().get(binaryPath)).toBeUndefined();
        expect(task.getFileReadState().get(missingPath)).toBeUndefined();
        expect(task.getFileReadState().get(textPath)).toBeUndefined();
    });
});
