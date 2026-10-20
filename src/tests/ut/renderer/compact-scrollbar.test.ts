import { describe, expect, it } from '@jest/globals';
import fs from 'fs';

/**
 * 二级（Compact）滚动条复用样式：规范见 docs/specifications/scrollbar_specification.md。
 * 弹窗等紧凑滚动容器若未定义 ::-webkit-scrollbar，会回退系统原生样式，
 * 呈现为带上下箭头的宽滚动条（深色模式下尤为突兀）。
 * .compact-scroll 为可复用工具类；.od-sp-scroll 为设置面板系列弹窗
 * 滚动容器的既有共用类，须同样纳入该规格。
 */

const customCss = fs.readFileSync(new URL('../../../renderer/styles/custom.css', import.meta.url), 'utf8');
const themeDarkCss = fs.readFileSync(new URL('../../../renderer/theme/theme-dark.css', import.meta.url), 'utf8');
const settingPanelSrc = fs.readFileSync(
    new URL('../../../renderer/components/settingpanel.js', import.meta.url),
    'utf8'
);
const channelSettingsSrc = fs.readFileSync(
    new URL('../../../renderer/components/channelSettings.js', import.meta.url),
    'utf8'
);

function ruleBody(css: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`${escaped}[^{]*\\{([^}]*)\\}`));
    expect(match).not.toBeNull();
    return match![1];
}

describe('二级 Compact 滚动条复用样式', () => {
    it('浅色：compact-scroll 基础规格为 4px 宽、透明轨道', () => {
        expect(ruleBody(customCss, '.compact-scroll::-webkit-scrollbar')).toMatch(/width:\s*4px/);
        expect(ruleBody(customCss, '.compact-scroll::-webkit-scrollbar-track')).toMatch(/background:\s*transparent/);
    });

    it('浅色：thumb 为实色灰、2px 圆角，hover 加深一级', () => {
        const thumb = ruleBody(customCss, '.compact-scroll::-webkit-scrollbar-thumb');
        expect(thumb).toMatch(/background:\s*#d1d5db/);
        expect(thumb).toMatch(/border-radius:\s*2px/);
        expect(ruleBody(customCss, '.compact-scroll::-webkit-scrollbar-thumb:hover')).toMatch(/background:\s*#9ca3af/);
    });

    it('浅色：设置面板弹窗滚动容器 od-sp-scroll 纳入同一规格', () => {
        expect(ruleBody(customCss, '.od-sp-scroll::-webkit-scrollbar')).toMatch(/width:\s*4px/);
        expect(ruleBody(customCss, '.od-sp-scroll::-webkit-scrollbar-track')).toMatch(/background:\s*transparent/);
        const thumb = ruleBody(customCss, '.od-sp-scroll::-webkit-scrollbar-thumb');
        expect(thumb).toMatch(/background:\s*#d1d5db/);
        expect(thumb).toMatch(/border-radius:\s*2px/);
    });

    it('深色：thumb 覆盖为半透明白并带 !important', () => {
        const thumb = ruleBody(themeDarkCss, "html[data-theme='dark'] .compact-scroll::-webkit-scrollbar-thumb");
        expect(thumb).toMatch(/background:\s*rgba\(255,\s*255,\s*255,\s*0\.18\)\s*!important/);
        const hover = ruleBody(themeDarkCss, "html[data-theme='dark'] .compact-scroll::-webkit-scrollbar-thumb:hover");
        expect(hover).toMatch(/background:\s*rgba\(255,\s*255,\s*255,\s*0\.28\)\s*!important/);
        expect(ruleBody(themeDarkCss, "html[data-theme='dark'] .od-sp-scroll::-webkit-scrollbar-thumb")).toMatch(
            /background:\s*rgba\(255,\s*255,\s*255,\s*0\.18\)\s*!important/
        );
    });

    it('弹窗滚动容器模板确实挂载 od-sp-scroll（设置面板与频道设置）', () => {
        expect(settingPanelSrc).toContain('od-confirm-modal-body od-sp-scroll');
        expect(channelSettingsSrc).toContain('od-confirm-modal-body od-sp-scroll');
    });
});
