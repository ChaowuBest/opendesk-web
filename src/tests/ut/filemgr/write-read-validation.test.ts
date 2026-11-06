import fs from 'fs';
import os from 'os';
import path from 'path';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';
import {
    ENFORCE_FILE_READ_BEFORE_WRITE,
    WriteFileTool,
    validateFileWasReadForWrite
} from '../../../main/applications/filemgr/tools';

let tempRootDir: string | undefined;

function createTempDir(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-write-read-validation-'));
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

function setReadState(
    task: TaskState,
    filePath: string,
    overrides: Partial<{
        timestamp: number;
        isPartialView: boolean;
    }> = {}
): void {
    const stat = fs.statSync(filePath);
    task.getFileReadState().set(filePath, {
        content: '     1\tcontent',
        timestamp: overrides.timestamp ?? Math.floor(stat.mtimeMs),
        offset: 1,
        isPartialView: overrides.isPartialView ?? false
    });
}

describe('write read-state validation helper', () => {
    afterEach(() => {
        cleanupTempDir();
    });

    test('returns not_read when a task has no read state for the file', () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'not-read.txt');
        fs.writeFileSync(filePath, 'content', 'utf8');
        const task = createTask(tempDir);

        const result = validateFileWasReadForWrite(task, filePath);

        expect(result).toMatchObject({
            ok: false,
            reason: 'not_read'
        });
        if (!result.ok) {
            expect(result.message).toContain('readFile');
        }
    });

    test('returns partial_view when the cached state is marked partial', () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'partial.txt');
        fs.writeFileSync(filePath, 'content', 'utf8');
        const task = createTask(tempDir);

        setReadState(task, filePath, { isPartialView: true });
        const result = validateFileWasReadForWrite(task, filePath);

        expect(result).toMatchObject({
            ok: false,
            reason: 'partial_view'
        });
    });

    test('returns ok after a full read state when the file mtime is unchanged', () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'unchanged.txt');
        fs.writeFileSync(filePath, 'content', 'utf8');
        const task = createTask(tempDir);

        setReadState(task, filePath);

        expect(validateFileWasReadForWrite(task, filePath)).toEqual({ ok: true });
    });

    test('returns modified_since_read when the file mtime moved forward', () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'modified.txt');
        fs.writeFileSync(filePath, 'before', 'utf8');
        const task = createTask(tempDir);

        setReadState(task, filePath);
        fs.writeFileSync(filePath, 'after', 'utf8');
        const future = new Date(Date.now() + 2000);
        fs.utimesSync(filePath, future, future);

        const result = validateFileWasReadForWrite(task, filePath);

        expect(result).toMatchObject({
            ok: false,
            reason: 'modified_since_read'
        });
    });

    test('returns ok without taskState', () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'no-task.txt');
        fs.writeFileSync(filePath, 'content', 'utf8');

        expect(validateFileWasReadForWrite(undefined, filePath)).toEqual({ ok: true });
    });

    test('keeps write tools non-enforcing while the soft switch is off', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'soft-switch.txt');
        fs.writeFileSync(filePath, 'before', 'utf8');
        const task = createTask(tempDir);
        const tool = new WriteFileTool();

        const result = await tool.executeCommand(
            {
                path: filePath,
                content: 'after'
            },
            task
        );

        expect(ENFORCE_FILE_READ_BEFORE_WRITE).toBe(false);
        expect(result).toContain('文件内容写入成功');
        expect(fs.readFileSync(filePath, 'utf8')).toBe('after');
    });
});
