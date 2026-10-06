// node 测试文件按仓库规范不在顶部放置开源协议头
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filePathToFileUrl } from '../../../common/file-url.js';
import {
    normalizeExplorerFilePath,
    buildFileBreadcrumbSegments,
    parentDirPath,
    explorerPathsEqual,
    isPathUnder
} from '../../../common/utils/path.js';

test('normalizeExplorerFilePath converts backslashes to forward slashes', () => {
    assert.equal(
        normalizeExplorerFilePath('D:\\Projects\\OpenDesk\\src\\main\\aikernel\\tool.ts'),
        'D:/Projects/OpenDesk/src/main/aikernel/tool.ts'
    );
    // 已为正斜杠的路径保持原样
    assert.equal(normalizeExplorerFilePath('D:/Projects/OpenDesk/src/main.ts'), 'D:/Projects/OpenDesk/src/main.ts');
    // 历史消息中的 POSIX 盘符前缀形式也规范化
    assert.equal(normalizeExplorerFilePath('/C:/Users/tester/a.txt'), 'C:/Users/tester/a.txt');
});

test('parentDirPath handles backslash Windows paths', () => {
    // 反斜杠路径必须返回真实父目录，而不是路径自身（旧逻辑的 bug 根因）
    assert.equal(
        parentDirPath('D:\\Projects\\OpenDesk\\src\\main\\aikernel\\tool.ts'),
        'D:/Projects/OpenDesk/src/main/aikernel'
    );
    assert.equal(
        parentDirPath('D:/Projects/OpenDesk/src/main/aikernel/tool.ts'),
        'D:/Projects/OpenDesk/src/main/aikernel'
    );
    // 盘符根 / 根级路径返回自身（边界）
    assert.equal(parentDirPath('D:/Projects'), 'D:');
    assert.equal(parentDirPath('D:'), 'D:');
    assert.equal(parentDirPath('tool.ts'), 'tool.ts');
});

test('buildFileBreadcrumbSegments builds hierarchy for forward-slash path inside workspace', () => {
    const segments = buildFileBreadcrumbSegments(
        'D:/Projects/OpenDesk/src/main/aikernel/tool.ts',
        'D:/Projects/OpenDesk'
    );
    assert.deepEqual(segments, [
        { name: 'src', dir: 'D:/Projects/OpenDesk/src' },
        { name: 'main', dir: 'D:/Projects/OpenDesk/src/main' },
        { name: 'aikernel', dir: 'D:/Projects/OpenDesk/src/main/aikernel' },
        { name: 'tool.ts', dir: 'D:/Projects/OpenDesk/src/main/aikernel' }
    ]);
});

test('buildFileBreadcrumbSegments builds hierarchy for backslash path from chat click (bug regression)', () => {
    // 用户在对话中点击文件时传入的是 Windows 反斜杠绝对路径，必须能正确分级，
    // 且最后一段（文件名）的 dir 必须是其父目录，绝不能被解析成文件自身。
    const segments = buildFileBreadcrumbSegments(
        'D:\\Projects\\OpenDesk\\src\\main\\aikernel\\tool.ts',
        'D:/Projects/OpenDesk'
    );
    assert.deepEqual(segments, [
        { name: 'src', dir: 'D:/Projects/OpenDesk/src' },
        { name: 'main', dir: 'D:/Projects/OpenDesk/src/main' },
        { name: 'aikernel', dir: 'D:/Projects/OpenDesk/src/main/aikernel' },
        { name: 'tool.ts', dir: 'D:/Projects/OpenDesk/src/main/aikernel' }
    ]);
});

test('buildFileBreadcrumbSegments falls back to single segment with parent dir when file is outside workspace', () => {
    const segments = buildFileBreadcrumbSegments('C:\\Users\\tester\\notes.txt', 'D:/Projects/OpenDesk');
    assert.deepEqual(segments, [{ name: 'notes.txt', dir: 'C:/Users/tester' }]);
    // workspace 为空时同样不能把文件自身当作目录
    const noWorkspace = buildFileBreadcrumbSegments('C:\\Users\\tester\\notes.txt', null);
    assert.deepEqual(noWorkspace, [{ name: 'notes.txt', dir: 'C:/Users/tester' }]);
});

test('buildFileBreadcrumbSegments handles workspaceRoot given with backslashes', () => {
    // workspaceRoot 若由外部以反斜杠传入，也应能正确分级
    const segments = buildFileBreadcrumbSegments('D:/Projects/OpenDesk/src/main.ts', 'D:\\Projects\\OpenDesk');
    assert.deepEqual(segments, [
        { name: 'src', dir: 'D:/Projects/OpenDesk/src' },
        { name: 'main.ts', dir: 'D:/Projects/OpenDesk/src' }
    ]);
});

test('explorerPathsEqual is case-insensitive and separator-insensitive', () => {
    // Windows/macOS 默认大小写不敏感文件系统：从对话打开的路径大小写
    // 可能与工作空间列表返回的不一致，仍应判定为同一文件（保证高亮/面包屑选中态）
    assert.equal(explorerPathsEqual('D:/Projects/OpenDesk/tool.ts', 'd:/projects/opendesk/tool.ts'), true);
    // 分隔符混用也视为同一文件
    assert.equal(explorerPathsEqual('D:/Projects/OpenDesk/tool.ts', 'D:\\Projects\\OpenDesk\\tool.ts'), true);
    assert.equal(explorerPathsEqual('/home/user/a.ts', '/HOME/user/a.ts'), true);
    // 确实不同文件不能误判相同
    assert.equal(explorerPathsEqual('D:/Projects/OpenDesk/tool.ts', 'D:/Projects/OpenDesk/other.ts'), false);
});

test('isPathUnder reports containment case-insensitively for workspace membership', () => {
    assert.equal(isPathUnder('D:/Projects/OpenDesk/src/main/tool.ts', 'D:/Projects/OpenDesk'), true);
    // 大小写不一致时仍应认定为位于工作空间下（分级导航需要）
    assert.equal(isPathUnder('D:/Projects/OpenDesk/src/main/tool.ts', 'd:/projects/opendesk'), true);
    assert.equal(isPathUnder('C:/Users/tester/notes.txt', 'D:/Projects/OpenDesk'), false);
});

test('filePathToFileUrl produces a correct base URL for Windows drive paths', () => {
    // Windows 盘符路径必须产出 file:///D:/... （三斜杠），否则会被解析成 host=盘符
    const win = filePathToFileUrl('D:\\workspace\\dist\\index.html');
    assert.equal(win, 'file:///D:/workspace/dist/index.html');
    // POSIX 路径同样正确
    assert.equal(filePathToFileUrl('/home/user/index.html'), 'file:///home/user/index.html');
});
