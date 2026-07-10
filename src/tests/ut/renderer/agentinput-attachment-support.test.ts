import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

const showConfirmModal = jest.fn(async () => true);
const executeSlashCommand = jest.fn();

describe('agent-input attachment support', () => {
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

        await jest.unstable_mockModule('../../../renderer/components/confirmModal.ts', () => ({
            showConfirmModal
        }));
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
            executeSlashCommand
        }));

        await import('../../../renderer/components/agentinput.js');
    });

    beforeEach(() => {
        showConfirmModal.mockClear();
        executeSlashCommand.mockReset();
        document.body.innerHTML = '';
        window.taskManagerAPI = {
            getAttachmentFileSupport: jest.fn(async () => ({
                supportedExtensions: [
                    'doc',
                    'docx',
                    'xls',
                    'xlsx',
                    'csv',
                    'pptx',
                    'odt',
                    'odp',
                    'ods',
                    'pdf',
                    'ofd',
                    'rtf'
                ],
                knownUnsupportedExtensions: ['ppt']
            }))
        };
    });

    test('accepts every attachment extension reported by the main process', async () => {
        const input = document.createElement('agent-input') as HTMLElement & {
            attachedFilePaths: string[];
            render: jest.Mock;
            attachFilePaths: (filePaths: string[]) => Promise<boolean>;
        };
        input.render = jest.fn();

        const files = [
            '/tmp/report.docx',
            '/tmp/legacy.doc',
            '/tmp/legacy-sheet.xls',
            '/tmp/slides.pptx',
            '/tmp/sheet.xlsx',
            '/tmp/text.odt',
            '/tmp/deck.odp',
            '/tmp/calc.ods',
            '/tmp/paper.pdf'
        ];

        await expect(input.attachFilePaths(files)).resolves.toBe(true);

        expect(input.attachedFilePaths).toEqual(files);
        expect(input.render).toHaveBeenCalledTimes(1);
        expect(showConfirmModal).not.toHaveBeenCalled();
    });

    test('shows a modal and does not attach unsupported legacy powerpoint files', async () => {
        const input = document.createElement('agent-input') as HTMLElement & {
            attachedFilePaths: string[];
            render: jest.Mock;
            attachFilePath: (filePath: string) => Promise<boolean>;
        };
        input.render = jest.fn();

        // 启动 attachFilePath，不 await —— 模态框的 Promise 需要手动关闭
        const promise = input.attachFilePath('/tmp/legacy.PPT');

        // 等待模态框渲染到 DOM
        await new Promise((r) => setTimeout(r, 10));

        // 点击取消按钮关闭模态框，使 Promise resolve
        const cancelBtn = document.querySelector('[data-action="cancel"]');
        if (cancelBtn instanceof HTMLElement) {
            cancelBtn.click();
        }

        const result = await promise;
        expect(result).toBe(false);
        expect(input.attachedFilePaths).toEqual([]);
        expect(input.render).not.toHaveBeenCalled();
    });

    test('hides the goal button when requested by the host surface', () => {
        const input = document.createElement('agent-input') as HTMLElement & {
            render: () => void;
        };
        input.setAttribute('hide-goal', '');

        input.render();

        expect(input.querySelector('#agent-goal-btn')).toBeNull();
    });

    test('preserves slash command input when execution is cancelled', async () => {
        executeSlashCommand.mockResolvedValueOnce({ status: 'cancelled', inputDisposition: 'preserve' });
        const input = document.createElement('agent-input') as HTMLElement & {
            _executeSlashCommand: (name: string, args: string) => Promise<void>;
        };
        input.innerHTML = '<textarea id="agent-input-textarea">/goal replacement</textarea>';

        await input._executeSlashCommand('goal', 'replacement');

        expect((input.querySelector('#agent-input-textarea') as HTMLTextAreaElement).value).toBe('/goal replacement');
    });

    test('clears slash command input after successful execution', async () => {
        executeSlashCommand.mockResolvedValueOnce({ status: 'executed', inputDisposition: 'clear' });
        const input = document.createElement('agent-input') as HTMLElement & {
            _executeSlashCommand: (name: string, args: string) => Promise<void>;
        };
        input.innerHTML = '<textarea id="agent-input-textarea">/goal replacement</textarea>';

        await input._executeSlashCommand('goal', 'replacement');

        expect((input.querySelector('#agent-input-textarea') as HTMLTextAreaElement).value).toBe('');
    });

    test('does not execute duplicate slash commands while confirmation is pending', async () => {
        let resolveCommand: ((value: { status: 'executed'; inputDisposition: 'clear' }) => void) | undefined;
        executeSlashCommand.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveCommand = resolve;
                })
        );
        const input = document.createElement('agent-input') as HTMLElement & {
            _executeSlashCommand: (name: string, args: string) => Promise<void>;
        };
        input.innerHTML = '<textarea id="agent-input-textarea">/goal replacement</textarea>';

        const first = input._executeSlashCommand('goal', 'replacement');
        await input._executeSlashCommand('goal', 'replacement');
        expect(executeSlashCommand).toHaveBeenCalledTimes(1);
        (input.querySelector('#agent-input-textarea') as HTMLTextAreaElement).value = 'new draft';
        resolveCommand?.({ status: 'executed', inputDisposition: 'clear' });
        await first;
        expect((input.querySelector('#agent-input-textarea') as HTMLTextAreaElement).value).toBe('new draft');
    });
});
