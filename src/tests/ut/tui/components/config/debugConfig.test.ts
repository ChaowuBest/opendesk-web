import { jest } from '@jest/globals';
import { Setting } from '../../../../../main/utils/setting.js';
import { DebugConfigPage } from '../../../../../main/tui/components/config/debugConfig.js';
import { setRuntimeLocale } from '../../../../../locale/index.js';
import { NotificationStore } from '../../../../../main/tui/components/notification.js';

function createTuiMock() {
    return {
        addInputListener: jest.fn(() => jest.fn()),
        setFocus: jest.fn(),
        requestRender: jest.fn()
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
        NotificationStore.getInstance().clear();
    });

    test('renders only the developer mode switch from shared debug settings', () => {
        const page = new DebugConfigPage(createTuiMock(), jest.fn());

        const text = page.render(80).join('\n');

        expect(text).toContain('Debug Mode');
        expect(text).toContain('Developer Mode');
        expect(text).not.toContain('Experimental');
        expect(Setting.getInstance().getData().debug.experimental_features).toBeUndefined();
    });

    test('announces session-only logging once on enable', () => {
        const tui = createTuiMock();
        const page = new DebugConfigPage(tui, jest.fn());

        (page as any).save({ developer_mode: true, log_raw_llm_request: true });
        expect(Setting.getInstance().getData().debug.log_raw_llm_request).toBe(true);
        expect(NotificationStore.getInstance().getAll()).toEqual([
            expect.objectContaining({
                type: 'info',
                title: 'Raw response logging enabled',
                message: expect.stringContaining('turns off after OpenDesk restarts')
            })
        ]);
        (page as any).save({ developer_mode: true, log_raw_llm_request: true });
        (page as any).save({ developer_mode: true, log_raw_llm_request: false });
        expect(NotificationStore.getInstance().getAll()).toHaveLength(1);
    });
});
