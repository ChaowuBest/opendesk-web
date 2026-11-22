import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Setting, setCustomOpendeskDirectory } from '../../../../../main/utils/setting';
import { LanguageConfigPage } from '../../../../../main/tui/components/config/languageConfig';
import { getLocale, getLocaleSetting, getRuntimeLocale, setRuntimeLocale } from '../../../../../locale/index';

function createOpenDeskTuiMock() {
    return {
        tui: { addInputListener: jest.fn(() => jest.fn()), setFocus: jest.fn(), requestRender: jest.fn() },
        refreshLocalizedTexts: jest.fn(),
        inputArea: { showPromptWidget: jest.fn() },
        hasOpenOverlay: false,
        deferInputPromptIfBlockedByMode: jest.fn(() => false),
        closeInputPrompt: jest.fn(() => false),
        focusAfterInputPromptClose: jest.fn()
    } as any;
}

describe('LanguageConfigPage', () => {
    let tempRoot: string;

    beforeEach(() => {
        // 运行时覆盖固定英文，便于断言设置值单独生效
        setRuntimeLocale('en-US');
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-language-config-'));
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

    test('applies a new language immediately instead of waiting for a restart', () => {
        const openDeskTUI = createOpenDeskTuiMock();
        const page = new LanguageConfigPage(openDeskTUI, jest.fn());

        (page as unknown as { save: (values: Record<string, unknown>) => void }).save({ locale: 'zh-CN' });

        expect(getLocaleSetting()).toBe('zh-CN');
        // 运行时覆盖必须清掉，否则界面仍是英文
        expect(getLocale()).toBe('zh-CN');
        expect(openDeskTUI.refreshLocalizedTexts).toHaveBeenCalledTimes(1);
    });

    test('does not re-register commands when the language is unchanged', () => {
        // 没有 --language 覆盖时，选中值与设置一致就是无事可做
        setRuntimeLocale(null);
        const openDeskTUI = createOpenDeskTuiMock();
        const page = new LanguageConfigPage(openDeskTUI, jest.fn());

        (page as unknown as { save: (values: Record<string, unknown>) => void }).save({ locale: 'auto' });

        expect(getLocaleSetting()).toBe('auto');
        expect(openDeskTUI.refreshLocalizedTexts).not.toHaveBeenCalled();
    });

    test('clears the --language override even when the chosen value equals the setting', () => {
        // 设置是 auto，但 --language 覆盖成 en-US：用户选的 auto 与设置相同，
        // 不处理的话界面仍是 en-US，看上去像「保存没生效」
        setRuntimeLocale('en-US');
        const openDeskTUI = createOpenDeskTuiMock();
        const page = new LanguageConfigPage(openDeskTUI, jest.fn());

        (page as unknown as { save: (values: Record<string, unknown>) => void }).save({ locale: 'auto' });

        expect(getRuntimeLocale()).toBeNull();
        expect(openDeskTUI.refreshLocalizedTexts).toHaveBeenCalledTimes(1);
    });

    test('tells the user when the settings file cannot be written', () => {
        const openDeskTUI = createOpenDeskTuiMock();
        const page = new LanguageConfigPage(openDeskTUI, jest.fn());
        const saveSpy = jest.spyOn(Setting.prototype, 'save').mockImplementation(() => {
            throw new Error('disk full');
        });

        try {
            (page as unknown as { save: (values: Record<string, unknown>) => void }).save({ locale: 'zh-CN' });

            // 保存失败时不假装切换成功，界面语言保持原样并弹出提示
            expect(getLocaleSetting()).toBe('auto');
            expect(getLocale()).toBe('en-US');
            expect(openDeskTUI.refreshLocalizedTexts).not.toHaveBeenCalled();
            expect(openDeskTUI.inputArea.showPromptWidget).toHaveBeenCalledTimes(1);
        } finally {
            saveSpy.mockRestore();
        }
    });
});
