import { zhCn as notesZhCn } from '../../../main/applications/notes/locale/zh-cn.js';
import { enUs as notesEnUs } from '../../../main/applications/notes/locale/en-us.js';
import { t as notesT } from '../../../main/applications/notes/locale/index.js';
import { createTranslatorForNotes } from '../../../main/applications/notes/locale/renderer.js';
import { zhCn as appZhCn } from '../../../locale/zh-cn.js';
import { enUs as appEnUs } from '../../../locale/en-us.js';
import { setRuntimeLocale } from '../../../locale/index.js';
import { resolveRendererLocale } from '../../../renderer/locale.js';

function keyDiff(a: Record<string, string>, b: Record<string, string>): string[] {
    const missingInB = Object.keys(a).filter((k) => !(k in b));
    const missingInA = Object.keys(b).filter((k) => !(k in a));
    return [...missingInB, ...missingInA];
}

describe('notes locale', () => {
    afterEach(() => {
        setRuntimeLocale(null);
    });

    test('per-app zh-CN and en-US dictionaries have identical key sets', () => {
        expect(keyDiff(notesZhCn, notesEnUs)).toEqual([]);
    });

    test('main-process t() follows the active locale and interpolates params', () => {
        setRuntimeLocale('zh-CN');
        expect(notesT('app.name')).toBe('笔记');
        expect(notesT('error.noteNotFound', { id: 'n1' })).toBe('笔记 n1 不存在');

        setRuntimeLocale('en-US');
        expect(notesT('app.name')).toBe('Notes');
        expect(notesT('error.noteNotFound', { id: 'n1' })).toBe('Note n1 not found');
        expect(notesT('renderer.note.deleted.remaining', { days: 3 })).toBe('3d until permanent deletion');
    });

    test('main-process t() returns the key itself for unknown keys', () => {
        expect(notesT('notes.does.not.exist')).toBe('notes.does.not.exist');
    });

    test('renderer translator resolves locale from setting and interpolates params', () => {
        expect(createTranslatorForNotes({ locale: 'zh-CN' })('renderer.note.group.pinned')).toBe('置顶');
        expect(createTranslatorForNotes({ locale: 'en-US' })('renderer.note.group.pinned')).toBe('Pinned');
        expect(
            createTranslatorForNotes({ locale: 'zh-CN' })('renderer.note.tag.delete.confirm.message', { name: '工作' })
        ).toContain('工作');
        expect(createTranslatorForNotes({ locale: 'en-US' })('renderer.note.count.notes', { count: 2 })).toBe(
            '2 notes'
        );
    });

    test('note delete confirm message carries the note name in both locales', () => {
        expect(
            createTranslatorForNotes({ locale: 'zh-CN' })('renderer.note.note.delete.confirm.message', { name: '周报' })
        ).toBe('确定要删除笔记「周报」吗？删除后可在回收站中恢复，10天后将永久删除。');
        const en = createTranslatorForNotes({ locale: 'en-US' })('renderer.note.note.delete.confirm.message', {
            name: 'Weekly report'
        });
        expect(en).toContain('Weekly report');
        expect(en).not.toContain('${');
    });

    test('locale switch detection matches the hot-swap contract', () => {
        // onSettingChanged 广播的是原始 setting（无 resolved_locale），显式语言必须能直接命中
        expect(resolveRendererLocale({ locale: 'zh-CN', resolved_locale: 'zh-CN' })).toBe('zh-CN');
        expect(resolveRendererLocale({ locale: 'en-US' })).toBe('en-US');
        // loadSettingObject 附带 resolved_locale，auto 设置按主进程解析结果渲染
        expect(resolveRendererLocale({ locale: 'auto', resolved_locale: 'zh-CN' })).toBe('zh-CN');
        expect(resolveRendererLocale({ locale: 'auto', resolved_locale: 'en-US' })).toBe('en-US');
        expect(resolveRendererLocale('en-US')).toBe('en-US');

        const needsRefresh = (prev: unknown, next: unknown) =>
            resolveRendererLocale(next) !== resolveRendererLocale(prev);
        expect(needsRefresh({ locale: 'zh-CN', resolved_locale: 'zh-CN' }, { locale: 'zh-CN' })).toBe(false);
        expect(needsRefresh({ locale: 'zh-CN', resolved_locale: 'zh-CN' }, { locale: 'en-US' })).toBe(true);
        expect(needsRefresh({ locale: 'auto', resolved_locale: 'zh-CN' }, { locale: 'en-US' })).toBe(true);

        let currentSetting: unknown = { locale: 'auto', resolved_locale: 'zh-CN' };
        const t = () => createTranslatorForNotes(currentSetting as { locale?: string });
        expect(t()('renderer.note.new')).toBe('新建');
        currentSetting = { locale: 'en-US' };
        expect(t()('renderer.note.new')).toBe('New');
    });

    test('notes-specific keys stay out of the OpenDesk core locale (no pollution)', () => {
        for (const dict of [appZhCn, appEnUs]) {
            expect(Object.keys(dict).some((k) => k.startsWith('notes.') || k.startsWith('note.'))).toBe(false);
        }
        for (const key of Object.keys(notesZhCn)) {
            // app.name 是各应用共用的通用键
            if (key === 'app.name') continue;
            expect(key in appZhCn).toBe(false);
            expect(key in appEnUs).toBe(false);
        }
    });

    test('agent instruct and polish prompt follow the active locale', () => {
        setRuntimeLocale('zh-CN');
        expect(notesT('agent.instruct')).toContain('笔记助手');
        expect(notesT('polish.prompt', { noteTitle: 'T', noteContext: 'C', text: 'X' })).toContain('请润色以下文本');

        setRuntimeLocale('en-US');
        expect(notesT('agent.instruct')).toContain('notes assistant');
        const prompt = notesT('polish.prompt', { noteTitle: 'T', noteContext: 'C', text: 'X' });
        expect(prompt).toContain('Polish the following text');
        expect(prompt).toContain('X');
        expect(prompt).not.toContain('${');
        expect(createTranslatorForNotes({ locale: 'en-US' })('renderer.tool.listCurrentNotes.description')).toBe(
            'Get the titles and summaries of all notes shown on the current page'
        );
    });
});
