import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

const taskViewStyles = readFileSync(new URL('../../../renderer/styles/custom.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, '');

describe('task-view GUI output modes', () => {
    let onSettingChanged: ((setting: Record<string, any>) => void) | undefined;
    let TaskViewClass: any;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            MouseEvent: window.MouseEvent,
            customElements: window.customElements,
            MutationObserver: window.MutationObserver,
            Node: window.Node,
            sessionStorage: { getItem: () => null, removeItem: () => undefined },
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN', platform: 'MacIntel' },
            configurable: true
        });

        await jest.unstable_mockModule('../../../renderer/components/toolbar.ts', () => ({
            ElasticToolbarWidget: class extends HTMLElement {
                setToolbarTitle() {}
                setToolbarSubtitle() {}
            }
        }));
        await jest.unstable_mockModule('../../../renderer/components/taskartifacts.ts', () => ({}));
        await jest.unstable_mockModule('../../../renderer/components/browserPip.ts', () => ({
            BrowserPip: class {
                destroy() {}
                hide() {}
                isClosed() {
                    return false;
                }
                isVisible() {
                    return false;
                }
                resetClosed() {}
                show() {}
                triggerCapture() {}
            }
        }));
        await jest.unstable_mockModule('../../../renderer/components/imageLightbox.js', () => ({
            showImageLightbox: jest.fn()
        }));
        await jest.unstable_mockModule('../../../renderer/components/previewer.ts', () => ({
            enhanceCodeBlocks: jest.fn(),
            enhanceToolPreviewCards: jest.fn()
        }));

        window.settingAPI = {
            loadSettingObject: async () => ({ locale: 'zh-CN', gui_config: { output_mode: 'minimal' } }),
            onSettingChanged: (callback: (setting: Record<string, any>) => void) => {
                onSettingChanged = callback;
            }
        };

        customElements.define('agent-input', class extends HTMLElement {});
        customElements.define('message-queue-panel', class extends HTMLElement {});
        await import('../../../renderer/components/taskview.js');
        TaskViewClass = customElements.get('task-view');
        await Promise.resolve();
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        onSettingChanged?.({ locale: 'zh-CN', gui_config: { output_mode: 'minimal' } });
        window.taskManagerAPI = {
            getToolCallDetail: jest.fn(),
            getFullTask: jest.fn()
        } as any;
    });

    function toolPart(start: number, count: number) {
        return {
            type: 'tool_call',
            rendered: '',
            toolcalls: Array.from({ length: count }, (_, offset) => ({
                id: `call-${start + offset}`,
                tool_name: `Tool${start + offset}`,
                status: 'success',
                args_string: `{"command":"echo ${start + offset}"}`,
                result: `output ${start + offset}`,
                elapsedSeconds: 0.4,
                rendered: `<div>rendered ${start + offset}</div>`
            }))
        };
    }

    function transcript() {
        return [
            { type: 'reasoning', rendered: '分析现有结构', elapsedSeconds: 8 },
            toolPart(1, 10),
            { type: 'text', text: '第一段正文', rendered: '<p>第一段正文</p>' },
            { type: 'reasoning', rendered: '实现展示方案', elapsedSeconds: 7 },
            toolPart(11, 10),
            { type: 'text', text: '第二段正文', rendered: '<p>第二段正文</p>' },
            { type: 'reasoning', rendered: '验证最终结果', elapsedSeconds: 6 },
            toolPart(21, 10),
            { type: 'text', text: '最终正文', rendered: '<p>最终正文</p>' }
        ];
    }

    function createView() {
        return new TaskViewClass() as any;
    }

    test('minimal completed output collapses the full process behind one elapsed-time row', () => {
        const view = createView();
        view.innerHTML = view.renderAssistantMessage({
            message_id: 'message-1',
            content: transcript(),
            elapsedSeconds: 460,
            timestamp: Date.now()
        });

        const completedToggle = view.querySelector('[data-completed-process-toggle]') as HTMLElement;
        expect(view.querySelectorAll('.od-completed-process')).toHaveLength(1);
        expect(completedToggle.textContent).toContain('耗时 7 分钟 40 秒');
        expect(completedToggle.getAttribute('aria-expanded')).toBe('false');
        expect(view.querySelector('.od-completed-process-detail')?.classList.contains('is-open')).toBe(false);

        const processSegments = view.querySelectorAll('.od-process-segment');
        expect(processSegments).toHaveLength(3);
        processSegments.forEach((segment: Element) => {
            expect(segment.querySelector('[data-process-toggle]')?.getAttribute('aria-expanded')).toBe('false');
        });
        expect(view.querySelectorAll('.od-stage-body')).toHaveLength(2);
        expect(view.querySelector('.od-final-result')?.textContent).toContain('最终正文');
        expect(
            Array.from(view.querySelectorAll('.od-process-summary-text')).map((element) => element.textContent)
        ).toEqual([
            '深度思考 · 使用了 Tool1、Tool2 等工具',
            '深度思考 · 使用了 Tool11、Tool12 等工具',
            '深度思考 · 使用了 Tool21、Tool22 等工具'
        ]);
        expect(view.textContent).not.toContain('工具调用 · 10 个工具');
        expect(view.textContent).not.toMatch(/工具调用 \d+[–-]\d+/);

        view._handleProcessToggleClick({ target: completedToggle, preventDefault() {}, stopPropagation() {} });
        expect(completedToggle.getAttribute('aria-expanded')).toBe('true');
        expect(view.querySelector('.od-completed-process-detail')?.classList.contains('is-open')).toBe(true);
    });

    test('detailed output reuses process markup and defaults every process segment open', () => {
        onSettingChanged?.({ locale: 'zh-CN', gui_config: { output_mode: 'detailed' } });
        const view = createView();
        view.innerHTML = view.renderAssistantMessage({
            message_id: 'message-2',
            content: transcript(),
            timestamp: Date.now()
        });

        const processSegments = view.querySelectorAll('.od-process-segment');
        expect(processSegments).toHaveLength(3);
        processSegments.forEach((segment: Element) => {
            expect(segment.querySelector('[data-process-toggle]')?.getAttribute('aria-expanded')).toBe('true');
            expect(segment.querySelector('.od-process-detail')?.classList.contains('is-open')).toBe(true);
        });
    });

    test('output mode changes rerender mounted assistant output without full reload', () => {
        const view = createView();
        view.setAttribute('task_id', 'task-mode-switch');
        view.task_id = 'task-mode-switch';
        view.connectedCallback = () => {};
        view.disconnectedCallback = () => {};
        document.body.appendChild(view);
        view.innerHTML = view.renderAssistantMessage({
            message_id: 'message-mode-switch',
            content: transcript(),
            elapsedSeconds: 12,
            timestamp: Date.now()
        });

        const messageContent = view.querySelector('#message-content-message-mode-switch');
        const completedToggle = view.querySelector('[data-completed-process-toggle]') as HTMLElement;
        view._handleProcessToggleClick({ target: completedToggle, preventDefault() {}, stopPropagation() {} });

        onSettingChanged?.({ locale: 'zh-CN', gui_config: { output_mode: 'detailed' } });

        expect(window.taskManagerAPI.getFullTask as jest.Mock).not.toHaveBeenCalled();
        expect(view.querySelector('#message-content-message-mode-switch')).toBe(messageContent);
        expect(view.querySelector('.od-assistant-output-flow')?.getAttribute('data-output-mode')).toBe('detailed');
        expect(view.querySelector('.od-process-summary[data-process-toggle]')?.getAttribute('aria-expanded')).toBe(
            'false'
        );

        onSettingChanged?.({ locale: 'zh-CN', gui_config: { output_mode: 'minimal' } });

        expect(view.querySelector('[data-completed-process-toggle]')?.getAttribute('aria-expanded')).toBe('true');
        view.remove();
    });

    test('minimal running output shows one clickable current-operation row', () => {
        const view = createView();
        const html = view._renderAssistantOutputHtml(transcript().slice(0, 2), {
            isRunning: true,
            messageId: 'message-running'
        });
        view._assistantPartsByMessage.set('message-running', transcript().slice(0, 2));
        view.innerHTML = `<div id="message-content-message-running">${html}</div>`;

        expect(view.querySelectorAll('.od-running-status')).toHaveLength(1);
        expect(view.querySelectorAll('.od-process-segment')).toHaveLength(0);
        expect(view.querySelectorAll('.od-stage-body')).toHaveLength(0);
        expect(view.querySelector('.od-final-result')).toBeNull();
        expect(view.querySelector('.od-running-status')?.textContent).not.toContain('总耗时');
        expect(view.querySelector('.od-running-status-time')).toBeNull();
        expect(view.querySelector('.od-running-status')?.textContent).toContain('正在调用 Tool10…');
        expect(view.querySelector('.od-running-status')?.textContent).not.toContain('echo 10');

        const runningStatus = view.querySelector('.od-running-status') as HTMLElement;
        expect(runningStatus.querySelector('.od-running-status-icon')).not.toBeNull();
        expect(runningStatus.querySelector('.od-running-status-viewport .od-running-status-line')).not.toBeNull();
        expect(runningStatus.getAttribute('aria-expanded')).toBe('false');

        view._handleProcessToggleClick({ target: runningStatus, preventDefault() {}, stopPropagation() {} });
        expect(view.querySelector('[data-running-output-toggle]')?.getAttribute('aria-expanded')).toBe('true');
        expect(view.querySelectorAll('.od-process-segment')).toHaveLength(0);
        expect(view.querySelectorAll('.od-running-process-detail')).toHaveLength(1);
        expect(view.querySelectorAll('.od-stage-body')).toHaveLength(0);
        expect(view.querySelector('[data-running-output-toggle]')?.nextElementSibling?.classList).toContain(
            'od-running-process-detail'
        );
        expect(view.querySelector('[data-running-output-toggle]')?.getAttribute('aria-controls')).toBe(
            view.querySelector('.od-running-process-detail')?.id
        );
        expect(view.querySelector('.od-process-summary-text')).toBeNull();

        const expandedStatus = view.querySelector('[data-running-output-toggle]') as HTMLElement;
        view._handleProcessToggleClick({ target: expandedStatus, preventDefault() {}, stopPropagation() {} });
        expect(view.querySelector('[data-running-output-toggle]')?.getAttribute('aria-expanded')).toBe('false');
        expect(view.querySelectorAll('.od-process-segment')).toHaveLength(0);
        expect(view.querySelectorAll('.od-running-process-detail')).toHaveLength(0);
        expect(view.querySelectorAll('.od-stage-body')).toHaveLength(0);
    });

    test('minimal running output shows completed stages before the current-operation row without expansion', () => {
        const view = createView();
        view.innerHTML = view._renderAssistantOutputHtml(transcript().slice(0, 5), {
            isRunning: true,
            messageId: 'message-staged-running'
        });

        expect(view.querySelectorAll('.od-process-segment')).toHaveLength(1);
        expect(view.querySelectorAll('.od-stage-body')).toHaveLength(1);
        expect(view.querySelector('.od-stage-body')?.textContent).toContain('第一段正文');
        expect(view.querySelector('.od-process-summary-text')?.textContent).toBe(
            '深度思考 · 使用了 Tool1、Tool2 等工具'
        );
        expect(view.querySelector('[data-running-output-toggle]')?.getAttribute('aria-expanded')).toBe('false');
        const flow = view.querySelector('.od-assistant-output-flow') as HTMLElement;
        expect(flow.lastElementChild?.classList.contains('od-running-status')).toBe(true);
        expect(flow.lastElementChild?.textContent).toContain('正在调用 Tool20…');
    });

    test('minimal reasoning status hides reasoning content from the current-operation row', () => {
        const view = createView();
        const reasoning = [{ type: 'reasoning', rendered: '这是一段不应出现在状态行中的详细思考内容' }];
        view.innerHTML = view._renderAssistantOutputHtml(reasoning, {
            isRunning: true,
            messageId: 'message-reasoning-status'
        });

        const status = view.querySelector('.od-running-status')?.textContent || '';
        expect(status).toContain('正在思考…');
        expect(status).not.toContain('详细思考内容');
    });

    test('running tool status uses the readable tool name without exposing parameters', () => {
        const view = createView();
        const fileTool = toolPart(1, 1);
        fileTool.toolcalls[0] = {
            ...fileTool.toolcalls[0],
            tool_name: 'filemgr-readFile',
            args_string: JSON.stringify({ file_path: '/workspace/OpenDesk/package.json' }),
            presentation: { displayName: { key: 'filemgr.readFile.name' } }
        };
        view.innerHTML = view._renderAssistantOutputHtml([fileTool], {
            isRunning: true,
            messageId: 'message-readable-running-tool'
        });

        const status = view.querySelector('.od-running-status')?.textContent || '';
        expect(status).toContain('正在调用 读取文件…');
        expect(status).not.toContain('filemgr-readFile');
        expect(status).not.toContain('package.json');
    });

    test('tool rows consume structured presentation metadata without knowing the tool name', () => {
        const view = createView();
        const tools = toolPart(1, 1);
        tools.toolcalls[0] = {
            ...tools.toolcalls[0],
            tool_name: 'plugin-opaqueOperation',
            presentation: {
                displayName: '制品检查',
                summary: '检查 report.txt',
                resource: { type: 'preview', value: '/workspace/report.txt' }
            }
        };
        view.innerHTML = view._renderAssistantOutputHtml([tools], {
            isRunning: false,
            messageId: 'message-tool-presentation'
        });

        const tool = view.querySelector('.od-process-tool') as HTMLElement;
        expect(tool.querySelector('.od-process-entry-label')?.textContent).toBe('制品检查');
        expect(tool.querySelector('.od-process-tool-args')?.textContent).toBe('检查 report.txt');
        expect((tool.querySelector('[data-open-preview]') as HTMLElement).dataset.openPreview).toBe(
            '/workspace/report.txt'
        );
        expect(view.textContent).not.toContain('plugin-opaqueOperation');
    });

    test('expanded process entries use the same reasoning and tool rows as the design mockup', () => {
        const view = createView();
        view.innerHTML = view._renderAssistantOutputHtml(transcript().slice(0, 2), {
            isRunning: true,
            messageId: 'message-process-detail',
            showRunningDetails: true
        });

        const reason = view.querySelector('.od-process-reason') as HTMLElement;
        expect(reason.querySelector('.od-process-entry-kind')?.textContent?.trim()).toBe('思考');
        expect(reason.querySelector('.od-process-entry-text')?.textContent).toBe('分析现有结构');
        expect(reason.classList.contains('is-expanded')).toBe(false);

        const tool = view.querySelector('.od-process-tool') as HTMLElement;
        expect(tool.querySelector('.od-process-entry-kind')?.textContent?.trim()).toBe('工具');
        expect(tool.querySelector('.od-process-entry-label')?.textContent).toBe('Tool1');
        expect(tool.querySelector('.od-process-entry-text')?.textContent).toBe('echo 1');
        expect(tool.querySelector('.od-process-tool-status')).toBeNull();
        expect(tool.querySelector('.od-process-chevron')?.textContent).toBe('>');

        expect(view.querySelector('.od-running-process-detail')).not.toBeNull();
        expect(view.querySelector('.od-process-summary')).toBeNull();
        expect(view.querySelector('[data-running-output-toggle]')?.nextElementSibling?.classList).toContain(
            'od-running-process-detail'
        );
    });

    test('process labels show reasoning and unique tool types without reasoning content', () => {
        const view = createView();
        const fileTools = toolPart(1, 3);
        fileTools.toolcalls = [
            {
                ...fileTools.toolcalls[0],
                tool_name: 'filemgr-readFile',
                args_string: JSON.stringify({ file_path: '/workspace/OpenDesk/README.md' }),
                presentation: { displayName: '读取文件' }
            },
            {
                ...fileTools.toolcalls[1],
                tool_name: 'filemgr-readFile',
                args_string: JSON.stringify({ file_path: '/workspace/OpenDesk/package.json' }),
                presentation: { displayName: '读取文件' }
            },
            {
                ...fileTools.toolcalls[2],
                tool_name: 'filemgr-grepFiles',
                args_string: JSON.stringify({ pattern: 'outputMode' }),
                presentation: { displayName: '搜索文件内容' }
            }
        ];
        view.innerHTML = view._renderAssistantOutputHtml(
            [
                {
                    type: 'reasoning',
                    rendered: '分析项目结构和当前输出方式，这部分后续解释不应进入摘要。'
                },
                fileTools,
                { type: 'reasoning', rendered: '确认关键路径和配置入口。' }
            ],
            {
                isRunning: false,
                messageId: 'message-tool-only-summary'
            }
        );

        const summary = view.querySelector('.od-process-summary-text')?.textContent || '';
        expect(summary).toBe('深度思考 · 使用了 读取文件、搜索文件内容 等工具');
        expect(summary).not.toContain('分析项目结构');
    });

    test('a failed child tool does not replace the process summary icon', () => {
        const view = createView();
        const failedTool = toolPart(1, 1);
        failedTool.toolcalls[0].status = 'error';
        view.innerHTML = view._renderAssistantOutputHtml([failedTool], {
            isRunning: false,
            messageId: 'message-failed-child-tool'
        });

        expect(view.querySelector('.od-process-summary .lucide-lightbulb')).not.toBeNull();
        expect(view.querySelector('.od-process-summary .fa-circle-exclamation')).toBeNull();
        expect(view.querySelector('.od-process-tool-status.is-error')?.textContent).toBe('失败');
    });

    test('process labels use the readable tool type instead of reasoning or tool parameters', () => {
        const view = createView();
        const browserTool = toolPart(1, 1);
        browserTool.toolcalls[0] = {
            ...browserTool.toolcalls[0],
            tool_name: 'webFetch',
            args_string: JSON.stringify({ url: 'https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/' }),
            presentation: { displayName: '网页获取' }
        };
        view.innerHTML = view._renderAssistantOutputHtml(
            [
                {
                    type: 'reasoning',
                    rendered: '页面 meta 标签提取有限，需要打开浏览器获取完整内容。尝试其它 URL。'
                },
                browserTool,
                {
                    type: 'text',
                    text: 'Meta 提取受限，改用浏览器访问华为 Kit 文档',
                    rendered: '<p>Meta 提取受限，改用浏览器访问华为 Kit 文档</p>'
                },
                { type: 'reasoning', rendered: '继续检查页面内容。' }
            ],
            { isRunning: true, messageId: 'message-stage-summary' }
        );

        const summary = view.querySelector('.od-process-summary-text')?.textContent || '';
        expect(summary).toBe('深度思考 · 使用了 网页获取 等工具');
        expect(summary).not.toContain('meta');
        expect(summary).not.toContain('developer.huawei.com');
    });

    test('aggregated process summaries stay compact when tool names are long', () => {
        const view = createView();
        const tools = toolPart(1, 4);
        tools.toolcalls = tools.toolcalls.map((tool: any, index: number) => ({
            ...tool,
            tool_name: `very-long-specialized-operation-name-${index}`
        }));
        view.innerHTML = view._renderAssistantOutputHtml(
            [
                {
                    type: 'reasoning',
                    rendered: '这是一个非常长的思考主题，需要压缩成简单清晰的阶段说明。'
                },
                tools
            ],
            { isRunning: false, messageId: 'message-long-summary' }
        );

        const summary = view.querySelector('.od-process-summary-text')?.textContent || '';
        expect(Array.from(summary).length).toBeLessThanOrEqual(40);
        expect(summary).toBe('深度思考 · 使用了 very-long-s… 等工具');
    });

    test('reasoning and tool rows share the same left edge and kind column width', () => {
        expect(taskViewStyles).toContain('.od-process-reason,.od-process-tool{margin-left:0;margin-right:0;}');
        expect(taskViewStyles).toContain(
            '.od-process-reason.od-process-entry-summary,.od-process-tool.od-process-entry-summary{padding-left:2px;padding-right:2px;}'
        );
        expect(taskViewStyles).toMatch(
            /\.od-process-reason\.od-process-entry-summary\{[^}]*grid-template-columns:58pxminmax\(0,1fr\)auto12px;/
        );
        expect(taskViewStyles).toMatch(
            /\.od-process-tool\.od-process-entry-summary\{[^}]*grid-template-columns:58pxautominmax\(0,1fr\)auto12px;/
        );
        expect(taskViewStyles).toContain('.od-process-tool.od-process-entry-label{max-width:240px;}');
        expect(taskViewStyles).toContain('.od-process-tool.od-process-entry-time{grid-column:4;}');
        expect(taskViewStyles).toContain('.od-process-tool.od-process-chevron{grid-column:5;}');
    });

    test('process typography and row spacing stay compact', () => {
        expect(taskViewStyles).toMatch(/\.od-process-main-icon\{[^}]*width:14px;[^}]*height:14px;/);
        expect(taskViewStyles).toMatch(/\.od-process-chevron\{[^}]*font-size:var\(--fs-sm\);/);
        expect(taskViewStyles).toMatch(/\.od-completed-process-chevron\{[^}]*font-size:var\(--fs-sm\);/);
        expect(taskViewStyles).toMatch(/\.od-process-reason\.od-process-entry-summary\{[^}]*font-size:var\(--fs-md\);/);
        expect(taskViewStyles).toMatch(/\.od-process-tool\.od-process-entry-summary\{[^}]*font-size:var\(--fs-md\);/);
        expect(taskViewStyles).toMatch(
            /\.od-process-tool-args,.od-process-tool-status\{[^}]*font-size:var\(--fs-md\);/
        );
        expect(taskViewStyles).toMatch(/\.od-process-entry-detail\{[^}]*font-size:var\(--fs-sm\);/);
        expect(taskViewStyles).toMatch(/\.od-process-detail-label\{[^}]*font-size:var\(--fs-sm\);/);
        expect(taskViewStyles).toMatch(/\.od-process-entry-label\{[^}]*font-weight:400;/);
        expect(taskViewStyles).toMatch(
            /\.od-process-reason\.od-process-entry-summary\{[^}]*min-height:26px;[^}]*padding-top:2px;[^}]*padding-bottom:2px;/
        );
        expect(taskViewStyles).toMatch(
            /\.od-process-tool\.od-process-entry-summary\{[^}]*min-height:26px;[^}]*padding-top:2px;[^}]*padding-bottom:2px;/
        );
        expect(taskViewStyles).toContain('.od-process-reason{margin-top:0;margin-bottom:0;');
        expect(taskViewStyles).toContain('.od-process-tool{margin-top:0;margin-bottom:0;');
    });

    test('process summaries use an unframed Codex-style row while details keep their height limit', () => {
        expect(taskViewStyles).toMatch(
            /\.od-process-segment\{[^}]*overflow:visible;[^}]*background:transparent;[^}]*border:0;[^}]*border-radius:0;/
        );
        expect(taskViewStyles).toMatch(
            /\.od-process-summary\{[^}]*min-height:28px;[^}]*padding:3px0;[^}]*border-bottom:0;[^}]*border-radius:0;/
        );
        expect(taskViewStyles).not.toContain(".od-process-summary[aria-expanded='true']{border-bottom-color:");
        expect(taskViewStyles).toMatch(
            /\.od-process-detail\{[^}]*max-height:280px;[^}]*overflow-y:auto;[^}]*margin:0;/
        );
    });

    test('GUI output does not maintain a message-level timer', () => {
        const view = createView();
        expect(view._assistantRunStartedAt).toBeUndefined();
    });

    test('nested process scrollers hand off wheel scrolling at their boundaries', () => {
        expect(taskViewStyles).toMatch(/\.od-process-detail\{[^}]*overscroll-behavior:auto;/);
        expect(taskViewStyles).toMatch(/\.od-process-entry-detail\{[^}]*overscroll-behavior:auto;/);
        expect(taskViewStyles).not.toMatch(/\.od-process-(?:detail|entry-detail)\{[^}]*overscroll-behavior:contain;/);
    });

    test('loads lightweight tool details only after the first expansion and then reuses the cache', async () => {
        const getToolCallDetail = jest.fn(async () => ({
            args_string: '{"command":"npm test"}',
            result: '6 passed',
            status: 'success',
            elapsedSeconds: 1.4
        }));
        window.taskManagerAPI.getToolCallDetail = getToolCallDetail;
        const view = createView();
        view.task_id = 'task-1';
        const part = {
            type: 'tool_call',
            rendered: '',
            toolcalls: [
                {
                    id: 'call-lazy',
                    index: 0,
                    tool_name: 'terminal-executeZsh',
                    status: 'success',
                    args_preview: '{"command":"npm test"}',
                    args_truncated: false,
                    detail_available: true,
                    elapsedSeconds: 1.4
                }
            ]
        };
        view._assistantPartsByMessage.set('message-lazy', [part]);
        view.innerHTML = view._renderAssistantOutputHtml([part], {
            isRunning: false,
            messageId: 'message-lazy'
        });

        const tool = view.querySelector('.od-process-tool') as HTMLElement;
        const toggle = tool.querySelector('[data-process-entry-toggle="tool"]') as HTMLElement;
        const detail = tool.querySelector('.od-process-entry-detail') as HTMLElement;
        expect(detail.innerHTML.trim()).toBe('');
        expect(getToolCallDetail).not.toHaveBeenCalled();

        view._handleProcessToggleClick({ target: toggle, preventDefault() {}, stopPropagation() {} });
        await Promise.resolve();
        await Promise.resolve();

        expect(getToolCallDetail).toHaveBeenCalledWith('task-1', 'message-lazy', 0, 0, 'call-lazy');
        expect(detail.textContent).toContain('npm test');
        expect(detail.textContent).toContain('6 passed');

        view._handleProcessToggleClick({ target: toggle, preventDefault() {}, stopPropagation() {} });
        view._handleProcessToggleClick({ target: toggle, preventDefault() {}, stopPropagation() {} });
        await Promise.resolve();
        expect(getToolCallDetail).toHaveBeenCalledTimes(1);
    });

    test('expanded tool details reuse a human-readable tool renderer when available', () => {
        const view = createView();
        const terminalTool = toolPart(1, 1);
        terminalTool.toolcalls[0].rendered = `
            <details class="terminal-tool" open>
                <summary>Bash（运行测试）</summary>
                <pre>$ npm test\n6 passed</pre>
            </details>`;
        view.innerHTML = view._renderAssistantOutputHtml([terminalTool], {
            isRunning: false,
            messageId: 'message-readable-tool'
        });

        const toolToggle = view.querySelector('[data-process-entry-toggle="tool"]') as HTMLElement;
        view._handleProcessToggleClick({ target: toolToggle, preventDefault() {}, stopPropagation() {} });

        const detail = view.querySelector('.od-process-tool .od-process-entry-detail') as HTMLElement;
        expect(detail.querySelector('.od-process-tool-rendered .terminal-tool')).not.toBeNull();
        expect(detail.textContent).toContain('Bash（运行测试）');
        expect(detail.textContent).toContain('6 passed');
        expect(detail.textContent).toContain('已完成');
        expect(detail.textContent).not.toContain('{"command"');
    });

    test('expanded tool details format JSON arguments into readable fields as a fallback', () => {
        const view = createView();
        const terminalTool = toolPart(1, 1);
        terminalTool.toolcalls[0].args_string = JSON.stringify({
            command: 'npm test',
            workingDirectory: '/workspace/OpenDesk',
            timeout: 30000
        });
        terminalTool.toolcalls[0].result = JSON.stringify({ passed: 6 }, null, 2);
        terminalTool.toolcalls[0].rendered = '';
        view.innerHTML = view._renderAssistantOutputHtml([terminalTool], {
            isRunning: false,
            messageId: 'message-readable-tool-fallback'
        });

        const toolToggle = view.querySelector('[data-process-entry-toggle="tool"]') as HTMLElement;
        view._handleProcessToggleClick({ target: toolToggle, preventDefault() {}, stopPropagation() {} });

        const detail = view.querySelector('.od-process-tool .od-process-entry-detail') as HTMLElement;
        expect(detail.querySelectorAll('.od-process-tool-field')).toHaveLength(3);
        expect(detail.textContent).toContain('命令');
        expect(detail.textContent).toContain('工作目录');
        expect(detail.textContent).toContain('npm test');
        expect(detail.textContent).toContain('/workspace/OpenDesk');
        expect(detail.textContent).toContain('"passed": 6');
        expect(detail.textContent).not.toContain('{"command":"npm test"');
    });

    test('file tool summaries describe the action and unwrap protocol JSON into readable output', () => {
        const view = createView();
        const fileTool = toolPart(1, 1);
        fileTool.toolcalls[0] = {
            ...fileTool.toolcalls[0],
            tool_name: 'filemgr-readFile',
            args_string: JSON.stringify({ file_path: '/workspace/OpenDesk/package.json' }),
            presentation: {
                displayName: { key: 'filemgr.readFile.name' },
                summary: {
                    key: 'renderer.taskview.output.purpose.readFile',
                    params: { name: 'package.json' }
                },
                resource: { type: 'preview', value: '/workspace/OpenDesk/package.json' }
            },
            result: JSON.stringify({
                type: 'text',
                file: {
                    filePath: '/workspace/OpenDesk/package.json',
                    content: '     1\t{\n     2\t  "name": "opendesk"\n     3\t}',
                    startLine: 1,
                    numLines: 3,
                    totalLines: 3
                }
            }),
            rendered: `
                <div class="od-inline-toolcall-container">
                    <span class="tool-title">读取文件</span>
                    <span>/workspace/OpenDesk/package.json · 3 行</span>
                </div>`
        };
        view.innerHTML = view._renderAssistantOutputHtml([fileTool], {
            isRunning: false,
            messageId: 'message-readable-file-tool'
        });

        const tool = view.querySelector('.od-process-tool') as HTMLElement;
        expect(tool.querySelector('.od-process-entry-label')?.textContent).toBe('读取文件');
        expect(tool.querySelector('.od-process-tool-args')?.textContent).toBe('读取 package.json');

        const toolToggle = tool.querySelector('[data-process-entry-toggle="tool"]') as HTMLElement;
        view._handleProcessToggleClick({ target: toolToggle, preventDefault() {}, stopPropagation() {} });

        const detail = tool.querySelector('.od-process-entry-detail') as HTMLElement;
        expect(detail.textContent).toContain('/workspace/OpenDesk/package.json');
        expect(detail.textContent).toContain('1\t{');
        expect(detail.textContent).toContain('"name": "opendesk"');
        expect(detail.textContent).not.toContain('"type": "text"');
        expect(detail.textContent).not.toContain('"file":');
    });

    test('file tool summaries link reads to previews and writes to task changes', () => {
        const view = createView();
        const fileTools = toolPart(1, 2);
        fileTools.toolcalls[0] = {
            ...fileTools.toolcalls[0],
            tool_name: 'filemgr-readFile',
            args_string: JSON.stringify({ file_path: '/workspace/OpenDesk/appguide.md' }),
            presentation: {
                displayName: '读取文件',
                summary: '读取 appguide.md',
                resource: { type: 'preview', value: '/workspace/OpenDesk/appguide.md' }
            }
        };
        fileTools.toolcalls[1] = {
            ...fileTools.toolcalls[1],
            tool_name: 'filemgr-writeFile',
            args_string: JSON.stringify({ path: '/workspace/OpenDesk/setting.md', content: '# Settings' }),
            presentation: {
                displayName: '写入文件',
                summary: '写入 setting.md',
                resource: { type: 'changes', value: '/workspace/OpenDesk/setting.md' }
            }
        };
        view.innerHTML = view._renderAssistantOutputHtml([fileTools], {
            isRunning: false,
            messageId: 'message-file-action-links'
        });

        const tools = view.querySelectorAll('.od-process-tool');
        const readLink = tools[0].querySelector('[data-open-preview]') as HTMLElement;
        const writeLink = tools[1].querySelector('[data-open-changes]') as HTMLElement;
        expect(readLink.textContent).toBe('appguide.md');
        expect(readLink.dataset.openPreview).toBe('/workspace/OpenDesk/appguide.md');
        expect(writeLink.textContent).toBe('setting.md');
        expect(writeLink.dataset.openChanges).toBe('/workspace/OpenDesk/setting.md');

        const readToggle = tools[0].querySelector('[data-process-entry-toggle]') as HTMLElement;
        view._handleProcessToggleClick({ target: readLink, preventDefault() {}, stopPropagation() {} });
        expect(readToggle.getAttribute('aria-expanded')).toBe('false');

        view.task_id = 'file-actions';
        view._forceExpandRightSidebar = jest.fn();
        const sidebar = document.createElement('div') as HTMLElement & {
            openFilePreview: jest.Mock;
            openFileChanges: jest.Mock;
        };
        sidebar.id = 'task-file-actions-artifacts';
        sidebar.openFilePreview = jest.fn();
        sidebar.openFileChanges = jest.fn();
        view.appendChild(sidebar);
        view._handlePreviewOpenClick({ target: readLink, preventDefault() {}, stopPropagation() {} });
        view._handleChangesOpenClick({ target: writeLink, preventDefault() {}, stopPropagation() {} });
        expect(sidebar.openFilePreview).toHaveBeenCalledWith('/workspace/OpenDesk/appguide.md', undefined, undefined);
        expect(sidebar.openFileChanges).toHaveBeenCalledWith('/workspace/OpenDesk/setting.md');
    });

    test('browser URLs open in the right sidebar without toggling tool details', () => {
        const view = createView();
        const browserTools = toolPart(1, 2);
        browserTools.toolcalls[0] = {
            ...browserTools.toolcalls[0],
            tool_name: 'browser-navigate',
            args_string: JSON.stringify({ url: 'https://docs.example.com/guide?lang=zh-CN' }),
            presentation: {
                displayName: '打开网页',
                summary: '打开 https://docs.example.com/guide?lang=zh-CN',
                resource: { type: 'url', value: 'https://docs.example.com/guide?lang=zh-CN' }
            }
        };
        browserTools.toolcalls[1] = {
            ...browserTools.toolcalls[1],
            tool_name: 'WebSearch',
            args_string: JSON.stringify({ query: 'OpenDesk' }),
            result: '1. OpenDesk\n   - url: https://opendesk.example.com/docs\n   - summary: 项目文档'
        };
        view.innerHTML = view._renderAssistantOutputHtml([browserTools], {
            isRunning: false,
            messageId: 'message-browser-action-links'
        });

        const tools = view.querySelectorAll('.od-process-tool');
        const summaryLink = tools[0].querySelector('[data-open-browser-url]') as HTMLAnchorElement;
        expect(tools[0].querySelector('.od-process-entry-label')?.textContent).toBe('打开网页');
        expect(summaryLink.textContent).toBe('docs.example.com/guide');
        expect(summaryLink.dataset.openBrowserUrl).toBe('https://docs.example.com/guide?lang=zh-CN');
        expect(tools[0].querySelector('.od-process-tool-args')?.textContent).toBe('打开 docs.example.com/guide');

        const firstToggle = tools[0].querySelector('[data-process-entry-toggle]') as HTMLElement;
        view._handleProcessToggleClick({ target: summaryLink, preventDefault() {}, stopPropagation() {} });
        expect(firstToggle.getAttribute('aria-expanded')).toBe('false');

        const secondToggle = tools[1].querySelector('[data-process-entry-toggle]') as HTMLElement;
        view._handleProcessToggleClick({ target: secondToggle, preventDefault() {}, stopPropagation() {} });
        const resultLink = tools[1].querySelector(
            '.od-process-tool-output [data-open-browser-url]'
        ) as HTMLAnchorElement;
        expect(resultLink.textContent).toBe('https://opendesk.example.com/docs');

        view.task_id = 'browser-actions';
        view._forceExpandRightSidebar = jest.fn();
        const sidebar = document.createElement('div') as HTMLElement & { browserAddTab: jest.Mock };
        sidebar.id = 'task-browser-actions-artifacts';
        sidebar.browserAddTab = jest.fn();
        view.appendChild(sidebar);
        view._handleBrowserUrlOpenClick({ target: resultLink, preventDefault() {}, stopPropagation() {} });
        expect(sidebar.browserAddTab).toHaveBeenCalledWith('https://opendesk.example.com/docs');
    });

    test('terminal tool summaries prefer the human description over raw command parameters', () => {
        const view = createView();
        const terminalTool = toolPart(1, 1);
        terminalTool.toolcalls[0] = {
            ...terminalTool.toolcalls[0],
            tool_name: 'terminal-executeBash',
            args_string: JSON.stringify({
                command: 'rg -n "renderToolCall" src/main',
                description: '定位工具渲染入口'
            }),
            presentation: {
                displayName: { key: 'renderer.taskview.output.toolName.executeCommand' },
                summary: '定位工具渲染入口'
            },
            rendered: '<details class="terminal-tool"><summary>Bash</summary><pre>result</pre></details>'
        };
        view.innerHTML = view._renderAssistantOutputHtml([terminalTool], {
            isRunning: false,
            messageId: 'message-readable-terminal-summary'
        });

        const tool = view.querySelector('.od-process-tool') as HTMLElement;
        expect(tool.querySelector('.od-process-entry-label')?.textContent).toBe('执行命令');
        expect(tool.querySelector('.od-process-tool-args')?.textContent).toBe('定位工具渲染入口');
        expect(tool.querySelector('.od-process-tool-args')?.textContent).not.toContain('rg -n');
    });

    test('task follow-up tools use a readable name and hide raw object arguments from the summary row', () => {
        const view = createView();
        const taskFollowUpTool = toolPart(1, 1);
        taskFollowUpTool.toolcalls[0] = {
            ...taskFollowUpTool.toolcalls[0],
            tool_name: 'task-info-askFromTask',
            args_string: JSON.stringify({
                taskId: 'task_example',
                question: '这个任务最终得出了什么结论？'
            }),
            presentation: { displayName: '任务追问' }
        };
        view.innerHTML = view._renderAssistantOutputHtml([taskFollowUpTool], {
            isRunning: false,
            messageId: 'message-task-follow-up-summary'
        });

        const tool = view.querySelector('.od-process-tool') as HTMLElement;
        expect(tool.querySelector('.od-process-entry-label')?.textContent).toBe('任务追问');
        expect(tool.querySelector('.od-process-tool-args')).toBeNull();
        expect(view.querySelector('.od-process-summary-text')?.textContent).toBe('使用了 任务追问 等工具');
    });

    test('load skill summaries show only the skill name instead of raw arguments', () => {
        const view = createView();
        const loadSkillTool = toolPart(1, 1);
        loadSkillTool.toolcalls[0] = {
            ...loadSkillTool.toolcalls[0],
            tool_name: 'LoadSkill',
            args_string: JSON.stringify({ bundleName: 'browser', skillName: 'use-browser' }),
            presentation: { displayName: '加载技能', summary: 'use-browser' }
        };
        view.innerHTML = view._renderAssistantOutputHtml([loadSkillTool], {
            isRunning: false,
            messageId: 'message-load-skill-summary'
        });

        const tool = view.querySelector('.od-process-tool') as HTMLElement;
        expect(tool.querySelector('.od-process-entry-label')?.textContent).toBe('加载技能');
        expect(tool.querySelector('.od-process-tool-args')?.textContent).toBe('use-browser');
        expect(tool.querySelector('.od-process-tool-args')?.textContent).not.toContain('bundleName');
        expect(view.querySelector('.od-process-summary-text')?.textContent).toBe('使用了 加载技能 等工具');

        const toggle = tool.querySelector('[data-process-entry-toggle]') as HTMLElement;
        view._handleProcessToggleClick({ target: toggle, preventDefault() {}, stopPropagation() {} });
        expect(tool.querySelector('.od-process-entry-detail')?.textContent).toContain('browser');
        expect(tool.querySelector('.od-process-entry-detail')?.textContent).toContain('use-browser');
        expect(tool.querySelector('.od-process-entry-detail')?.textContent).not.toContain('output 1');
        expect(tool.querySelector('.od-process-entry-detail')?.textContent).not.toContain('bundleName');
    });

    test('call skill summaries show the skill name and compact readable execution details', () => {
        const view = createView();
        const callSkillTool = toolPart(1, 1);
        callSkillTool.toolcalls[0] = {
            ...callSkillTool.toolcalls[0],
            tool_name: 'CallSkillTool',
            args_string: JSON.stringify({
                bundleName: 'browser',
                skillName: 'use-browser',
                toolName: 'navigate',
                toolArgs: { url: 'https://developer.huawei.com/docs', waitUntil: 'load' }
            }),
            presentation: { displayName: '调用技能', summary: 'use-browser' },
            result: JSON.stringify({
                content: [{ type: 'text', text: '页面已打开' }],
                internalTrace: 'verbose protocol data'
            })
        };
        view.innerHTML = view._renderAssistantOutputHtml([callSkillTool], {
            isRunning: false,
            messageId: 'message-call-skill-summary'
        });

        const tool = view.querySelector('.od-process-tool') as HTMLElement;
        expect(tool.querySelector('.od-process-entry-label')?.textContent).toBe('调用技能');
        expect(tool.querySelector('.od-process-tool-args')?.textContent).toBe('通过 use-browser 打开网页');
        expect(view.querySelector('.od-process-summary-text')?.textContent).toBe('使用了 调用技能 等工具');

        const toggle = tool.querySelector('[data-process-entry-toggle]') as HTMLElement;
        view._handleProcessToggleClick({ target: toggle, preventDefault() {}, stopPropagation() {} });
        const detail = tool.querySelector('.od-process-entry-detail')?.textContent || '';
        expect(tool.querySelector('.od-process-tool-execution-header')?.textContent).toContain(
            '通过 use-browser 打开网页'
        );
        expect(tool.querySelector('.od-process-tool-execution-header')?.textContent).not.toContain('执行详情');
        expect(detail).toContain('目标网址');
        expect(detail).toContain('https://developer.huawei.com/docs');
        expect(detail).toContain('等待条件');
        expect(detail).toContain('页面加载完成');
        expect(detail).toContain('结果');
        expect(detail).toContain('页面已打开');
        expect(detail).not.toContain('内部工具');
        expect(detail).not.toContain('navigate');
        expect(detail).not.toContain('bundleName');
        expect(detail).not.toContain('toolArgs');
        expect(detail).not.toContain('internalTrace');
        expect(detail).not.toContain('"content"');
    });

    test('call skill entry titles include the skill and unknown inner tool action', () => {
        const view = createView();
        const callSkillTool = toolPart(1, 1);
        callSkillTool.toolcalls[0] = {
            ...callSkillTool.toolcalls[0],
            tool_name: 'CallSkillTool',
            args_string: JSON.stringify({
                bundleName: 'browser',
                skillName: 'use-browser',
                toolName: 'evaluate',
                toolArgs: { expression: '() => document.title' }
            }),
            presentation: { displayName: '调用技能', summary: 'use-browser' }
        };
        view.innerHTML = view._renderAssistantOutputHtml([callSkillTool], {
            isRunning: false,
            messageId: 'message-call-skill-evaluate-title'
        });

        const tool = view.querySelector('.od-process-tool') as HTMLElement;
        expect(tool.querySelector('.od-process-entry-label')?.textContent).toBe('调用技能');
        expect(tool.querySelector('.od-process-tool-args')?.textContent).toBe('通过 use-browser 执行 evaluate');
    });

    test('file search summaries describe grep and glob operations in plain language', () => {
        const view = createView();
        const searchTools = toolPart(1, 2);
        searchTools.toolcalls[0] = {
            ...searchTools.toolcalls[0],
            tool_name: 'filemgr-grepFiles',
            args_string: JSON.stringify({ pattern: 'model' }),
            presentation: { displayName: '搜索文件内容', summary: '查找匹配“model”的内容' }
        };
        searchTools.toolcalls[1] = {
            ...searchTools.toolcalls[1],
            tool_name: 'filemgr-globFiles',
            args_string: JSON.stringify({ pattern: 'src/cli/**/*.ts' }),
            presentation: { displayName: '查找文件', summary: '查找 src/cli 中的 TypeScript 文件' }
        };
        view.innerHTML = view._renderAssistantOutputHtml([searchTools], {
            isRunning: false,
            messageId: 'message-readable-search-tools'
        });

        const tools = view.querySelectorAll('.od-process-tool');
        expect(tools[0].querySelector('.od-process-entry-label')?.textContent).toBe('搜索文件内容');
        expect(tools[0].querySelector('.od-process-tool-args')?.textContent).toBe('查找匹配“model”的内容');
        expect(tools[1].querySelector('.od-process-entry-label')?.textContent).toBe('查找文件');
        expect(tools[1].querySelector('.od-process-tool-args')?.textContent).toBe('查找 src/cli 中的 TypeScript 文件');
        expect(view.textContent).not.toContain('内容搜索');
        expect(view.textContent).not.toContain('模式匹配');
        expect(tools[1].querySelector('.od-process-entry-summary')?.textContent).not.toContain('src/cli/**/*.ts');
        expect(tools[1].querySelector('.od-process-entry-detail')?.textContent?.trim()).toBe('');
        view._handleProcessToggleClick({
            target: tools[1].querySelector('[data-process-entry-toggle]'),
            preventDefault() {},
            stopPropagation() {}
        });
        expect(tools[1].querySelector('.od-process-entry-detail')?.textContent).toContain('src/cli/**/*.ts');
    });

    test('web search results render as safe markdown previews without affecting plain tool output', () => {
        const view = createView();
        const tools = toolPart(1, 2);
        tools.toolcalls[0] = {
            ...tools.toolcalls[0],
            tool_name: 'webSearch',
            args_string: JSON.stringify({ query: 'HarmonyOS ArkTS API Kit' }),
            presentation: { displayName: '网页搜索', resultFormat: 'markdown' },
            result: [
                '## Bing 搜索结果',
                '',
                '**结果数量**: 1',
                '',
                '- [HarmonyOS 开发文档](https://developer.huawei.com/consumer/cn/doc/)'
            ].join('\n')
        };
        tools.toolcalls[1] = {
            ...tools.toolcalls[1],
            tool_name: 'customLogTool',
            result: '## literal terminal-like output'
        };
        view.innerHTML = view._renderAssistantOutputHtml([tools], {
            isRunning: false,
            messageId: 'message-markdown-tool-result'
        });

        const renderedTools = view.querySelectorAll('.od-process-tool');
        renderedTools.forEach((tool) => {
            view._handleProcessToggleClick({
                target: tool.querySelector('[data-process-entry-toggle]'),
                preventDefault() {},
                stopPropagation() {}
            });
        });
        const markdown = renderedTools[0].querySelector('.od-process-markdown-result.markdown-body');
        expect(markdown).not.toBeNull();
        expect(markdown?.querySelector('h2')?.textContent).toBe('Bing 搜索结果');
        expect(markdown?.querySelector('strong')?.textContent).toBe('结果数量');
        expect(markdown?.querySelector('li')?.textContent).toContain('HarmonyOS 开发文档');
        const link = markdown?.querySelector('a') as HTMLAnchorElement;
        expect(link?.dataset.openBrowserUrl).toBe('https://developer.huawei.com/consumer/cn/doc/');
        expect(renderedTools[0].querySelector('.od-process-tool-output > pre')).toBeNull();
        expect(renderedTools[1].querySelector('.od-process-tool-output > pre')?.textContent).toBe(
            '## literal terminal-like output'
        );
    });

    test('minimal running output preserves the expanded execution timeline while streaming', () => {
        const view = createView();
        view.task_id = 'task-1';
        view.innerHTML = '<div id="taskview-chat-history"></div>';
        view.handleAssistantReplace({
            task_status: 'running',
            message_id: 'message-streaming',
            parts: [{ type: 'reasoning', rendered: '第一段思考' }]
        });

        expect(view.querySelector('[data-process-toggle]')).toBeNull();
        const runningStatus = view.querySelector('[data-running-output-toggle]') as HTMLElement;
        view._handleProcessToggleClick({ target: runningStatus, preventDefault() {}, stopPropagation() {} });

        view.handleAssistantReplace({
            task_status: 'running',
            message_id: 'message-streaming',
            parts: [
                { type: 'reasoning', rendered: '第一段思考' },
                { type: 'text', rendered: '<p>阶段正文</p>' },
                toolPart(1, 1)
            ]
        });

        const segments = view.querySelectorAll('.od-process-segment');
        expect(segments).toHaveLength(1);
        expect(view.querySelectorAll('.od-running-process-detail')).toHaveLength(1);
        expect(view.querySelector('[data-running-output-toggle]')?.getAttribute('aria-expanded')).toBe('true');
        expect(view.querySelector('[data-running-output-toggle]')?.nextElementSibling?.classList).toContain(
            'od-running-process-detail'
        );
        expect(view.querySelector('.od-stage-body')?.textContent).toContain('阶段正文');
    });

    test('minimal running output commits body text during streaming without expanding the current process', () => {
        const view = createView();
        view.task_id = 'task-1';
        view.innerHTML = '<div id="taskview-chat-history"></div>';
        view.handleAssistantReplace({
            task_status: 'running',
            message_id: 'message-streaming-collapsed',
            parts: [{ type: 'reasoning', rendered: '第一段思考' }]
        });

        view.handleAssistantReplace({
            task_status: 'running',
            message_id: 'message-streaming-collapsed',
            parts: [
                { type: 'reasoning', rendered: '第一段思考' },
                { type: 'text', rendered: '<p>阶段正文</p>' },
                toolPart(1, 1)
            ]
        });

        expect(view.querySelectorAll('.od-process-segment')).toHaveLength(1);
        expect(view.querySelector('.od-stage-body')?.textContent).toContain('阶段正文');
        expect(view.querySelector('[data-running-output-toggle]')?.getAttribute('aria-expanded')).toBe('false');
        const flow = view.querySelector('.od-assistant-output-flow') as HTMLElement;
        expect(flow.lastElementChild?.classList.contains('od-running-status')).toBe(true);
        expect(flow.lastElementChild?.textContent).toContain('正在调用 Tool1…');
    });

    test('collapsing a process also collapses open reasoning and tool details', () => {
        onSettingChanged?.({ locale: 'zh-CN', gui_config: { output_mode: 'detailed' } });
        const view = createView();
        view.innerHTML = view.renderAssistantMessage({
            message_id: 'message-3',
            content: transcript().slice(0, 3),
            timestamp: Date.now()
        });
        const process = view.querySelector('.od-process-segment') as HTMLElement;
        const reasonToggle = process.querySelector('[data-process-entry-toggle="reasoning"]') as HTMLElement;
        const toolToggle = process.querySelector('[data-process-entry-toggle="tool"]') as HTMLElement;
        view._handleProcessToggleClick({ target: reasonToggle, preventDefault() {}, stopPropagation() {} });
        view._handleProcessToggleClick({ target: toolToggle, preventDefault() {}, stopPropagation() {} });
        expect(reasonToggle.getAttribute('aria-expanded')).toBe('true');
        expect(toolToggle.getAttribute('aria-expanded')).toBe('true');

        const processToggle = process.querySelector('[data-process-toggle]') as HTMLElement;
        view._handleProcessToggleClick({ target: processToggle, preventDefault() {}, stopPropagation() {} });

        expect(processToggle.getAttribute('aria-expanded')).toBe('false');
        expect(reasonToggle.getAttribute('aria-expanded')).toBe('false');
        expect(toolToggle.getAttribute('aria-expanded')).toBe('false');
    });
});
