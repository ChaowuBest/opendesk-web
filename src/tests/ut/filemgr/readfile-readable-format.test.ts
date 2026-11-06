import fs from 'fs';
import os from 'os';
import path from 'path';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';
import { ReadFileTool } from '../../../main/applications/filemgr/tools';

let tempRootDir: string | undefined;

function createTempDir(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-readfile-format-'));
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

describe('ReadFileTool 可读文本格式（消除 JSON 包裹回显假象）', () => {
    afterEach(() => {
        cleanupTempDir();
    });

    test('返回多行可读文本而非 JSON 字符串，文件内容保持原样不转义', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'sample.ts').replace(/\\/g, '/');
        const source = [
            'const greeting = "你好，\\"世界\\"";',
            "// 中文注释：expect(interactions(channel).get('sel-1')).toBe(false);",
            'export const answer = 42;'
        ].join('\n');
        fs.writeFileSync(filePath, source, 'utf8');
        const tool = new ReadFileTool();

        const result = await tool.executeCommand({ file_path: filePath }, createTask(tempDir));

        expect(typeof result).toBe('string');
        expect(result.startsWith('{"type"')).toBe(false);
        // 首行元信息：[文件] 路径 · 总行数 · 显示范围
        const firstLine = result.split('\n')[0];
        expect(firstLine).toContain(`[文件] ${filePath}`);
        expect(firstLine).toContain('共 3 行');
        expect(firstLine).toContain('显示第 1-3 行');
        // 正文为 cat -n 风格行号 + 原文（换行保持真实换行，引号不转义）
        expect(result).toContain('\n     1\tconst greeting = "你好，\\"世界\\"";');
        expect(result).toContain("     2\t// 中文注释：expect(interactions(channel).get('sel-1')).toBe(false);");
        expect(result).toContain('     3\texport const answer = 42;');
    });

    test('分段读取时首行标注显示范围', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'big.txt').replace(/\\/g, '/');
        fs.writeFileSync(filePath, 'l1\nl2\nl3\nl4\nl5', 'utf8');
        const tool = new ReadFileTool();

        const result = await tool.executeCommand({ file_path: filePath, offset: 2, limit: 2 }, undefined);

        expect(result.split('\n')[0]).toBe(`[文件] ${filePath} · 共 5 行 · 显示第 2-3 行`);
        expect(result).toContain('     2\tl2');
        expect(result).toContain('     3\tl3');
        expect(result).not.toContain('     4\tl4');
    });

    test('空文件返回空文件提示文本', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'empty.txt').replace(/\\/g, '/');
        fs.writeFileSync(filePath, '', 'utf8');
        const tool = new ReadFileTool();

        const result = await tool.executeCommand({ file_path: filePath }, undefined);

        expect(result).toBe(`[文件] ${filePath} · 空文件（0 行）`);
    });

    test('offset 超出文件末尾时返回范围提示文本', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'short.txt').replace(/\\/g, '/');
        fs.writeFileSync(filePath, 'only', 'utf8');
        const tool = new ReadFileTool();

        const result = await tool.executeCommand({ file_path: filePath, offset: 50 }, undefined);

        expect(result).toBe(`[文件] ${filePath} · 共 1 行 · 第 50 行超出文件末尾`);
    });

    test('重复读取同一文件返回 file_unchanged 可读标记', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'same.txt').replace(/\\/g, '/');
        fs.writeFileSync(filePath, 'alpha\nbeta', 'utf8');
        const task = createTask(tempDir);
        const tool = new ReadFileTool();

        await tool.executeCommand({ file_path: filePath }, task);
        const second = await tool.executeCommand({ file_path: filePath }, task);

        expect(second.startsWith('[文件未变化] ')).toBe(true);
        expect(second).toContain(filePath);
        expect(second).toContain('与上次读取一致');
    });

    test('CLI 渲染空文件时保留文件总行数信息', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'empty.txt').replace(/\\/g, '/');
        fs.writeFileSync(filePath, '', 'utf8');
        const tool = new ReadFileTool();

        const result = await tool.executeCommand({ file_path: filePath }, undefined);
        const cli = tool.renderToolCallCli(
            {
                args_object: { file_path: filePath },
                status: 'success',
                result
            } as any,
            120
        );

        expect(cli?.join('\n')).toContain('0 行');
    });

    test('GUI 渲染空文件时保留文件总行数信息', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'empty.txt').replace(/\\/g, '/');
        fs.writeFileSync(filePath, '', 'utf8');
        const tool = new ReadFileTool();

        const result = await tool.executeCommand({ file_path: filePath }, undefined);
        const html = await tool.renderToolCall({
            args_object: { file_path: filePath },
            status: 'success',
            result
        } as any);

        expect(html).toContain('0 行');
    });
});
