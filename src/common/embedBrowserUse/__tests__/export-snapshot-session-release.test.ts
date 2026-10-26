import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * 回归测试（issue #120）：`exportSnapshot` 每次调用都会建立一次 CDP 会话。
 * 会话一旦建立，`webContents.debugger` 上就多出一组 `message` / `detach`
 * listener，只有 `dispose()` 才会移除；而 `CDPSessionManager.getSession` 还会
 * 为每个会话在 webContents 上注册一个 `'destroyed'` 兜底监听，一次性 manager
 * 无法在 disposeAll 时注销它。所以导出不能走 manager，且成功、取消、
 * capture/write 异常三条返回路径都必须 dispose 会话 —— 否则反复导出
 * （即使每次都取消保存）会持续累积 listener / 闭包。
 *
 * 另一个约束：webContents 上只有一条 CDP 连接。导出时它可能已被浏览器控制器
 * 占用，这时导出会话复用该连接，结束时不得 detach，否则会打断对方正在进行的
 * 自动化操作。
 */

const wcById = new Map<number, any>();
let saveDialogResult: { canceled: boolean; filePath?: string } = { canceled: true };
let captureError: Error | null = null;
/** 最近一次保存对话框收到的选项，用于校验文案来源 */
let lastDialogOptions: any = null;
/** 对话框弹出瞬间各 webContents 的 debugger 状态，用于校验会话已提前释放 */
const dialogTimeStates = new Map<number, { message: number; detach: number; attached: boolean }>();

const fakeSnapshot = {
    url: 'https://example.com/page',
    title: 'Example',
    viewport: { width: 1280, height: 720 },
    scroll: { x: 0, y: 0 },
    ariaSnapshot: '- button "OK"',
    tree: { role: 'RootWebArea', children: [] }
};

jest.unstable_mockModule('electron', () => ({
    webContents: {
        fromId: (id: number) => wcById.get(id)
    },
    BrowserWindow: {
        getFocusedWindow: () => null,
        getAllWindows: () => []
    },
    dialog: {
        showSaveDialog: async (...args: any[]) => {
            lastDialogOptions = args[args.length - 1];
            for (const [id, wc] of wcById) {
                dialogTimeStates.set(id, {
                    message: wc.debuggerListeners.get('message')?.size ?? 0,
                    detach: wc.debuggerListeners.get('detach')?.size ?? 0,
                    attached: wc.debugger.isAttached()
                });
            }
            return saveDialogResult;
        }
    }
}));

jest.unstable_mockModule('../cdp/snapshot.js', () => ({
    captureSnapshot: async () => {
        if (captureError) throw captureError;
        return fakeSnapshot;
    },
    resolveTargetCoords: () => ({ x: 0, y: 0 })
}));

function makeWebContents(id: number, initiallyAttached = false): any {
    const debuggerListeners = new Map<string, Set<(...args: any[]) => void>>();
    /** 记录 webContents 上注册过的一次性监听（destroyed 兜底），用于检查泄漏 */
    const onceEvents: string[] = [];
    let attached = initiallyAttached;
    const wc = {
        id,
        isDestroyed: () => false,
        once: (event: string) => {
            onceEvents.push(event);
        },
        onceEvents,
        debuggerListeners,
        debugger: {
            isAttached: () => attached,
            attach: () => {
                attached = true;
            },
            detach: () => {
                attached = false;
            },
            on: (event: string, listener: (...args: any[]) => void) => {
                if (!debuggerListeners.has(event)) debuggerListeners.set(event, new Set());
                debuggerListeners.get(event)!.add(listener);
            },
            removeListener: (event: string, listener: (...args: any[]) => void) => {
                debuggerListeners.get(event)?.delete(listener);
            },
            sendCommand: async () => ({})
        }
    };
    wcById.set(id, wc);
    return wc;
}

