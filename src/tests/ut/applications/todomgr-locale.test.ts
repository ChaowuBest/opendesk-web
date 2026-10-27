import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { zhCn as todoZhCn } from '../../../main/applications/todomgr/locale/zh-cn.js';
import { enUs as todoEnUs } from '../../../main/applications/todomgr/locale/en-us.js';
import { modelZhCn } from '../../../common/locale/model.js';
import { t as todoT } from '../../../main/applications/todomgr/locale/index.js';
import { createTranslatorForTodoMgr } from '../../../main/applications/todomgr/locale/renderer.js';
import { TODO_TEMPLATES } from '../../../main/applications/todomgr/templates.js';
import { buildTriggerInfo, buildTriggerMessage } from '../../../main/applications/todomgr/trigger.js';
import { zhCn as appZhCn } from '../../../locale/zh-cn.js';
import { enUs as appEnUs } from '../../../locale/en-us.js';
import { setRuntimeLocale } from '../../../locale/index.js';
import { resolveRendererLocale } from '../../../renderer/locale.js';

function keyDiff(a: Record<string, string>, b: Record<string, string>): string[] {
    const missingInB = Object.keys(a).filter((k) => !(k in b));
    const missingInA = Object.keys(b).filter((k) => !(k in a));
    return [...missingInB, ...missingInA];
}

