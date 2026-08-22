import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('plugin manager application renderer', () => {
    let callMainWorld: jest.Mock;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            customElements: window.customElements
        });
        window.confirm = jest.fn(() => true);
        await jest.unstable_mockModule('../../../renderer/theme/theme-iframe-bridge.ts', () => ({
            OPENDESK_THEME_CHANGED: 'opendesk-theme-changed'
        }));
        await jest.unstable_mockModule('../../../renderer/theme/theme-shadow-overrides.ts', () => ({
            syncShadowHostTheme: jest.fn()
        }));
        await import('../../../main/applications/pluginmgr/renderer/entry.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        callMainWorld = jest.fn(async (method: string) => {
            if (method === 'list') {
                return [
                    {
                        id: '<local-plugin>',
                        source: 'local',
                        path: '/plugins/local',
                        removable: true,
                        enabled: true,
                        runtime: {
                            id: '<local-plugin>',
                            displayName: 'Local Review',
                            version: '1.2.0',
                            status: 'active',
                            origin: '/plugins/local',
                            apiVersion: 1,
                            capabilities: ['skill', 'mcp'],
                            diagnostics: []
                        },
                        skills: [
                            {
                                name: 'review-notes',
                                description: 'Review notes and extract actions.'
                            },
                            {
                                name: 'build-checklist',
                                description: 'Build a verifiable checklist.'
                            }
                        ],
                        mcpServers: [
                            {
                                name: 'local-echo',
                                transport: 'stdio'
                            },
                            {
                                name: 'local-text-stats',
                                transport: 'stdio'
                            }
                        ],
                        tools: [
                            {
                                name: 'review-code',
                                description: 'Review a piece of code.'
                            }
                        ],
                        hooks: [{ name: 'tool.execute.before' }, { name: 'shell.env' }]
                    },
                    {
                        id: 'installed-plugin',
                        source: 'local',
                        path: '/plugins/installed',
                        removable: true,
                        enabled: false,
                        manifest: {
                            displayName: 'Installed Plugin',
                            version: '2.0.0',
                            apiVersion: 1,
                            capabilities: ['command', 'skill']
                        },
                        skills: [
                            {
                                name: 'release-review',
                                description: 'Review a release.'
                            }
                        ],
                        mcpServers: []
                    }
                ];
            }
            return undefined;
        });
        window.applicationAPI = {
            callMainWorld,
            subscribe: jest.fn(),
            unsubscribe: jest.fn()
        };
        Object.assign(window, {
            fsAPI: {
                getFilePath: jest.fn(() => '/plugins/example.tgz'),
                selectDirectory: jest.fn(async () => '/plugins/example')
            }
        });
    });

    async function createWidget(): Promise<any> {
        const widget = document.createElement('pluginmgr-entry-widget') as any;
        document.body.append(widget);
        await new Promise((resolve) => setTimeout(resolve, 0));
        return widget;
    }

    test('renders discovered plugins safely and only offers uninstall for removable entries', async () => {
        const widget = await createWidget();

        expect(widget.shadowRoot.innerHTML).toContain('&lt;local-plugin&gt;');
        expect(widget.shadowRoot.querySelector('local-plugin')).toBeNull();
        expect(widget.shadowRoot.querySelectorAll('[data-action="uninstall"]')).toHaveLength(2);
        expect(widget.shadowRoot.querySelector('[data-plugin-id="installed-plugin"]')).not.toBeNull();
    });

    test('renders tool and hook contributions on plugin cards and detail sections', async () => {
        const widget = await createWidget();
        const card = widget.shadowRoot.querySelector('[data-plugin-id="<local-plugin>"]');

        expect(card.innerHTML).toContain('1 个工具');
        expect(card.innerHTML).toContain('2 个钩子');

        card.dispatchEvent(new Event('click'));

        const detail = widget.shadowRoot.querySelector('skill-detail-card');
        expect(detail.shadowRoot.innerHTML).toContain('工具');
        expect(detail.shadowRoot.innerHTML).toContain('review-code');
        expect(detail.shadowRoot.innerHTML).toContain('Review a piece of code.');
        expect(detail.shadowRoot.innerHTML).toContain('钩子');
        expect(detail.shadowRoot.innerHTML).toContain('tool.execute.before');
        expect(detail.shadowRoot.innerHTML).toContain('shell.env');
    });

    test('renders plugin enable controls as skill-style switches', async () => {
        const widget = await createWidget();
        const activeToggle = widget.shadowRoot.querySelector(
            '[data-plugin-id="\\<local-plugin\\>"] [data-action="toggle"]'
        );
        const disabledToggle = widget.shadowRoot.querySelector(
            '[data-plugin-id="installed-plugin"] [data-action="toggle"]'
        );

        expect(activeToggle.tagName).toBe('INPUT');
        expect(activeToggle.type).toBe('checkbox');
        expect(activeToggle.hasAttribute('checked')).toBe(true);
        expect(activeToggle.closest('.plugin-toggle')?.querySelector('.plugin-toggle-slider')).not.toBeNull();
        expect(disabledToggle.tagName).toBe('INPUT');
        expect(disabledToggle.hasAttribute('checked')).toBe(false);
    });

    test('keeps the install source menu stacking context above plugin card controls', async () => {
        const widget = await createWidget();
        const styles = widget.shadowRoot.querySelector('style')?.textContent ?? '';
        const headerRule = styles.match(/\.header-area\s*\{([^}]*)\}/)?.[1] ?? '';

        expect(headerRule).toMatch(/position:\s*relative/);
        expect(headerRule).toMatch(/z-index:\s*[1-9]\d*/);

        widget.shadowRoot.querySelector('[data-action="add"]').dispatchEvent(new Event('click'));
        expect(widget.shadowRoot.querySelector('.add-dropdown.visible')).not.toBeNull();
    });

    test('routes enable and npm install actions through the application API', async () => {
        const widget = await createWidget();
        const enable = widget.shadowRoot.querySelector('[data-plugin-id="installed-plugin"] [data-action="toggle"]');
        enable.checked = true;
        enable.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(callMainWorld).toHaveBeenCalledWith('setEnabled', 'installed-plugin', true);

        widget.shadowRoot.querySelector('[data-action="add"]').dispatchEvent(new Event('click'));
        widget.shadowRoot.querySelector('[data-install-source="npm"]').dispatchEvent(new Event('click'));
        const input = widget.shadowRoot.querySelector('input[name="spec"]');
        input.value = '@example/plugin';
        input.dispatchEvent(new Event('input'));
        widget.shadowRoot.querySelector('[data-install-form]').dispatchEvent(new Event('submit', { cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(callMainWorld).toHaveBeenCalledWith('install', '@example/plugin');
    });

    test('keeps the plugin switch mounted while the runtime reload is pending', async () => {
        const widget = await createWidget();
        let finishToggle: (() => void) | undefined;
        callMainWorld.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finishToggle = resolve;
                })
        );
        const toggle = widget.shadowRoot.querySelector('[data-plugin-id="installed-plugin"] [data-action="toggle"]');

        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));

        expect(widget.shadowRoot.querySelector('[data-plugin-id="installed-plugin"] [data-action="toggle"]')).toBe(
            toggle
        );
        expect(toggle.disabled).toBe(true);

        finishToggle?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    test('installs a selected directory as a local plugin', async () => {
        const widget = await createWidget();

        widget.shadowRoot.querySelector('[data-action="add"]').dispatchEvent(new Event('click'));
        widget.shadowRoot.querySelector('[data-install-source="directory"]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(callMainWorld).toHaveBeenCalledWith('install', '/plugins/example');
        expect(widget.shadowRoot.querySelector('[data-install-progress]')?.dataset.installSource).toBe('directory');
    });

    test('waits for an asynchronous file path before installing a plugin package', async () => {
        const widget = await createWidget();
        window.fsAPI.getFilePath = jest.fn(async () => '/plugins/example.tgz');

        widget.shadowRoot.querySelector('[data-action="add"]').dispatchEvent(new Event('click'));
        const input = widget.shadowRoot.querySelector('[data-install-file]');
        Object.defineProperty(input, 'files', {
            configurable: true,
            value: [{ name: 'example.tgz' }]
        });
        input.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(callMainWorld).toHaveBeenCalledWith('install', '/plugins/example.tgz');
        expect(widget.shadowRoot.querySelector('[data-install-progress]')?.dataset.installSource).toBe('package');
    });

    test.each([
        ['npm', '@example/plugin'],
        ['url', 'https://example.com/plugin.tgz']
    ])('shows installation progress after submitting a %s source', async (source, spec) => {
        const widget = await createWidget();

        widget.shadowRoot.querySelector('[data-action="add"]').dispatchEvent(new Event('click'));
        widget.shadowRoot.querySelector(`[data-install-source="${source}"]`).dispatchEvent(new Event('click'));
        const input = widget.shadowRoot.querySelector('input[name="spec"]');
        input.value = spec;
        input.dispatchEvent(new Event('input'));
        widget.shadowRoot.querySelector('[data-install-form]').dispatchEvent(new Event('submit', { cancelable: true }));

        expect(widget.shadowRoot.querySelector('[data-install-progress]')?.dataset.installSource).toBe(source);
        expect(widget.shadowRoot.querySelector('.install-progress-bar')).not.toBeNull();
        expect(widget.shadowRoot.querySelector('.modal-overlay.visible')).toBeNull();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    test('uses the OpenDesk confirmation modal before uninstalling a plugin', async () => {
        const widget = await createWidget();
        const uninstall = widget.shadowRoot.querySelector(
            '[data-plugin-id="installed-plugin"] [data-action="uninstall"]'
        );

        uninstall.dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(window.confirm).not.toHaveBeenCalled();
        const modal = widget.shadowRoot.querySelector('.od-confirm-modal-overlay');
        expect(modal).not.toBeNull();
        expect(callMainWorld).not.toHaveBeenCalledWith('uninstall', 'installed-plugin');

        modal.querySelector('[data-action="confirm"]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 220));

        expect(callMainWorld).toHaveBeenCalledWith('uninstall', 'installed-plugin');
    });

    test('renders only the installed page with skill-style add actions', async () => {
        const widget = await createWidget();

        expect(widget.shadowRoot.querySelector('[data-tab="installed"]')).not.toBeNull();
        expect(widget.shadowRoot.querySelector('[data-tab="marketplace"]')).toBeNull();
        expect(widget.shadowRoot.querySelector('[data-tab="settings"]')).toBeNull();
        expect(widget.shadowRoot.querySelector('[data-action="add"]')).not.toBeNull();
        expect(widget.shadowRoot.querySelector('[data-panel="marketplace"]')).toBeNull();
    });

    test('opens a skill-style plugin detail with basic information, Skills, and MCP servers', async () => {
        const widget = await createWidget();
        const card = widget.shadowRoot.querySelector('[data-plugin-id="<local-plugin>"]');

        card.dispatchEvent(new Event('click'));

        const detail = widget.shadowRoot.querySelector('skill-detail-card');
        expect(detail).not.toBeNull();
        expect(detail.shadowRoot.innerHTML).toContain('Local Review');
        expect(detail.shadowRoot.innerHTML).toContain('1.2.0');
        expect(detail.shadowRoot.innerHTML).toContain('review-notes');
        expect(detail.shadowRoot.innerHTML).toContain('build-checklist');
        expect(detail.shadowRoot.innerHTML).toContain('local-echo');
        expect(detail.shadowRoot.innerHTML).toContain('local-text-stats');
    });

    test('uses manifest metadata in the detail when a plugin is disabled', async () => {
        const widget = await createWidget();
        const card = widget.shadowRoot.querySelector('[data-plugin-id="installed-plugin"]');

        card.dispatchEvent(new Event('click'));

        const detail = widget.shadowRoot.querySelector('skill-detail-card');
        expect(detail.shadowRoot.innerHTML).toContain('Installed Plugin');
        expect(detail.shadowRoot.innerHTML).toContain('2.0.0');
        expect(detail.shadowRoot.innerHTML).toContain('command, skill');
        expect(detail.shadowRoot.innerHTML).toContain('release-review');
    });
});
