import fs from 'fs';
import { describe, expect, test } from '@jest/globals';

const source = fs.readFileSync(
    new URL('../../../main/applications/skillmgr/renderer/entry.js', import.meta.url),
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
        expect(source).toContain('placeholder="无限制"');
        expect(source).toContain('this.analyzeState.timeoutMinutes === null ? undefined');
    });

    test('registry and analyzer search clear controls have dark-mode colors', () => {
        expect(source).toContain(':host([data-theme="dark"]) .search-clear');
        expect(source).toContain(':host([data-theme="dark"]) .analyze-filter-bar .search-clear');
        expect(source).toContain(':host([data-theme="dark"]) .search-clear:hover');
    });
});
