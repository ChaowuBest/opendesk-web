import fs from 'fs';
import { describe, expect, test } from '@jest/globals';
import { zhCn } from '../../../main/applications/skillmgr/locale/zh-cn.js';

const source = fs.readFileSync(
    new URL('../../../main/applications/skillmgr/renderer/entry.js', import.meta.url),
    'utf8'
);
const detailCardSource = fs.readFileSync(
    new URL('../../../renderer/components/skills/skill-detail-card.ts', import.meta.url),
    'utf8'
);

describe('Skill Center dark theme regressions', () => {
    test('the add menu overrides text, hover, divider, and icon surfaces in dark mode', () => {
        expect(source).toContain(':host([data-theme="dark"]) .add-dropdown-item .item-name');
        expect(source).toContain(':host([data-theme="dark"]) .add-dropdown-item:hover');
        expect(source).toContain(':host([data-theme="dark"]) .add-dropdown-section + .add-dropdown-section');
        expect(source).toContain(':host([data-theme="dark"]) .add-dropdown-item .icon.import');
        expect(source).not.toContain('class="icon" style="background:#E7F6EA');
    });

    test('the analyzer defaults to unlimited timeout', () => {
        expect(source).toContain('timeoutMinutes: null');
        // 占位符已接入 i18n：源码断言取词调用，词典断言中文语义仍为“无限制”
        expect(source).toContain('placeholder="${this._t(\'renderer.skill.analyze.timeoutPlaceholder\')}"');
        expect(zhCn['renderer.skill.analyze.timeoutPlaceholder']).toBe('无限制');
        expect(source).toContain('this.analyzeState.timeoutMinutes === null ? undefined');
    });

    test('registry and analyzer search clear controls have dark-mode colors', () => {
        expect(source).toContain(':host([data-theme="dark"]) .search-clear');
        expect(source).toContain(':host([data-theme="dark"]) .analyze-filter-bar .search-clear');
        expect(source).toContain(':host([data-theme="dark"]) .search-clear:hover');
    });

    test('read-only contributed skills do not render an individual toggle', () => {
        expect(source).toContain('const scopeControl = s.readOnly');
        expect(source).toContain('${scopeControl}');
    });

    test('plugin skill details keep the skill title above plugin and application attribution', () => {
        expect(source).toContain("const skillOwner = s.pluginName || s.pluginId || s.bundleName || ''");
        expect(source).toContain('const pluginSkillOwner = detail.pluginName || detail.pluginId;');
        expect(source).toContain('name: detail.name || detail.id');
        // 详情副标题改为宿主注入的高亮归属文案（subtitleHtml，宿主侧已转义）
        expect(source).toContain('subtitleHtml: pluginManagedHtml || undefined');
        expect(source).toContain('opts.isBuiltin && detail.bundleName');
        expect(detailCardSource).toContain('const subtitle = model.subtitle ?? model.id;');
    });
});
