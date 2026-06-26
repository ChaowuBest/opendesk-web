import { jest } from '@jest/globals';
import { ConfigMainPage } from '../../../../../main/tui/components/config/configMain';
import { setRuntimeLocale } from '../../../../../locale/index';

function createOpenDeskTuiMock() {
    return {
        tui: {
            setFocus: jest.fn(),
            requestRender: jest.fn()
        }
    } as any;
}

describe('ConfigMainPage', () => {
    beforeEach(() => {
        setRuntimeLocale('en-US');
    });

    afterEach(() => {
        setRuntimeLocale(null);
    });

    test('includes debug mode settings entry', () => {
        const page = new ConfigMainPage(createOpenDeskTuiMock(), jest.fn());

        const text = page.render(100).join('\n');

        expect(text).toContain('Debug Mode');
        expect(text).toContain('Configure developer visibility');
    });

    test('places display settings after task settings', () => {
        const page = new ConfigMainPage(createOpenDeskTuiMock(), jest.fn());

        const text = page.render(100).join('\n');

        expect(text).toContain('Task Settings');
        expect(text).toContain('Display Settings');
        expect(text.indexOf('Task Settings')).toBeLessThan(text.indexOf('Display Settings'));
    });
});