function listenerCounts(wc: any): { message: number; detach: number } {
    return {
        message: wc.debuggerListeners.get('message')?.size ?? 0,
        detach: wc.debuggerListeners.get('detach')?.size ?? 0
    };
}

/** 一次导出结束后不应留下任何会话残留：debugger listener、destroyed 监听 */
function expectNoSessionResidue(wc: any): void {
    expect(listenerCounts(wc)).toEqual({ message: 0, detach: 0 });
    expect(wc.onceEvents).toEqual([]);
}

const { BrowserManager, setSnapshotDialogTextsProvider, setCDPLogger } = await import('../main.js');
const { Channels } = await import('../protocol.js');

const handlers = new Map<string, (...args: any[]) => any>();
BrowserManager.bind({
    handle: (channel: string, listener: (...args: any[]) => any) => {
        handlers.set(channel, listener);
    }
} as any);

const exportSnapshot = handlers.get(Channels.exportSnapshot)!;

describe('embedBrowserUse exportSnapshot releases its one-off CDP session (issue #120)', () => {
    let tmpDir: string;

    beforeAll(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opendesk-snapshot-export-'));
    });

    afterAll(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        saveDialogResult = { canceled: true };
        captureError = null;
        lastDialogOptions = null;
        dialogTimeStates.clear();
        setSnapshotDialogTextsProvider();
        // 默认用静默 logger，避免失败路径把 console 噪音带进测试输出
        setCDPLogger({ warn: () => {}, error: () => {} });
    });

    test('cancel path detaches the debugger and removes every listener', async () => {
        const wc = makeWebContents(9001);

        const result = await exportSnapshot({}, wc.id);

        expect(result).toEqual({ status: 'ok', data: { canceled: true, filePath: null } });
        expectNoSessionResidue(wc);
        expect(wc.debugger.isAttached()).toBe(false);
    });

    test('repeated cancelled exports do not accumulate debugger listeners', async () => {
        const wc = makeWebContents(9002);

        for (let i = 0; i < 5; i++) {
            await exportSnapshot({}, wc.id);
            expectNoSessionResidue(wc);
        }
    });

    test('success path writes the file and releases the session', async () => {
        const wc = makeWebContents(9003);
        const filePath = path.join(tmpDir, 'snapshot.txt');
        saveDialogResult = { canceled: false, filePath };

        const result = await exportSnapshot({}, wc.id);

        expect(result).toEqual({ status: 'ok', data: { canceled: false, filePath } });
        expect(await fs.readFile(filePath, 'utf8')).toContain('- Page URL: https://example.com/page');
        expectNoSessionResidue(wc);
        expect(wc.debugger.isAttached()).toBe(false);
    });

    test('capture error path releases the session and reports the error', async () => {
        const wc = makeWebContents(9004);
        captureError = new Error('capture failed');

        const result = await exportSnapshot({}, wc.id);

        expect(result.status).toBe('error');
        expect(result.message).toContain('capture failed');
        expectNoSessionResidue(wc);
        expect(wc.debugger.isAttached()).toBe(false);
    });

    test('write error path releases the session and reports the error', async () => {
        const wc = makeWebContents(9005);
        // 目录不存在 → fs.writeFile 抛 ENOENT，覆盖 dialog 之后的异常路径
        saveDialogResult = { canceled: false, filePath: path.join(tmpDir, 'missing-dir', 'snapshot.txt') };

        const result = await exportSnapshot({}, wc.id);

        expect(result.status).toBe('error');
        expectNoSessionResidue(wc);
        expect(wc.debugger.isAttached()).toBe(false);
    });

    test('export does not detach a debugger attachment owned by another session', async () => {
        // 模拟浏览器控制器的 CDP 会话已 attach：导出应复用该连接，
        // 结束后不得 detach，否则会打断对方正在进行的操作。
        const wc = makeWebContents(9006, true);

        const result = await exportSnapshot({}, wc.id);

        expect(result).toEqual({ status: 'ok', data: { canceled: true, filePath: null } });
        expectNoSessionResidue(wc);
        expect(wc.debugger.isAttached()).toBe(true);
    });

    test('the one-off session is released before the save dialog opens', async () => {
        // 用户在对话框前停留多久都不该占着 CDP 连接
        const wc = makeWebContents(9012);

        await exportSnapshot({}, wc.id);

        expect(dialogTimeStates.get(wc.id)).toEqual({ message: 0, detach: 0, attached: false });
    });

    test('save dialog falls back to English texts when the host injects nothing', async () => {
        // 库里不得残留硬编码的中文标题：未注入时用英文兜底
        const wc = makeWebContents(9008);

        await exportSnapshot({}, wc.id);

        expect(lastDialogOptions.title).toBe('Save Snapshot');
        expect(lastDialogOptions.filters).toEqual([
            { name: 'Text Files', extensions: ['txt'] },
            { name: 'All Files', extensions: ['*'] }
        ]);
    });

    test('save dialog uses the texts injected by the host', async () => {
        // 宿主（主进程）按当前语言注入标题与过滤器名称
        setSnapshotDialogTextsProvider(() => ({
            title: '保存 Snapshot',
            textFiles: '文本文件',
            allFiles: '所有文件'
        }));
        const wc = makeWebContents(9009);

        await exportSnapshot({}, wc.id);

        expect(lastDialogOptions.title).toBe('保存 Snapshot');
        expect(lastDialogOptions.filters).toEqual([
            { name: '文本文件', extensions: ['txt'] },
            { name: '所有文件', extensions: ['*'] }
        ]);
    });

    test('save dialog texts follow the host locale at call time', async () => {
        // 语言可在运行时切换：provider 每次导出都会被调用，不能缓存首次结果
        let zh = true;
        setSnapshotDialogTextsProvider(() => ({ title: zh ? '保存 Snapshot' : 'Save Snapshot' }));
        const wc = makeWebContents(9010);

        await exportSnapshot({}, wc.id);
        expect(lastDialogOptions.title).toBe('保存 Snapshot');

        zh = false;
        await exportSnapshot({}, wc.id);
        expect(lastDialogOptions.title).toBe('Save Snapshot');
    });

    test('a throwing texts provider falls back to the built-in texts', async () => {
        setSnapshotDialogTextsProvider(() => {
            throw new Error('locale unavailable');
        });
        const wc = makeWebContents(9011);

        await exportSnapshot({}, wc.id);

        expect(lastDialogOptions.title).toBe('Save Snapshot');
    });

    test('a failed export is logged so the cause is visible in the app log', async () => {
        // 渲染端只会弹一次提示；attach 失败 / CDP 超时 / 写盘失败的具体原因只能靠日志
        const warn = jest.fn<any>();
        setCDPLogger({ warn, error: () => {} });
        const wc = makeWebContents(9013);
        captureError = new Error('capture failed');

        const result = await exportSnapshot({}, wc.id);

        expect(result.status).toBe('error');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('exportSnapshot failed');
        expect(warn.mock.calls[0][0]).toContain('webContentsId=9013');
        expect(warn.mock.calls[0][0]).toContain('capture failed');
    });

    test('a failed attach does not leave the one-off session s listeners behind', async () => {
        // attach 抛错（如 DevTools 已占用 debugger）时导出直接失败：create 内部
        // 已经注册了 message/detach 监听，必须由 create 自己收回，否则每次失败
        // 的导出都会在页面上多留一组闭包。
        const wc = makeWebContents(9007);
        wc.debugger.attach = () => {
            throw new Error('Debugger is already attached to the target');
        };

        const result = await exportSnapshot({}, wc.id);

        expect(result.status).toBe('error');
        expect(result.message).toContain('Failed to attach CDP debugger');
        expectNoSessionResidue(wc);
    });
});
