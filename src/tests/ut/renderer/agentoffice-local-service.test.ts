import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('agentoffice local web service settings', () => {
    let WidgetClass: new () => HTMLElement;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Element: window.Element,
            Node: window.Node,
            HTMLInputElement: window.HTMLInputElement,
            HTMLTextAreaElement: window.HTMLTextAreaElement,
            HTMLSelectElement: window.HTMLSelectElement,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            customElements: window.customElements,
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });
        (window as any).applicationAPI = {
            subscribe: jest.fn(),
            unsubscribe: jest.fn()
        };
        if (!(window.HTMLElement.prototype as any).getBoundingClientRect) {
            (window.HTMLElement.prototype as any).getBoundingClientRect = () => ({
                left: 0,
                top: 0,
                right: 200,
                bottom: 120,
                width: 200,
                height: 120
            });
        }
        if (!(globalThis as any).navigator) {
            (globalThis as any).navigator = { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } };
        }

        const module = await import('../../../main/applications/agentoffice/renderer/entry.js');
        WidgetClass = module.AgentOfficeEntryWidget;
    });

    beforeEach(() => {
        document.body.innerHTML = '';
    });

    function createWidget(): any {
        const widget = new WidgetClass() as any;
        widget.attachShadow({ mode: 'open' });
        widget.strings = {
            'agentoffice.operationFailed': 'Operation failed',
            'agentoffice.localService': 'Local web service',
            'agentoffice.localServiceHint': 'Share this staff member on the local network',
            'agentoffice.localServiceAddress': 'Listen address',
            'agentoffice.localServicePort': 'Port',
            'agentoffice.localServiceRunning': 'Service running',
            'agentoffice.localServiceStopped': 'Service stopped',
            'agentoffice.localServiceCopy': 'Copy link',
            'agentoffice.localServiceCopied': 'Copied',
            'agentoffice.localServicePortInvalid': 'Port must be between 1 and 65535',
            'agentoffice.localServiceApplying': 'Applying changes…',
            'agentoffice.localServiceChatUrl': 'User link',
            'agentoffice.localServiceManageUrl': 'Manage link',
            'agentoffice.localServiceUserToken': 'User token',
            'agentoffice.localServiceManageToken': 'Manage token',
            'agentoffice.localServiceUserTokenHint': 'Leave empty for token-free chat access',
            'agentoffice.localServiceTokenGenerate': 'Generate',
            'agentoffice.localServiceManageTokenRequired': 'A manage token is required while the service is enabled',
            'agentoffice.localServiceHideStaffInfo': 'Hide staff info',
            'agentoffice.localServiceHideStaffInfoHint': 'Hides staff profile details on the chat page',
            'agentoffice.localServiceHttps': 'Use HTTPS',
            'agentoffice.localServiceHttpsHint':
                'Serves HTTPS with a self-signed certificate generated on this device.',
            'agentoffice.openInBrowser': 'Open in browser'
        };
        widget.localAddresses = [
            { address: '127.0.0.1', name: 'This device' },
            { address: '192.168.1.8', name: 'Ethernet' }
        ];
        return widget;
    }

    function detail(overrides: Record<string, unknown> = {}): any {
        return {
            id: 'staff-id',
            name: 'Staff name',
            vendor_name: 'Vendor',
            title: 'Title',
            specialties: [],
            trigger_interval: 'never',
            hired_at: '2026-01-01T00:00:00.000Z',
            enabled: true,
            message_count: 0,
            task_count: 0,
            skill_count: 0,
            agents_md: 'Instructions',
            mcp: { servers: [] },
            permission: { network_access: false, directories: [] },
            tasks: [],
            ...overrides
        };
    }

    function openBasicDetail(overrides: Record<string, unknown> = {}): any {
        const widget = createWidget();
        widget.detail = detail(overrides);
        widget.activeTab = 'management';
        widget.detailSection = 'basic';
        widget.render();
        widget.queueStaffUpdate = jest.fn();
        return widget;
    }

    test('the toggle renders below the enable-staff switch and stays collapsed while off', () => {
        const widget = openBasicDetail();

        const toggle = widget.shadowRoot.querySelector('#f-local-service');
        expect(toggle).not.toBeNull();
        const rows = widget.shadowRoot.querySelectorAll('.setting-check-row');
        expect(rows.length).toBeGreaterThanOrEqual(2);
        expect(rows[0].contains(widget.shadowRoot.querySelector('#f-enabled'))).toBe(true);
        expect(rows[1].contains(toggle)).toBe(true);
        expect(widget.shadowRoot.querySelector('#local-service-config').hidden).toBe(true);
    });

    test('enabling the service expands the config, defaults to a LAN address and saves immediately', () => {
        const widget = openBasicDetail();

        const toggle = widget.shadowRoot.querySelector('#f-local-service');
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));

        expect(widget.detail.local_service).toEqual({
            enabled: true,
            host: '192.168.1.8',
            port: 9050,
            https: false,
            user_token: expect.stringMatching(/^[a-zA-Z0-9]{16}$/),
            manage_token: expect.stringMatching(/^[a-zA-Z0-9]{16}$/),
            hide_staff_info: false
        });
        expect(widget.queueStaffUpdate).toHaveBeenCalledWith({ local_service: widget.detail.local_service }, true);
        expect(widget.shadowRoot.querySelector('#local-service-config').hidden).toBe(false);
        const hostSelect = widget.shadowRoot.querySelector('#f-local-service-host') as any;
        expect(hostSelect.value).toBe('192.168.1.8');
        expect(widget.shadowRoot.querySelector('#f-local-service-port').value).toBe('9050');
        // 两个令牌在首次启用时都自动生成并回填到输入框
        expect((widget.shadowRoot.querySelector('#f-local-service-manage-token') as HTMLInputElement).value).toMatch(
            /^[a-zA-Z0-9]{16}$/
        );
        expect((widget.shadowRoot.querySelector('#f-local-service-user-token') as HTMLInputElement).value).toBe(
            widget.detail.local_service.user_token
        );
    });

    test('re-enabling keeps a saved user token instead of rotating it', () => {
        const widget = openBasicDetail({
            local_service: {
                enabled: false,
                host: '192.168.1.8',
                port: 9050,
                https: false,
                user_token: 'kept-token',
                manage_token: 'kept-manage',
                hide_staff_info: false
            }
        });

        const toggle = widget.shadowRoot.querySelector('#f-local-service');
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));

        expect(widget.detail.local_service.user_token).toBe('kept-token');
        expect(widget.detail.local_service.manage_token).toBe('kept-manage');
    });

    test('address and port changes update the draft config and queue saves', () => {
        const widget = openBasicDetail({
            local_service: {
                enabled: true,
                host: '192.168.1.8',
                port: 9050,
                https: false,
                user_token: 'u1',
                manage_token: 'm1',
                hide_staff_info: false
            }
        });
        widget.localServiceRuntime = { listening: true, url: 'http://192.168.1.8:9050' };
        widget.updateLocalServiceStatusUI();

        const hostSelect = widget.shadowRoot.querySelector('#f-local-service-host');
        Object.defineProperty(hostSelect, 'value', { value: '127.0.0.1' });
        hostSelect.dispatchEvent(new Event('change'));
        expect(widget.detail.local_service.host).toBe('127.0.0.1');
        expect(widget.queueStaffUpdate).toHaveBeenLastCalledWith(
            {
                local_service: {
                    enabled: true,
                    host: '127.0.0.1',
                    port: 9050,
                    https: false,
                    user_token: 'u1',
                    manage_token: 'm1',
                    hide_staff_info: false
                }
            },
            true
        );

        const portInput = widget.shadowRoot.querySelector('#f-local-service-port');
        Object.defineProperty(portInput, 'value', { value: '9060' });
        portInput.dispatchEvent(new Event('change'));
        expect(widget.detail.local_service.port).toBe(9060);
        expect(widget.queueStaffUpdate).toHaveBeenLastCalledWith(
            {
                local_service: {
                    enabled: true,
                    host: '127.0.0.1',
                    port: 9060,
                    https: false,
                    user_token: 'u1',
                    manage_token: 'm1',
                    hide_staff_info: false
                }
            },
            true
        );
    });

    test('out-of-range ports surface an inline error without saving', () => {
        const widget = openBasicDetail({
            local_service: {
                enabled: true,
                host: '192.168.1.8',
                port: 9050,
                https: false,
                user_token: '',
                manage_token: 'm1',
                hide_staff_info: false
            }
        });

        widget.handleLocalServicePortChange('70000');

        expect(widget.queueStaffUpdate).not.toHaveBeenCalled();
        const status = widget.shadowRoot.querySelector('#local-service-status');
        expect(status.dataset.state).toBe('error');
        expect(status.textContent).toContain('Port must be between 1 and 65535');
    });

    test('service state events refresh the status rows in place with both entry links', () => {
        const widget = openBasicDetail({
            local_service: {
                enabled: true,
                host: '192.168.1.8',
                port: 9050,
                https: false,
                user_token: 'u1',
                manage_token: 'm1',
                hide_staff_info: false
            }
        });

        widget.onLocalServiceChanged('staff-id', { listening: true, url: 'http://192.168.1.8:9050' });
        const status = widget.shadowRoot.querySelector('#local-service-status');
        expect(status.dataset.state).toBe('running');
        const urls = [...status.querySelectorAll('.local-service-url')].map((node: any) => node.textContent);
        expect(urls).toEqual(['http://192.168.1.8:9050/chat?token=u1', 'http://192.168.1.8:9050/manage?token=m1']);
        expect(status.querySelector('[data-service-link="chat"][data-link-action="copy"]')).not.toBeNull();
        expect(status.querySelector('[data-service-link="manage"][data-link-action="open"]')).not.toBeNull();

        widget.onLocalServiceChanged('staff-id', { listening: false, error: 'port busy' });
        expect(status.dataset.state).toBe('error');
        expect(status.querySelector('.local-service-error').textContent).toBe('port busy');

        widget.onLocalServiceChanged('other-staff', { listening: false });
        expect(status.dataset.state).toBe('error');
    });

    test('token-free chat yields bare links while the manage link keeps its token', () => {
        const widget = openBasicDetail({
            local_service: {
                enabled: true,
                host: '192.168.1.8',
                port: 9050,
                https: false,
                user_token: '',
                manage_token: 'm1',
                hide_staff_info: false
            }
        });

        widget.onLocalServiceChanged('staff-id', { listening: true, url: 'http://192.168.1.8:9050' });
        const urls = [...widget.shadowRoot.querySelectorAll('#local-service-status .local-service-url')].map(
            (node: any) => node.textContent
        );
        expect(urls).toEqual(['http://192.168.1.8:9050/chat', 'http://192.168.1.8:9050/manage?token=m1']);
    });

    test('status line enters a pending state while applying and shows the error when listening fails', () => {
        const widget = openBasicDetail({
            local_service: {
                enabled: true,
                host: '192.168.3.26',
                port: 9050,
                https: false,
                user_token: '',
                manage_token: 'm1',
                hide_staff_info: false
            }
        });

        widget.handleLocalServiceConfigChange({ port: 9053 });
        let status = widget.shadowRoot.querySelector('#local-service-status');
        expect(status.dataset.state).toBe('pending');
        expect(status.textContent).toContain('Applying changes…');
        // 过渡态绝不沿用旧的绿色可用状态
        expect(status.querySelector('.local-service-url')).toBeNull();

        widget.onLocalServiceChanged('staff-id', { listening: false, error: 'listen EADDRINUSE' });
        status = widget.shadowRoot.querySelector('#local-service-status');
        expect(status.dataset.state).toBe('error');
        expect(status.textContent).toContain('listen EADDRINUSE');

        widget.onLocalServiceChanged('staff-id', { listening: true, url: 'http://192.168.3.26:9053' });
        status = widget.shadowRoot.querySelector('#local-service-status');
        expect(status.dataset.state).toBe('running');
        expect(status.textContent).toContain('http://192.168.3.26:9053/chat');
    });

    test('saved hosts missing from the current address list stay selectable', () => {
        const widget = openBasicDetail({
            local_service: {
                enabled: true,
                host: '10.0.0.99',
                port: 9050,
                https: false,
                user_token: '',
                manage_token: 'm1',
                hide_staff_info: false
            }
        });

        const hostSelect = widget.shadowRoot.querySelector('#f-local-service-host') as any;
        const values = [...hostSelect.querySelectorAll('option')].map((option: any) => option.value);
        expect(values).toEqual(['127.0.0.1', '192.168.1.8', '10.0.0.99']);
        expect(hostSelect.value).toBe('10.0.0.99');
    });

    test('clearing the manage token while enabled surfaces an error and skips saving', () => {
        const widget = openBasicDetail({
            local_service: {
                enabled: true,
                host: '192.168.1.8',
                port: 9050,
                https: false,
                user_token: '',
                manage_token: 'm1',
                hide_staff_info: false
            }
        });

        const manageInput = widget.shadowRoot.querySelector('#f-local-service-manage-token');
        manageInput.value = '   ';
        manageInput.dispatchEvent(new Event('change'));

        expect(widget.queueStaffUpdate).not.toHaveBeenCalled();
        const error = widget.shadowRoot.querySelector('#f-local-service-manage-token-error');
        expect(error.textContent).toBe('A manage token is required while the service is enabled');
        expect(widget.detail.local_service.manage_token).toBe('m1');

        // 重新填入后错误消失并立即保存
        manageInput.value = ' new-manage-token ';
        manageInput.dispatchEvent(new Event('change'));
        expect(error.textContent).toBe('');
        expect(widget.detail.local_service.manage_token).toBe('new-manage-token');
        expect(widget.queueStaffUpdate).toHaveBeenLastCalledWith(
            {
                local_service: {
                    enabled: true,
                    host: '192.168.1.8',
                    port: 9050,
                    https: false,
                    user_token: '',
                    manage_token: 'new-manage-token',
                    hide_staff_info: false
                }
            },
            true
        );
    });

    test('the generate buttons fill random tokens and save immediately', () => {
        const widget = openBasicDetail({
            local_service: {
                enabled: true,
                host: '192.168.1.8',
                port: 9050,
                https: false,
                user_token: '',
                manage_token: 'm1',
                hide_staff_info: false
            }
        });

        widget.shadowRoot.querySelector('[data-action="generate-user-token"]').click();
        expect(widget.detail.local_service.user_token).toMatch(/^[a-zA-Z0-9]{16}$/);
        expect((widget.shadowRoot.querySelector('#f-local-service-user-token') as HTMLInputElement).value).toBe(
            widget.detail.local_service.user_token
        );

        widget.shadowRoot.querySelector('[data-action="generate-manage-token"]').click();
        expect(widget.detail.local_service.manage_token).toMatch(/^[a-zA-Z0-9]{16}$/);
        expect(widget.detail.local_service.manage_token).not.toBe('m1');
        expect(widget.queueStaffUpdate).toHaveBeenLastCalledWith({ local_service: widget.detail.local_service }, true);
    });

    test('the hide-staff-info toggle saves the privacy flag immediately', () => {
        const widget = openBasicDetail({
            local_service: {
                enabled: true,
                host: '192.168.1.8',
                port: 9050,
                https: false,
                user_token: '',
                manage_token: 'm1',
                hide_staff_info: false
            }
        });

        const hideInfo = widget.shadowRoot.querySelector('#f-local-service-hide-info');
        hideInfo.checked = true;
        hideInfo.dispatchEvent(new Event('change'));

        expect(widget.detail.local_service.hide_staff_info).toBe(true);
        expect(widget.queueStaffUpdate).toHaveBeenLastCalledWith(
            {
                local_service: {
                    enabled: true,
                    host: '192.168.1.8',
                    port: 9050,
                    https: false,
                    user_token: '',
                    manage_token: 'm1',
                    hide_staff_info: true
                }
            },
            true
        );
    });

    test('transient stopped events during a restart keep the applying state to avoid flicker', () => {
        const widget = openBasicDetail({
            local_service: {
                enabled: true,
                host: '192.168.1.8',
                port: 9050,
                https: false,
                user_token: '',
                manage_token: 'm1',
                hide_staff_info: false
            }
        });
        widget.onLocalServiceChanged('staff-id', { listening: true, url: 'http://192.168.1.8:9050' });

        // 切换 HTTPS 进入过渡态
        widget.localServicePending = true;
        widget.updateLocalServiceStatusUI();
        let status = widget.shadowRoot.querySelector('#local-service-status');
        expect(status.dataset.state).toBe('pending');

        // 重启过程中的无错误 stopped 事件不清除"正在应用"，状态行不闪烁
        widget.onLocalServiceChanged('staff-id', { listening: false });
        status = widget.shadowRoot.querySelector('#local-service-status');
        expect(widget.localServicePending).toBe(true);
        expect(status.dataset.state).toBe('pending');

        // 重新监听后恢复运行态
        widget.onLocalServiceChanged('staff-id', { listening: true, url: 'https://192.168.1.8:9050' });
        status = widget.shadowRoot.querySelector('#local-service-status');
        expect(widget.localServicePending).toBe(false);
        expect(status.dataset.state).toBe('running');

        // 启动失败则清除过渡态并显示错误
        widget.localServicePending = true;
        widget.onLocalServiceChanged('staff-id', { listening: false, error: 'listen EADDRINUSE' });
        status = widget.shadowRoot.querySelector('#local-service-status');
        expect(widget.localServicePending).toBe(false);
        expect(status.dataset.state).toBe('error');
    });

    test('disabling the service does not enter the applying state', () => {
        const widget = openBasicDetail({
            local_service: {
                enabled: true,
                host: '192.168.1.8',
                port: 9050,
                https: false,
                user_token: '',
                manage_token: 'm1',
                hide_staff_info: false
            }
        });
        widget.onLocalServiceChanged('staff-id', { listening: true, url: 'http://192.168.1.8:9050' });

        const toggle = widget.shadowRoot.querySelector('#f-local-service');
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change'));

        expect(widget.localServicePending).toBe(false);
    });

    test('open buttons call the main-world entry opener with the link target', async () => {
        const widget = openBasicDetail({
            local_service: {
                enabled: true,
                host: '192.168.1.8',
                port: 9050,
                https: false,
                user_token: 'u1',
                manage_token: 'm1',
                hide_staff_info: false
            }
        });
        widget.onLocalServiceChanged('staff-id', { listening: true, url: 'http://192.168.1.8:9050' });
        widget.call = jest.fn().mockResolvedValue(undefined);

        widget.shadowRoot
            .querySelector('[data-service-link="chat"][data-link-action="open"]')
            .dispatchEvent(new Event('click'));
        await Promise.resolve();
        expect(widget.call).toHaveBeenCalledWith('openServiceInBrowser', 'staff-id', 'chat');

        widget.shadowRoot
            .querySelector('[data-service-link="manage"][data-link-action="open"]')
            .dispatchEvent(new Event('click'));
        await Promise.resolve();
        expect(widget.call).toHaveBeenCalledWith('openServiceInBrowser', 'staff-id', 'manage');
    });

    test('the https toggle saves the scheme flag and link rows follow the running scheme', () => {
        const widget = openBasicDetail({
            local_service: {
                enabled: true,
                host: '192.168.1.8',
                port: 9050,
                https: false,
                user_token: '',
                manage_token: 'm1',
                hide_staff_info: false
            }
        });

        const httpsToggle = widget.shadowRoot.querySelector('#f-local-service-https');
        expect(httpsToggle).not.toBeNull();
        httpsToggle.checked = true;
        httpsToggle.dispatchEvent(new Event('change'));

        expect(widget.detail.local_service.https).toBe(true);
        expect(widget.queueStaffUpdate).toHaveBeenLastCalledWith(
            {
                local_service: {
                    enabled: true,
                    host: '192.168.1.8',
                    port: 9050,
                    https: true,
                    user_token: '',
                    manage_token: 'm1',
                    hide_staff_info: false
                }
            },
            true
        );

        // 链接行直接采用运行时地址（服务重启后为 https://）
        widget.onLocalServiceChanged('staff-id', { listening: true, url: 'https://192.168.1.8:9050' });
        const urls = [...widget.shadowRoot.querySelectorAll('#local-service-status .local-service-url')].map(
            (node: any) => node.textContent
        );
        expect(urls).toEqual(['https://192.168.1.8:9050/chat', 'https://192.168.1.8:9050/manage?token=m1']);
    });
});
