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
            getToolCallDetail: jest.fn(async (_taskId, _messageId, _partIndex, toolIndex) => ({
                result: `output ${toolIndex + 1}`,
                status: 'success'
            })),
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
                detail_available: true,
                presentation: {
                    displayName: `Tool${start + offset}`,
                    summary: `echo ${start + offset}`
                },
                elapsedSeconds: 0.4
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

    test('completed output safely renders Markdown text when rendered HTML is missing', () => {
        const view = createView();
        view.innerHTML = view.renderAssistantMessage({
            message_id: 'message-text-only-final',
            content: [
                { type: 'reasoning', rendered: '分析过程' },
                { type: 'text', text: '**最终回复** <script>unsafe()</script>' }
            ],
            elapsedSeconds: 57,
            timestamp: Date.now()
        });

        expect(view.querySelector('[data-completed-process-toggle]')?.textContent).toContain('耗时 57 秒');
        expect(view.querySelector('.od-final-result')?.textContent?.trim()).toBe('最终回复 <script>unsafe()</script>');
        expect(view.querySelector('.od-final-result strong')?.textContent).toBe('最终回复');
        expect(view.querySelector('.od-final-result script')).toBeNull();
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
        expect(tool.querySelector('[data-process-entry-toggle]')).not.toBeNull();
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
                presentation: { displayName: '读取文件' }
            },
            {
                ...fileTools.toolcalls[1],
                tool_name: 'filemgr-readFile',
                presentation: { displayName: '读取文件' }
            },
            {
                ...fileTools.toolcalls[2],
                tool_name: 'filemgr-grepFiles',
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
            tool_name: `very-long-specialized-operation-name-${index}`,
            presentation: { displayName: `very-long-specialized-operation-name-${index}` }
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
                    detail_available: true,
                    presentation: { displayName: 'Zsh', summary: '执行命令' },
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
        expect(detail.textContent).not.toContain('npm test');
        expect(detail.textContent).toContain('6 passed');

        view._handleProcessToggleClick({ target: toggle, preventDefault() {}, stopPropagation() {} });
        view._handleProcessToggleClick({ target: toggle, preventDefault() {}, stopPropagation() {} });
        await Promise.resolve();
        expect(getToolCallDetail).toHaveBeenCalledTimes(1);
    });

    test('does not make tools without results or custom rendering expandable', () => {
        const view = createView();
        const part = {
            type: 'tool_call',
            rendered: '',
            toolcalls: [
                {
                    id: 'call-without-detail',
                    index: 0,
                    tool_name: 'plugin-noOutput',
                    status: 'success',
                    detail_available: false,
                    presentation: { displayName: '无输出工具' }
                }
            ]
        };

        view.innerHTML = view._renderAssistantOutputHtml([part], {
            isRunning: false,
            messageId: 'message-without-detail'
        });

        expect(view.querySelector('[data-process-entry-toggle="tool"]')).toBeNull();
        expect(view.querySelector('.od-process-entry-detail')).toBeNull();
    });

    test('successful file resources navigate through the filename without expandable details or IPC', () => {
        const getToolCallDetail = jest.fn();
        window.taskManagerAPI.getToolCallDetail = getToolCallDetail;
        const view = createView();
        view.task_id = 'task-file-resource';
        const part = {
            type: 'tool_call',
            rendered: '',
            toolcalls: [
                {
                    id: 'call-file-resource',
                    index: 0,
                    tool_name: 'filemgr-readFile',
                    status: 'success',
                    detail_available: true,
                    presentation: {
                        displayName: '读取文件',
                        summary: '读取 package.json',
                        resource: { type: 'preview', value: '/workspace/OpenDesk/package.json' },
                        detailMode: 'resource'
                    }
                }
            ]
        };
        view.innerHTML = view._renderAssistantOutputHtml([part], {
            isRunning: false,
            messageId: 'message-file-resource'
        });

        const tool = view.querySelector('.od-process-tool') as HTMLElement;
        expect(tool.querySelector('[data-open-preview]')?.textContent).toBe('package.json');
        expect(tool.querySelector('[data-process-entry-toggle]')).toBeNull();
        expect(tool.querySelector('.od-process-entry-detail')).toBeNull();
        expect(getToolCallDetail).not.toHaveBeenCalled();
    });

    test('resource-only tools append a filename link when a custom summary omits the filename', () => {
        const view = createView();
        const part = {
            type: 'tool_call',
            rendered: '',
            toolcalls: [
                {
                    id: 'call-custom-resource',
                    index: 0,
                    tool_name: 'plugin-updateDocument',
                    status: 'success',
                    detail_available: true,
                    presentation: {
                        displayName: '更新文档',
                        summary: '更新项目配置',
                        resource: { type: 'changes', value: '/workspace/OpenDesk/config.json' },
                        detailMode: 'resource'
                    }
                }
            ]
        };
        view.innerHTML = view._renderAssistantOutputHtml([part], {
            isRunning: false,
            messageId: 'message-custom-resource'
        });

        const link = view.querySelector('[data-open-changes]') as HTMLElement;
        expect(link.textContent).toBe('config.json');
        expect(link.parentElement?.textContent).toContain('更新项目配置 · config.json');
        expect(view.querySelector('[data-process-entry-toggle]')).toBeNull();
    });

    test('failed file resources keep expandable error details', async () => {
        const getToolCallDetail = jest.fn(async () => ({
            result: 'permission denied',
            status: 'error'
        }));
        window.taskManagerAPI.getToolCallDetail = getToolCallDetail;
        const view = createView();
        view.task_id = 'task-file-error';
        const part = {
            type: 'tool_call',
            rendered: '',
            toolcalls: [
                {
                    id: 'call-file-error',
                    index: 0,
                    tool_name: 'filemgr-readFile',
                    status: 'error',
                    detail_available: true,
                    presentation: {
                        displayName: '读取文件',
                        summary: '读取 package.json',
                        resource: { type: 'preview', value: '/workspace/OpenDesk/package.json' },
                        detailMode: 'resource'
                    }
                }
            ]
        };
        view.innerHTML = view._renderAssistantOutputHtml([part], {
            isRunning: false,
            messageId: 'message-file-error'
        });

        const toggle = view.querySelector('[data-process-entry-toggle="tool"]') as HTMLElement;
        expect(toggle).not.toBeNull();
        view._handleProcessToggleClick({ target: toggle, preventDefault() {}, stopPropagation() {} });
        await Promise.resolve();
        await Promise.resolve();

        expect(getToolCallDetail).toHaveBeenCalledTimes(1);
        expect(view.querySelector('.od-process-entry-detail')?.textContent).toContain('permission denied');
    });

    test('expanded tool details reuse a human-readable tool renderer when available', async () => {
        const view = createView();
        const terminalTool = toolPart(1, 1);
        window.taskManagerAPI.getToolCallDetail = jest.fn(async () => ({
            rendered: `<details class="terminal-tool" open>
                <summary>Bash（运行测试）</summary>
                <pre>$ npm test\n6 passed</pre>
            </details>`,
            status: 'success'
        }));
        terminalTool.toolcalls[0].presentation = { displayName: 'Bash', detailMode: 'custom' };
        view.innerHTML = view._renderAssistantOutputHtml([terminalTool], {
            isRunning: false,
            messageId: 'message-readable-tool'
        });

        const toolToggle = view.querySelector('[data-process-entry-toggle="tool"]') as HTMLElement;
        view._handleProcessToggleClick({ target: toolToggle, preventDefault() {}, stopPropagation() {} });
        await Promise.resolve();
        await Promise.resolve();

        const detail = view.querySelector('.od-process-tool .od-process-entry-detail') as HTMLElement;
        expect(detail.querySelector('.od-process-tool-rendered .terminal-tool')).not.toBeNull();
        expect(detail.textContent).toContain('Bash（运行测试）');
        expect(detail.textContent).toContain('6 passed');
        expect(detail.textContent).toContain('已完成');
        expect(detail.textContent).not.toContain('{"command"');
    });

    test('expanded tool details never render raw arguments as a fallback', async () => {
        const view = createView();
        const terminalTool = toolPart(1, 1);
        window.taskManagerAPI.getToolCallDetail = jest.fn(async () => ({
            result: JSON.stringify({ passed: 6 }, null, 2),
            status: 'success'
        }));
        view.innerHTML = view._renderAssistantOutputHtml([terminalTool], {
            isRunning: false,
            messageId: 'message-readable-tool-fallback'
        });

        const toolToggle = view.querySelector('[data-process-entry-toggle="tool"]') as HTMLElement;
        view._handleProcessToggleClick({ target: toolToggle, preventDefault() {}, stopPropagation() {} });
        await Promise.resolve();
        await Promise.resolve();

        const detail = view.querySelector('.od-process-tool .od-process-entry-detail') as HTMLElement;
        expect(detail.querySelectorAll('.od-process-tool-field')).toHaveLength(0);
        expect(detail.textContent).not.toContain('npm test');
        expect(detail.textContent).not.toContain('/workspace/OpenDesk');
        expect(detail.textContent).toContain('"passed": 6');
        expect(detail.textContent).not.toContain('{"command":"npm test"');
    });

    test('truncated tool details use bounded plain text and report the display limit', () => {
        const html = TaskViewClass._renderToolExecutionDetail({
            result: '# head\n...\n## tail',
            rendered: '<div>oversized rich output</div>',
            status: 'success',
            presentation: { resultFormat: 'markdown' },
            truncation: {
                result: { originalBytes: 300_000 },
                rendered: { originalBytes: 400_000 }
            }
        });

        expect(html).toContain('内容过大，已截断显示');
        expect(html).toContain('# head');
        expect(html).toContain('## tail');
        expect(html).not.toContain('oversized rich output');
        expect(html).not.toContain('od-process-markdown-result');
    });

    test('tool detail cache evicts old entries instead of growing for the full task lifetime', () => {
        const view = createView();
        for (let index = 0; index < 21; index += 1) {
            view._cacheToolDetail(`detail-${index}`, { result: `result-${index}` });
        }

        expect(view._toolDetailCache).toHaveProperty('size', 20);
        expect(view._toolDetailCache.has('detail-0')).toBe(false);
        expect(view._toolDetailCache.has('detail-20')).toBe(true);
    });

    test('file tool summaries describe the action without embedding the file result', () => {
        const view = createView();
        const fileTool = toolPart(1, 1);
        fileTool.toolcalls[0] = {
            ...fileTool.toolcalls[0],
            tool_name: 'filemgr-readFile',
            presentation: {
                displayName: { key: 'filemgr.readFile.name' },
                summary: {
                    key: 'renderer.taskview.output.purpose.readFile',
                    params: { name: 'package.json' }
                },
                resource: { type: 'preview', value: '/workspace/OpenDesk/package.json' },
                detailMode: 'resource'
            }
        };
        view.innerHTML = view._renderAssistantOutputHtml([fileTool], {
            isRunning: false,
            messageId: 'message-readable-file-tool'
        });

        const tool = view.querySelector('.od-process-tool') as HTMLElement;
        expect(tool.querySelector('.od-process-entry-label')?.textContent).toBe('读取文件');
        expect(tool.querySelector('.od-process-tool-args')?.textContent).toBe('读取 package.json');

        expect(tool.querySelector('[data-open-preview]')?.textContent).toBe('package.json');
        expect(tool.querySelector('[data-process-entry-toggle]')).toBeNull();
        expect(tool.querySelector('.od-process-entry-detail')).toBeNull();
    });

    test('file tool summaries link reads to previews and writes to task changes', () => {
        const view = createView();
        const fileTools = toolPart(1, 2);
        fileTools.toolcalls[0] = {
            ...fileTools.toolcalls[0],
            tool_name: 'filemgr-readFile',
            presentation: {
                displayName: '读取文件',
                summary: '读取 appguide.md',
                resource: { type: 'preview', value: '/workspace/OpenDesk/appguide.md' },
                detailMode: 'resource'
            }
        };
        fileTools.toolcalls[1] = {
            ...fileTools.toolcalls[1],
            tool_name: 'filemgr-writeFile',
            presentation: {
                displayName: '写入文件',
                summary: '写入 setting.md',
                resource: { type: 'changes', value: '/workspace/OpenDesk/setting.md' },
                detailMode: 'resource'
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

        view._handleProcessToggleClick({ target: readLink, preventDefault() {}, stopPropagation() {} });
        expect(tools[0].querySelector('[data-process-entry-toggle]')).toBeNull();
        expect(tools[1].querySelector('[data-process-entry-toggle]')).toBeNull();

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

    test('browser URLs open in the right sidebar without toggling tool details', async () => {
        const view = createView();
        const browserTools = toolPart(1, 2);
        window.taskManagerAPI.getToolCallDetail = jest.fn(async (_taskId, _messageId, _partIndex, toolIndex) => ({
            result:
                toolIndex === 1
                    ? '1. OpenDesk\n   - url: https://opendesk.example.com/docs\n   - summary: 项目文档'
                    : '',
            status: 'success'
        }));
        browserTools.toolcalls[0] = {
            ...browserTools.toolcalls[0],
            tool_name: 'browser-navigate',
            presentation: {
                displayName: '打开网页',
                summary: '打开 https://docs.example.com/guide?lang=zh-CN',
                resource: { type: 'url', value: 'https://docs.example.com/guide?lang=zh-CN' }
            }
        };
        browserTools.toolcalls[1] = {
            ...browserTools.toolcalls[1],
            tool_name: 'WebSearch',
            presentation: { displayName: '网页搜索' }
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
        await Promise.resolve();
        await Promise.resolve();
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
            presentation: {
                displayName: { key: 'renderer.taskview.output.toolName.executeCommand' },
                summary: '定位工具渲染入口'
            }
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

    test('load skill summaries show only the skill name instead of raw arguments', async () => {
        const view = createView();
        const loadSkillTool = toolPart(1, 1);
        loadSkillTool.toolcalls[0] = {
            ...loadSkillTool.toolcalls[0],
            tool_name: 'LoadSkill',
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
        await Promise.resolve();
        await Promise.resolve();
        expect(tool.querySelector('.od-process-entry-detail')?.textContent).toContain('output 1');
        expect(tool.querySelector('.od-process-entry-detail')?.textContent).not.toContain('bundleName');
    });

    test('call skill summaries and details use presentation plus the on-demand result', async () => {
        const view = createView();
        const callSkillTool = toolPart(1, 1);
        window.taskManagerAPI.getToolCallDetail = jest.fn(async () => ({
            result: JSON.stringify({
                content: [{ type: 'text', text: '页面已打开' }],
                internalTrace: 'verbose protocol data'
            }),
            status: 'success'
        }));
        callSkillTool.toolcalls[0] = {
            ...callSkillTool.toolcalls[0],
            tool_name: 'CallSkillTool',
            presentation: { displayName: '调用技能', summary: 'use-browser' }
        };
        view.innerHTML = view._renderAssistantOutputHtml([callSkillTool], {
            isRunning: false,
            messageId: 'message-call-skill-summary'
        });

        const tool = view.querySelector('.od-process-tool') as HTMLElement;
        expect(tool.querySelector('.od-process-entry-label')?.textContent).toBe('调用技能');
        expect(tool.querySelector('.od-process-tool-args')?.textContent).toBe('use-browser');
        expect(view.querySelector('.od-process-summary-text')?.textContent).toBe('使用了 调用技能 等工具');

        const toggle = tool.querySelector('[data-process-entry-toggle]') as HTMLElement;
        view._handleProcessToggleClick({ target: toggle, preventDefault() {}, stopPropagation() {} });
        await Promise.resolve();
        await Promise.resolve();
        const detail = tool.querySelector('.od-process-entry-detail')?.textContent || '';
        expect(tool.querySelector('.od-process-tool-execution-header')?.textContent).toContain('执行详情');
        expect(detail).not.toContain('目标网址');
        expect(detail).not.toContain('https://developer.huawei.com/docs');
        expect(detail).not.toContain('等待条件');
        expect(detail).toContain('页面已打开');
        expect(detail).not.toContain('内部工具');
        expect(detail).not.toContain('navigate');
        expect(detail).not.toContain('bundleName');
        expect(detail).not.toContain('toolArgs');
        expect(detail).not.toContain('internalTrace');
        expect(detail).not.toContain('"content"');
    });

    test('call skill entry titles come entirely from presentation metadata', () => {
        const view = createView();
        const callSkillTool = toolPart(1, 1);
        callSkillTool.toolcalls[0] = {
            ...callSkillTool.toolcalls[0],
            tool_name: 'CallSkillTool',
            presentation: { displayName: '调用技能', summary: 'use-browser' }
        };
        view.innerHTML = view._renderAssistantOutputHtml([callSkillTool], {
            isRunning: false,
            messageId: 'message-call-skill-evaluate-title'
        });

        const tool = view.querySelector('.od-process-tool') as HTMLElement;
        expect(tool.querySelector('.od-process-entry-label')?.textContent).toBe('调用技能');
        expect(tool.querySelector('.od-process-tool-args')?.textContent).toBe('use-browser');
    });

    test('file search summaries describe grep and glob operations in plain language', async () => {
        const view = createView();
        const searchTools = toolPart(1, 2);
        searchTools.toolcalls[0] = {
            ...searchTools.toolcalls[0],
            tool_name: 'filemgr-grepFiles',
            presentation: { displayName: '搜索文件内容', summary: '查找匹配“model”的内容' }
        };
        searchTools.toolcalls[1] = {
            ...searchTools.toolcalls[1],
            tool_name: 'filemgr-globFiles',
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
        await Promise.resolve();
        await Promise.resolve();
        expect(tools[1].querySelector('.od-process-entry-detail')?.textContent).toContain('output 2');
        expect(tools[1].querySelector('.od-process-entry-detail')?.textContent).not.toContain('src/cli/**/*.ts');
    });

    test('web search results render as safe markdown previews without affecting plain tool output', async () => {
        const view = createView();
        const tools = toolPart(1, 2);
        window.taskManagerAPI.getToolCallDetail = jest.fn(async (_taskId, _messageId, _partIndex, toolIndex) => ({
            result:
                toolIndex === 0
                    ? [
                          '## Bing 搜索结果',
                          '',
                          '**结果数量**: 1',
                          '',
                          '- [HarmonyOS 开发文档](https://developer.huawei.com/consumer/cn/doc/)'
                      ].join('\n')
                    : '## literal terminal-like output',
            status: 'success'
        }));
        tools.toolcalls[0] = {
            ...tools.toolcalls[0],
            tool_name: 'webSearch',
            presentation: { displayName: '网页搜索', resultFormat: 'markdown' }
        };
        tools.toolcalls[1] = {
            ...tools.toolcalls[1],
            tool_name: 'customLogTool',
            presentation: { displayName: '日志工具' }
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
        await Promise.resolve();
        await Promise.resolve();
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

    test('streaming text deltas render safe Markdown in one stable part without rebuilding the assistant output', () => {
        const view = createView();
        view.task_id = 'task-1';
        view.innerHTML = '<div id="taskview-chat-history"></div>';
        const history = view.querySelector('#taskview-chat-history');
        const renderSpy = jest.spyOn(view, '_renderAssistantOutputHtml');

        view._renderAssistantProgress(
            {
                type: 'assistant',
                task_status: 'running',
                message_id: 'message-delta',
                last_part_index: 0,
                streaming: true,
                last_part: {
                    type: 'text',
                    text_delta: '**hello**',
                    text_length: 9,
                    stream_reset: true
                }
            },
            history
        );

        const streamingPart = view.querySelector('[data-streaming-part-index="0"]');
        expect(streamingPart?.textContent?.trim()).toBe('hello');
        expect(streamingPart?.querySelector('strong')?.textContent).toBe('hello');
        expect(streamingPart?.innerHTML).not.toContain('**');
        expect(renderSpy).toHaveBeenCalledTimes(1);

        view._renderAssistantProgress(
            {
                type: 'assistant',
                task_status: 'running',
                message_id: 'message-delta',
                last_part_index: 0,
                streaming: true,
                last_part: {
                    type: 'text',
                    text_delta: '\n\n- world',
                    text_length: 18
                }
            },
            history
        );

        expect(view.querySelector('[data-streaming-part-index="0"]')).toBe(streamingPart);
        expect(streamingPart?.textContent).toContain('hello');
        expect(streamingPart?.querySelector('li')?.textContent).toBe('world');
        expect(streamingPart?.innerHTML).not.toContain('**');
        expect(renderSpy).toHaveBeenCalledTimes(1);
    });

    test('hidden history merges text deltas instead of replacing the complete part', () => {
        const view = createView();
        view._historyMessages = [
            {
                role: 'assistant',
                message_id: 'message-hidden-delta',
                content: [{ type: 'text', text: 'hello', rendered: '<p>hello</p>' }]
            }
        ];

        view._applyHiddenAssistantProgressToHistory({
            type: 'assistant',
            task_status: 'running',
            message_id: 'message-hidden-delta',
            last_part_index: 0,
            streaming: true,
            last_part: {
                type: 'text',
                text_delta: ' world',
                text_length: 11
            }
        });

        expect(view._historyMessages[0].content[0]).toMatchObject({
            type: 'text',
            text: 'hello world',
            streaming: true
        });
        expect(view._historyMessages[0].content[0].rendered).toBeUndefined();
    });

    test('ignores a stale running delta after a message reached terminal state', () => {
        const view = createView();
        view.task_id = 'task-1';
        view.innerHTML = '<div id="taskview-chat-history"></div>';
        view.handleAssistantReplace({
            type: 'assistant_replace',
            task_status: 'stopped',
            message_id: 'message-terminal',
            parts: [
                { type: 'reasoning', rendered: '分析过程' },
                { type: 'text', text: 'complete', rendered: '<p>complete</p>' }
            ],
            elapsedSeconds: 12
        });

        view._renderAssistantProgress(
            {
                type: 'assistant',
                task_status: 'running',
                message_id: 'message-terminal',
                last_part_index: 1,
                streaming: true,
                last_part: {
                    type: 'text',
                    text_delta: ' stale',
                    text_length: 14
                }
            },
            view.querySelector('#taskview-chat-history')
        );

        expect(view.querySelector('.od-final-result')?.textContent).toBe('complete');
        expect(view._assistantPartsByMessage.get('message-terminal')[1].text).toBe('complete');
        expect(view._assistantRenderStateByMessage.get('message-terminal').isRunning).toBe(false);
    });

    test('terminal assistant update replaces the streaming DOM instead of depending on incremental morphing', () => {
        const view = createView();
        view.innerHTML = '<div id="taskview-chat-history"></div>';
        const history = view.querySelector('#taskview-chat-history');

        view._renderAssistantProgress(
            {
                type: 'assistant',
                task_status: 'running',
                message_id: 'message-terminal-replace',
                last_part_index: 0,
                last_part: {
                    type: 'text',
                    text_delta: '## 最终',
                    text_length: 5,
                    stream_reset: true
                },
                streaming: true
            },
            history
        );

        const morph = TaskViewClass.morphDomChildren;
        TaskViewClass.morphDomChildren = jest.fn();
        try {
            view._renderAssistantProgress(
                {
                    type: 'assistant',
                    task_status: 'stopped',
                    message_id: 'message-terminal-replace',
                    last_part_index: 0,
                    last_part: {
                        type: 'text',
                        text: '## 最终回复\n\n终态正文',
                        rendered: '<h2>最终回复</h2><p>终态正文</p>'
                    },
                    elapsedSeconds: 300.4
                },
                history
            );
        } finally {
            TaskViewClass.morphDomChildren = morph;
        }

        expect(view.querySelector('.od-final-result')?.textContent).toContain('最终回复');
        expect(view.querySelector('.od-final-result')?.textContent).toContain('终态正文');
    });

    test('replays assistant parts received while history reload is replacing the DOM', () => {
        const view = createView();
        view.task_id = 'task-1';
        view.innerHTML = '<div id="taskview-chat-history"></div>';
        const history = view.querySelector('#taskview-chat-history');
        view._taskUpdateHandler = (progress: any) => view._renderAssistantProgress(progress, history);
        view._reloading = true;

        const updates = [
            {
                type: 'assistant',
                task_status: 'running',
                message_id: 'message-reload-race',
                last_part_index: 0,
                last_part: { type: 'reasoning', rendered: '分析过程' }
            },
            {
                type: 'assistant',
                task_status: 'running',
                message_id: 'message-reload-race',
                last_part_index: 1,
                last_part: { type: 'text', text: '中间结论', rendered: '<p>中间结论</p>' }
            },
            {
                type: 'assistant',
                task_status: 'running',
                message_id: 'message-reload-race',
                last_part_index: 2,
                last_part: { type: 'reasoning', rendered: '继续分析' }
            },
            {
                type: 'assistant',
                task_status: 'stopped',
                message_id: 'message-reload-race',
                last_part_index: 3,
                last_part: { type: 'text', text: '最终回复', rendered: '<p>最终回复</p>' },
                elapsedSeconds: 57
            }
        ];

        updates.forEach((progress) => view._deferTaskUpdateDuringReload(progress));
        view._flushDeferredTaskUpdates();
        expect(history.children).toHaveLength(0);

        view._reloading = false;
        view._flushDeferredTaskUpdates();

        expect(view.querySelector('.od-final-result')?.textContent).toContain('最终回复');
        const completedToggle = view.querySelector('[data-completed-process-toggle]') as HTMLElement;
        expect(completedToggle?.textContent).toContain('耗时 57 秒');
        view._handleProcessToggleClick({ target: completedToggle, preventDefault() {}, stopPropagation() {} });
        expect(view.querySelector('.od-completed-process-detail')?.textContent).toContain('中间结论');
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
