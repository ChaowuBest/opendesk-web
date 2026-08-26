import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

const getEffectiveWorkspace = jest.fn<() => Promise<string>>();
const searchFilesByKeywordInPath =
    jest.fn<
        (
            keyword: string,
            basePath: string
        ) => Promise<Array<{ path: string; filename: string; modified: number; size: number }>>
    >();

describe('agent-input @ file completion follows workspace switch', () => {
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
            showConfirmModal: jest.fn(async () => true)
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
            executeSlashCommand: jest.fn(),
            refreshPluginSlashCommands: jest.fn(async () => {})
        }));

        await import('../../../renderer/components/agentinput.js');
    });

    beforeEach(() => {
        getEffectiveWorkspace.mockReset();
        searchFilesByKeywordInPath.mockReset();
        document.body.innerHTML = '';
        (window as any).workspaceAPI = {
            getEffectiveWorkspace
        };
        (window as any).fsAPI = {
            searchFilesByKeywordInPath
        };
    });

    test('uses the newly selected workspace for @ file completion after switching workspace', async () => {
        const input = document.createElement('agent-input') as HTMLElement & {
            loadFileCompletions: (query: string, textarea: HTMLTextAreaElement) => Promise<void>;
            _workspacePath: string;
        };
        input.innerHTML = '<textarea id="agent-input-textarea"></textarea>';
        const textarea = input.querySelector('#agent-input-textarea') as HTMLTextAreaElement;

        // 首次补全：工作空间 A
        getEffectiveWorkspace.mockResolvedValue('/workspace/A');
        searchFilesByKeywordInPath.mockResolvedValue([
            { path: '/workspace/A/readme.md', filename: 'readme.md', modified: 0, size: 0 }
        ]);
        await input.loadFileCompletions('readme', textarea);
        expect(searchFilesByKeywordInPath).toHaveBeenLastCalledWith('readme', '/workspace/A');

        // 切换到工作空间 B 后再补全：应当使用 B
        getEffectiveWorkspace.mockResolvedValue('/workspace/B');
        searchFilesByKeywordInPath.mockResolvedValue([
            { path: '/workspace/B/readme.md', filename: 'readme.md', modified: 0, size: 0 }
        ]);
        await input.loadFileCompletions('readme', textarea);
        expect(searchFilesByKeywordInPath).toHaveBeenLastCalledWith('readme', '/workspace/B');
    });
});
