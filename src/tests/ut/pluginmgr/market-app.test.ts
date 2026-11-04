import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { AbstractPlatform, setPlatform } from '../../../platforms/base.js';
import { setRuntimeLocale } from '../../../locale/index.js';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';
import { disposePluginHost } from '../../../main/applications/pluginmgr/runtime/bootstrap.js';
import { PluginMgrApplication } from '../../../main/applications/pluginmgr/app.js';
import { OFFICIAL_PLUGIN_CHANNEL_ID, PLUGIN_CATALOG_URL } from '../../../main/applications/pluginmgr/channels.js';

/**
 * 插件渠道 + 插件市场的主进程接口（renderer 通过 callMainWorld 调的那一批）。
 *
 * 覆盖：渠道增删改启停 → registry 重建 → 市场清单按分类/关键词过滤 → 从市场下载安装并回报进度。
 * 网络一律走注入的平台 fetch，避免测试真的联网。
 */

const CUSTOM_CATALOG_URL = 'https://market.example.com/category/plugins.json';

const CATALOG = {
    categories: ['开发工具', '效率'],
    plugins: [
        {
            id: 'dev-plugin',
            displayName: { 'zh-CN': '开发插件', 'en-US': 'Dev plugin' },
            description: 'A developer plugin',
            version: '1.0.0',
            category: ['开发工具'],
            downloadUrl: 'https://market.example.com/plugins/dev-plugin-1.0.0.zip'
        },
        {
            id: 'office-plugin',
            displayName: { 'zh-CN': '办公插件', 'en-US': 'Office plugin' },
            description: 'An office plugin',
            version: '1.0.0',
            category: ['效率'],
            downloadUrl: 'https://market.example.com/plugins/office-plugin-1.0.0.zip'
        }
    ]
};

function buildArchive(pluginId: string, manifestExtras: Record<string, unknown> = {}): Buffer {
    const zip = new AdmZip();
    zip.addFile(
        'package.json',
        Buffer.from(JSON.stringify({ name: pluginId, version: '1.0.0', type: 'module' }, null, 2))
    );
    zip.addFile(
        'opendesk.plugin.json',
        Buffer.from(JSON.stringify({ entry: 'index.js', apiVersion: 1, capabilities: [], ...manifestExtras }))
    );
    zip.addFile('index.js', Buffer.from(`export default { id: '${pluginId}', setup: () => ({}) };\n`));
    return zip.toBuffer();
}

class MarketTestPlatform extends AbstractPlatform {
    readonly fetchMock = jest.fn(async (input: string | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/category/plugins.json')) {
            return new Response(JSON.stringify(CATALOG), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }
        const matched = /plugins\/([a-zA-Z0-9._-]+)-1\.0\.0\.zip$/.exec(url);
        if (matched) {
            const archive = buildArchive(matched[1]);
            return new Response(archive, {
                status: 200,
                headers: { 'content-type': 'application/zip', 'content-length': String(archive.byteLength) }
            });
        }
        return new Response('not found', { status: 404 });
    });

    getName(): string {
        return 'test';
    }

    getEffectiveWorkspace(): string {
        return process.cwd();
    }

    async initPlatformHarness(): Promise<void> {
        /* 测试平台不需要任务交互 UI */
    }

    async fetch(input: string | URL): Promise<Response> {
        return this.fetchMock(input);
    }
}

