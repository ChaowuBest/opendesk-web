import { ExtractTextTool, ReadFileTool } from '../../../main/applications/filemgr/tools.js';
import { extractText } from '../../../main/applications/filemgr/parser/extract.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

describe('sanitizePath - 特殊字符路径处理', () => {
    let tempDir: string;
    let workspace: string;
    let testFile: string;
    let workspaceFile: string;

    beforeAll(() => {
        // 创建临时目录作为 workspace
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-test-'));
        workspace = path.join(tempDir, 'workspace');
        fs.mkdirSync(workspace, { recursive: true });

        // 创建测试文件（在 workspace 外部，用于测试绝对路径）
        // sanitizePath 统一使用正斜杠，期望值也需保持一致
        testFile = path.join(tempDir, 'test-file.txt').replace(/\\/g, '/');
        fs.writeFileSync(testFile, 'test content', 'utf8');

        // 创建 workspace 内的测试文件（用于测试相对路径）
        workspaceFile = path.join(workspace, 'relative-test.txt').replace(/\\/g, '/');
        fs.writeFileSync(workspaceFile, 'workspace test content', 'utf8');
    });

    afterAll(() => {
        // 清理临时文件
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe('ExtractTextTool 路径处理', () => {
        const tool = new ExtractTextTool(extractText);

        test('带前导空格的绝对路径应正确处理', async () => {
            const args = { file_path: ` ${testFile}` };
            const result = await tool.executeCommand(args as any);
            const parsed = JSON.parse(result);
            expect(parsed.type).toBe('text');
            expect(parsed.file.filePath).toBe(testFile);
        });

        test('带零宽空格的绝对路径应正确处理', async () => {
            const args = { file_path: `\u200B${testFile}` };
            const result = await tool.executeCommand(args as any);
            const parsed = JSON.parse(result);
            expect(parsed.type).toBe('text');
            expect(parsed.file.filePath).toBe(testFile);
        });

        test('带 BOM 的绝对路径应正确处理', async () => {
            const args = { file_path: `\uFEFF${testFile}` };
            const result = await tool.executeCommand(args as any);
            const parsed = JSON.parse(result);
            expect(parsed.type).toBe('text');
            expect(parsed.file.filePath).toBe(testFile);
        });

        test('带尾随空格的绝对路径应正确处理', async () => {
            const args = { file_path: `${testFile} ` };
            const result = await tool.executeCommand(args as any);
            const parsed = JSON.parse(result);
            expect(parsed.type).toBe('text');
            expect(parsed.file.filePath).toBe(testFile);
        });

        test('带软连字符的路径应正确处理', async () => {
            const args = { file_path: `\u00AD${testFile}` };
            const result = await tool.executeCommand(args as any);
            const parsed = JSON.parse(result);
            expect(parsed.type).toBe('text');
            expect(parsed.file.filePath).toBe(testFile);
        });

        test('正常的绝对路径应正确处理', async () => {
            const args = { file_path: testFile };
            const result = await tool.executeCommand(args as any);
            const parsed = JSON.parse(result);
            expect(parsed.type).toBe('text');
            expect(parsed.file.filePath).toBe(testFile);
        });
    });

    describe('ReadFileTool 路径处理', () => {
        const tool = new ReadFileTool();

        test('带前导空格的绝对路径应正确处理', async () => {
            const args = { file_path: ` ${testFile}` };
            const result = await tool.executeCommand(args as any);
            const parsed = JSON.parse(result);
            expect(parsed.type).toBe('text');
            expect(parsed.file.filePath).toBe(testFile);
        });

        test('带零宽空格的绝对路径应正确处理', async () => {
            const args = { file_path: `\u200B${testFile}` };
            const result = await tool.executeCommand(args as any);
            const parsed = JSON.parse(result);
            expect(parsed.type).toBe('text');
            expect(parsed.file.filePath).toBe(testFile);
        });

        test('带 BOM 的绝对路径应正确处理', async () => {
            const args = { file_path: `\uFEFF${testFile}` };
            const result = await tool.executeCommand(args as any);
            const parsed = JSON.parse(result);
            expect(parsed.type).toBe('text');
            expect(parsed.file.filePath).toBe(testFile);
        });

        test('带尾随空格的绝对路径应正确处理', async () => {
            const args = { file_path: `${testFile} ` };
            const result = await tool.executeCommand(args as any);
            const parsed = JSON.parse(result);
            expect(parsed.type).toBe('text');
            expect(parsed.file.filePath).toBe(testFile);
        });

        test('正常的绝对路径应正确处理', async () => {
            const args = { file_path: testFile };
            const result = await tool.executeCommand(args as any);
            const parsed = JSON.parse(result);
            expect(parsed.type).toBe('text');
            expect(parsed.file.filePath).toBe(testFile);
        });
    });

    describe('相对路径基于 workspace 解析', () => {
        const extractTool = new ExtractTextTool(extractText);
        const readTool = new ReadFileTool();

        test('ExtractTextTool 应正确解析相对路径', async () => {
            // 模拟 taskState 提供 workspace
            const mockTaskState = {
                getWorkspace: () => workspace
            };

            const relativePath = path.relative(workspace, workspaceFile);
            const args = { file_path: relativePath };
            const result = await extractTool.executeCommand(args as any, mockTaskState as any);
            const parsed = JSON.parse(result);
            expect(parsed.type).toBe('text');
            expect(parsed.file.filePath).toBe(workspaceFile);
        });

        test('ReadFileTool 应正确解析相对路径', async () => {
            const mockTaskState = {
                getWorkspace: () => workspace,
                getFileReadState: () => ({
                    get: () => null,
                    set: () => {},
                    has: () => false
                })
            };

            const relativePath = path.relative(workspace, workspaceFile);
            const args = { file_path: relativePath };
            const result = await readTool.executeCommand(args as any, mockTaskState as any);
            const parsed = JSON.parse(result);
            expect(parsed.type).toBe('text');
            expect(parsed.file.filePath).toBe(workspaceFile);
        });
    });
});