describe('todomgr locale', () => {
    afterEach(() => {
        setRuntimeLocale(null);
    });

    test('per-app zh-CN and en-US dictionaries have identical key sets', () => {
        expect(keyDiff(todoZhCn, todoEnUs)).toEqual([]);
    });

    test('period and interval editor copy is available in both languages', () => {
        for (const dictionary of [todoZhCn, todoEnUs]) {
            for (const suffix of [
                'label',
                'periodTab',
                'intervalTab',
                'period.once',
                'period.daily',
                'period.weekly',
                'period.biweekly',
                'period.monthly',
                'period.yearly',
                'weekdays',
                'everyWeek',
                'every',
                'intervalSuffix',
                'intervalOn',
                'intervalUnitLabel',
                'intervalValueLabel',
                'intervalUnit.hour',
                'intervalUnit.day',
                'intervalUnit.week',
                'intervalUnit.month',
                'intervalUnit.year',
                'hours',
                'selectDays',
                'back',
                'backMonths',
                'removeDay',
                'selectDates',
                'selectMonths',
                'removeDate',
                'removeMonth',
                'selectAllDates',
                'selectAllMonths',
                'anchorWeek',
                'anchorWeekHint',
                'month',
                'day',
                'time',
                'legacy',
                'legacyHint',
                'replaceLegacy',
                'invalid',
                'missingDate',
                'openOptions',
                'selectAll'
            ]) {
                expect(dictionary[`renderer.todo.frequency.${suffix}`]).toEqual(expect.any(String));
            }
            expect(dictionary['error.recurrenceInvalid']).toEqual(expect.any(String));
        }
    });

    test('app name is 自动化任务 in zh-CN and Automation in en-US (no Crontab)', () => {
        expect(todoZhCn['app.name']).toBe('自动化任务');
        expect(todoEnUs['app.name']).toBe('Automation');
        for (const value of Object.values(todoEnUs)) {
            expect(value.toLowerCase()).not.toContain('crontab');
        }
    });

    test('main-process t() follows the active locale (zh-CN / en-US)', () => {
        setRuntimeLocale('zh-CN');
        expect(todoT('app.name')).toBe('自动化任务');

        setRuntimeLocale('en-US');
        expect(todoT('app.name')).toBe('Automation');
    });

    test('main-process t() interpolates params', () => {
        setRuntimeLocale('zh-CN');
        expect(todoT('tool.cli.list.found', { count: 3 })).toBe('找到 3 个全局待办:');

        setRuntimeLocale('en-US');
        expect(todoT('tool.cli.list.found', { count: 3 })).toBe('Found 3 global todos:');
    });

    test('main-process t() returns the key itself for unknown keys', () => {
        expect(todoT('todomgr.does.not.exist')).toBe('todomgr.does.not.exist');
    });

    test('renderer translator resolves locale from setting and interpolates params', () => {
        expect(createTranslatorForTodoMgr({ locale: 'zh-CN' })('app.name')).toBe('自动化任务');
        expect(createTranslatorForTodoMgr({ locale: 'en-US' })('app.name')).toBe('Automation');
        expect(
            createTranslatorForTodoMgr({ locale: 'zh-CN' })('renderer.todo.delete.message', { title: 'X' })
        ).toContain('<b>X</b>');
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
        const t = () => createTranslatorForTodoMgr(currentSetting as { locale?: string });

        expect(t()('app.name')).toBe('自动化任务');
        currentSetting = enSetting;
        expect(t()('app.name')).toBe('Automation');
        expect(t()('renderer.todo.detail.executeNow')).toBe('Run Now');
    });

    test('every template provides title / description / content keys in both locales', () => {
        expect(TODO_TEMPLATES.length).toBeGreaterThan(0);
        for (const tpl of TODO_TEMPLATES) {
            for (const suffix of ['title', 'description', 'content']) {
                const key = `template.${tpl.id}.${suffix}`;
                expect(typeof todoZhCn[key]).toBe('string');
                expect(typeof todoEnUs[key]).toBe('string');
                expect(todoZhCn[key].length).toBeGreaterThan(0);
                expect(todoEnUs[key].length).toBeGreaterThan(0);
            }
        }
    });

    test('todomgr-specific keys stay out of the OpenDesk core locale (no pollution)', () => {
        expect('tools.getCurrentTime.name' in appZhCn).toBe(false);
        expect('tools.getCurrentTime.name' in appEnUs).toBe(false);
        for (const key of Object.keys(todoZhCn)) {
            // app.name 是各应用共用的通用键，主 locale 中指向 OpenDesk 本身
            if (key === 'app.name') continue;
            expect(key in appZhCn).toBe(false);
            expect(key in appEnUs).toBe(false);
        }
    });

    test('every static t() key referenced by todomgr source resolves in a dictionary', () => {
        // 防止词条改名/迁移后源码仍引用旧键（如 tools.getCurrentTime.name → tool.getCurrentTime.name）。
        // 动态键（含 ${} 模板拼接）无法静态解析，跳过；workspace picker 的两个词条
        // 由 entry.ts 内独立创建的 createRendererTranslator 解析，不属于 TodoMgr 词典。
        const sources = [
            '../../../main/applications/todomgr/tools.ts',
            '../../../main/applications/todomgr/app.ts',
            '../../../main/applications/todomgr/worker.ts',
            '../../../main/applications/todomgr/recurrence-description.ts',
            '../../../main/applications/todomgr/recurrence-validation.ts',
            '../../../main/applications/todomgr/trigger.ts',
            '../../../main/applications/todomgr/renderer/entry.ts',
            '../../../main/applications/todomgr/renderer/legacy-timezone.ts',
            '../../../main/applications/todomgr/renderer/time-schedule-picker.ts'
        ];
        const knownKeys = new Set([...Object.keys(todoZhCn), ...Object.keys(modelZhCn)]);
        const workspacePickerKeys = new Set([
            'renderer.workspacePicker.taskNameFallback',
            'renderer.workspacePicker.titleWithName'
        ]);
        const callPattern = /(?<![\w$])(?:_t|t)\(\s*'([^']+)'\s*[,)]/g;
        const here = path.dirname(fileURLToPath(import.meta.url));
        const missing: string[] = [];
        for (const rel of sources) {
            const file = path.resolve(here, rel);
            const src = fs.readFileSync(file, 'utf8');
            for (const m of src.matchAll(callPattern)) {
                const key = m[1];
                if (key.includes('${')) continue;
                if (path.basename(file) === 'entry.ts' && workspacePickerKeys.has(key)) {
                    expect(appZhCn[key]).toEqual(expect.any(String));
                    expect(appEnUs[key]).toEqual(expect.any(String));
                    continue;
                }
                if (!knownKeys.has(key)) missing.push(`${path.basename(file)}: ${key}`);
            }
        }
        expect(missing).toEqual([]);
    });

    test('date.format templates interpolate with exactly the params their call sites pass', () => {
        // 镜像 entry.ts 的实际传参：formatDate 传 {month, monthName, day, time}，
        // 日历标题传 {year, monthName}，日期确认文案传 {year, month, monthName, day, time}。
        // 模板若引用了对应集合之外的占位符，界面上会残留 ${...} 原文。
        const cases: Array<[string, Record<string, string | number>]> = [
            ['date.format.monthDayTime', { month: 9, monthName: '9月', day: 5, time: '09:00' }],
            ['date.format.monthYear', { year: 2026, monthName: '9月' }],
            ['date.format.fullTime', { year: 2026, month: 9, monthName: '9月', day: 5, time: '09:00' }]
        ];
        for (const dict of [todoZhCn, todoEnUs]) {
            for (const [key, params] of cases) {
                let text: string = dict[key];
                for (const [k, v] of Object.entries(params)) {
                    text = text.replace(new RegExp(`\\$\\{${k}\\}`, 'g'), String(v));
                }
                expect(text).not.toContain('${');
            }
        }
    });

    test('agent instruct follows the active locale (task system prompt language)', () => {
        setRuntimeLocale('zh-CN');
        expect(todoT('agent.instruct')).toContain('待办事项管理助手');
        expect(todoT('agent.instruct')).toContain('自动化任务');

        setRuntimeLocale('en-US');
        expect(todoT('agent.instruct')).toContain('automation assistant');
        expect(todoT('agent.instruct')).toContain('addGlobalTodo');
    });

    test('trigger info and message templates interpolate and follow the active locale', () => {
        setRuntimeLocale('zh-CN');
        expect(buildTriggerInfo({ type: 'scheduled' })).toBe('[scheduled] 定时任务，仅执行一次 ');
        expect(
            buildTriggerInfo({ type: 'event', bundleName: 'mailbox', eventName: 'newEmailCountsUpdated' })
        ).toContain('mailbox:newEmailCountsUpdated');

        setRuntimeLocale('en-US');
        expect(buildTriggerInfo({ type: 'scheduled' })).toBe('[scheduled] One-shot task, runs once ');

        const message = buildTriggerMessage('id-1', '标题', '内容', { type: 'scheduled' });
        expect(message).toContain('id-1');
        expect(message).toContain('标题');
        expect(message).toContain('内容');
        expect(message).not.toContain('${');

        setRuntimeLocale('zh-CN');
        const zhMessage = buildTriggerMessage('id-1', 't', 'c', { type: 'scheduled' });
        expect(zhMessage).toContain('请执行以下全局待办事项');

        setRuntimeLocale('en-US');
        const enMessage = buildTriggerMessage('id-1', 't', 'c', { type: 'scheduled' });
        expect(enMessage).toContain('Please execute the following global todo');
    });
});