describe('plugin channels and marketplace (main process)', () => {
    let configDirectory: string;
    let platform: MarketTestPlatform;
    let previousBuiltinDirectory: string | undefined;
    let app: PluginMgrApplication;

    /**
     * 把应用注册进 Setting 的应用配置 schema。
     *
     * 生产环境由 ApplicationRegistry 在启动时完成（Setting.registerApplicationSettings）：
     * 它既让 `applications.pluginmgr` 的 schema 生效（未注册时 zod 会把整块配置裁掉），
     * 也把「配置变更 → onConfigChanged」的回调接上。测试里必须显式补上这一步，
     * 否则渠道写进 Setting 后会被 schema 直接丢掉。
     */
    function registerApp(): void {
        Setting.registerApplicationSettings(app, () => app.onConfigChanged());
    }

    async function addCustomChannel(name = '社区市场'): Promise<string> {
        const [custom] = (await app.addPluginChannel({ name, url: CUSTOM_CATALOG_URL })).filter(
            (channel) => !channel.isDefault
        );
        return custom.id;
    }

    beforeEach(() => {
        setRuntimeLocale('zh-CN');
        configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-market-app-'));
        previousBuiltinDirectory = process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY;
        // 隔离内置插件目录：宿主初始化时不该去加载仓库里真实的内置插件
        process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY = path.join(configDirectory, 'builtin');
        setCustomOpendeskDirectory(configDirectory);
        Setting.clearCache();
        platform = new MarketTestPlatform();
        setPlatform(platform);
        app = new PluginMgrApplication();
        registerApp();
    });

    afterEach(async () => {
        await disposePluginHost();
        if (previousBuiltinDirectory === undefined) delete process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY;
        else process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY = previousBuiltinDirectory;
        Setting.clearCache();
        setCustomOpendeskDirectory(undefined);
        setRuntimeLocale(null);
        fs.rmSync(configDirectory, { recursive: true, force: true });
    });

    test('the official marketplace display name follows the UI language', async () => {
        setRuntimeLocale('zh-CN');
        expect((await app.listPluginRegistries())[0].displayName).toBe('官方插件市场');

        setRuntimeLocale('en-US');
        expect((await app.listPluginRegistries())[0].displayName).toBe('Official Marketplace');
    });

    test('the official channel is listed first and can only be toggled', async () => {
        const channels = await app.listPluginChannels();

        expect(channels).toHaveLength(1);
        expect(channels[0]).toMatchObject({
            id: OFFICIAL_PLUGIN_CHANNEL_ID,
            url: PLUGIN_CATALOG_URL,
            isEnabled: true,
            isDefault: true
        });

        await expect(
            app.updatePluginChannel(OFFICIAL_PLUGIN_CHANNEL_ID, { name: 'x', url: PLUGIN_CATALOG_URL })
        ).rejects.toThrow(/官方插件市场/);
        await expect(app.deletePluginChannel(OFFICIAL_PLUGIN_CHANNEL_ID)).rejects.toThrow(/官方插件市场/);
    });

    test('adding a channel verifies the catalog online before saving it', async () => {
        const channels = await app.addPluginChannel({ name: '社区市场', url: CUSTOM_CATALOG_URL });

        expect(platform.fetchMock).toHaveBeenCalledWith(CUSTOM_CATALOG_URL);
        expect(channels.map((channel) => channel.name)).toEqual(['官方插件市场', '社区市场']);
        expect(channels[1]).toMatchObject({ url: CUSTOM_CATALOG_URL, isEnabled: true, isDefault: false });
        // 配置已经落进 Setting（registry 会按它重建）
        expect(
            (Setting.getInstance().getData().applications.pluginmgr as { channels: unknown[] }).channels
        ).toHaveLength(2);
    });

    test('an unusable catalog is rejected and the channel list stays unchanged', async () => {
        platform.fetchMock.mockImplementationOnce(async () => new Response('{ broken', { status: 200 }));

        await expect(app.addPluginChannel({ name: '坏市场', url: CUSTOM_CATALOG_URL })).rejects.toThrow(
            /插件清单验证失败/
        );
        expect(await app.listPluginChannels()).toHaveLength(1);
    });

    test('a disabled channel disappears from the marketplace list as well', async () => {
        const customId = await addCustomChannel();

        expect((await app.listPluginRegistries()).map((registry) => registry.name)).toEqual([
            OFFICIAL_PLUGIN_CHANNEL_ID,
            customId
        ]);

        await app.setPluginChannelEnabled(customId, false);
        expect((await app.listPluginRegistries()).map((registry) => registry.name)).toEqual([
            OFFICIAL_PLUGIN_CHANNEL_ID
        ]);

        // 官方市场也可以被禁用，禁用后市场列表为空
        await app.setPluginChannelEnabled(OFFICIAL_PLUGIN_CHANNEL_ID, false);
        expect(await app.listPluginRegistries()).toEqual([]);
    });

    test('the marketplace catalog filters by category and by keyword', async () => {
        const customId = await addCustomChannel();
        await app.setPluginChannelEnabled(OFFICIAL_PLUGIN_CHANNEL_ID, false);

        const all = await app.getPluginCatalog(customId);
        expect(all.categories).toEqual(['开发工具', '效率']);
        expect(all.entries.map((entry) => entry.id)).toEqual(['dev-plugin', 'office-plugin']);

        const efficiency = await app.getPluginCatalog(customId, ['效率']);
        expect(efficiency.entries.map((entry) => entry.id)).toEqual(['office-plugin']);

        const searched = await app.getPluginCatalog(customId, undefined, '开发');
        expect(searched.entries.map((entry) => entry.id)).toEqual(['dev-plugin']);
    });

    test('installing from the marketplace downloads the archive and reports progress', async () => {
        const customId = await addCustomChannel();
        await app.setPluginChannelEnabled(OFFICIAL_PLUGIN_CHANNEL_ID, false);
        const emitEvent = jest.spyOn(app, 'emitEvent').mockImplementation(async () => undefined);

        const result = await app.installFromPluginRegistry(customId, 'office-plugin');

        expect(result).toEqual({ success: true, id: 'office-plugin' });
        const progressEvents = emitEvent.mock.calls.filter(([eventName]) => eventName === 'marketInstallProgress');
        expect(progressEvents.length).toBeGreaterThan(0);
        const payload = progressEvents.at(-1)?.[1] as { pluginId: string; receivedBytes: number; totalBytes: number };
        expect(payload.pluginId).toBe('office-plugin');
        expect(payload.receivedBytes).toBe(payload.totalBytes);
        expect(fs.existsSync(path.join(configDirectory, 'plugins', 'office-plugin', 'index.js'))).toBe(true);
    });

    test('installing an unknown plugin id is refused', async () => {
        const customId = await addCustomChannel();

        await expect(app.installFromPluginRegistry(customId, 'ghost-plugin')).rejects.toThrow(/没有插件/);
        await expect(app.installFromPluginRegistry('missing-market', 'office-plugin')).rejects.toThrow(
            /未找到插件市场/
        );
    });

    test('entries that do not support the current platform are hidden and cannot be installed', async () => {
        // 当前平台放一条能用的、一条只给别的平台的
        const otherPlatform = (['win32', 'darwin', 'linux', 'android', 'openharmony'] as const).find(
            (item) => item !== process.platform
        ) as string;
        platform.fetchMock.mockImplementation(async (input: string | URL) => {
            const url = typeof input === 'string' ? input : input.toString();
            if (url.endsWith('/category/plugins.json')) {
                return new Response(
                    JSON.stringify({
                        categories: ['效率'],
                        plugins: [
                            {
                                id: 'desktop-plugin',
                                version: '1.0.0',
                                platforms: [process.platform, otherPlatform],
                                downloadUrl: 'https://market.example.com/plugins/desktop-plugin-1.0.0.zip'
                            },
                            {
                                id: 'other-platform-plugin',
                                version: '1.0.0',
                                platforms: [otherPlatform],
                                downloadUrl: 'https://market.example.com/plugins/other-platform-plugin-1.0.0.zip'
                            }
                        ]
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } }
                );
            }
            const archive = buildArchive('desktop-plugin');
            return new Response(archive, {
                status: 200,
                headers: { 'content-type': 'application/zip', 'content-length': String(archive.byteLength) }
            });
        });
        const customId = await addCustomChannel();

        const catalog = await app.getPluginCatalog(customId);
        // 只声明了别的平台的条目不上架
        expect(catalog.entries.map((entry) => entry.id)).toEqual(['desktop-plugin']);
        // 即便直接调主进程 API，也不能安装平台不支持的条目
        await expect(app.installFromPluginRegistry(customId, 'other-platform-plugin')).rejects.toThrow(
            /不支持当前平台/
        );
    });

    test('an entry that the current host version cannot run is listed but cannot be installed', async () => {
        platform.fetchMock.mockImplementation(async (input: string | URL) => {
            const url = typeof input === 'string' ? input : input.toString();
            if (url.endsWith('/category/plugins.json')) {
                return new Response(
                    JSON.stringify({
                        plugins: [
                            {
                                id: 'future-plugin',
                                version: '1.0.0',
                                // 要求一个比当前宿主更高的版本：装上也只会加载失败
                                minOpenDeskVersion: '99.0.0',
                                downloadUrl: 'https://market.example.com/plugins/future-plugin-1.0.0.zip'
                            }
                        ]
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } }
                );
            }
            return new Response('should not be downloaded', { status: 500 });
        });
        const customId = await addCustomChannel();

        // 仍然列出来（用户得知道「有个插件要更新 OpenDesk」），但安装被拒
        const catalog = await app.getPluginCatalog(customId);
        expect(catalog.entries.map((entry) => entry.id)).toEqual(['future-plugin']);
        await expect(app.installFromPluginRegistry(customId, 'future-plugin')).rejects.toThrow(/需要 OpenDesk/);
        expect(platform.fetchMock.mock.calls.some(([input]) => String(input).endsWith('.zip'))).toBe(false);

        // 上界同样生效：只支持到很老的宿主时也不该装进来
        platform.fetchMock.mockImplementation(async (input: string | URL) => {
            const url = typeof input === 'string' ? input : input.toString();
            if (url.endsWith('/category/plugins.json')) {
                return new Response(
                    JSON.stringify({
                        plugins: [
                            {
                                id: 'legacy-plugin',
                                version: '1.0.0',
                                maxOpenDeskVersion: '0.0.1',
                                downloadUrl: 'https://market.example.com/plugins/legacy-plugin-1.0.0.zip'
                            }
                        ]
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } }
                );
            }
            return new Response('should not be downloaded', { status: 500 });
        });
        await app.getPluginCatalog(customId, undefined, undefined, true);
        await expect(app.installFromPluginRegistry(customId, 'legacy-plugin')).rejects.toThrow(/需要 OpenDesk/);
    });

    test('a package whose manifest contradicts the marketplace entry is never installed', async () => {
        // 市场条目与包内清单都声明了 version / homepage / author：两边必须一致。
        // 核对发生在「下载解压之后、落盘之前」——对不上就整单失败，磁盘上不能留下这一版
        const manifest = {
            version: '1.0.0',
            homepage: 'https://example.com/plugin',
            author: { name: { 'zh-CN': '张三' }, homepage: 'https://example.com/team' }
        };
        const catalogEntry = {
            id: 'matched-plugin',
            version: '1.0.0',
            homepage: 'https://example.com/plugin/',
            author: { name: { 'zh-CN': '张三' }, homepage: 'https://example.com/team/' },
            downloadUrl: 'https://market.example.com/plugins/matched-plugin-1.0.0.zip'
        };
        const serve = (entry: Record<string, unknown>, manifestExtras: Record<string, unknown> = {}) => {
            platform.fetchMock.mockImplementation(async (input: string | URL) => {
                const url = typeof input === 'string' ? input : input.toString();
                if (url.endsWith('/category/plugins.json')) {
                    return new Response(JSON.stringify({ plugins: [entry] }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' }
                    });
                }
                const archive = buildArchive('matched-plugin', { ...manifest, ...manifestExtras });
                return new Response(archive, {
                    status: 200,
                    headers: { 'content-type': 'application/zip', 'content-length': String(archive.byteLength) }
                });
            });
        };

        // 结尾斜杠差异不算不一致
        serve(catalogEntry);
        let customId = await addCustomChannel();
        await expect(app.installFromPluginRegistry(customId, 'matched-plugin')).resolves.toEqual({
            success: true,
            id: 'matched-plugin'
        });
        expect(fs.existsSync(path.join(configDirectory, 'plugins', 'matched-plugin'))).toBe(true);

        // 市场清单有 5 分钟内存缓存：每次改完 mock 都要强制重拉一次
        const refreshCatalog = () => app.getPluginCatalog(customId, undefined, undefined, true);

        // 覆盖安装遇到不一致：不能动已经装好的旧版本
        serve({ ...catalogEntry, version: '9.9.9' });
        await refreshCatalog();
        await expect(app.installFromPluginRegistry(customId, 'matched-plugin')).resolves.toMatchObject({
            success: false,
            code: 'manifest_mismatch'
        });
        const installedManifest = JSON.parse(
            fs.readFileSync(path.join(configDirectory, 'plugins', 'matched-plugin', 'opendesk.plugin.json'), 'utf-8')
        ) as { version?: string };
        expect(installedManifest.version).toBe('1.0.0');

        // 把上一版装好的插件删掉，好确认「不一致时不会新落一份」
        fs.rmSync(path.join(configDirectory, 'plugins', 'matched-plugin'), { recursive: true, force: true });

        const expectMismatch = async (entry: Record<string, unknown>, manifestExtras: Record<string, unknown> = {}) => {
            serve(entry, manifestExtras);
            customId = (await app.listPluginChannels()).find((channel) => !channel.isDefault)!.id;
            await refreshCatalog();
            const outcome = await app.installFromPluginRegistry(customId, 'matched-plugin');
            expect(outcome).toMatchObject({ success: false, code: 'manifest_mismatch' });
            expect((outcome as { message: string }).message).toContain('不一致');
            // 关键：不一致时磁盘上什么都不留
            expect(fs.existsSync(path.join(configDirectory, 'plugins', 'matched-plugin'))).toBe(false);
        };

        await expectMismatch({ ...catalogEntry, version: '9.9.9' });
        await expectMismatch({ ...catalogEntry, homepage: 'https://example.com/other' });
        await expectMismatch({ ...catalogEntry, author: { name: { 'zh-CN': '李四' } } });
        // 宿主版本上下界同样参与核对（两边都声明了才比）
        await expectMismatch({ ...catalogEntry, minOpenDeskVersion: '0.0.2' }, { minOpenDeskVersion: '0.0.1' });

        // 市场只维护 name 时（author 只写 name、没有 institution/homepage），包内声明的
        // institution / homepage 不该被判为「不一致」拦下安装——与其它字段「市场未声明就不比」同口径
        serve(
            { ...catalogEntry, author: { name: { 'zh-CN': '张三' } } },
            {
                author: {
                    name: { 'zh-CN': '张三' },
                    institution: { 'zh-CN': '某团队' },
                    homepage: 'https://example.com/team'
                }
            }
        );
        await refreshCatalog();
        await expect(app.installFromPluginRegistry(customId, 'matched-plugin')).resolves.toMatchObject({
            success: true,
            id: 'matched-plugin'
        });
    });

    test('a failed market install reports the reason together with the underlying detail', async () => {
        const baseImplementation = platform.fetchMock.getMockImplementation();
        platform.fetchMock.mockImplementation(async (input: string | URL) => {
            const url = typeof input === 'string' ? input : input.toString();
            // 插件包下载失败：市场安装要把这条底层原因带进错误消息，
            // 界面才好通过通知把「为什么失败」推给用户
            if (url.endsWith('.zip')) return new Response('not found', { status: 404 });
            return baseImplementation ? baseImplementation(input) : new Response('{}', { status: 404 });
        });
        const customId = await addCustomChannel();

        const error = await app.installFromPluginRegistry(customId, 'office-plugin').catch((thrown) => thrown);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('安装失败：');
        expect((error as Error).message).toContain('404');
    });

    test('an entry whose id belongs to a builtin plugin is refused before downloading', async () => {
        // 内置插件优先：同 id 的包一定装不上。必须在下下载之前就拒绝——否则用户白等几十兆，
        // 而且为了这次安装会先把正在运行的内置插件（飞书之类的渠道）停掉再装回去
        const builtinDirectory = path.join(configDirectory, 'builtin');
        const builtinPlugin = path.join(builtinDirectory, 'builtin-helper');
        fs.mkdirSync(builtinPlugin, { recursive: true });
        fs.writeFileSync(
            path.join(builtinPlugin, 'opendesk.plugin.json'),
            JSON.stringify({ id: 'builtin-helper', entry: './index.js', apiVersion: 1, capabilities: [] })
        );
        fs.writeFileSync(path.join(builtinPlugin, 'index.js'), "export default { id: 'builtin-helper', setup() {} };");

        platform.fetchMock.mockImplementation(async (input: string | URL) => {
            const url = typeof input === 'string' ? input : input.toString();
            if (url.endsWith('/category/plugins.json')) {
                return new Response(
                    JSON.stringify({
                        plugins: [
                            {
                                id: 'builtin-helper',
                                version: '1.0.0',
                                downloadUrl: 'https://market.example.com/plugins/builtin-helper-1.0.0.zip'
                            }
                        ]
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } }
                );
            }
            return new Response('should not be downloaded', { status: 500 });
        });
        const customId = await addCustomChannel();
        platform.fetchMock.mockClear();

        await expect(app.installFromPluginRegistry(customId, 'builtin-helper')).rejects.toThrow(/内置插件/);

        // 只拉了清单，没有去下归档包
        expect(platform.fetchMock.mock.calls.some(([input]) => String(input).endsWith('.zip'))).toBe(false);
        expect(fs.existsSync(path.join(configDirectory, 'plugins', 'builtin-helper'))).toBe(false);
    });

    test('a marketplace entry whose id differs from the package id is reported', async () => {
        // 清单说 id 是 mismatched-plugin，包里的插件 id 却是 dev-plugin：
        // 装得上，但市场卡片的「已安装」会永远对不上，所以必须明确报错而不是静默成功
        platform.fetchMock.mockImplementation(async (input: string | URL) => {
            const url = typeof input === 'string' ? input : input.toString();
            if (url.endsWith('/category/plugins.json')) {
                return new Response(
                    JSON.stringify({
                        plugins: [
                            {
                                id: 'mismatched-plugin',
                                version: '1.0.0',
                                downloadUrl: 'https://market.example.com/plugins/dev-plugin-1.0.0.zip'
                            }
                        ]
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } }
                );
            }
            const archive = buildArchive('dev-plugin');
            return new Response(archive, {
                status: 200,
                headers: { 'content-type': 'application/zip', 'content-length': String(archive.byteLength) }
            });
        });
        const customId = await addCustomChannel();

        await expect(app.installFromPluginRegistry(customId, 'mismatched-plugin')).rejects.toThrow(/不一致/);
        // 按包内 id 装上了，插件列表里能看到，只是这条市场条目对不上
        expect(fs.existsSync(path.join(configDirectory, 'plugins', 'dev-plugin'))).toBe(true);
    });
});
