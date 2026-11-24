import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const spawnMock = jest.fn();
const execFileMock = jest.fn();

jest.unstable_mockModule('child_process', () => ({
    spawn: spawnMock,
    execFile: execFileMock
}));

jest.unstable_mockModule('../../../main/aikernel/interaction/tools.js', () => ({
    createInteractionToolset: jest.fn()
}));

jest.unstable_mockModule('../../../platforms/proxy-fetch.js', () => ({
    fetchWithResolvedProxy: jest.fn()
}));

jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: {
        getInstance: () => ({
            getData: () => ({
                network_config: { no_ssl: false, use_proxy: 'system', custom_proxy_addr: '', no_proxy: '' }
            })
        })
    }
}));

// CliPlatform 顶层静态引入了全部内置应用，仅替换为空类以满足加载，测试本身不触碰它们
const builtinApplications: [string, string][] = [
    ['mobileaccess', 'MobileAccessApplication'],
    ['mailbox', 'MailboxApplication'],
    ['filemgr', 'FileMgrApplication'],
    ['calendar', 'CalendarApplication'],
    ['search', 'SearchApplication'],
    ['terminal', 'TerminalApplication'],
    ['mcpmgr', 'McpMgrApplication'],
    ['todomgr', 'TodoMgrApplication'],
    ['skillmgr', 'SkillMgrApplication'],
    ['channelmgr', 'ChannelMgrApplication'],
    ['knowledgebase', 'KnowledgeBaseApplication'],
    ['devicemgr', 'DeviceMgrApplication'],
    ['builtin', 'BuiltinApplication'],
    ['appmgr', 'AppMgrApplication'],
    ['agentoffice', 'AgentOfficeApplication'],
    ['pluginmgr', 'PluginMgrApplication'],
    ['acpmgr', 'AcpMgrApplication']
];
for (const [dir, className] of builtinApplications) {
    jest.unstable_mockModule(`../../../main/applications/${dir}/app.js`, () => ({
        [className]: class {}
    }));
}

const { CliPlatform } = await import('../../../platforms/cli.js');

type LaunchListener = (...args: unknown[]) => void;

/** 可手动触发事件的最小子进程替身 */
class FakeChild {
    private readonly handlers = new Map<string, LaunchListener[]>();
    readonly unref = jest.fn<() => void>();

    on(event: string, listener: LaunchListener): this {
        const listeners = this.handlers.get(event) ?? [];
        listeners.push(listener);
        this.handlers.set(event, listeners);
        return this;
    }

    once(event: string, listener: LaunchListener): this {
        return this.on(event, listener);
    }

    removeListener(event: string, listener: LaunchListener): this {
        const listeners = this.handlers.get(event) ?? [];
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
        return this;
    }

    emit(event: string, ...args: unknown[]): void {
        for (const listener of [...(this.handlers.get(event) ?? [])]) {
            listener(...args);
        }
    }
}

let currentChild: FakeChild | null = null;

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const setProcessPlatform = (value: string): void => {
    Object.defineProperty(process, 'platform', { value, configurable: true });
};

