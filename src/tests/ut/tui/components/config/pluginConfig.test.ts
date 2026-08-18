import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { setRuntimeLocale } from '../../../../../locale/index.js';
import { ApplicationRegistry } from '../../../../../main/applications/registry.js';
import { PluginConfigPage } from '../../../../../main/tui/components/config/pluginConfig.js';

describe('PluginConfigPage', () => {
    let application: {
        list: jest.Mock;
        reload: jest.Mock;
        setEnabled: jest.Mock;
        uninstall: jest.Mock;
    };

    beforeEach(() => {
        setRuntimeLocale('en-US');
        application = {
            list: jest.fn(async () => [
                {
                    id: 'local-plugin',
                    source: 'local',
                    managed: false,
                    enabled: true,
                    runtime: { status: 'active', apiVersion: 1, capabilities: ['skill'] }
                },
                {
                    id: 'managed-plugin',
                    source: 'managed',
                    managed: true,
                    enabled: false
                }
            ]),
            reload: jest.fn(async () => []),
            setEnabled: jest.fn(async () => []),
            uninstall: jest.fn(async () => ({ success: true }))
        };
        ApplicationRegistry.applications.set('pluginmgr', application as any);
    });

    afterEach(() => {
        ApplicationRegistry.applications.delete('pluginmgr');
        setRuntimeLocale(null);
    });

    function createPage(): PluginConfigPage {
        return new PluginConfigPage(
            {
                tui: {
                    setFocus: jest.fn(),
                    requestRender: jest.fn()
                }
            } as any,
            jest.fn()
        );
    }

    test('shows local and managed plugins discovered by the application', async () => {
        const page = createPage();
        await new Promise((resolve) => setTimeout(resolve, 0));

        const text = page.render(100).join('\n');
        expect(text).toContain('local-plugin');
        expect(text).toContain('Local plugin directory');
        expect(text).toContain('managed-plugin');
        expect(text).toContain('Managed installation');
    });

    test('toggles a selected plugin through pluginmgr', async () => {
        const page = createPage() as any;
        await new Promise((resolve) => setTimeout(resolve, 0));

        page.list.onSelect({ value: 'managed-plugin' });
        page.list.onSelect({ value: 'toggle' });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(application.setEnabled).toHaveBeenCalledWith('managed-plugin', true);
    });
});
