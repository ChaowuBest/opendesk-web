import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { confirmModalMockShim } from '../../confirmModalMock.js';

const showConfirmModal = jest.fn(async () => true);
const executeSlashCommand = jest.fn();

describe('agent-input send/stop mutual exclusion', () => {
    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Event: window.Event,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            MutationObserver: window.MutationObserver,
            Node: window.Node,
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined,
            ResizeObserver: class {
                observe() {}
                disconnect() {}
            }
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });

        await jest.unstable_mockModule('../../../renderer/components/confirmModal.ts', () =>
            confirmModalMockShim({
                showConfirmModal
            })
        );
        await jest.unstable_mockModule('../../../renderer/components/imageLightbox.js', () => ({
            showImageLightbox: jest.fn()
        }));
        await jest.unstable_mockModule('../../../platforms/bridges/renderer.ts', () => ({
            NativeBridgeProxy: class {
                async getSpeechKit() {
                    return {
                        available: async () => false
                    };
                }
            }
        }));
        await jest.unstable_mockModule('../../../renderer/components/slash-command.ts', () => ({
            getSlashCommands: jest.fn(() => []),
            filterSlashCommands: jest.fn(() => []),
            executeSlashCommand,
            refreshPluginSlashCommands: jest.fn(async () => {})
        }));

        await import('../../../renderer/components/agentinput.js');
    });

    beforeEach(() => {
        showConfirmModal.mockClear();
        executeSlashCommand.mockReset();
        document.body.innerHTML = '';
        window.taskManagerAPI = {
            getAttachmentFileSupport: jest.fn(async () => ({
                supportedExtensions: ['doc', 'docx', 'xls', 'xlsx', 'pptx', 'odt', 'odp', 'ods', 'pdf', 'ofd', 'rtf'],
                knownUnsupportedExtensions: ['ppt']
            }))
        };
    });

    function setupInput() {
        const input = document.createElement('agent-input') as HTMLElement & {
            render: () => void;
            setStopMode: (showStop: boolean, onStopCallback?: (() => void) | null) => void;
            setDisabled: (disabled: boolean) => void;
            clearInput: () => void;
        };
        input.render();
        const textarea = input.querySelector('#agent-input-textarea') as HTMLTextAreaElement;
        textarea.setRangeText = jest.fn(function (this: HTMLTextAreaElement, text: string, start: number, end: number) {
            this.value = this.value.slice(0, start) + text + this.value.slice(end);
        });
        textarea.focus = jest.fn();
        return { input, textarea };
    }

    function getSendGroup(input: HTMLElement) {
        return input.querySelector('.agent-send-group') as HTMLElement;
    }

    function getStopButton(input: HTMLElement) {
        return input.querySelector('#agent-input-stop-btn') as HTMLElement;
    }

    test('未运行时只显示发送组，不显示停止按钮', () => {
        const { input } = setupInput();
        expect(getSendGroup(input).style.display).not.toBe('none');
        expect(getStopButton(input).style.display).toBe('none');
    });

    test('任务运行中且输入为空时，只显示停止按钮，隐藏发送组', () => {
        const { input, textarea } = setupInput();
        textarea.value = '';
        input.setStopMode(true, jest.fn());

        expect(getSendGroup(input).style.display).toBe('none');
        expect(getStopButton(input).style.display).not.toBe('none');
    });

    test('任务运行中且输入非空时，只显示发送组，不显示停止按钮', () => {
        const { input, textarea } = setupInput();
        textarea.value = 'hello';
        input.setStopMode(true, jest.fn());

        expect(getSendGroup(input).style.display).not.toBe('none');
        expect(getStopButton(input).style.display).toBe('none');
    });

    test('任务运行中仅附加图片（无文本）时，仍显示发送组', () => {
        const { input, textarea } = setupInput();
        textarea.value = '';
        input.setStopMode(true, jest.fn());
        expect(getSendGroup(input).style.display).toBe('none');

        // 模拟运行中附加图片：addImage 会经 updateSendButtonState 触发互斥刷新
        (input as unknown as { addImage: (dataUrl: string, name?: string) => void }).addImage(
            'data:image/png;base64,x',
            '图片1'
        );

        expect(getSendGroup(input).style.display).not.toBe('none');
        expect(getStopButton(input).style.display).toBe('none');
    });

    test('任务运行中输入从空变为非空时，实时从停止按钮切换为发送组', () => {
        const { input, textarea } = setupInput();
        input.setStopMode(true, jest.fn());
        expect(getSendGroup(input).style.display).toBe('none');
        expect(getStopButton(input).style.display).not.toBe('none');

        textarea.value = '排队消息';
        textarea.dispatchEvent(new window.Event('input', { bubbles: true }));

        expect(getSendGroup(input).style.display).not.toBe('none');
        expect(getStopButton(input).style.display).toBe('none');
    });

    test('任务运行中清空输入时，实时从发送组切换回停止按钮', () => {
        const { input, textarea } = setupInput();
        textarea.value = '排队消息';
        input.setStopMode(true, jest.fn());
        expect(getSendGroup(input).style.display).not.toBe('none');

        input.clearInput();

        expect(getSendGroup(input).style.display).toBe('none');
        expect(getStopButton(input).style.display).not.toBe('none');
    });

    test('输入仅含空白字符时视为空输入，显示停止按钮', () => {
        const { input, textarea } = setupInput();
        textarea.value = '   ';
        input.setStopMode(true, jest.fn());

        expect(getSendGroup(input).style.display).toBe('none');
        expect(getStopButton(input).style.display).not.toBe('none');
    });

    test('任务停止后（setStopMode(false)）恢复显示发送组，隐藏停止按钮', () => {
        const { input, textarea } = setupInput();
        textarea.value = '';
        input.setStopMode(true, jest.fn());
        expect(getSendGroup(input).style.display).toBe('none');

        input.setStopMode(false);

        expect(getSendGroup(input).style.display).not.toBe('none');
        expect(getStopButton(input).style.display).toBe('none');
    });

    test('taskview 调用顺序 setDisabled(true) + setStopMode(true) 下互斥逻辑依然生效', () => {
        const { input, textarea } = setupInput();
        textarea.value = 'hello';
        input.setDisabled(true);
        input.setStopMode(true, jest.fn());

        expect(getSendGroup(input).style.display).not.toBe('none');
        expect(getStopButton(input).style.display).toBe('none');

        textarea.value = '';
        input.clearInput();
        expect(getSendGroup(input).style.display).toBe('none');
        expect(getStopButton(input).style.display).not.toBe('none');
    });
});
