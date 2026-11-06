import fs from 'fs';
import os from 'os';
import path from 'path';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';
import { EditFileTool, ReadFileTool, SearchReplaceTool, WriteFileTool } from '../../../main/applications/filemgr/tools';

let tempRootDir: string | undefined;

function createTempDir(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-write-echo-'));
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

describe('写类工具磁盘回读锚点（消除回显假象）', () => {
    afterEach(() => {
        cleanupTempDir();
    });

    test('writeFile 成功后返回磁盘回读校验：行数与尾部 3 行为磁盘真实内容', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'out.ts').replace(/\\/g, '/');
        const content = ['line-1', 'line-2', 'line-3', 'line-4', 'line-5'].join('\n');
        const tool = new WriteFileTool();

        const result = await tool.executeCommand({ path: filePath, mode: 'overwrite', content }, createTask(tempDir));

        expect(result).toContain('文件内容写入成功');
        expect(result).toContain('磁盘回读校验：共 5 行');
        // 尾部 3 行是磁盘真实内容，模型可直接与自己提交的 content 尾部比对
        expect(result).toContain('  line-3');
        expect(result).toContain('  line-4');
        expect(result).toContain('  line-5');
        // 回读内容与磁盘逐字一致
        const disk = fs.readFileSync(filePath, 'utf8');
        expect(disk).toBe(content);
        const diskTail = disk.split('\n').slice(-3);
        expect(result).toContain(diskTail.map((l) => '  ' + l).join('\n'));
    });

    test('writeFile append 后回读的是追加后的完整文件尾部', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'log.txt').replace(/\\/g, '/');
        // 原文件带尾换行（追加语义不自动补换行符）
        fs.writeFileSync(filePath, 'old-1\nold-2\n', 'utf8');
        const tool = new WriteFileTool();

        const result = await tool.executeCommand(
            { path: filePath, mode: 'append', content: 'new-1\nnew-2' },
            createTask(tempDir)
        );

        expect(result).toContain('文件内容追加成功');
        expect(result).toContain('磁盘回读校验：共 4 行');
        expect(result).toContain('  new-2');
        expect(result).toContain('  old-2');
    });

    test('回读锚点的尾部行不携带 CRLF 的回车符，与 readFile 行口径一致', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'win.txt').replace(/\\/g, '/');
        // 往已有 CRLF 文件追加（Windows 现实场景）：行内容必须剥离 \r，
        // 否则模型对比"尾部 3 行"时会误判磁盘内容与提交内容不一致（新的回显假象）
        fs.writeFileSync(filePath, 'old-1\r\nold-2\r\n', 'utf8');
        const tool = new WriteFileTool();

        const result = await tool.executeCommand(
            { path: filePath, mode: 'append', content: 'new-1\nnew-2' },
            undefined
        );

        expect(result).toContain('磁盘回读校验：共 4 行');
        expect(result).toContain('  old-2');
        expect(result).toContain('  new-1');
        expect(result).not.toContain('\r');
        // 字节数仍按磁盘真实字节（含 \r）
        expect(result).toContain('/ 25 字节');
    });

    test('回读行数与 readFile 对同一磁盘内容的行数口径完全一致', async () => {
        const tempDir = createTempDir();
        const readTool = new ReadFileTool();
        const writeTool = new WriteFileTool();

        // 场景 1：CRLF 带尾换行。readFile 视为 3 行（'a'、'b'、尾空行），
        // echo 也必须报 3 行，且尾部行剥离 \r
        const crlfPath = path.join(tempDir, 'crlf.txt').replace(/\\/g, '/');
        fs.writeFileSync(crlfPath, 'a\r\nb\r\n', 'utf8');
        const writeResult = await writeTool.executeCommand(
            { path: crlfPath, mode: 'overwrite', content: 'a\r\nb\r\n' },
            undefined
        );
        const readResult = await readTool.executeCommand({ file_path: crlfPath }, undefined);

        expect(readResult.split('\n')[0]).toContain('共 3 行');
        expect(writeResult).toContain('磁盘回读校验：共 3 行');
        expect(writeResult).not.toContain('\r');

        // 场景 2：LF 带尾换行。readFile 视为 2 行，echo 同样 2 行
        const lfPath = path.join(tempDir, 'lf.txt').replace(/\\/g, '/');
        const lfResult = await writeTool.executeCommand({ path: lfPath, mode: 'overwrite', content: 'a\n' }, undefined);
        const lfRead = await readTool.executeCommand({ file_path: lfPath }, undefined);

        expect(lfRead.split('\n')[0]).toContain('共 2 行');
        expect(lfResult).toContain('磁盘回读校验：共 2 行');
    });

    test('editFile 成功后返回替换位置与磁盘回读行数', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'code.ts').replace(/\\/g, '/');
        const original = ['a', 'b', 'old-value', 'd', 'e'].join('\n');
        fs.writeFileSync(filePath, original, 'utf8');
        const tool = new EditFileTool();

        const result = await tool.executeCommand(
            { filePath, oldString: 'old-value', newString: 'new-value' },
            createTask(tempDir),
            undefined
        );

        expect(result).toContain('成功替换 1 处');
        expect(result).toContain('原文件第 3 行');
        expect(result).toContain('磁盘回读校验：共 5 行');
        expect(fs.readFileSync(filePath, 'utf8')).toBe(['a', 'b', 'new-value', 'd', 'e'].join('\n'));
    });

    test('editFile 多行 newString 时行号是替换首行的行号而非末行', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'multi.ts').replace(/\\/g, '/');
        const original = ['a', 'b', 'old-value', 'd', 'e'].join('\n');
        fs.writeFileSync(filePath, original, 'utf8');
        const tool = new EditFileTool();

        // old-value 在原文件第 3 行，newString 两行，替换后首行 "x" 仍应在第 3 行
        const result = await tool.executeCommand(
            { filePath, oldString: 'old-value', newString: 'x\ny' },
            createTask(tempDir),
            undefined
        );

        expect(result).toContain('成功替换 1 处');
        expect(result).toContain('原文件第 3 行');
        expect(result).not.toContain('原文件第 4 行');
        expect(fs.readFileSync(filePath, 'utf8')).toBe(['a', 'b', 'x', 'y', 'd', 'e'].join('\n'));
    });

    test('searchReplace 成功后返回替换位置与磁盘回读行数', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'cfg.txt').replace(/\\/g, '/');
        fs.writeFileSync(filePath, ['x=1', 'y=2', 'z=3'].join('\n'), 'utf8');
        const tool = new SearchReplaceTool();

        const result = await tool.executeCommand(
            { filePath: filePath, oldString: 'y=2', newString: 'y=22' },
            createTask(tempDir),
            undefined
        );

        expect(result).toContain('成功替换 1 处');
        expect(result).toContain('原文件第 2 行');
        expect(result).toContain('磁盘回读校验：共 3 行');
    });

    test('searchReplace 多行 newString 时行号是替换首行的行号而非末行', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'cfg2.txt').replace(/\\/g, '/');
        fs.writeFileSync(filePath, ['x=1', 'y=2', 'z=3'].join('\n'), 'utf8');
        const tool = new SearchReplaceTool();

        // y=2 在原文件第 2 行，newString 两行，替换后首行 "y=22" 仍应在第 2 行
        const result = await tool.executeCommand(
            { filePath: filePath, oldString: 'y=2', newString: 'y=22\ny=23' },
            createTask(tempDir),
            undefined
        );

        expect(result).toContain('成功替换 1 处');
        expect(result).toContain('原文件第 2 行');
        expect(result).not.toContain('原文件第 3 行');
    });

    test('writeFile 写入空内容时行数与字节数自洽（0 行 / 0 字节）', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'empty.txt').replace(/\\/g, '/');
        const tool = new WriteFileTool();

        const result = await tool.executeCommand({ path: filePath, mode: 'overwrite', content: '' }, undefined);

        expect(result).toContain('共 0 行 / 0 字节');
        expect(result).not.toContain('共 1 行');
    });

    test('磁盘回读尾部行数文案与实际列出的行数一致', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'two.txt').replace(/\\/g, '/');
        const tool = new WriteFileTool();

        const result = await tool.executeCommand({ path: filePath, mode: 'overwrite', content: 'a\nb' }, undefined);

        expect(result).toContain('尾部 2 行');
        expect(result).not.toContain('尾部 3 行');
        expect(fs.readFileSync(filePath, 'utf8')).toBe('a\nb');
    });

    test('writeFile 尾部超长行会被截断避免撑爆回读锚点', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'long.txt').replace(/\\/g, '/');
        const longLine = 'x'.repeat(500);
        const tool = new WriteFileTool();

        const result = await tool.executeCommand(
            { path: filePath, mode: 'overwrite', content: `a\n${longLine}` },
            undefined
        );

        expect(result).toContain('…');
        expect(result.length).toBeLessThan(longLine.length);
    });
});
