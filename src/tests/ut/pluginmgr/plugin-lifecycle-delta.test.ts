import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { PluginMgrApplication } from '../../../main/applications/pluginmgr/app.js';
import {
    applyPluginEnabledChange,
    applyPluginInstall,
    disposePluginHost,
    initializePluginHost
} from '../../../main/applications/pluginmgr/runtime/bootstrap.js';
import { getPluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { installPlugin } from '../../../main/applications/pluginmgr/management/manager.js';
import { getPluginsDirectory } from '../../../main/applications/pluginmgr/management/paths.js';
import { AgentRegistry } from '../../../main/aikernel/agents/registry.js';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

/**
 * 卸载必须是"差量"的：只释放被卸载的插件，其他插件实例保持运行。
 * 历史实现是 dispose + 全量 reload，会让所有插件（含内置渠道插件）重新 import + setup，
 * 卸载时主进程被阻塞数秒、界面无响应。
 */

function writePluginSource(directory: string, id: string, manifestExtras: Record<string, unknown> = {}): void {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
        path.join(directory, 'opendesk.plugin.json'),
        JSON.stringify({ id, entry: './index.mjs', apiVersion: 1, capabilities: [], ...manifestExtras })
    );
    // setup 时在自己的数据目录里累计一次启动次数，用于判断插件是否被重新激活
    fs.writeFileSync(
        path.join(directory, 'index.mjs'),
        `import fs from 'node:fs';
import path from 'node:path';
export default {
    id: '${id}',
    setup(ctx) {
        const counter = path.join(ctx.dataDir, 'setup-count.txt');
        const previous = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf-8')) || 0 : 0;
        fs.writeFileSync(counter, String(previous + 1));
    }
};`
    );
}