describe('CliPlatform 系统打开（命令注入防护，GitCode issue #188）', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        currentChild = null;
        spawnMock.mockImplementation(() => {
            currentChild = new FakeChild();
            return currentChild;
        });
        execFileMock.mockImplementation(
            (_command: string, _args: string[], _options: unknown, callback: (error: Error | null) => void) => {
                callback(null);
            }
        );
    });

    afterEach(() => {
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor);
        }
    });

    const injectionPayload = 'a" & calc & echo "';

    test('win32 openPath: 以 explorer.exe 单参数派发且不使用 shell', async () => {
        setProcessPlatform('win32');
        const platform = new CliPlatform();
        const pending = platform.openPath('C:\\a b\\文件.txt');
        currentChild!.emit('spawn');
        await pending;
        expect(spawnMock).toHaveBeenCalledWith(
            'explorer.exe',
            ['C:\\a b\\文件.txt'],
            expect.objectContaining({ shell: false, stdio: 'ignore' })
        );
        expect(execFileMock).not.toHaveBeenCalled();
    });

    test('win32 showItemInFolder: 恶意路径连同 /select 保持为单个参数，不会拆出命令', async () => {
        setProcessPlatform('win32');
        const platform = new CliPlatform();
        const pending = platform.showItemInFolder(injectionPayload);
        currentChild!.emit('spawn');
        await pending;
        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(spawnMock).toHaveBeenCalledWith('explorer.exe', [`/select,${injectionPayload}`], expect.anything());
        expect(execFileMock).not.toHaveBeenCalled();
    });

    test('win32 openExternal: 含 & 的 URL 作为单个参数整体传递', async () => {
        setProcessPlatform('win32');
        const platform = new CliPlatform();
        const pending = platform.openExternal('https://example.com/?a=1&b=2');
        currentChild!.emit('spawn');
        await pending;
        expect(spawnMock).toHaveBeenCalledWith('explorer.exe', ['https://example.com/?a=1&b=2'], expect.anything());
    });

    test('win32: spawn 事件即完成并 unref，不等待进程退出', async () => {
        setProcessPlatform('win32');
        const platform = new CliPlatform();
        const pending = platform.openPath('C:\\a.txt');
        // 只派发 spawn 事件、不派发 exit：若实现错误地等待进程退出，这里会超时失败
        currentChild!.emit('spawn');
        await Promise.race([
            pending,
            new Promise<never>((_resolve, reject) => {
                setTimeout(() => reject(new Error('spawn 成功后未及时完成')), 150);
            })
        ]);
        expect(currentChild!.unref).toHaveBeenCalled();
    });

    test('win32: spawn 失败向上传播', async () => {
        setProcessPlatform('win32');
        const platform = new CliPlatform();
        const pending = platform.openPath('C:\\a.txt');
        const spawnError = new Error('spawn explorer.exe ENOENT');
        currentChild!.emit('error', spawnError);
        await expect(pending).rejects.toBe(spawnError);
    });

    test('darwin openPath/showItemInFolder: open 与 open -R 以独立参数执行', async () => {
        setProcessPlatform('darwin');
        const platform = new CliPlatform();
        await platform.openPath('/tmp/a b.txt');
        expect(execFileMock).toHaveBeenCalledWith('open', ['/tmp/a b.txt'], expect.anything(), expect.any(Function));
        await platform.showItemInFolder(injectionPayload);
        expect(execFileMock).toHaveBeenCalledWith(
            'open',
            ['-R', injectionPayload],
            expect.anything(),
            expect.any(Function)
        );
        expect(spawnMock).not.toHaveBeenCalled();
    });

    test('darwin: 子进程失败向上传播', async () => {
        setProcessPlatform('darwin');
        execFileMock.mockImplementationOnce(
            (_command: string, _args: string[], _options: unknown, callback: (error: Error | null) => void) => {
                callback(new Error('open: file does not exist'));
            }
        );
        const platform = new CliPlatform();
        await expect(platform.openPath('/tmp/missing.txt')).rejects.toThrow('open: file does not exist');
    });

    test('linux openExternal: xdg-open 单参数执行，URL 不被 shell 拆分', async () => {
        setProcessPlatform('linux');
        const platform = new CliPlatform();
        await platform.openExternal('https://example.com/?a=1&b=2');
        expect(execFileMock).toHaveBeenCalledWith(
            'xdg-open',
            ['https://example.com/?a=1&b=2'],
            expect.anything(),
            expect.any(Function)
        );
        expect(spawnMock).not.toHaveBeenCalled();
    });

    test('openharmony: 不发起任何系统调用', async () => {
        setProcessPlatform('openharmony');
        const platform = new CliPlatform();
        await platform.openPath('C:\\a.txt');
        await platform.openExternal('https://example.com');
        await platform.showItemInFolder('C:\\a.txt');
        expect(spawnMock).not.toHaveBeenCalled();
        expect(execFileMock).not.toHaveBeenCalled();
    });
});
