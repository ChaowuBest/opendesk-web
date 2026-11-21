import { beforeAll, describe, expect, jest, test } from '@jest/globals';

/**
 * 变更面板的 diff 展示需要与对话里的 editFile 工具卡片保持一致：
 * 双列行号（旧 / 新）+ marker 列 + 代码列，而不是单列行号 + "@@ -a,b +c,d @@" 头。
 */
describe('task artifacts changes panel diff display', () => {
    beforeAll(async () => {
        const { parseHTML } = await import('linkedom');
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Element: window.Element,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            ResizeObserver: class {
                observe() {}
                disconnect() {}
            },
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });

        await jest.unstable_mockModule('../../../renderer/components/fileExplorer.ts', () => ({
            FileExplorer: class {
                stopWatchingFile() {}
            },
            getFileExplorerCSS: () => '',
            isHtmlFile: () => false
        }));
        await jest.unstable_mockModule('../../../renderer/browser.ts', () => ({
            EmbeddedBrowser: class {}
        }));
        await jest.unstable_mockModule('../../../renderer/theme/theme-iframe-bridge.ts', () => ({
            OPENDESK_THEME_CHANGED: 'opendesk-theme-changed'
        }));
        await jest.unstable_mockModule('../../../renderer/theme/theme-shadow-overrides.ts', () => ({
            syncShadowHostTheme: jest.fn()
        }));

        await import('../../../renderer/components/taskartifacts.ts');
    });

    function renderChanges(changesData: unknown): HTMLElement {
        const artifacts = document.createElement('task-artifacts') as HTMLElement & {
            _changesData: unknown;
            _renderChangesPanel: () => void;
        };
        artifacts.shadowRoot!.innerHTML = '<div class="tab-content" data-tab="changes"></div>';
        artifacts._changesData = changesData;
        artifacts._renderChangesPanel();
        return artifacts.shadowRoot!.querySelector('.tab-content[data-tab="changes"]') as HTMLElement;
    }

    function changeData(hunks: unknown[]): unknown {
        return {
            files: [
                {
                    filePath: 'src/main/utils/shellExec.ts',
                    totalAdded: 2,
                    totalRemoved: 1,
                    changes: [{ toolName: 'cumulative', addedLines: 2, removedLines: 1, hunks }]
                }
            ],
            totalFiles: 1,
            totalAdded: 2,
            totalRemoved: 1
        };
    }

    test('renders old/new line numbers in two columns like the editFile card', () => {
        const panel = renderChanges(
            changeData([
                {
                    oldStart: 563,
                    oldLines: 3,
                    newStart: 563,
                    newLines: 4,
                    lines: [
                        { type: 'context', oldNum: 563, newNum: 563, content: 'const npmPrefix = 1;' },
                        { type: 'removed', oldNum: 564, content: 'const hdcthisHome = old;' },
                        { type: 'added', newNum: 564, content: 'const hdcthisHome = next;' },
                        { type: 'added', newNum: 565, content: 'fs.mkdirSync(hdcthisHome);' },
                        { type: 'context', oldNum: 565, newNum: 566, content: 'const env = {};' }
                    ]
                }
            ])
        );

        expect(panel.querySelector('table.diff-table')).not.toBeNull();
        expect(panel.textContent).not.toContain('@@');

        const ctxRow = panel.querySelector('tr.diff-row-ctx')!;
        const ctxCells = Array.from(ctxRow.querySelectorAll('td')).map((cell) => cell.textContent);
        expect(ctxCells).toEqual(['563', '563', '\u00a0', 'const npmPrefix = 1;']);

        const removedCells = Array.from(panel.querySelector('tr.diff-row-del')!.querySelectorAll('td')).map(
            (cell) => cell.textContent
        );
        expect(removedCells).toEqual(['564', '', '-', 'const hdcthisHome = old;']);

        const addedRows = panel.querySelectorAll('tr.diff-row-add');
        expect(addedRows).toHaveLength(2);
        const firstAddedCells = Array.from(addedRows[0].querySelectorAll('td')).map((cell) => cell.textContent);
        expect(firstAddedCells).toEqual(['', '564', '+', 'const hdcthisHome = next;']);
    });

    test('separates non-adjacent hunks with a gap row instead of a hunk header', () => {
        const panel = renderChanges(
            changeData([
                {
                    oldStart: 10,
                    oldLines: 1,
                    newStart: 10,
                    newLines: 1,
                    lines: [{ type: 'context', oldNum: 10, newNum: 10, content: 'a' }]
                },
                {
                    oldStart: 40,
                    oldLines: 1,
                    newStart: 40,
                    newLines: 1,
                    lines: [{ type: 'context', oldNum: 40, newNum: 40, content: 'b' }]
                }
            ])
        );

        const gapRows = panel.querySelectorAll('tr.diff-row-gap');
        expect(gapRows).toHaveLength(1);
        expect(panel.querySelector('table.diff-table')!.querySelectorAll('tr.diff-row-ctx')).toHaveLength(2);
        expect(panel.textContent).not.toContain('@@');
    });

    test('escapes diff content', () => {
        const panel = renderChanges(
            changeData([
                {
                    oldStart: 1,
                    oldLines: 0,
                    newStart: 1,
                    newLines: 1,
                    lines: [{ type: 'added', newNum: 1, content: '<img src=x onerror=alert(1)>' }]
                }
            ])
        );

        expect(panel.querySelector('tr.diff-row-add img')).toBeNull();
        expect(panel.querySelector('tr.diff-row-add .diff-code')!.textContent).toBe('<img src=x onerror=alert(1)>');
    });
});
