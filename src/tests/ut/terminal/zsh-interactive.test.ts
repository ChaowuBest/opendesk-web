import { jest } from '@jest/globals';
import { EventEmitter } from 'events';

// setting.ts 含 create(import.meta.url) 写法，ts-jest 编译为 CJS 后与 require 标识符冲突，mock 掉
jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: class {
        static getInstance() {
            return {
                getData: () => {
                    throw new Error('Setting not initialized in test');
                },
                getEffectiveWorkspace: () => '/'
            };
        }
    },
    getOpendeskDirectory: () => '/tmp/opendesk-test',
    getLogDirectory: () => '/tmp/opendesk-test/logs'
}));

// 通过 fs mock 控制 findExecutableInPath 的结果（默认构造时动态查找 zsh 的场景）
const existsSyncMock = jest.fn((p: unknown) => typeof p === 'string' && String(p).endsWith('/zsh'));

jest.unstable_mockModule('fs', () => {
    const fsMock = {
        existsSync: (p: unknown) => existsSyncMock(p),
        accessSync: () => undefined,
        mkdirSync: () => undefined,
        constants: { X_OK: 1 }
    };
    return { ...fsMock, default: fsMock };
});

const spawnMock = jest.fn();
const spawnSyncMock = jest.fn();

jest.unstable_mockModule('child_process', () => ({
    spawn: (...args: unknown[]) => spawnMock(...args),
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
    execSync: jest.fn()
}));

const { ExecuteZshTool, setZshPath } = await import('../../../main/applications/terminal/tools.js');
const { clearZshExitNoiseCache } = await import('../../../main/utils/shellExec.js');
const { ToolResult } = await import('../../../main/aikernel/tool.js');

function createFakeProc() {
    const proc = new EventEmitter() as any;
    proc.pid = 4242;
    proc.stdin = { end: jest.fn() };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = jest.fn();
    return proc;
}

function resetMocks() {
    setZshPath('/usr/bin/zsh');
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
    // 探测默认返回干净输出（/etc/zshrc source smartshell.zsh 等无噪音 trap 环境）
    spawnSyncMock.mockImplementation(() => ({ status: 0, stdout: '', stderr: '' }));
    clearZshExitNoiseCache();
    existsSyncMock.mockReset();
    existsSyncMock.mockImplementation((p: unknown) => typeof p === 'string' && String(p).endsWith('/zsh'));
}

// executeCommand 在 spawn 之前已 await runPluginShellEnv 让出控制权，测试事件必须在
// spawn 发生且 stdout/stderr/close listener 全部注册完成后的下一轮 microtask 再触发
function spawnWithEvents(proc: any, emit: (proc: any) => void) {
    spawnMock.mockImplementation(() => {
        queueMicrotask(() => emit(proc));
        return proc;
    });
}

async function runTool(tool: InstanceType<typeof ExecuteZshTool>, command: string) {
    const result = new ToolResult();
    const proc = createFakeProc();
    spawnWithEvents(proc, (p) => p.emit('close', 0));
    const pending = tool.executeCommand({ command, timeout: 5000 } as any, result);
    await pending;
    return result;
}

describe('ExecuteZshTool custom path and interactive mode', () => {
    beforeEach(resetMocks);

    test('spawn uses -i -c args with trap prefix when exit-trap noise is detected', async () => {
        // /etc/zshrc 无条件 trap preexit EXIT 的版本：探测输出含 saving history
        spawnSyncMock.mockImplementation(() => ({
            status: 0,
            stdout: 'saving history...\ncompleted.\n',
            stderr: ''
        }));
        const tool = new ExecuteZshTool(true);
        const result = await runTool(tool, 'echo hi');

        expect(spawnSyncMock).toHaveBeenCalledWith('/usr/bin/zsh', ['-i', '-c', 'true'], expect.anything());
        // 前置 trap - EXIT 清除噪音 trap，保证输出确定性
        expect(spawnMock).toHaveBeenCalledWith('/usr/bin/zsh', ['-i', '-c', 'trap - EXIT; echo hi'], expect.anything());
        // 进程 close 后工具已写入结果（无输出时为退出码提示）
        expect(result.result.length).toBeGreaterThan(0);
    });

    test('spawn keeps command untouched when probe is clean (smartshell variants)', async () => {
        // /etc/zshrc 仅 source /etc/smartshell.zsh 的版本：探测干净则原样执行，
        // 不得用 trap - EXIT 误伤 smartshell 可能依赖的 EXIT trap
        const tool = new ExecuteZshTool(true);
        await runTool(tool, 'echo hi');

        expect(spawnSyncMock).toHaveBeenCalledWith('/usr/bin/zsh', ['-i', '-c', 'true'], expect.anything());
        expect(spawnMock).toHaveBeenCalledWith('/usr/bin/zsh', ['-i', '-c', 'echo hi'], expect.anything());
    });
});

