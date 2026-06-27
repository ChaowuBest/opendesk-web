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
                supportedExtensions: ['doc', 'docx', 'xls', 'xlsx', 'pptx', 'odt', 'odp', 'ods', 'pdf'],
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

        await expect(input.attachFilePath('/tmp/legacy.PPT')).resolves.toBe(false);

        expect(input.attachedFilePaths).toEqual([]);
        expect(input.render).not.toHaveBeenCalled();
        expect(showConfirmModal).toHaveBeenCalledTimes(1);
        const [options] = showConfirmModal.mock.calls[0];
        expect(options.title).toBe('无法解析该文件格式');
        expect(options.message).toContain('.ppt');
        expect(options.message).toContain('.docx');
        expect(options.message).toContain('legacy.PPT');
        expect(options.cancelText).toBeNull();
    });
});
