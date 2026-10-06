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
                    'rtf',
                    'txt'
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
            '/tmp/paper.pdf',
            '/tmp/notes.txt'
        ];

        await expect(input.attachFilePaths(files)).resolves.toBe(true);

        expect(input.attachedFilePaths).toEqual(files);
        expect(input.render).toHaveBeenCalledTimes(1);
        expect(showConfirmModal).not.toHaveBeenCalled();
    });

    test('pastes unsupported file paths to textarea without attaching them', async () => {
        const input = document.createElement('agent-input') as HTMLElement & {
            attachedFilePaths: string[];
            render: jest.Mock;
            attachFilePath: (filePath: string) => Promise<boolean>;
        };
        input.render = jest.fn();
        input.innerHTML = '<textarea id="agent-input-textarea"></textarea>';

        const textarea = input.querySelector('#agent-input-textarea') as HTMLTextAreaElement;
        textarea.setSelectionRange = jest.fn();
        textarea.focus = jest.fn();

        const result = await input.attachFilePath('/tmp/legacy.PPT');

        expect(result).toBe(false);
        expect(input.attachedFilePaths).toEqual([]);
        expect(input.render).not.toHaveBeenCalled();

        // 路径应直接粘贴到 textarea，不弹模态窗
        expect(textarea.value).toContain('/tmp/legacy.PPT');
        expect(document.querySelector('.od-confirm-modal-overlay')).toBeNull();
    });

    test('leaves rich-text clipboard content to the textarea native plain-text paste', () => {
        const input = document.createElement('agent-input') as HTMLElement & {
            render: () => void;
        };
        input.render();
        const textarea = input.querySelector('#agent-input-textarea') as HTMLTextAreaElement;
        const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(pasteEvent, 'clipboardData', {
            value: {
                items: [{ type: 'text/html' }],
                getData: jest.fn((type: string) =>
                    type === 'text/plain' ? '/Users/tester/.ssh/known_hosts' : '<strong>known_hosts</strong>'
                )
            }
        });

        textarea.dispatchEvent(pasteEvent);

        expect(pasteEvent.defaultPrevented).toBe(false);
    });

    test('leaves PowerPoint clipboard text to the textarea instead of attaching its image preview', () => {
        const input = document.createElement('agent-input') as HTMLElement & {
            render: () => void;
        };
        input.render();
        const textarea = input.querySelector('#agent-input-textarea') as HTMLTextAreaElement;
        const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(pasteEvent, 'clipboardData', {
            value: {
                items: [
                    { type: 'text/plain' },
                    { type: 'text/html' },
                    { type: 'image/png', getAsFile: jest.fn(() => null) }
                ],
                getData: jest.fn((type: string) => {
                    if (type === 'text/plain') return 'Quarterly review';
                    if (type === 'text/html') {
                        return '<html xmlns:p="urn:schemas-microsoft-com:office:powerpoint"><body>Quarterly review</body></html>';
                    }
                    return '';
                })
            }
        });

        textarea.dispatchEvent(pasteEvent);

        expect(pasteEvent.defaultPrevented).toBe(false);
    });

    test('still intercepts copied web images when HTML accompanies the image', () => {
        const input = document.createElement('agent-input') as HTMLElement & {
            render: () => void;
        };
        input.render();
        const textarea = input.querySelector('#agent-input-textarea') as HTMLTextAreaElement;
        const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(pasteEvent, 'clipboardData', {
            value: {
                items: [{ type: 'text/html' }, { type: 'image/png', getAsFile: jest.fn(() => null) }],
                getData: jest.fn((type: string) =>
                    type === 'text/html' ? '<img src="https://example.com/chart.png">' : ''
                )
            }
        });

        textarea.dispatchEvent(pasteEvent);

        expect(pasteEvent.defaultPrevented).toBe(true);
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