describe('pluginmgr 卸载差量化', () => {
    let configDirectory: string;
    let previousBuiltinPluginsDirectory: string | undefined;
    let sourcesDirectory: string;

    beforeEach(() => {
        configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-uninstall-'));
        sourcesDirectory = path.join(configDirectory, 'sources');
        // 隔离内置插件目录，避免加载仓库里真实的内置插件
        previousBuiltinPluginsDirectory = process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY;
        process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY = path.join(configDirectory, 'builtin');
        setCustomOpendeskDirectory(configDirectory);
        Setting.clearCache();
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await disposePluginHost();
        Setting.clearCache();
        setCustomOpendeskDirectory(undefined);
        if (previousBuiltinPluginsDirectory === undefined) delete process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY;
        else process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY = previousBuiltinPluginsDirectory;
        fs.rmSync(configDirectory, { recursive: true, force: true });
    });

    function setupCount(id: string): number {
        const file = path.join(getPluginsDirectory(configDirectory), '.pluginmgr', 'data', id, 'setup-count.txt');
        return fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf-8')) : 0;
    }

    test('卸载只释放目标插件，其他插件不会被重新加载', async () => {
        writePluginSource(path.join(sourcesDirectory, 'target-plugin'), 'target-plugin');
        writePluginSource(path.join(sourcesDirectory, 'bystander-plugin'), 'bystander-plugin');
        await installPlugin(path.join(sourcesDirectory, 'target-plugin'), { configDirectory });
        await installPlugin(path.join(sourcesDirectory, 'bystander-plugin'), { configDirectory });

        await initializePluginHost();
        expect(getPluginHost().get('target-plugin')?.status).toBe('active');
        expect(getPluginHost().get('bystander-plugin')?.status).toBe('active');
        expect(setupCount('target-plugin')).toBe(1);
        expect(setupCount('bystander-plugin')).toBe(1);

        const application = new PluginMgrApplication();
        await expect(application.uninstall('target-plugin')).resolves.toEqual({ success: true, id: 'target-plugin' });

        // 目标插件已从运行时移除，旁观插件仍是同一个实例（setup 没有被再次调用）
        expect(getPluginHost().get('target-plugin')).toBeUndefined();
        expect(getPluginHost().get('bystander-plugin')?.status).toBe('active');
        expect(setupCount('bystander-plugin')).toBe(1);
    });

    test('不可卸载的插件不会被先拆掉再装回来', async () => {
        // 内置插件不可卸载：应用层应先做可卸载检查，直接拒绝，不触碰正在运行的实例
        writePluginSource(path.join(configDirectory, 'builtin', 'builtin-plugin'), 'builtin-plugin');
        await initializePluginHost();
        expect(getPluginHost().get('builtin-plugin')?.status).toBe('active');
        expect(setupCount('builtin-plugin')).toBe(1);

        const application = new PluginMgrApplication();
        await expect(application.uninstall('builtin-plugin')).rejects.toThrow();

        // 实例仍是同一个（setup 没有被再次调用），数据目录也原样保留
        expect(getPluginHost().get('builtin-plugin')?.status).toBe('active');
        expect(setupCount('builtin-plugin')).toBe(1);
    });

    test('差量收尾刷新失败不影响卸载结果', async () => {
        // 收尾（刷新派生注册表）发生在实例已释放、磁盘已删除之后：
        // 它失败不能把已经完成的卸载改判为失败，否则用户会重试一个不存在的插件
        writePluginSource(path.join(sourcesDirectory, 'teardown-fail'), 'teardown-fail');
        await installPlugin(path.join(sourcesDirectory, 'teardown-fail'), { configDirectory });
        await initializePluginHost();
        expect(getPluginHost().get('teardown-fail')?.status).toBe('active');

        const agentSpy = jest
            .spyOn(AgentRegistry, 'replacePluginAgents')
            .mockRejectedValue(new Error('agent registry boom'));
        try {
            const application = new PluginMgrApplication();
            await expect(application.uninstall('teardown-fail')).resolves.toEqual({
                success: true,
                id: 'teardown-fail'
            });
        } finally {
            agentSpy.mockRestore();
        }

        expect(getPluginHost().get('teardown-fail')).toBeUndefined();
        expect(fs.existsSync(path.join(getPluginsDirectory(configDirectory), 'teardown-fail'))).toBe(false);
    });

    test('删除磁盘失败时把已释放的插件装回去，不让它凭空消失', async () => {
        writePluginSource(path.join(sourcesDirectory, 'sticky-plugin'), 'sticky-plugin');
        await installPlugin(path.join(sourcesDirectory, 'sticky-plugin'), { configDirectory });
        await initializePluginHost();
        expect(getPluginHost().get('sticky-plugin')?.status).toBe('active');
        expect(setupCount('sticky-plugin')).toBe(1);

        const managedDirectory = path.join(getPluginsDirectory(configDirectory), 'sticky-plugin');
        const originalRename = fs.promises.rename.bind(fs.promises);
        const rename = jest.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
            if (path.resolve(String(source)) === managedDirectory) {
                // EIO 不在 moveToTrash 的重试码内：直接判定卸载失败
                const error = new Error('io error') as NodeJS.ErrnoException;
                error.code = 'EIO';
                throw error;
            }
            await originalRename(source, destination);
        });

        const application = new PluginMgrApplication();
        // 事件是渠道等订阅方「按宿主注册表自愈」的唯一入口，失败路径也必须广播
        const emitSpy = jest.spyOn(application, 'emitEvent').mockResolvedValue(undefined as never);
        try {
            await expect(application.uninstall('sticky-plugin')).rejects.toThrow();
        } finally {
            rename.mockRestore();
        }

        // 卸载没成功：磁盘目录还在，运行时也要恢复成卸载前的状态
        expect(fs.existsSync(managedDirectory)).toBe(true);
        expect(getPluginHost().get('sticky-plugin')?.status).toBe('active');
        expect(setupCount('sticky-plugin')).toBe(2);
        expect(emitSpy).toHaveBeenCalledWith('pluginsChanged', {
            operation: 'uninstall',
            id: 'sticky-plugin'
        });
    });
});

