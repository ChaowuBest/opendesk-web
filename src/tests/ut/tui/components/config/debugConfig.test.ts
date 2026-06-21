import { jest } from '@jest/globals';
import { Setting } from '../../../../../main/utils/setting';
import { DebugConfigPage } from '../../../../../main/tui/components/config/debugConfig';
import { setRuntimeLocale } from '../../../../../locale/index';

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
                developer_mode: false,
                experimental_feature: true
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
        expect(Setting.getInstance().getData().debug.experimental_feature).toBe(true);
    });
});
