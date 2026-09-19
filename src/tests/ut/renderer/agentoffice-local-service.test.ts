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
            'agentoffice.localServiceApplying': 'Applying changes…'
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
            port: 9050
        });
        expect(widget.queueStaffUpdate).toHaveBeenCalledWith(
            { local_service: { enabled: true, host: '192.168.1.8', port: 9050 } },
            true
        );
        expect(widget.shadowRoot.querySelector('#local-service-config').hidden).toBe(false);
        const hostSelect = widget.shadowRoot.querySelector('#f-local-service-host') as any;
        expect(hostSelect.value).toBe('192.168.1.8');
        expect(widget.shadowRoot.querySelector('#f-local-service-port').value).toBe('9050');
    });

    test('address and port changes update the draft config and queue saves', () => {
        const widget = openBasicDetail({
            local_service: { enabled: true, host: '192.168.1.8', port: 9050 }
        });
        widget.localServiceRuntime = { listening: true, url: 'http://192.168.1.8:9050' };
        widget.updateLocalServiceStatusUI();

        const hostSelect = widget.shadowRoot.querySelector('#f-local-service-host');
        Object.defineProperty(hostSelect, 'value', { value: '127.0.0.1' });
        hostSelect.dispatchEvent(new Event('change'));
        expect(widget.detail.local_service.host).toBe('127.0.0.1');
        expect(widget.queueStaffUpdate).toHaveBeenLastCalledWith(
            { local_service: { enabled: true, host: '127.0.0.1', port: 9050 } },
            true
        );

        const portInput = widget.shadowRoot.querySelector('#f-local-service-port');
        Object.defineProperty(portInput, 'value', { value: '9060' });
        portInput.dispatchEvent(new Event('change'));
        expect(widget.detail.local_service.port).toBe(9060);
        expect(widget.queueStaffUpdate).toHaveBeenLastCalledWith(
            { local_service: { enabled: true, host: '127.0.0.1', port: 9060 } },
            true
        );
    });

    test('out-of-range ports surface an inline error without saving', () => {
        const widget = openBasicDetail({
            local_service: { enabled: true, host: '192.168.1.8', port: 9050 }
        });

        widget.handleLocalServicePortChange('70000');

        expect(widget.queueStaffUpdate).not.toHaveBeenCalled();
        const status = widget.shadowRoot.querySelector('#local-service-status');
        expect(status.dataset.state).toBe('error');
        expect(status.textContent).toContain('Port must be between 1 and 65535');
    });

    test('service state events refresh the status row in place', () => {
        const widget = openBasicDetail({
            local_service: { enabled: true, host: '192.168.1.8', port: 9050 }
        });

        widget.onLocalServiceChanged('staff-id', { listening: true, url: 'http://192.168.1.8:9050' });
        const status = widget.shadowRoot.querySelector('#local-service-status');
        expect(status.dataset.state).toBe('running');
        expect(status.querySelector('.local-service-url').textContent).toBe('http://192.168.1.8:9050');
        expect(status.querySelector('[data-action="copy-service-url"]')).not.toBeNull();

        widget.onLocalServiceChanged('staff-id', { listening: false, error: 'port busy' });
        expect(status.dataset.state).toBe('error');
        expect(status.querySelector('.local-service-error').textContent).toBe('port busy');

        widget.onLocalServiceChanged('other-staff', { listening: false });
        expect(status.dataset.state).toBe('error');
    });

    test('status line enters a pending state while applying and shows the error when listening fails', () => {
        const widget = openBasicDetail({
            local_service: { enabled: true, host: '192.168.3.26', port: 9050 }
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
        expect(status.textContent).toContain('http://192.168.3.26:9053');
    });

    test('saved hosts missing from the current address list stay selectable', () => {
        const widget = openBasicDetail({
            local_service: { enabled: true, host: '10.0.0.99', port: 9050 }
        });

        const hostSelect = widget.shadowRoot.querySelector('#f-local-service-host') as any;
        const values = [...hostSelect.querySelectorAll('option')].map((option: any) => option.value);
        expect(values).toEqual(['127.0.0.1', '192.168.1.8', '10.0.0.99']);
        expect(hostSelect.value).toBe('10.0.0.99');
    });
});
