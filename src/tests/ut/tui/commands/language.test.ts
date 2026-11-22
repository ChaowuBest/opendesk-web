import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerLanguageCommand } from '../../../../main/tui/commands/language';
import { Setting, setCustomOpendeskDirectory } from '../../../../main/utils/setting';
import { getLocale, getLocaleSetting, setRuntimeLocale } from '../../../../locale/index';

function createTui(overrides: Record<string, any> = {}) {
    let handler: any;
    const tui = {
        commandRegistry: {
            register: jest.fn((registered) => {
                handler = registered;
                return true;
            })
        },
        refreshLocalizedTexts: jest.fn(),
        isInputBlocked: jest.fn(() => false),
        showTextPage: jest.fn(),
        tui: { setFocus: jest.fn(), requestRender: jest.fn(), terminal: { rows: 40 } },
        inputArea: { showPromptWidget: jest.fn() },
        hasOpenOverlay: false,
        deferInputPromptIfBlockedByMode: jest.fn(() => false),
        closeInputPrompt: jest.fn(() => false),
        focusAfterInputPromptClose: jest.fn(),
        ...overrides
    } as any;
    registerLanguageCommand(tui);
    return { tui, handler: handler! };
}

describe('/language command', () => {
    let tempRoot: string;

    beforeEach(() => {
        // 运行时覆盖固定英文，便于断言：命令文案走 en-US，设置值单独校验
        setRuntimeLocale('en-US');
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-language-command-'));
        setCustomOpendeskDirectory(tempRoot);
        Setting.clearCache();
        Setting.updateInstanceData({ locale: 'auto' });
    });

    afterEach(() => {
        setRuntimeLocale(null);
        Setting.clearCache();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test.each([
        ['zh-cn', 'zh-CN'],
        ['zh_CN', 'zh-CN'],
        ['ZH-CN', 'zh-CN'],
        ['en', 'en-US'],
        ['auto', 'auto']
    ])('applies %s as %s and refreshes localized texts', async (arg, expected) => {
        const { tui, handler } = createTui();

        await handler.execute(arg);

        expect(getLocaleSetting()).toBe(expected);
        expect(tui.refreshLocalizedTexts).toHaveBeenCalledTimes(1);
    });

    test('clears the --language runtime override so the new setting takes effect', async () => {
        const { handler } = createTui();

        await handler.execute('zh-cn');

        // 运行时覆盖（beforeEach 中的 en-US）必须被清掉，否则界面仍是英文
        expect(getLocale()).toBe('zh-CN');
    });

    test('keeps the previous setting and lists options when the language is unknown', async () => {
        const { tui, handler } = createTui();

        await handler.execute('klingon-ish');

        expect(getLocaleSetting()).toBe('auto');
        expect(tui.refreshLocalizedTexts).not.toHaveBeenCalled();
        expect(tui.showTextPage).not.toHaveBeenCalled();
    });

    test('reports a save failure instead of crashing and keeps the previous language', async () => {
        const { tui, handler } = createTui();
        const saveSpy = jest.spyOn(Setting.prototype, 'save').mockImplementation(() => {
            throw new Error('disk full');
        });

        try {
            // 写盘失败不能以未捕获异常打断 TUI 主循环
            await expect(handler.execute('zh-cn')).resolves.toBeUndefined();

            // 设置没写成，--language 的运行时覆盖也没被清掉，界面仍是英文
            expect(getLocaleSetting()).toBe('auto');
            expect(getLocale()).toBe('en-US');
            expect(tui.refreshLocalizedTexts).not.toHaveBeenCalled();
        } finally {
            saveSpy.mockRestore();
        }
    });

    test('does not silently downgrade an explicit region tag to the primary language', async () => {
        const { tui, handler } = createTui();

        // zh-Hant 不在可用集合里时不能就近匹配成 zh-CN，否则用户以为切的是繁体
        await handler.execute('zh-Hant');

        expect(getLocaleSetting()).toBe('auto');
        expect(tui.refreshLocalizedTexts).not.toHaveBeenCalled();
    });

    test('offers auto plus every available locale as completions', () => {
        const { handler } = createTui();

        const values = (handler.getArgumentCompletions('') ?? []).map((item: any) => item.value);

        expect(values).toContain('auto');
        expect(values).toContain('zh-CN');
        expect(values).toContain('en-US');
        expect(handler.getArgumentCompletions('zh')).toEqual([
            expect.objectContaining({ value: 'zh-CN', description: expect.stringContaining('简体中文') })
        ]);
    });

    test('marks the active setting in completions', () => {
        Setting.updateInstanceData({ locale: 'zh-CN' });
        const { handler } = createTui();

        const zhItem = (handler.getArgumentCompletions('zh-CN') ?? [])[0] as any;

        expect(zhItem.description).toContain('current');
    });

    test('opens the language picker when invoked without arguments', async () => {
        const { tui, handler } = createTui();

        await handler.execute('');

        expect(tui.inputArea.showPromptWidget).toHaveBeenCalledTimes(1);
        expect(tui.tui.setFocus).toHaveBeenCalledTimes(1);
        expect(getLocaleSetting()).toBe('auto');
    });

    test('applies the language picked from the picker', async () => {
        const { tui, handler } = createTui();
        await handler.execute('');
        const picker = tui.inputArea.showPromptWidget.mock.calls[0][0];

        // pi-tui 的 SelectList 在 jest 里是 mock，没有 handleInput，直接触发选中回调
        picker.table.onSelect('zh-CN');

        expect(getLocaleSetting()).toBe('zh-CN');
        expect(tui.refreshLocalizedTexts).toHaveBeenCalledTimes(1);
        expect(tui.closeInputPrompt).toHaveBeenCalledWith(picker);
    });
});
