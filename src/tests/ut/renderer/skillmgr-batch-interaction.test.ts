import fs from 'fs';
import { describe, expect, test } from '@jest/globals';
import { zhCn } from '../../../main/applications/skillmgr/locale/zh-cn.js';
import { enUs } from '../../../main/applications/skillmgr/locale/en-us.js';

const source = fs.readFileSync(
    new URL('../../../main/applications/skillmgr/renderer/entry.js', import.meta.url),
    'utf8'
);

/* 技能中心批量操作（方案A：⋯ 菜单 = 批量选择 + 批量执行；已选托盘；无「全部xx」入口）结构回归 */
describe('skill center batch operations (proposal A)', () => {
    test('search bar keeps the tri-state select-all button and inline batch bar removed', () => {
        expect(source).not.toContain('selall-btn');
        expect(source).not.toContain('_selallSvg');
        expect(source).not.toContain('_toggleSelectAll');
        expect(source).not.toContain('_computeSelallState');
        expect(source).not.toContain('batch-bar');
        expect(source).not.toContain('search-bar.ctx');
        expect(source).not.toContain('cb-btn');
        expect(source).not.toContain('cb-x');
        expect(source).not.toContain('sb-normal');
    });

    test('the overflow menu drops every "enable/disable/delete all" entry and helper', () => {
        expect(source).not.toContain('data-batch-action="enable-all"');
        expect(source).not.toContain('data-batch-action="disable-all"');
        expect(source).not.toContain('data-batch-action="delete-all"');
        expect(source).not.toContain('_enableAllSkills');
        expect(source).not.toContain('_disableAllSkills');
    });

    test('the ⋯ menu exposes exactly the selection group and the batch execution group', () => {
        expect(source).toContain("t('renderer.skill.batch.menu.headPick')");
        expect(source).toContain("t('renderer.skill.batch.menu.headExec')");
        for (const action of ['pick-all', 'pick-vis', 'clear-sel', 'enable-sel', 'disable-sel', 'delete-sel']) {
            expect(source).toContain(`action === '${action}'`);
        }
        // 菜单主项随状态动态：无搜索=全选；有搜索=选择搜索结果
        expect(source).toContain("t('renderer.skill.batch.menu.pickAll')");
        expect(source).toContain("t('renderer.skill.batch.menu.pickVisible')");
        expect(source).toContain("t('renderer.skill.batch.menu.clear')");
    });

    test('batch execution applies to the selection with smart graying', () => {
        // 所选全部已启用 → 批量启用置灰；全部已禁用 → 批量禁用置灰
        expect(source).toContain('selected.every((s) => s.enabled !== false)');
        expect(source).toContain('selected.every((s) => s.enabled === false)');
        // 菜单项与置灰联动
        expect(source).toContain("this._batchBtnDis(scope, 'enable') ? 'dis' : ''");
        expect(source).toContain("this._batchBtnDis(scope, 'disable') ? 'dis' : ''");
    });

    test('a selection tray keeps chosen skills visible across searches and editable', () => {
        expect(source).toContain('_renderTrayHtml(scope)');
        expect(source).toContain('_syncBatchTray(scope)');
        expect(source).toContain('data-tray-remove');
        expect(source).toContain('data-tray-clear');
        // 选中集合跨搜索保留：pick-vis 只把过滤结果并入全局 selection
        expect(source).toContain('for (const s of this._getFilteredSkills(scope)) selection.add(s.id);');
        expect(source).toContain('_batchPickAll');
        expect(source).toContain('_batchClearSelection');
    });

    test('the ⋯ button carries a live selection-count badge', () => {
        expect(source).toContain('more-badge');
        expect(source).toContain('_syncBatchBadge(scope)');
    });

    test('menu icons follow the 24px-grid 2px-stroke OpenDesk drawing style (no emoji)', () => {
        expect(source).toContain('stroke-width="2" stroke-linecap="round"');
        expect(source).not.toContain('>▶️<');
        expect(source).not.toContain('>⏸️<');
        expect(source).not.toContain('>🗑️<');
    });

    test('builtin skills never get a batch delete entry', () => {
        const fnStart = source.indexOf('_batchDropdownItemsHtml(scope) {');
        expect(fnStart).toBeGreaterThan(-1);
        const fnBody = source.slice(fnStart, source.indexOf('\n    }', fnStart));
        // 批量删除项由 isBuiltin 三目守卫（内置技能不可删除）
        expect(fnBody).toContain('isBuiltin');
        expect(fnBody).toContain('data-batch-action="delete-sel"');
        expect(fnBody.indexOf('isBuiltin')).toBeLessThan(fnBody.indexOf('data-batch-action="delete-sel"'));
    });

    test('iteration leftovers ("append / keep-only" semantics) stay out of the GUI', () => {
        // 面向用户的批量操作文案中不得出现"追加 / 仅保留"语义（注释等内部说明除外）
        const userFacing = source
            .split('\n')
            .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
            .join('\n');
        expect(userFacing).not.toContain('追加');
        expect(userFacing).not.toContain('仅保留');
        expect(userFacing).not.toContain('append-vis');
        expect(userFacing).not.toContain('keep-vis');
    });

    test('locale keys match the proposal A menu and tray, with v2 leftovers removed', () => {
        const required = [
            'renderer.skill.batch.more',
            'renderer.skill.batch.menu.headPick',
            'renderer.skill.batch.menu.pickAll',
            'renderer.skill.batch.menu.pickAllHintDone',
            'renderer.skill.batch.menu.pickAllHintTotal',
            'renderer.skill.batch.menu.pickAllHintProgress',
            'renderer.skill.batch.menu.pickVisible',
            'renderer.skill.batch.menu.pickVisibleHintNone',
            'renderer.skill.batch.menu.pickVisibleHintDone',
            'renderer.skill.batch.menu.pickVisibleHintAdd',
            'renderer.skill.batch.menu.clear',
            'renderer.skill.batch.menu.clearHint',
            'renderer.skill.batch.menu.headExec',
            'renderer.skill.batch.menu.enable',
            'renderer.skill.batch.menu.enableHint',
            'renderer.skill.batch.menu.disable',
            'renderer.skill.batch.menu.disableHint',
            'renderer.skill.batch.menu.delete',
            'renderer.skill.batch.menu.deleteHint',
            'renderer.skill.batch.menu.empty',
            'renderer.skill.batch.tray.label',
            'renderer.skill.batch.tray.remove',
            'renderer.skill.batch.tray.clear',
            'renderer.skill.batch.enable.done',
            'renderer.skill.batch.enable.summary',
            'renderer.skill.batch.disable.done',
            'renderer.skill.batch.disable.summary',
            'renderer.skill.batch.delete.title',
            'renderer.skill.batch.delete.message',
            'renderer.skill.batch.delete.confirm',
            // 批量删除的 toast 沿用通用键
            'renderer.skill.deleteAll.done',
            'renderer.skill.deleteAll.summary',
            'renderer.skill.deleteAll.failedSuffix'
        ];
        for (const key of required) {
            expect(zhCn[key]).toBeDefined();
            expect(enUs[key]).toBeDefined();
        }
        const removed = [
            'renderer.skill.batch.selectAll',
            'renderer.skill.batch.bar.count',
            'renderer.skill.batch.menu.enableAll',
            'renderer.skill.batch.menu.enableAllHint',
            'renderer.skill.batch.menu.disableAll',
            'renderer.skill.batch.menu.disableAllHint',
            'renderer.skill.batch.menu.deleteAll',
            'renderer.skill.batch.menu.deleteAllHint',
            'renderer.skill.disableAll.title',
            'renderer.skill.disableAll.message',
            'renderer.skill.disableAll.confirm',
            'renderer.skill.disableAll.done',
            'renderer.skill.disableAll.summary',
            'renderer.skill.deleteAll.title',
            'renderer.skill.deleteAll.message',
            'renderer.skill.deleteAll.confirm'
        ];
        for (const key of removed) {
            expect(zhCn[key]).toBeUndefined();
            expect(enUs[key]).toBeUndefined();
        }
    });

    test('tray label embeds the count with emphasis in both locales', () => {
        expect(zhCn['renderer.skill.batch.tray.label']).toContain('${count}');
        expect(enUs['renderer.skill.batch.tray.label']).toContain('${count}');
    });
});
