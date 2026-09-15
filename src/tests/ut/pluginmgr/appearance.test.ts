import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { parsePluginManifest } from '../../../main/applications/pluginmgr/discovery/manifest.js';
import { definePlugin } from '../../../../packages/plugin-sdk/src/index.js';

// 1x1 PNG 的文件头（校验 data URL 前缀用，内容本身不影响解析）
const PNG_BYTES = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
]);

function createTempPluginDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-appearance-'));
}

async function activateAppearancePlugin(
    host: PluginHost,
    id: string,
    pluginDir: string,
    setup: (ctx: any) => void,
    grantedCapabilities?: string[]
) {
    return await host.activate(
        definePlugin({
            id,
            capabilities: ['appearance'],
            setup
        }) as any,
        {
            origin: `test:${id}`,
            pluginDir,
            ...(grantedCapabilities ? { grantedCapabilities: grantedCapabilities as any } : {})
        }
    );
}

describe('appearance capability', () => {
    let pluginDir: string;

    beforeEach(() => {
        pluginDir = createTempPluginDir();
    });

    afterEach(() => {
        fs.rmSync(pluginDir, { recursive: true, force: true });
    });

    test('manifest 接受 appearance 能力', () => {
        const manifest = parsePluginManifest({
            entry: './index.mjs',
            apiVersion: 1,
            capabilities: ['appearance']
        });
        expect(manifest.capabilities).toEqual(['appearance']);
    });

    test('未声明 appearance capability 时 setAppTitle 被拒绝', async () => {
        const host = new PluginHost();
        const entry = await host.activate(
            definePlugin({
                id: 'appearance-undeclared',
                capabilities: [],
                setup(ctx: any) {
                    ctx.appearance.setAppTitle('MyApp');
                }
            }),
            { origin: 'test:appearance-undeclared', pluginDir }
        );

        expect(entry.status).toBe('error');
        expect(entry.diagnostics[0]?.detail).toBe('plugin.capability_not_declared:appearance');
        expect(host.listAppearance().appTitle).toBeUndefined();
        await host.dispose();
    });

    test('未授权 appearance capability 时 setAppTitle 被拒绝', async () => {
        const host = new PluginHost();
        const entry = await activateAppearancePlugin(
            host,
            'appearance-ungranted',
            pluginDir,
            (ctx) => {
                ctx.appearance.setAppTitle('MyApp');
            },
            []
        );

        expect(entry.status).toBe('disabled');
        expect(host.listAppearance().appTitle).toBeUndefined();
        await host.dispose();
    });

    test('setAppTitle 修改应用标题并记录能力', async () => {
        const host = new PluginHost();
        const entry = await activateAppearancePlugin(host, 'appearance-title', pluginDir, (ctx) => {
            ctx.appearance.setAppTitle('My Custom App');
        });

        expect(entry.status).toBe('active');
        expect(entry.capabilities).toContain('appearance');
        expect(host.listAppearance().appTitle).toBe('My Custom App');
        await host.dispose();
    });

    test('setAppTitle 空名称被拒绝', async () => {
        const host = new PluginHost();
        const entry = await activateAppearancePlugin(host, 'appearance-empty-title', pluginDir, (ctx) => {
            ctx.appearance.setAppTitle('   ');
        });

        expect(entry.status).toBe('error');
        expect(entry.diagnostics[0]?.detail).toBe('plugin.appearance_title_invalid');
        await host.dispose();
    });

    test('setAppTitle 超长名称被拒绝', async () => {
        const host = new PluginHost();
        const entry = await activateAppearancePlugin(host, 'appearance-long-title', pluginDir, (ctx) => {
            ctx.appearance.setAppTitle('a'.repeat(65));
        });

        expect(entry.status).toBe('error');
        expect(entry.diagnostics[0]?.detail).toBe('plugin.appearance_title_too_long');
        await host.dispose();
    });

    test('setAppTitle 本地化映射按语言解析，语言切换后读取即时生效', async () => {
        const host = new PluginHost();
        const entry = await activateAppearancePlugin(host, 'appearance-title-l10n', pluginDir, (ctx) => {
            ctx.appearance.setAppTitle({ zh: '我的桌面', en: 'MyDesk' });
        });

        expect(entry.status).toBe('active');
        expect(host.listAppearance('zh-CN').appTitle).toBe('我的桌面');
        expect(host.listAppearance('en-US').appTitle).toBe('MyDesk');
        // 无匹配语言时回退到注册输入的第一项
        expect(host.listAppearance('ja-JP').appTitle).toBe('我的桌面');
        // 键按主语言标签归一化：zh-CN 键匹配 zh 语种
        await host.deactivate('appearance-title-l10n');

        await activateAppearancePlugin(host, 'appearance-title-l10n-key', pluginDir, (ctx) => {
            ctx.appearance.setAppTitle({ 'zh-CN': '简体中文' });
        });
        expect(host.listAppearance('zh-TW').appTitle).toBe('简体中文');
        await host.dispose();
    });

    test('setAppTitle 本地化映射空值、未知类型或非法键被拒绝', async () => {
        const host = new PluginHost();

        const emptyValue = await activateAppearancePlugin(host, 'appearance-title-empty-value', pluginDir, (ctx) => {
            ctx.appearance.setAppTitle({ zh: '   ' });
        });
        expect(emptyValue.status).toBe('error');
        expect(emptyValue.diagnostics[0]?.detail).toBe('plugin.appearance_title_invalid');

        const badType = await host.activate(
            definePlugin({
                id: 'appearance-title-bad-type',
                capabilities: ['appearance'],
                setup(ctx: any) {
                    ctx.appearance.setAppTitle(42);
                }
            }),
            { origin: 'test:appearance-title-bad-type', pluginDir }
        );
        expect(badType.status).toBe('error');
        expect(badType.diagnostics[0]?.detail).toBe('plugin.appearance_title_invalid');

        const emptyObject = await activateAppearancePlugin(host, 'appearance-title-empty-map', pluginDir, (ctx) => {
            ctx.appearance.setAppTitle({});
        });
        expect(emptyObject.status).toBe('error');
        expect(emptyObject.diagnostics[0]?.detail).toBe('plugin.appearance_title_invalid');
        expect(host.listAppearance().appTitle).toBeUndefined();
        await host.dispose();
    });

    test('setAppDescription 支持字符串与本地化映射，未设置时为 undefined', async () => {
        const host = new PluginHost();
        const entry = await activateAppearancePlugin(host, 'appearance-desc', pluginDir, (ctx) => {
            ctx.appearance.setAppTitle('MyDesk');
            ctx.appearance.setAppDescription({ zh: '一站式工作台', en: 'All-in-one workbench' });
        });

        expect(entry.status).toBe('active');
        expect(host.listAppearance('zh-CN').appDescription).toBe('一站式工作台');
        expect(host.listAppearance('en-US').appDescription).toBe('All-in-one workbench');
        expect(host.listAppearance().appTitle).toBe('MyDesk');

        // 未设置描述的插件不影响标题
        await host.deactivate('appearance-desc');
        await activateAppearancePlugin(host, 'appearance-desc-missing', pluginDir, (ctx) => {
            ctx.appearance.setAppTitle('Only Title');
        });
        const appearance = host.listAppearance();
        expect(appearance.appTitle).toBe('Only Title');
        expect(appearance.appDescription).toBeUndefined();
        await host.dispose();
    });

    test('setAppDescription 非法输入被拒绝', async () => {
        const host = new PluginHost();
        const entry = await activateAppearancePlugin(host, 'appearance-desc-empty', pluginDir, (ctx) => {
            ctx.appearance.setAppDescription('');
        });
        expect(entry.status).toBe('error');
        expect(entry.diagnostics[0]?.detail).toBe('plugin.appearance_title_invalid');

        const tooLong = await host.activate(
            definePlugin({
                id: 'appearance-desc-long',
                capabilities: ['appearance'],
                setup(ctx: any) {
                    ctx.appearance.setAppDescription('长'.repeat(65));
                }
            }),
            { origin: 'test:appearance-desc-long', pluginDir }
        );
        expect(tooLong.status).toBe('error');
        expect(tooLong.diagnostics[0]?.detail).toBe('plugin.appearance_title_too_long');
        await host.dispose();
    });

    test('setAppLogo 将插件根目录相对路径解析为 data URL', async () => {
        fs.writeFileSync(path.join(pluginDir, 'logo.png'), PNG_BYTES);
        fs.mkdirSync(path.join(pluginDir, 'assets'));
        fs.writeFileSync(path.join(pluginDir, 'assets', 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

        const host = new PluginHost();
        const entry = await activateAppearancePlugin(host, 'appearance-logo', pluginDir, (ctx) => {
            ctx.appearance.setAppLogo('logo.png');
            ctx.appearance.setAppLogo('assets/mark.svg');
        });

        expect(entry.status).toBe('active');
        const appearance = host.listAppearance();
        expect(appearance.appLogoUrl).toMatch(/^data:image\/svg\+xml;base64,/);
        await host.dispose();
    });

    test('setAppLogo 拒绝绝对路径与越界路径', async () => {
        const host = new PluginHost();
        const entry = await activateAppearancePlugin(host, 'appearance-logo-escape', pluginDir, (ctx) => {
            ctx.appearance.setAppLogo(os.tmpdir().startsWith('/') ? '/tmp/evil.png' : 'C:\\tmp\\evil.png');
        });

        expect(entry.status).toBe('error');
        expect(entry.diagnostics[0]?.detail).toBe('plugin.appearance_logo_path_invalid:absolute');

        const entryOutside = await host.activate(
            definePlugin({
                id: 'appearance-logo-outside',
                capabilities: ['appearance'],
                setup(ctx: any) {
                    ctx.appearance.setAppLogo('../outside.png');
                }
            }),
            { origin: 'test:appearance-logo-outside', pluginDir }
        );
        expect(entryOutside.status).toBe('error');
        expect(entryOutside.diagnostics[0]?.detail).toBe('plugin.appearance_logo_path_invalid:outside_root');
        expect(host.listAppearance().appLogoUrl).toBeUndefined();
        await host.dispose();
    });

    test('setAppLogo 拒绝不存在的文件与不支持的格式', async () => {
        fs.writeFileSync(path.join(pluginDir, 'payload.exe'), Buffer.from('MZ'));

        const host = new PluginHost();
        const entry = await activateAppearancePlugin(host, 'appearance-logo-missing', pluginDir, (ctx) => {
            ctx.appearance.setAppLogo('missing.png');
        });
        expect(entry.status).toBe('error');
        expect(entry.diagnostics[0]?.detail).toBe('plugin.appearance_logo_path_invalid:not_found');

        const entryFormat = await host.activate(
            definePlugin({
                id: 'appearance-logo-format',
                capabilities: ['appearance'],
                setup(ctx: any) {
                    ctx.appearance.setAppLogo('payload.exe');
                }
            }),
            { origin: 'test:appearance-logo-format', pluginDir }
        );
        expect(entryFormat.status).toBe('error');
        expect(entryFormat.diagnostics[0]?.detail).toBe('plugin.appearance_logo_format_unsupported');
        await host.dispose();
    });

    test('setAppLogo 超过大小上限被拒绝', async () => {
        const largeFile = path.join(pluginDir, 'large.png');
        const handle = fs.openSync(largeFile, 'w');
        fs.writeSync(handle, PNG_BYTES);
        // 稀疏写：直接扩展到上限之外
        fs.ftruncateSync(handle, 3 * 1024 * 1024);
        fs.closeSync(handle);

        const host = new PluginHost();
        const entry = await activateAppearancePlugin(host, 'appearance-logo-large', pluginDir, (ctx) => {
            ctx.appearance.setAppLogo('large.png');
        });

        expect(entry.status).toBe('error');
        expect(entry.diagnostics[0]?.detail).toBe('plugin.appearance_logo_too_large');
        await host.dispose();
    });

    test('setAppLogo 主题变体对象形式按主题解析', async () => {
        fs.writeFileSync(path.join(pluginDir, 'logo-dark.png'), PNG_BYTES);
        fs.writeFileSync(path.join(pluginDir, 'logo-light.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

        const host = new PluginHost();
        const entry = await activateAppearancePlugin(host, 'appearance-logo-variants', pluginDir, (ctx) => {
            ctx.appearance.setAppLogo({ dark: 'logo-dark.png', light: 'logo-light.svg' });
        });

        expect(entry.status).toBe('active');
        const appearance = host.listAppearance();
        expect(appearance.appLogoUrl).toBeUndefined();
        expect(appearance.appLogoDarkUrl).toMatch(/^data:image\/png;base64,/);
        expect(appearance.appLogoLightUrl).toMatch(/^data:image\/svg\+xml;base64,/);
        await host.dispose();
    });

    test('setAppLogo 主题变体缺省一侧复用另一侧', async () => {
        fs.writeFileSync(path.join(pluginDir, 'only-dark.png'), PNG_BYTES);

        const host = new PluginHost();
        const entry = await activateAppearancePlugin(host, 'appearance-logo-partial', pluginDir, (ctx) => {
            ctx.appearance.setAppLogo({ dark: 'only-dark.png' });
        });

        expect(entry.status).toBe('active');
        const appearance = host.listAppearance();
        expect(appearance.appLogoDarkUrl).toMatch(/^data:image\/png;base64,/);
        expect(appearance.appLogoLightUrl).toBe(appearance.appLogoDarkUrl);
        await host.dispose();
    });

    test('setAppLogo 主题变体非法结构被拒绝', async () => {
        const host = new PluginHost();

        const empty = await activateAppearancePlugin(host, 'appearance-logo-variants-empty', pluginDir, (ctx) => {
            ctx.appearance.setAppLogo({});
        });
        expect(empty.status).toBe('error');
        expect(empty.diagnostics[0]?.detail).toBe('plugin.appearance_logo_variants_invalid');

        const unknownKey = await host.activate(
            definePlugin({
                id: 'appearance-logo-variants-key',
                capabilities: ['appearance'],
                setup(ctx: any) {
                    ctx.appearance.setAppLogo({ dark: 'a.png', blue: 'b.png' });
                }
            }),
            { origin: 'test:appearance-logo-variants-key', pluginDir }
        );
        expect(unknownKey.status).toBe('error');
        expect(unknownKey.diagnostics[0]?.detail).toBe('plugin.appearance_logo_variants_invalid');

        const badValue = await host.activate(
            definePlugin({
                id: 'appearance-logo-variants-value',
                capabilities: ['appearance'],
                setup(ctx: any) {
                    ctx.appearance.setAppLogo({ light: 123 });
                }
            }),
            { origin: 'test:appearance-logo-variants-value', pluginDir }
        );
        expect(badValue.status).toBe('error');
        expect(badValue.diagnostics[0]?.detail).toBe('plugin.appearance_logo_variants_invalid');

        // 变体内单侧路径错误沿用路径错误码
        const outside = await activateAppearancePlugin(host, 'appearance-logo-variants-outside', pluginDir, (ctx) => {
            ctx.appearance.setAppLogo({ dark: '../evil.png', light: 'ok.png' });
        });
        expect(outside.status).toBe('error');
        expect(outside.diagnostics[0]?.detail).toBe('plugin.appearance_logo_path_invalid:outside_root');
        expect(host.listAppearance().appLogoDarkUrl).toBeUndefined();
        await host.dispose();
    });

    test('同一字段后设置者整体覆盖先设置者（字符串与对象形式互替）', async () => {
        fs.writeFileSync(path.join(pluginDir, 'single.png'), PNG_BYTES);
        fs.writeFileSync(path.join(pluginDir, 'dark.png'), PNG_BYTES);

        const host = new PluginHost();
        await activateAppearancePlugin(host, 'appearance-logo-single-first', pluginDir, (ctx) => {
            ctx.appearance.setAppLogo('single.png');
        });
        await activateAppearancePlugin(host, 'appearance-logo-variants-second', pluginDir, (ctx) => {
            ctx.appearance.setAppLogo({ dark: 'dark.png', light: 'dark.png' });
        });

        const appearance = host.listAppearance();
        expect(appearance.appLogoUrl).toBeUndefined();
        expect(appearance.appLogoDarkUrl).toMatch(/^data:image\/png;base64,/);
        expect(appearance.appLogoLightUrl).toMatch(/^data:image\/png;base64,/);
        await host.dispose();
    });

    test('注册返回的 PluginRegistration 释放后外观回退并发出变更通知', async () => {
        const host = new PluginHost();
        const notifications: string[] = [];
        const unsubscribe = host.onAppearanceChanged(() => notifications.push('changed'));

        const entry = await activateAppearancePlugin(host, 'appearance-revert', pluginDir, async (ctx) => {
            const registration = ctx.appearance.setAppTitle('Temporary');
            expect(host.listAppearance().appTitle).toBe('Temporary');
            await registration.dispose();
        });

        expect(entry.status).toBe('active');
        expect(host.listAppearance().appTitle).toBeUndefined();
        expect(notifications).toEqual(['changed', 'changed']);
        unsubscribe();
        await host.dispose();
    });

    test('后激活插件覆盖先激活插件，先者释放不影响后者的覆盖', async () => {
        const host = new PluginHost();
        await activateAppearancePlugin(host, 'appearance-first', pluginDir, (ctx) => {
            ctx.appearance.setAppTitle('First');
        });
        await activateAppearancePlugin(host, 'appearance-second', pluginDir, (ctx) => {
            ctx.appearance.setAppTitle('Second');
        });
        expect(host.listAppearance().appTitle).toBe('Second');

        await host.deactivate('appearance-first');
        expect(host.listAppearance().appTitle).toBe('Second');

        await host.deactivate('appearance-second');
        expect(host.listAppearance().appTitle).toBeUndefined();
        await host.dispose();
    });

    test('host.dispose 清空全部外观覆盖', async () => {
        fs.writeFileSync(path.join(pluginDir, 'logo.png'), PNG_BYTES);
        const host = new PluginHost();
        await activateAppearancePlugin(host, 'appearance-dispose', pluginDir, (ctx) => {
            ctx.appearance.setAppTitle('MyApp');
            ctx.appearance.setAppDescription('My Description');
            ctx.appearance.setAppLogo('logo.png');
        });
        expect(host.listAppearance()).toEqual({
            appTitle: 'MyApp',
            appDescription: 'My Description',
            appLogoUrl: expect.stringMatching(/^data:image\/png;base64,/)
        });

        await host.dispose();
        expect(host.listAppearance()).toEqual({});
    });
});
