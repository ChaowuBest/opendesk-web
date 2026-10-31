import { jest } from '@jest/globals';
import { Setting } from '../../../../../main/utils/setting.js';
import { DebugConfigPage } from '../../../../../main/tui/components/config/debugConfig.js';
import { setRuntimeLocale } from '../../../../../locale/index.js';
import { ConfirmOverlay } from '../../../../../main/tui/components/notice.js';

function createTuiMock() {
    return {
        tui: {
            addInputListener: jest.fn(() => jest.fn()),
            setFocus: jest.fn(),
            requestRender: jest.fn()
        },
        inputArea: { showPromptWidget: jest.fn() },
        deferInputPromptIfBlockedByMode: jest.fn(() => false),
        closeInputPrompt: jest.fn(() => null),
        focusAfterInputPromptClose: jest.fn()
    } as any;
}

describe('DebugConfigPage', () => {
    beforeEach(() => {
        setRuntimeLocale('en-US');
        Setting.clearCache();
        Setting.updateInstanceData({
            debug: {
                developer_mode: false
            }
        });
    });

    afterEach(() => {
        setRuntimeLocale(null);
        Setting.clearCache();
    });

    test('renders only the developer mode switch from shared debug settings', () => {
        const page = new DebugConfigPage(createTuiMock(), jest.fn());

        const text = page.render(80).join('\n');

        expect(text).toContain('Debug Mode');
        expect(text).toContain('Developer Mode');
        expect(text).not.toContain('Experimental');
        expect(Setting.getInstance().getData().debug.experimental_features).toBeUndefined();
    });

    test('asks for risk confirmation before saving raw logging and restores the form on cancel', () => {
        const tui = createTuiMock();
        const onBack = jest.fn();
        const page = new DebugConfigPage(tui, onBack);
        (page as any).save({ developer_mode: true, log_raw_llm_request: true });
        expect(Setting.getInstance().getData().debug.log_raw_llm_request).toBe(false);
        const prompt = tui.inputArea.showPromptWidget.mock.calls.at(-1)[0];
        expect(prompt).toBeInstanceOf(ConfirmOverlay);
        expect(tui.deferInputPromptIfBlockedByMode).toHaveBeenCalledWith(expect.any(Function), {
            allowDuringConfig: true
        });
        const warning = prompt.render(120).join('\n');
        expect(warning).toContain('private');
        expect(warning).toContain('one week');
        expect(warning).toContain('next startup');
        expect(warning).toContain('turns off');
        const choices = tui.tui.setFocus.mock.calls.at(-1)[0];
        choices.onCancel();
        expect(tui.closeInputPrompt).toHaveBeenCalledWith(prompt);
        expect(tui.focusAfterInputPromptClose).toHaveBeenCalledWith(null);
        expect((page as any).form.getValues()).toMatchObject({ developer_mode: true, log_raw_llm_request: false });
        expect(onBack).not.toHaveBeenCalled();
        expect(page.render(120).join('\n')).toContain('Log Raw LLM Responses');
        expect(Setting.getInstance().getData().debug.log_raw_llm_request).toBe(false);

        (page as any).save({ developer_mode: true, log_raw_llm_request: true });
        const confirmation = tui.tui.setFocus.mock.calls.at(-1)[0];
        confirmation.onSelect({ value: 'confirm' });
        expect(Setting.getInstance().getData().debug.log_raw_llm_request).toBe(true);
        expect(onBack).toHaveBeenCalledTimes(1);
    });
});
