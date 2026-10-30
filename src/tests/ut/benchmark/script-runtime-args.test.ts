import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 仅 mock spawn 层与设置/扫描依赖：runScript 的参数组装是本文件的被测对象
let taskConfig: Record<string, unknown> = {};
jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: class {
        static getInstance() {
            return { getData: () => ({ task_config: taskConfig }) };
        }
    },
    getOpendeskDirectory: () => path.join(os.tmpdir(), 'opendesk-test'),
    getLogDirectory: () => path.join(os.tmpdir(), 'opendesk-test', 'logs')
}));

const scanShells = jest.fn();
jest.unstable_mockModule('../../../main/applications/terminal/scan.js', () => ({
    scanSupportedShells: scanShells,
    scanShells,
    getSupportedShells: scanShells
}));

const spawnMock = jest.fn();
const spawnSyncMock = jest.fn();
jest.unstable_mockModule('child_process', () => ({
    spawn: (...args: unknown[]) => spawnMock(...args),
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args)
}));
jest.unstable_mockModule('node:child_process', () => ({
    spawn: (...args: unknown[]) => spawnMock(...args),
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args)
}));

const { runScript } = await import('../../../main/applications/benchmark/script-runtime.js');
import { setRuntimeLocale } from '../../../locale/index.js';

beforeEach(() => setRuntimeLocale('zh-CN'));
afterEach(() => setRuntimeLocale(null));

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
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
    scanShells.mockReset();
    taskConfig = {};
}

/** spawn 后下一轮 microtask 触发 close，让 listener 注册完成 */
function spawnClosesWith(code: number, stdout = '', stderr = '') {
    spawnMock.mockImplementation(() => {
        const proc = createFakeProc();
        queueMicrotask(() => {
            if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
            if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
            proc.emit('close', code);
        });
        return proc;
    });
}

beforeEach(resetMocks);

/** zsh 只负责加载 ~/.zshrc，脚本本体仍由 bash 执行 */
const ZSH_WRAPPER = 'if command -v bash >/dev/null 2>&1; then exec bash "$1"; else exec zsh "$1"; fi';

describe('runScript 以交互模式执行用例脚本', () => {
    test('bash：spawn 参数为 [-i, scriptPath]（加载 ~/.bashrc 后再跑脚本）', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-args-'));
        const scriptPath = path.join(dir, 'prepare.sh');
        fs.writeFileSync(scriptPath, 'echo ok\n');
        scanShells.mockReturnValue([{ kind: 'bash', path: '/data/service/hnp/bin/bash', sandboxed: false }]);
        spawnClosesWith(0, 'ok\n');

        await runScript({ scriptPath, cwd: dir, env: process.env, logPath: path.join(dir, 'run.log'), timeoutSec: 30 });

        expect(spawnMock).toHaveBeenCalledWith('/data/service/hnp/bin/bash', ['-i', scriptPath], expect.anything());
    });

    test('zsh：先用 zsh -i 加载 ~/.zshrc，再 exec bash 跑脚本', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-args-'));
        const scriptPath = path.join(dir, 'prepare.sh');
        fs.writeFileSync(scriptPath, 'echo ok\n');
        scanShells.mockReturnValue([{ kind: 'zsh', path: '/usr/bin/zsh', sandboxed: false }]);
        spawnClosesWith(0, 'ok\n');

        await runScript({ scriptPath, cwd: dir, env: process.env, logPath: path.join(dir, 'run.log'), timeoutSec: 30 });

        expect(spawnMock).toHaveBeenCalledWith(
            '/usr/bin/zsh',
            ['-i', '-c', ZSH_WRAPPER, 'opendesk-benchmark', scriptPath],
            expect.anything()
        );
    });

    test('设置里选中 zsh 时用 zsh 外套 bash 执行脚本（不再被 bash 抢走）', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-args-'));
        const scriptPath = path.join(dir, 'prepare.sh');
        fs.writeFileSync(scriptPath, 'echo ok\n');
        taskConfig = { shell_path: '/usr/bin/zsh' };
        scanShells.mockReturnValue([
            { kind: 'bash', path: '/data/service/hnp/bin/bash', sandboxed: false },
            { kind: 'zsh', path: '/usr/bin/zsh', sandboxed: false }
        ]);
        spawnClosesWith(0, 'ok\n');

        await runScript({ scriptPath, cwd: dir, env: process.env, logPath: path.join(dir, 'run.log'), timeoutSec: 30 });

        expect(spawnMock).toHaveBeenCalledWith(
            '/usr/bin/zsh',
            ['-i', '-c', ZSH_WRAPPER, 'opendesk-benchmark', scriptPath],
            expect.anything()
        );
    });

    test('脚本失败时 stderr 里的内容进 logError（真实链路语义不变）', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-args-'));
        const scriptPath = path.join(dir, 'prepare.sh');
        fs.writeFileSync(scriptPath, 'exit 3\n');
        scanShells.mockReturnValue([{ kind: 'bash', path: '/bin/bash', sandboxed: false }]);
        spawnClosesWith(3, 'done\n', 'some real error\n');

        const result = await runScript({
            scriptPath,
            cwd: dir,
            env: process.env,
            logPath: path.join(dir, 'run.log'),
            timeoutSec: 30
        });

        expect(result.ok).toBe(false);
        expect(result.logError).toContain('some real error');
    });
});

/**
 * 真实 bash 行为验证见 script-runtime.test.ts 的「runScript 交互模式真实执行」：
 * 本文件 mock 了 child_process，真实执行链路必须放在无 spawn mock 的测试文件里。
 */
