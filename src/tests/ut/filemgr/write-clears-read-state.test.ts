import fs from 'fs';
import os from 'os';
import path from 'path';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';
import { EditFileTool, ReadFileTool, SearchReplaceTool, WriteFileTool } from '../../../main/applications/filemgr/tools';

let tempRootDir: string | undefined;

function createTempDir(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-write-clears-read-state-'));
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

async function readFile(tool: ReadFileTool, task: TaskState, filePath: string): Promise<string> {
    return await tool.executeCommand(
        {
            file_path: filePath
        },
        task
    );
}

async function readAndExpectState(task: TaskState, readTool: ReadFileTool, filePath: string): Promise<void> {
    const result = await readFile(readTool, task, filePath);

    expect(result.startsWith('[文件] ')).toBe(true);
    expect(task.getFileReadState().get(filePath)).toBeDefined();
}

describe('local writes clear readFile state', () => {
    afterEach(() => {
        cleanupTempDir();
    });

    test('writeFile overwrite clears read state before the next read', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'overwrite.txt');
        fs.writeFileSync(filePath, 'before', 'utf8');
        const task = createTask(tempDir);
        const readTool = new ReadFileTool();
        const writeTool = new WriteFileTool();

        await readAndExpectState(task, readTool, filePath);
        const writeResult = await writeTool.executeCommand(
            {
                path: filePath,
                content: 'after'
            },
            task
        );
        expect(task.getFileReadState().get(filePath)).toBeUndefined();
        const readResult = await readFile(readTool, task, filePath);

        expect(writeResult).toContain('文件内容写入成功');
        expect(readResult).toContain('after');
    });

    test('writeFile append clears read state before the next read', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'append.txt');
        fs.writeFileSync(filePath, 'one\n', 'utf8');
        const task = createTask(tempDir);
        const readTool = new ReadFileTool();
        const writeTool = new WriteFileTool();

        await readAndExpectState(task, readTool, filePath);
        const appendResult = await writeTool.executeCommand(
            {
                path: filePath,
                content: 'two',
                mode: 'append'
            },
            task
        );
        expect(task.getFileReadState().get(filePath)).toBeUndefined();
        const readResult = await readFile(readTool, task, filePath);

        expect(appendResult).toContain('文件内容追加成功');
        expect(readResult).toContain('two');
    });

    test('editFile clears read state before the next read', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'edit.txt');
        fs.writeFileSync(filePath, 'alpha\nbeta\ngamma', 'utf8');
        const task = createTask(tempDir);
        const readTool = new ReadFileTool();
        const editTool = new EditFileTool();

        await readAndExpectState(task, readTool, filePath);
        const editResult = await editTool.executeCommand(
            {
                filePath,
                oldString: 'beta',
                newString: 'delta'
            },
            task
        );
        expect(task.getFileReadState().get(filePath)).toBeUndefined();
        const readResult = await readFile(readTool, task, filePath);

        expect(editResult).toContain('成功替换 1 处');
        expect(readResult).toContain('delta');
    });

    test('searchReplace clears read state before the next read', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'replace.txt');
        fs.writeFileSync(filePath, 'hello world', 'utf8');
        const task = createTask(tempDir);
        const readTool = new ReadFileTool();
        const searchReplaceTool = new SearchReplaceTool();

        await readAndExpectState(task, readTool, filePath);
        const replaceResult = await searchReplaceTool.executeCommand(
            {
                filePath,
                oldString: 'world',
                newString: 'opendesk'
            },
            task
        );
        expect(task.getFileReadState().get(filePath)).toBeUndefined();
        const readResult = await readFile(readTool, task, filePath);

        expect(replaceResult).toContain('成功替换 1 处');
        expect(readResult).toContain('opendesk');
    });

    test('writeFile still overwrites existing files without a prior read', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'no-prior-read.txt');
        fs.writeFileSync(filePath, 'before', 'utf8');
        const task = createTask(tempDir);
        const writeTool = new WriteFileTool();

        const writeResult = await writeTool.executeCommand(
            {
                path: filePath,
                content: 'after'
            },
            task
        );

        expect(writeResult).toContain('文件内容写入成功');
        expect(fs.readFileSync(filePath, 'utf8')).toBe('after');
    });
});
