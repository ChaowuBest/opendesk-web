import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('agentoffice management form behavior', () => {
    let WidgetClass: new () => HTMLElement;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Element: window.Element,
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
            'agentoffice.requiredFields': 'Required fields',
            'agentoffice.autoSaveSaving': 'Saving',
            'agentoffice.autoSaveSaved': 'Saved',
            'agentoffice.autoSaveInvalid': 'Fix the highlighted field',
            'agentoffice.autoSaveFailed': 'Auto-save failed',
            'agentoffice.deleteMessage': 'Delete message',
            'agentoffice.deleteMessagePart.text': 'Delete text',
            'agentoffice.deleteMessagePart.image': 'Delete image',
            'agentoffice.deleteMessagePart.video': 'Delete video',
            'agentoffice.deleteMessagePart.audio': 'Delete audio',
            'agentoffice.deleteMessagePart.file': 'Delete file'
        };
        return widget;
    }

    function detail(overrides: Record<string, unknown> = {}): any {
        return {
            id: 'staff-id',
            name: 'Staff name',
            vendor_name: 'Vendor',
            title: 'Title',
            specialties: ['Research'],
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

    test('an operation locks the existing DOM without discarding draft values', async () => {
        const widget = createWidget();
        widget.shadowRoot.innerHTML =
            '<div class="root"><p class="detail-notice" hidden></p><textarea id="draft">unsaved MCP draft</textarea></div>';
        const draft = widget.shadowRoot.querySelector('#draft');
        let capturedValue = '';

        widget.runOperation(async () => {
            capturedValue = widget.shadowRoot.querySelector('#draft').value;
            throw new Error('invalid JSON');
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(capturedValue).toBe('unsaved MCP draft');
        expect(widget.shadowRoot.querySelector('#draft')).toBe(draft);
        expect(draft.value).toBe('unsaved MCP draft');
        expect(widget.shadowRoot.querySelector('.root').classList.contains('busy')).toBe(false);
        expect(widget.shadowRoot.querySelector('.detail-notice').textContent).toBe('Operation failed: invalid JSON');
        expect(widget.shadowRoot.querySelector('.detail-notice').hidden).toBe(false);
    });

    test('basic information validation stays inline and preserves the form draft', () => {
        const widget = createWidget();
        widget.detail = detail();
        widget.shadowRoot.innerHTML = `<div class="root"><p class="detail-notice" hidden></p>
            <div class="field" data-basic-field="vendor"><input id="f-vendor" value=""></div>
            <span class="auto-save-indicator" data-state="idle"></span></div>`;
        const vendor = widget.shadowRoot.querySelector('#f-vendor');
        widget.queueStaffUpdate = jest.fn();

        widget.handleBasicFieldInput(vendor);

        expect(widget.queueStaffUpdate).not.toHaveBeenCalled();
        expect(vendor.value).toBe('');
        expect(widget.shadowRoot.querySelector('[data-basic-field="vendor"]').classList.contains('invalid')).toBe(true);
        expect(vendor.hasAttribute('aria-invalid')).toBe(true);
        expect(widget.shadowRoot.querySelector('.auto-save-indicator').textContent).toBe('Fix the highlighted field');
    });

    test('enabled changes are applied to the draft and queued immediately', () => {
        const widget = createWidget();
        widget.detail = detail();
        widget.activeTab = 'management';
        widget.render();
        widget.queueStaffUpdate = jest.fn();
        const enabled = widget.shadowRoot.querySelector('#f-enabled');

        enabled.checked = false;
        enabled.dispatchEvent(new Event('change'));

        expect(widget.detail.enabled).toBe(false);
        expect(widget.queueStaffUpdate).toHaveBeenCalledWith({ enabled: false }, true);
        expect(widget.shadowRoot.querySelector('[data-action="save-basic"]')).toBeNull();
        expect(widget.shadowRoot.querySelector('#f-enabled + .setting-toggle-track')).not.toBeNull();
    });

    test('trigger interval changes update the template definition immediately', () => {
        const widget = createWidget();
        widget.detail = detail();
        widget.activeTab = 'management';
        widget.render();
        widget.queueStaffUpdate = jest.fn();
        const interval = widget.shadowRoot.querySelector('#f-trigger-interval');

        Object.defineProperty(interval, 'value', { value: '15m' });
        interval.dispatchEvent(new Event('change'));

        expect(widget.detail.trigger_interval).toBe('15m');
        expect(widget.queueStaffUpdate).toHaveBeenCalledWith(
            {
                definition: {
                    name: 'Staff name',
                    vendor_name: 'Vendor',
                    title: 'Title',
                    specialties: ['Research'],
                    trigger_interval: '15m'
                }
            },
            true
        );
    });

    test('chat messages hide task ids and retain task navigation metadata for the context menu', () => {
        const widget = createWidget();
        widget.locale = 'en-US';
        widget.messages = [
            {
                id: 'message-1',
                role: 'user',
                task_id: 'task-secret',
                created_at: '2026-01-01T00:00:00.000Z',
                content: [{ type: 'text', text: '**Hello**' }]
            }
        ];

        const html = widget.renderMessages('staff-id');

        expect(html).toContain('data-message-task="task-secret"');
        expect(html).not.toContain('data-task="task-secret"');
        expect(html).not.toContain('>task-secret<');
        expect(html).toContain('<strong>Hello</strong>');
        expect(html).toContain('message-markdown markdown-body');
    });

    test('both message roles expose copy actions and task navigation through the context menu', () => {
        const widget = createWidget();
        widget.messages = [
            {
                id: 'assistant-message',
                role: 'assistant',
                task_id: 'task-id',
                created_at: '2026-01-01T00:00:00.000Z',
                content: [{ type: 'text', text: 'Reply' }]
            }
        ];
        widget.shadowRoot.innerHTML =
            '<div class="root"><div class="message assistant" data-message-id="assistant-message"></div></div>';
        const postMessage = jest.fn();
        (window as any).parent = { postMessage };

        widget.showMessageContextMenu(20, 20, widget.shadowRoot.querySelector('[data-message-id="assistant-message"]'));

        expect(widget.shadowRoot.querySelector('[data-message-menu="copy"]')).not.toBeNull();
        expect(widget.shadowRoot.querySelector('[data-message-menu="copy-plain"]')).not.toBeNull();
        widget.shadowRoot.querySelector('[data-message-menu="open-task"]').click();
        expect(postMessage).toHaveBeenCalledWith({ type: 'openTask', taskId: 'task-id' }, '*');
    });

    test('message context menu offers per-part and whole-message deletion', async () => {
        const widget = createWidget();
        widget.selectedStaffId = 'staff-id';
        const imageMessage = {
            id: 'm-img',
            role: 'assistant',
            task_id: 'task-1',
            created_at: '2026-01-01T00:00:00.000Z',
            content: [
                { type: 'text', text: '看图' },
                {
                    type: 'resource',
                    resource_id: 'r1',
                    media_type: 'image',
                    mime_type: 'image/png',
                    name: 'shot.png',
                    path: 'resources/shot.png'
                }
            ]
        };
        widget.messages = [imageMessage];
        widget.call = jest.fn((method: string) => {
            if (method === 'getHistoryMessagesForUI') {
                return Promise.resolve({ messages: [], has_more: false });
            }
            return Promise.resolve(null);
        });
        widget.shadowRoot.innerHTML =
            '<div class="root"><div class="message assistant" data-message-id="m-img"></div></div>';
        const postMessage = jest.fn();
        (window as any).parent = { postMessage };

        widget.showMessageContextMenu(20, 20, widget.shadowRoot.querySelector('[data-message-id="m-img"]'));

        const deleteMessage = widget.shadowRoot.querySelector('[data-message-menu="delete-message"]');
        const partItems = widget.shadowRoot.querySelectorAll('[data-message-menu="delete-part"]');
        expect(deleteMessage).not.toBeNull();
        expect(partItems).toHaveLength(2);
        const deleteImage = widget.shadowRoot.querySelector(
            '[data-message-menu="delete-part"][data-part-index="1"]'
        ) as HTMLElement;
        expect(deleteImage.textContent).toContain('Delete image');

        deleteImage.click();
        await Promise.resolve();
        await Promise.resolve();
        expect(widget.call).toHaveBeenCalledWith('deleteStaffMessagePart', 'staff-id', 'm-img', 1);

        // 分块删除会关闭菜单，且 mock 的刷新会清空消息；整条删除前先恢复再重新打开
        widget.messages = [imageMessage];
        widget.shadowRoot.innerHTML =
            '<div class="root"><div class="message assistant" data-message-id="m-img"></div></div>';
        widget.showMessageContextMenu(20, 20, widget.shadowRoot.querySelector('[data-message-id="m-img"]'));
        widget.shadowRoot.querySelector('[data-message-menu="delete-message"]').click();
        await Promise.resolve();
        await Promise.resolve();
        expect(widget.call).toHaveBeenCalledWith('deleteStaffMessage', 'staff-id', 'm-img');
    });

    test('detail controls use toggle and Font Awesome treatments', () => {
        const widget = createWidget();
        widget.detail = detail({
            permission: { network_access: true, directories: [{ path: '/docs', access: 'read' }] }
        });
        widget.activeTab = 'management';

        widget.render();

        expect(widget.shadowRoot.querySelector('[data-action="back"] .fa-arrow-left')).not.toBeNull();
        const css = widget.shadowRoot.querySelector('style').textContent.replace(/\s+/g, '');
        expect(css).toContain(".fa-arrow-left{--fa:'\\f060';}");
        expect(widget.shadowRoot.querySelector('#f-enabled + .setting-toggle-track')).not.toBeNull();
        widget.detailSection = 'security';
        widget.render();
        expect(widget.shadowRoot.querySelector('#f-network + .setting-toggle-track')).not.toBeNull();
        expect(widget.shadowRoot.querySelector('[data-remove-dir] .fa-xmark')).not.toBeNull();
        expect(widget.shadowRoot.querySelector('.network-setting-row')).not.toBeNull();
        expect(widget.shadowRoot.querySelector('style').textContent.replace(/\s+/g, '')).toContain(
            '.network-setting-row{border-bottom:0;}'
        );
    });

    test('security directory rows share aligned columns and Settings-style access selects', () => {
        const widget = createWidget();
        widget.detail = detail({
            permission: {
                network_access: true,
                directories: [
                    { path: '/first', access: 'read' },
                    { path: '/second', access: 'readwrite' }
                ]
            }
        });
        widget.activeTab = 'management';
        widget.detailSection = 'security';

        widget.render();

        expect(widget.shadowRoot.querySelector('.directory-header.directory-grid')).not.toBeNull();
        expect(widget.shadowRoot.querySelectorAll('.directory-row.directory-grid')).toHaveLength(2);
        expect(widget.shadowRoot.querySelectorAll('.directory-row select[data-dir-access]')).toHaveLength(2);
        expect(widget.shadowRoot.querySelectorAll('.directory-remove .fa-xmark')).toHaveLength(2);
    });

    test('skill import choices open exactly one explicit picker', async () => {
        const widget = createWidget();
        widget.detail = detail();
        widget.call = jest.fn();
        const selectDirectory = jest.fn().mockResolvedValue(null);
        const selectFile = jest.fn().mockResolvedValue([]);
        (window as any).fsAPI = { selectDirectory, selectFile };

        await widget.addSkillFromDirectory();

        expect(selectDirectory).toHaveBeenCalledTimes(1);
        expect(selectFile).not.toHaveBeenCalled();

        await widget.addSkillFromZip();

        expect(selectFile).toHaveBeenCalledTimes(1);
        expect(selectDirectory).toHaveBeenCalledTimes(1);
        expect(widget.call).not.toHaveBeenCalled();
    });

    test('the Skill add menu includes every Skill Center import route plus installed Skills', () => {
        const widget = createWidget();

        const html = widget.renderSkillAddMenu();

        expect(html).toContain('data-action="add-skill-directory"');
        expect(html).toContain('data-action="add-skill-zip"');
        expect(html).toContain('data-action="batch-import-skills"');
        expect(html).toContain('data-action="add-skill-url"');
        expect(html).toContain('data-action="add-installed-skills"');
    });

    test('staff Skill cards open a Skill Center-style detail card', () => {
        const widget = createWidget();
        widget.activeTab = 'management';
        widget.detail = detail();
        widget.detailSection = 'skills';
        widget.modal = 'skill-detail';
        widget.selectedSkill = {
            name: 'Research Helper',
            directory_name: 'research-helper',
            path: 'agent/skills/research-helper',
            description: 'Finds evidence',
            body: '# Instructions',
            license: 'MIT',
            allowed_tools: ['web']
        };
        widget.skills = [widget.selectedSkill];

        widget.render();

        const card = widget.shadowRoot.querySelector('#staff-skill-detail-card');
        expect(card).not.toBeNull();
        expect(card.shadowRoot.querySelector('.detail-dialog')).not.toBeNull();
        expect(card.shadowRoot.querySelector('.detail-icon').textContent).toBe('R');
        expect(card.shadowRoot.querySelector('.detail-body-content.markdown-body')).not.toBeNull();
        expect(card.shadowRoot.querySelector('.detail-meta-grid')).not.toBeNull();
        expect(card.shadowRoot.querySelector('[data-detail-action="delete"]')).not.toBeNull();
        expect(widget.shadowRoot.querySelector('.skill-card-icon').textContent).toBe('R');
    });

    test('dark mode uses the same base surfaces as Skill Center', () => {
        const widget = createWidget();
        widget.render();

        const css = widget.shadowRoot.querySelector('style').textContent.replace(/\s+/g, '');
        expect(css).toContain('background:#1e1e1e');
        expect(css).toContain('--bg:#1e1e1e;--surface:#252526;--surface2:#333;');
    });

    test('batch Skill import scans one chosen directory and opens a constrained multi-select list', async () => {
        const widget = createWidget();
        widget.detail = detail();
        (window as any).fsAPI = { selectDirectory: jest.fn().mockResolvedValue('/skills') };
        widget.call = jest.fn().mockResolvedValue([
            { path: '/skills/one', name: 'one', type: 'directory' },
            { path: '/skills/two.zip', name: 'two.zip', type: 'zip' }
        ]);

        await widget.openBatchSkillPicker();

        expect(widget.call).toHaveBeenCalledWith('scanSkillSources', '/skills');
        expect(widget.modal).toBe('batch-skills');
        expect(widget.selectedBatchSkillPaths.size).toBe(2);
        expect(widget.shadowRoot.querySelectorAll('[data-batch-skill]')).toHaveLength(2);
        expect(widget.shadowRoot.querySelector('.installed-skill-list')).not.toBeNull();
    });

    test('URL Skill import validates inline without calling the backend or closing the modal', async () => {
        const widget = createWidget();
        widget.detail = detail();
        widget.call = jest.fn();
        widget.shadowRoot.innerHTML = `<div class="root"><div class="modal-error" id="skill-modal-error"></div><input id="skill-url-input" value="file:///skill.zip"></div>`;

        await widget.addSkillFromUrl();

        expect(widget.call).not.toHaveBeenCalled();
        expect(widget.shadowRoot.querySelector('#skill-modal-error').textContent).toBe('agentoffice.skillUrlInvalid');
    });

    test('auto-save persists immediate updates and reports completion', async () => {
        const widget = createWidget();
        widget.detail = detail({ enabled: false });
        widget.staffs = [detail()];
        widget.shadowRoot.innerHTML = `<div class="root"><span class="auto-save-indicator" data-state="idle"></span>
            <p class="detail-notice" hidden></p></div>`;
        widget.call = jest.fn().mockResolvedValue(detail({ enabled: false }));

        widget.queueStaffUpdate({ enabled: false }, true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(widget.call).toHaveBeenCalledWith('updateStaff', 'staff-id', { enabled: false });
        expect(widget.staffs[0].enabled).toBe(false);
        expect(widget.shadowRoot.querySelector('.auto-save-indicator').dataset.state).toBe('saved');
        expect(widget.shadowRoot.querySelector('.auto-save-indicator').textContent).toBe('Saved');
        clearTimeout(widget.autoSaveIndicatorTimer);
    });

    test('edits made during an in-flight save are sent in a following update', async () => {
        const widget = createWidget();
        widget.detail = detail();
        widget.shadowRoot.innerHTML = `<span class="auto-save-indicator" data-state="idle"></span>
            <p class="detail-notice" hidden></p>`;
        let finishFirst: ((value: unknown) => void) | undefined;
        widget.call = jest
            .fn()
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finishFirst = resolve;
                    })
            )
            .mockResolvedValueOnce(detail({ model: 'model-b' }));

        widget.queueStaffUpdate({ enabled: false }, true);
        widget.queueStaffUpdate({ model: 'model-b' }, true);
        finishFirst?.(detail({ enabled: false }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(widget.call).toHaveBeenNthCalledWith(1, 'updateStaff', 'staff-id', { enabled: false });
        expect(widget.call).toHaveBeenNthCalledWith(2, 'updateStaff', 'staff-id', { model: 'model-b' });
        clearTimeout(widget.autoSaveIndicatorTimer);
    });

    test('a failed auto-save remains pending and is retried with the next edit', async () => {
        const widget = createWidget();
        widget.detail = detail();
        widget.shadowRoot.innerHTML = `<span class="auto-save-indicator" data-state="idle"></span>
            <p class="detail-notice" hidden></p>`;
        widget.call = jest
            .fn()
            .mockRejectedValueOnce(new Error('disk unavailable'))
            .mockResolvedValueOnce(detail({ enabled: false, model: 'model-b' }));

        widget.queueStaffUpdate({ enabled: false }, true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(widget.shadowRoot.querySelector('.auto-save-indicator').dataset.state).toBe('error');
        expect(widget.shadowRoot.querySelector('.detail-notice').textContent).toContain('disk unavailable');

        widget.queueStaffUpdate({ model: 'model-b' }, true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(widget.call).toHaveBeenNthCalledWith(2, 'updateStaff', 'staff-id', {
            enabled: false,
            model: 'model-b'
        });
        expect(widget.shadowRoot.querySelector('.auto-save-indicator').dataset.state).toBe('saved');
        clearTimeout(widget.autoSaveIndicatorTimer);
    });

    test('security controls synchronize their current draft before rows are changed', () => {
        const widget = createWidget();
        widget.detail = {
            permission: {
                network_access: false,
                directories: [
                    { path: '/first', access: 'read' },
                    { path: '/second', access: 'readwrite' }
                ]
            }
        };
        widget.shadowRoot.innerHTML = `<div class="root"><input id="f-network" type="checkbox" checked>
            <select data-dir-access="0"><option value="read">read</option><option value="readwrite" selected>readwrite</option></select>
            <select data-dir-access="1"><option value="read" selected>read</option><option value="readwrite">readwrite</option></select></div>`;
        widget.shadowRoot.querySelector('#f-network').checked = true;

        widget.syncSecurityDraft();

        expect(widget.detail.permission).toEqual({
            network_access: true,
            directories: [
                { path: '/first', access: 'readwrite' },
                { path: '/second', access: 'read' }
            ]
        });
    });
});
