import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

const showConfirmModal = jest.fn(async () => true);

describe('agent-input attachment support', () => {
    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
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
            executeSlashCommand: jest.fn()
        }));

        await import('../../../renderer/components/agentinput.js');
    });

    beforeEach(() => {
        showConfirmModal.mockClear();
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
});
