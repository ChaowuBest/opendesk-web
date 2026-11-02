import { jest } from '@jest/globals';
import { EventEmitter } from 'events';

/**
 * Windows 进程树终止不能同步阻塞主进程。
 *
 * 回归背景：killProcessTree 在 win32 上用 `execSync('taskkill /F /T /PID ...')`。
 * 这条路径在「用户点停止」「命令超时转后台」「退出清理」时都会走到，
 * 进程树较大或系统繁忙时 execSync 会冻结主进程数秒——表现为点停止后整个界面卡死。
 * 修复后改为异步 spawn（stdio ignore + windowsHide），主进程不再等待。
 */
const spawnMock = jest.fn();
const execSyncMock = jest.fn();
const spawnSyncMock = jest.fn();

jest.unstable_mockModule('child_process', () => ({
    spawn: (...args: unknown[]) => spawnMock(...args),
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
    execSync: (...args: unknown[]) => execSyncMock(...args),
    default: {
        spawn: (...args: unknown[]) => spawnMock(...args),
        spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
        execSync: (...args: unknown[]) => execSyncMock(...args)
    }
}));

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
    getOpendeskDirectory: () => '/tmp/opendesk-test'
}));

const { killProcessTree, BackgroundProcessManager } = await import('../../../main/applications/terminal/background.js');

function createFakeChild() {
    const child = Object.assign(new EventEmitter(), {
        pid: 4321,
        unref: jest.fn(),
        kill: jest.fn()
    });
    return child;
}

describe('killProcessTree', () => {
    const originalPlatform = process.platform;

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        spawnMock.mockReset();
        execSyncMock.mockReset();
    });

    test('Windows 分支使用异步 spawn，不调用 execSync', () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        const child = createFakeChild();
        spawnMock.mockReturnValueOnce(child);

        killProcessTree({ pid: 4321 } as any);

        expect(execSyncMock).not.toHaveBeenCalled();
        expect(spawnMock).toHaveBeenCalledWith(
            'taskkill',
            ['/F', '/T', '/PID', '4321'],
            expect.objectContaining({ stdio: 'ignore', windowsHide: true })
        );
        // 不等待子进程结束，避免主进程被 taskkill 拖住
        expect(child.unref).toHaveBeenCalled();
    });

    test('taskkill 启动失败（ENOENT 等）时静默吞掉，不影响调用方', () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        const child = createFakeChild();
        spawnMock.mockReturnValueOnce(child);

        expect(() => killProcessTree({ pid: 99 } as any)).not.toThrow();
        // 注册 error 监听，否则 Node 会把 spawn 失败抛成未捕获异常
        expect(child.listenerCount('error')).toBeGreaterThan(0);
        child.emit('error', new Error('ENOENT'));
    });

    test('pid 缺失时不做任何事', () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

        killProcessTree({ pid: undefined } as any);

        expect(spawnMock).not.toHaveBeenCalled();
        expect(execSyncMock).not.toHaveBeenCalled();
    });

    test('taskkill 非 0 退出（拒绝执行）时回落到只杀父进程，避免调用方以为已终止', () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        const killer = createFakeChild();
        const proc = createFakeChild();
        spawnMock.mockReturnValueOnce(killer);

        killProcessTree(proc as any);
        killer.emit('exit', 128);

        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    test('taskkill 成功（exit 0）时不额外杀父进程，保留 /T 的整树语义', () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        const killer = createFakeChild();
        const proc = createFakeChild();
        spawnMock.mockReturnValueOnce(killer);

        killProcessTree(proc as any);
        killer.emit('exit', 0);

        expect(proc.kill).not.toHaveBeenCalled();
    });
});

describe('BackgroundProcessManager.killProcess', () => {
    const originalPlatform = process.platform;

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        spawnMock.mockReset();
    });

    test('Windows 上不先 proc.kill：父进程先死会让 taskkill /T 枚举不到子树', () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        const killer = createFakeChild();
        spawnMock.mockReturnValueOnce(killer);
        const proc = Object.assign(new EventEmitter(), {
            pid: 777,
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            kill: jest.fn()
        });

        const manager = BackgroundProcessManager.getInstance();
        manager.register(proc as any, 'npm run build', '', Date.now());

        expect(manager.killProcess(777)).toBe(true);

        // 交给 taskkill /F /T 处理整棵树，父进程由它一起终结
        expect(proc.kill).not.toHaveBeenCalled();
        expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '777'], expect.anything());
    });
});