describe('pluginmgr 安装差量化', () => {
    let configDirectory: string;
    let previousBuiltinPluginsDirectory: string | undefined;
    let sourcesDirectory: string;

    beforeEach(() => {
        configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-install-'));
        sourcesDirectory = path.join(configDirectory, 'sources');
        previousBuiltinPluginsDirectory = process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY;
        process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY = path.join(configDirectory, 'builtin');
        setCustomOpendeskDirectory(configDirectory);
        Setting.clearCache();
    });

    afterEach(async () => {
        await jest.restoreAllMocks();
        await disposePluginHost();
        Setting.clearCache();
        setCustomOpendeskDirectory(undefined);
        if (previousBuiltinPluginsDirectory === undefined) delete process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY;
        else process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY = previousBuiltinPluginsDirectory;
        fs.rmSync(configDirectory, { recursive: true, force: true });
    });

    function setupCount(id: string): number {
        const file = path.join(getPluginsDirectory(configDirectory), '.pluginmgr', 'data', id, 'setup-count.txt');
        return fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf-8')) : 0;
    }

    test('安装只加载新插件，已有插件不会被重新加载', async () => {
        const application = new PluginMgrApplication();
        writePluginSource(path.join(sourcesDirectory, 'bystander-plugin'), 'bystander-plugin');
        await expect(application.install(path.join(sourcesDirectory, 'bystander-plugin'))).resolves.toMatchObject({
            success: true,
            id: 'bystander-plugin'
        });
        expect(setupCount('bystander-plugin')).toBe(1);

        writePluginSource(path.join(sourcesDirectory, 'newbie-plugin'), 'newbie-plugin');
        await expect(application.install(path.join(sourcesDirectory, 'newbie-plugin'))).resolves.toMatchObject({
            success: true,
            id: 'newbie-plugin'
        });

        expect(getPluginHost().get('newbie-plugin')?.status).toBe('active');
        expect(setupCount('newbie-plugin')).toBe(1);
        expect(setupCount('bystander-plugin')).toBe(1);
    });

    test('覆盖安装先释放旧实例，插件目录被占用时也能替换', async () => {
        const application = new PluginMgrApplication();
        const sourceDirectory = path.join(sourcesDirectory, 'overwrite-plugin');
        writePluginSource(sourceDirectory, 'overwrite-plugin');
        await application.install(sourceDirectory);
        expect(getPluginHost().get('overwrite-plugin')?.status).toBe('active');

        // 模拟 Windows：插件实例还在运行时，插件目录无法被 rename
        const managedDirectory = path.join(getPluginsDirectory(configDirectory), 'overwrite-plugin');
        const originalRenameSync = fs.renameSync.bind(fs);
        const originalRename = fs.promises.rename.bind(fs.promises);
        const lockedError = () => {
            const error = new Error('directory is in use') as NodeJS.ErrnoException;
            error.code = 'EPERM';
            return error;
        };
        jest.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
            if (path.resolve(String(source)) === managedDirectory && getPluginHost().get('overwrite-plugin')) {
                throw lockedError();
            }
            originalRenameSync(source, destination);
        });
        jest.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
            if (path.resolve(String(source)) === managedDirectory && getPluginHost().get('overwrite-plugin')) {
                throw lockedError();
            }
            await originalRename(source, destination);
        });

        // 覆盖安装：内容是新的，但 id 不变
        writePluginSource(sourceDirectory, 'overwrite-plugin');
        fs.appendFileSync(path.join(sourceDirectory, 'index.mjs'), '\n// v2\n');

        await expect(application.install(sourceDirectory)).resolves.toMatchObject({
            success: true,
            id: 'overwrite-plugin'
        });

        expect(getPluginHost().get('overwrite-plugin')?.status).toBe('active');
        // 旧实例被释放、新实例完成一次 setup
        expect(setupCount('overwrite-plugin')).toBe(2);
    });

    test('安装撞上内置插件 ID 时不会先释放内置实例', async () => {
        // 内置插件占用了同名 id：本地安装会被拒绝，且不应先把内置实例拆掉
        writePluginSource(path.join(configDirectory, 'builtin', 'builtin-plugin'), 'builtin-plugin');
        await initializePluginHost();
        expect(setupCount('builtin-plugin')).toBe(1);

        const sourceDirectory = path.join(sourcesDirectory, 'builtin-plugin');
        writePluginSource(sourceDirectory, 'builtin-plugin');

        const application = new PluginMgrApplication();
        await expect(application.install(sourceDirectory)).rejects.toThrow();

        expect(getPluginHost().get('builtin-plugin')?.status).toBe('active');
        expect(setupCount('builtin-plugin')).toBe(1);
    });

    test('平台不满足的本地安装原样抛结构化串供渲染层弹模态', async () => {
        // 渲染层靠结构化串识别平台闸门并弹模态；若走 describeInstallFailure 的合成消息
        // （文案 + 原始串），界面解析不出原因，只能落回默认系统通知
        const sourceDirectory = path.join(sourcesDirectory, 'other-platform-plugin');
        writePluginSource(sourceDirectory, 'other-platform-plugin', { platforms: ['openharmony'] });

        const application = new PluginMgrApplication();
        await expect(application.install(sourceDirectory)).rejects.toThrow(
            'plugin.install_platform_unsupported:other-platform-plugin:openharmony'
        );
    });

    test('覆盖安装失败时旧插件被装回运行时，并广播变更', async () => {
        const sourceDirectory = path.join(sourcesDirectory, 'overwrite-fail');
        writePluginSource(sourceDirectory, 'overwrite-fail');
        await installPlugin(sourceDirectory, { configDirectory });
        await initializePluginHost();
        expect(getPluginHost().get('overwrite-fail')?.status).toBe('active');
        expect(setupCount('overwrite-fail')).toBe(1);

        // 提交阶段（旧目录移入 trash）失败：EIO 不在 moveToTrash 的重试码内
        const managedDirectory = path.join(getPluginsDirectory(configDirectory), 'overwrite-fail');
        const originalRename = fs.promises.rename.bind(fs.promises);
        const rename = jest.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
            if (path.resolve(String(source)) === managedDirectory) {
                const error = new Error('io error') as NodeJS.ErrnoException;
                error.code = 'EIO';
                throw error;
            }
            await originalRename(source, destination);
        });

        const application = new PluginMgrApplication();
        const emitSpy = jest.spyOn(application, 'emitEvent').mockResolvedValue(undefined as never);
        try {
            await expect(application.install(sourceDirectory)).rejects.toThrow();
        } finally {
            rename.mockRestore();
        }

        // 覆盖安装前旧实例已被释放，失败后必须装回（否则插件从运行时凭空消失），
        // 并广播变更让渠道等订阅方按宿主注册表重新对齐
        expect(fs.existsSync(managedDirectory)).toBe(true);
        expect(getPluginHost().get('overwrite-fail')?.status).toBe('active');
        expect(setupCount('overwrite-fail')).toBe(2);
        expect(emitSpy).toHaveBeenCalledWith('pluginsChanged', { operation: 'install', id: 'overwrite-fail' });
    });

    test('安装落盘期间不阻塞其他插件操作', async () => {
        writePluginSource(path.join(configDirectory, 'builtin', 'bystander-plugin'), 'bystander-plugin');
        await initializePluginHost();
        expect(getPluginHost().get('bystander-plugin')?.status).toBe('active');

        let releaseInstall = () => {};
        let markStarted = () => {};
        const installGate = new Promise<void>((resolve) => {
            releaseInstall = resolve;
        });
        const installStarted = new Promise<void>((resolve) => {
            markStarted = resolve;
        });

        // npm install / 解压这类慢操作由 install() 承载，这里用可控的提交点模拟
        const installPromise = applyPluginInstall('newbie-plugin', async () => {
            markStarted();
            await installGate;
            return { success: true, id: 'newbie-plugin' };
        });
        await installStarted;

        // 落盘还没完成时，其他插件操作应当照常生效（旧实现会在这里被宿主机队列堵住）
        await expect(applyPluginEnabledChange('bystander-plugin', false)).resolves.toBeUndefined();
        expect(getPluginHost().get('bystander-plugin')).toBeUndefined();

        releaseInstall();
        await expect(installPromise).resolves.toMatchObject({ success: true, id: 'newbie-plugin' });
    });
});
