import { zhCn as mcpZhCn } from '../../../main/applications/mcpmgr/locale/zh-cn.js';
import { enUs as mcpEnUs } from '../../../main/applications/mcpmgr/locale/en-us.js';
import { t as mcpT } from '../../../main/applications/mcpmgr/locale/index.js';
import { createTranslatorForMcpMgr } from '../../../main/applications/mcpmgr/locale/renderer.js';
import { zhCn as appZhCn } from '../../../locale/zh-cn.js';
import { enUs as appEnUs } from '../../../locale/en-us.js';
import { setRuntimeLocale } from '../../../locale/index.js';
import { resolveRendererLocale } from '../../../renderer/locale.js';

function keyDiff(a: Record<string, string>, b: Record<string, string>): string[] {
    const missingInB = Object.keys(a).filter((k) => !(k in b));
    const missingInA = Object.keys(b).filter((k) => !(k in a));
    return [...missingInB, ...missingInA];
}

describe('mcpmgr locale', () => {
    afterEach(() => {
        setRuntimeLocale(null);
    });

    test('per-app zh-CN and en-US dictionaries have identical key sets', () => {
        expect(keyDiff(mcpZhCn, mcpEnUs)).toEqual([]);
    });

    test('main-process t() follows the active locale and interpolates params', () => {
        setRuntimeLocale('zh-CN');
        expect(mcpT('app.name')).toBe('MCP');
        expect(mcpT('status.connected')).toBe('已连接');
        expect(mcpT('error.unknownRegistry', { id: 'x' })).toBe('未知 MCP Registry: x');

        setRuntimeLocale('en-US');
        expect(mcpT('status.connected')).toBe('Connected');
        expect(mcpT('error.unknownRegistry', { id: 'x' })).toBe('Unknown MCP registry: x');
        expect(mcpT('install.result.summary', { installed: 1, updated: 2, skipped: 3 })).toBe(
            'Installed 1, updated 2, skipped 3'
        );
    });

    test('main-process t() returns the key itself for unknown keys', () => {
        expect(mcpT('mcpmgr.does.not.exist')).toBe('mcpmgr.does.not.exist');
    });

    test('renderer translator resolves locale from setting and interpolates params', () => {
        expect(createTranslatorForMcpMgr({ locale: 'zh-CN' })('renderer.mcp.title')).toBe('MCP 管理');
        expect(createTranslatorForMcpMgr({ locale: 'en-US' })('renderer.mcp.title')).toBe('MCP Manager');
        expect(
            createTranslatorForMcpMgr({ locale: 'zh-CN' })('renderer.mcp.search.placeholder.registry', {
                label: 'Matrix'
            })
        ).toBe('搜索 Matrix…');
        expect(
            createTranslatorForMcpMgr({ locale: 'en-US' })('renderer.mcp.confirm.delete.message', { name: 'fs' })
        ).toBe('Delete MCP "<b>fs</b>"?');
    });

    test('setting:changed payloads resolve to the same locale the widget rendered with', () => {
        // onSettingChanged 广播的是原始 setting（无 resolved_locale），显式语言必须能直接命中
        expect(resolveRendererLocale({ locale: 'zh-CN', resolved_locale: 'zh-CN' })).toBe('zh-CN');
        expect(resolveRendererLocale({ locale: 'en-US' })).toBe('en-US');
        // loadSettingObject 附带 resolved_locale，auto 设置按主进程解析结果渲染
        expect(resolveRendererLocale({ locale: 'auto', resolved_locale: 'zh-CN' })).toBe('zh-CN');
        expect(resolveRendererLocale({ locale: 'auto', resolved_locale: 'en-US' })).toBe('en-US');
        expect(resolveRendererLocale('en-US')).toBe('en-US');
    });

    test('locale switch detection matches the widget guard: refresh only when resolved locale differs', () => {
        const needsRefresh = (prev: unknown, next: unknown) =>
            resolveRendererLocale(next) !== resolveRendererLocale(prev);

        // 同一语言（含仅 resolved_locale 字段差异）不触发重建
        expect(needsRefresh({ locale: 'zh-CN', resolved_locale: 'zh-CN' }, { locale: 'zh-CN' })).toBe(false);
        // 显式语言切换触发重建
        expect(needsRefresh({ locale: 'zh-CN', resolved_locale: 'zh-CN' }, { locale: 'en-US' })).toBe(true);
        // auto → 显式语言的切换触发重建
        expect(needsRefresh({ locale: 'auto', resolved_locale: 'zh-CN' }, { locale: 'en-US' })).toBe(true);
    });

    test('translator recreated with the new setting switches language (hot-swap contract)', () => {
        const zhSetting = { locale: 'auto', resolved_locale: 'zh-CN' };
        const enSetting = { locale: 'en-US' };

        let currentSetting: unknown = zhSetting;
        const t = () => createTranslatorForMcpMgr(currentSetting as { locale?: string });

        expect(t()('app.name')).toBe('MCP');
        expect(t()('status.connected')).toBe('已连接');
        currentSetting = enSetting;
        expect(t()('status.connected')).toBe('Connected');
        expect(t()('renderer.mcp.detail.reconnect')).toBe('Reconnect');
    });

    test('mcpmgr-specific keys stay out of the OpenDesk core locale (no pollution)', () => {
        // gateway 词条已从主 locale 迁入应用目录
        for (const dict of [appZhCn, appEnUs]) {
            expect(Object.keys(dict).some((k) => k.startsWith('mcpmgr.'))).toBe(false);
        }
        for (const key of Object.keys(mcpZhCn)) {
            // app.name 是各应用共用的通用键
            if (key === 'app.name') continue;
            expect(key in appZhCn).toBe(false);
            expect(key in appEnUs).toBe(false);
        }
    });

    test('agent instruct follows the active locale (task system prompt language)', () => {
        setRuntimeLocale('zh-CN');
        expect(mcpT('agent.instruct')).toContain('MCP 管理助手');

        setRuntimeLocale('en-US');
        expect(mcpT('agent.instruct')).toContain('MCP management assistant');
        expect(createTranslatorForMcpMgr({ locale: 'en-US' })('renderer.tool.listMcpServers.description')).toBe(
            'Get the name, transport, connection status and tool count of every registered MCP server'
        );
    });
});