describe('stdout noise filtering in interactive mode', () => {
    beforeEach(resetMocks);

    test('filters OSC shell-integration event sequences (BEL-terminated) from stdout', async () => {
        // 复现 OpenHarmony 真机场景：.zshrc 中的 shell integration 在启动时向 stdout
        // 输出 OSC 9278 事件（如 \x1b]9278;f;{"event": "SetupComplete"}\x07），与命令输出同流
        const tool = new ExecuteZshTool(true);
        const result = new ToolResult();
        const proc = createFakeProc();
        spawnWithEvents(proc, (p) => {
            p.stdout.emit('data', Buffer.from('\x1b]9278;f;{"event": "SetupComplete"}\x07'));
            p.stdout.emit('data', Buffer.from('make_ppt.py\ntest_pptx.py\n通用演示文稿.pptx'));
            p.emit('close', 0);
        });

        const pending = tool.executeCommand({ command: 'ls', timeout: 5000 } as any, result);
        await pending;

        expect(result.result).not.toContain('\x1b');
        expect(result.result).not.toContain('SetupComplete');
        expect(result.result).not.toContain('9278');
        expect(result.result).toContain('make_ppt.py');
        expect(result.result).toContain('test_pptx.py');
        expect(result.result).toContain('通用演示文稿.pptx');
    });

    test('filters OSC sequences with ST terminator and cwd warnings from stdout', async () => {
        const tool = new ExecuteZshTool(true);
        const result = new ToolResult();
        const proc = createFakeProc();
        spawnWithEvents(proc, (p) => {
            // ST 结尾的 OSC 序列（如设置窗口标题 \x1b]0;title\x1b\\）
            p.stdout.emit('data', Buffer.from('\x1b]0;user@host\x1b\\'));
            p.stdout.emit(
                'data',
                Buffer.from(
                    'chdir: error retrieving current directory: getcwd: cannot access parent directories: Permission denied\n'
                )
            );
            p.stdout.emit('data', Buffer.from('real stdout output\n'));
            p.emit('close', 0);
        });

        const pending = tool.executeCommand({ command: 'ls', timeout: 5000 } as any, result);
        await pending;

        expect(result.result).not.toContain('\x1b');
        expect(result.result).not.toContain('user@host');
        expect(result.result).not.toContain('chdir');
        expect(result.result).toContain('real stdout output');
    });

    test('does not swallow command output when a dangling OSC start marker precedes it', async () => {
        // 复现真机事故（OpenHarmony + Warp shell integration）：marker 起始符 ESC] 与
        // 终止 BEL 分离写入，中间夹着 ls 的输出。若 payload 允许跨行，从悬空起始符到
        // 迟到 BEL 之间的命令输出会被整体当作 payload 吞掉（result 仅剩
        // "saving history...\ncompleted."）。信息保全优先：无终止符的残段整体保留
        const tool = new ExecuteZshTool(true);
        const result = new ToolResult();
        const proc = createFakeProc();
        spawnWithEvents(proc, (p) => {
            p.stdout.emit('data', Buffer.from('\x1b]9278;f;{"event": "PreExec"}'));
            p.stdout.emit('data', Buffer.from('make_ppt.py\ntest_pptx.py\n通用演示文稿.pptx\n'));
            p.stdout.emit('data', Buffer.from('\x07saving history...\ncompleted.'));
            p.emit('close', 0);
        });

        const pending = tool.executeCommand({ command: 'ls', timeout: 5000 } as any, result);
        await pending;

        // 命令输出必须保留
        expect(result.result).toContain('make_ppt.py');
        expect(result.result).toContain('test_pptx.py');
        expect(result.result).toContain('通用演示文稿.pptx');
        expect(result.result).toContain('saving history...');
        // 孤立 BEL 被剔除
        expect(result.result).not.toContain('\x07');
        // 悬空起始符无终止 BEL，作为残段保留（保全信息优先于美观）
        expect(result.result).toContain('{"event": "PreExec"}');
    });
});
