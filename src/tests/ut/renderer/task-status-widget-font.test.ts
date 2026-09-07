import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';
import { FONT_PRESET_CHANNEL, normalizeFontPreset } from '../../../renderer/theme/font-preset.js';

// 卡片浮窗（task-status-widget）的 :host 曾硬编码一套系统字体栈（SF Pro Text / Microsoft YaHei），
// 与主界面默认字体（styles/fonts.css 定义的 --font-sans，首选内嵌的 HarmonyOS Sans）不一致；
// 且浮窗是独立页面（task_status_widget.html），不加载 common.css，内嵌字体与字体变量均不可用，
// 导致 Windows 上浮窗回落到 Microsoft YaHei、主界面使用 HarmonyOS Sans，观感明显不同。

function stripCssNoise(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
}

const widgetSource = stripCssNoise(
    readFileSync(new URL('../../../renderer/components/task-status-widget.js', import.meta.url), 'utf8')
);
const widgetPage = readFileSync(new URL('../../../renderer/task_status_widget.html', import.meta.url), 'utf8');
const fontsCss = stripCssNoise(readFileSync(new URL('../../../renderer/styles/fonts.css', import.meta.url), 'utf8'));
const commonCss = stripCssNoise(readFileSync(new URL('../../../renderer/styles/common.css', import.meta.url), 'utf8'));
const customCss = stripCssNoise(readFileSync(new URL('../../../renderer/styles/custom.css', import.meta.url), 'utf8'));
const preloadSource = readFileSync(new URL('../../../renderer/preload.js', import.meta.url), 'utf8');
const themeServiceSource = readFileSync(
    new URL('../../../renderer/theme/main-theme-service.ts', import.meta.url),
    'utf8'
);

/** 从 CSS 文本中提取 `--font-xxx: <值>;` 的原始值（已去空白）。 */
function extractVar(css: string, name: string): string {
    const match = css.match(new RegExp(`${name}:([^;]+);`));
    if (!match) {
        throw new Error(`${name} not found`);
    }
    return match[1];
}

describe('task status widget font consistency', () => {
    test('浮窗 :host 使用全局 --font-sans 而非硬编码字体栈', () => {
        expect(widgetSource).toContain(':host{display:block;width:100%;height:100%;font-family:var(--font-sans,');
    });

    test('浮窗等宽数字使用全局 --font-mono 而非硬编码字体栈', () => {
        expect(widgetSource).toContain('--mono:var(--font-mono,');
    });

    test('浮窗不再硬编码 SF Pro Text / Microsoft YaHei 字体栈', () => {
        expect(widgetSource).not.toContain('SFProText');
        expect(widgetSource).not.toContain('MicrosoftYaHei');
    });

    test('浮窗页面引入共享字体样式，内嵌字体在浮窗窗口内可用', () => {
        expect(widgetPage).toContain('styles/fonts.css');
    });

    test('fonts.css 提供内嵌 HarmonyOS Sans 与 Maple Mono 的 @font-face', () => {
        expect(fontsCss).toContain("@font-face{font-family:'HarmonyOSSans';");
        expect(fontsCss).toContain("@font-face{font-family:'MapleMono';");
        expect(fontsCss).toContain('/fonts/harmonyos/HarmonyOS_Sans_SC_Regular.woff2');
        expect(fontsCss).toContain('/fonts/maplemono/MapleMono-Regular.ttf.woff2');
    });

    test('fonts.css 的字体栈与主窗口 custom.css :root 保持一致', () => {
        expect(extractVar(fontsCss, '--font-sans')).toBe(extractVar(customCss, '--font-sans'));
        expect(extractVar(fontsCss, '--font-mono')).toBe(extractVar(customCss, '--font-mono'));
    });

    test('fonts.css 的字体栈首选内嵌字体（HarmonyOS Sans / Maple Mono）', () => {
        expect(extractVar(fontsCss, '--font-sans')).toContain("'HarmonyOSSans',");
        expect(extractVar(fontsCss, '--font-mono')).toContain("'MapleMono',");
    });

    test('common.css 复用 fonts.css 作为字体唯一来源', () => {
        expect(commonCss).toContain("@import'./fonts.css';");
    });
});

describe('task status widget font preset follow', () => {
    test('fonts.css 携带字体预设覆盖规则（lxgwwenkai 重定义 --font-sans）', () => {
        expect(fontsCss).toContain("html[data-font-preset='lxgwwenkai']{--font-sans:'LXGWWenKaiScreen',");
    });

    test('fonts.css 引入 LXGW WenKai 内嵌字体，预设字体在浮窗窗口内可解析', () => {
        expect(fontsCss).toContain("@import'lxgw-wenkai-screen-webfont/lxgwwenkaiscreen.css';");
    });

    test('主进程注册 theme:getFontPreset 并在设置变更时广播', () => {
        expect(FONT_PRESET_CHANNEL).toBe('theme:fontPresetChanged');
        expect(themeServiceSource).toContain("ipcMain.handle('theme:getFontPreset'");
        expect(themeServiceSource).toContain('safeSendToWebContents(win.webContents, FONT_PRESET_CHANNEL, preset)');
        expect(themeServiceSource).toContain('Setting.afterSetDataCallbacks.push');
    });

    test('preload themeAPI 暴露 getFontPreset / onFontPresetChanged', () => {
        expect(preloadSource).toContain('getFontPreset: async () =>');
        expect(preloadSource).toContain('onFontPresetChanged: (callback) =>');
        expect(preloadSource).toContain(`ipcRenderer.on('${FONT_PRESET_CHANNEL}'`);
    });

    test('浮窗组件启动拉取并订阅字体预设，应用到页面 documentElement', () => {
        expect(widgetSource).toContain('_bindFontPreset()');
        expect(widgetSource).toContain('getFontPreset');
        expect(widgetSource).toContain('onFontPresetChanged');
        expect(widgetSource).toContain("setAttribute('data-font-preset'");
    });

    test('normalizeFontPreset：空值/非字符串回退 default，其余原样透传', () => {
        expect(normalizeFontPreset(undefined)).toBe('default');
        expect(normalizeFontPreset(null)).toBe('default');
        expect(normalizeFontPreset('')).toBe('default');
        expect(normalizeFontPreset(42)).toBe('default');
        expect(normalizeFontPreset('default')).toBe('default');
        expect(normalizeFontPreset('lxgwwenkai')).toBe('lxgwwenkai');
    });
});
