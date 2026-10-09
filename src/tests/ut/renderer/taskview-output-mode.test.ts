import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { zhCn } from '../../../locale/zh-cn.js';
import { enUs } from '../../../locale/en-us.js';

const taskViewStyles = readFileSync(new URL('../../../renderer/styles/custom.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, '');

describe('task-view GUI output modes', () => {
    let onSettingChanged: ((setting: Record<string, any>) => void) | undefined;
    let TaskViewClass: any;
    const createdViews: any[] = [];

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
            enhanceToolPreviewCards: jest.fn(),
            renderMermaidBlocks: jest.fn(),
            untrackPreviewerContainers: jest.fn()
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
        onSettingChanged?.({
            locale: 'zh-CN',
            gui_config: { output_mode: 'minimal', gui_reason_display: 'inline' }
        });
        window.taskManagerAPI = {
            getFullTask: jest.fn()
        } as any;
    });

    // Streaming reasoning blocks start a per-second elapsed-time interval (see
    // updateReasoningPreview in taskview.js). Tests below create such blocks but
    // never mount the view, so disconnectedCallback (which finalizes them) never
    // runs and the interval would keep the jest worker alive until force-exit.
    // Finalize every block created by the test to match the real teardown path.
    afterEach(() => {
        for (const view of createdViews.splice(0)) {
            view.querySelectorAll('.reasoning-block-od.reasoning-active').forEach((el) => {
                TaskViewClass.finalizeReasoningBlock(el);
            });
        }
    });

    function toolPart(start: number, count: number, withMainlineCards = false) {
        const toolcalls = Array.from({ length: count }, (_, offset) => ({
            id: `call-${start + offset}`,
            tool_name: `Tool${start + offset}`,
            status: 'success'
        }));
        return {
            type: 'tool_call',
            rendered: withMainlineCards
                ? toolcalls
                      .map(
                          (tool) =>
                              `<div class="mainline-tool-card" data-mainline-tool="${tool.id}">Mainline ${tool.tool_name}</div>`
                      )
                      .join('')
                : '',
            toolcalls
        };
    }

    /** 主进程终端卡片渲染产物：<details class="terminal-tool" ... open> 固定为展开。 */
    function terminalCardHtml(id: string, output = 'output') {
        return (
            `<details data-toolcall-id="${id}" class="terminal-tool od-card-shadow" open>` +
            `<summary class="terminal-tool-summary">${id}</summary>` +
            `<div class="terminal-tool-scroll"><pre class="terminal-tool-output">${output}</pre></div>` +
            `</details>`
        );
    }

    function terminalToolPart(ids: string[]) {
        return {
            type: 'tool_call',
            rendered: ids.map((id) => terminalCardHtml(id)).join(''),
            toolcalls: ids.map((id) => ({ id, tool_name: 'bash', status: 'success' }))
        };
    }

    function transcript() {
        return [
            { type: 'reasoning', rendered: '分析现有结构' },
            toolPart(1, 10, true),
            { type: 'text', text: '第一段正文', rendered: '<p>第一段正文</p>' },
            { type: 'reasoning', rendered: '实现展示方案' },
            toolPart(11, 10, true),
            { type: 'text', text: '第二段正文', rendered: '<p>第二段正文</p>' },
            { type: 'reasoning', rendered: '验证最终结果' },
            toolPart(21, 10, true),
            { type: 'text', text: '最终正文', rendered: '<p>最终正文</p>' }
        ];
    }

    function createView() {
        const view = new TaskViewClass() as any;
        createdViews.push(view);
        return view;
    }

    test('minimal completed output collapses the full process behind one process row', () => {
        const view = createView();
        view.innerHTML = view.renderAssistantMessage({
            message_id: 'message-1',
            content: transcript(),
            timestamp: Date.now()
        });

        const completedToggle = view.querySelector('[data-completed-process-toggle]') as HTMLElement;
        expect(view.querySelectorAll('.od-completed-process')).toHaveLength(1);
        expect(completedToggle.textContent).toContain('查看过程');
        const chevron = completedToggle.querySelector('.od-completed-process-chevron svg');
        expect(chevron?.getAttribute('fill')).toBe('none');
        expect(chevron?.getAttribute('stroke')).toBe('currentColor');
        expect(completedToggle.getAttribute('aria-expanded')).toBe('false');
        expect(view.querySelector('.od-completed-process-detail')?.classList.contains('is-open')).toBe(false);

        const processSegments = view.querySelectorAll('.od-process-segment');
        expect(processSegments).toHaveLength(3);
        const processChevron = processSegments[0].querySelector('.od-process-chevron svg');
        expect(processChevron?.getAttribute('fill')).toBe('none');
        expect(processChevron?.getAttribute('stroke')).toBe('currentColor');
        processSegments.forEach((segment: Element) => {
            expect(segment.querySelector('[data-process-toggle]')?.getAttribute('aria-expanded')).toBe('false');
        });
        expect(view.querySelectorAll('.od-stage-body')).toHaveLength(2);
        expect(view.querySelector('.od-final-result')?.textContent).toContain('最终正文');
        expect(
            Array.from(view.querySelectorAll('.od-process-summary-text')).map((element) => element.textContent)
        ).toEqual([
            '深度思考，调用了Tool1、Tool2等 10个工具',
            '深度思考，调用了Tool11、Tool12等 10个工具',
            '深度思考，调用了Tool21、Tool22等 10个工具'
        ]);
        expect(view.textContent).not.toContain('工具调用 · 10 个工具');
        expect(view.textContent).not.toMatch(/工具调用 \d+[–-]\d+/);

        view._handleProcessToggleClick({ target: completedToggle, preventDefault() {}, stopPropagation() {} });
        expect(completedToggle.getAttribute('aria-expanded')).toBe('true');
        expect(view.querySelector('.od-completed-process-detail')?.classList.contains('is-open')).toBe(true);
        expect(view.querySelectorAll('.mainline-tool-card')).toHaveLength(30);
    });

    test('completed output safely renders Markdown text when rendered HTML is missing', () => {
        const view = createView();
        view.innerHTML = view.renderAssistantMessage({
            message_id: 'message-text-only-final',
            content: [
                { type: 'reasoning', rendered: '分析过程' },
                { type: 'text', text: '**最终回复** <script>unsafe()</script>' }
            ],
            timestamp: Date.now()
        });

        expect(view.querySelector('[data-completed-process-toggle]')?.textContent).toContain('查看过程');
        expect(view.querySelector('.od-final-result')?.textContent?.trim()).toBe('最终回复 <script>unsafe()</script>');
        expect(view.querySelector('.od-final-result strong')?.textContent).toBe('最终回复');
        expect(view.querySelector('.od-final-result script')).toBeNull();
    });

    test('completed minimal toggle shows the persisted turn duration when execution timestamps exist', () => {
        const now = Date.now();
        const view = createView();
        view.innerHTML = view.renderAssistantMessage({
            message_id: 'message-with-duration',
            content: [
                { type: 'reasoning', rendered: '分析过程' },
                { type: 'text', text: '最终回复', rendered: '<p>最终回复</p>' }
            ],
            metadata: {
                execution: { startAt: now - 65 * 1000, finishAt: now }
            }
        });

        const toggle = view.querySelector('[data-completed-process-toggle]') as HTMLElement;
        expect(toggle.textContent).toContain('查看过程（本轮共耗时 1 分 5 秒）');
    });

    test('completed minimal toggle falls back to plain label when turn duration is unavailable', () => {
        const view = createView();
        view.innerHTML = view.renderAssistantMessage({
            message_id: 'message-without-duration',
            content: [
                { type: 'reasoning', rendered: '分析过程' },
                { type: 'text', text: '最终回复', rendered: '<p>最终回复</p>' }
            ],
            timestamp: Date.now()
        });

        const toggle = view.querySelector('[data-completed-process-toggle]') as HTMLElement;
        expect(toggle.textContent).toContain('查看过程');
        expect(toggle.textContent).not.toContain('本轮共耗时');
    });

    test('turn duration formats hours and plain seconds across ranges', () => {
        const view = createView();
        const now = Date.now();
        const render = (durationMs: number, messageId: string) =>
            view.renderAssistantMessage({
                message_id: messageId,
                content: [
                    { type: 'reasoning', rendered: '过程' },
                    { type: 'text', text: '回复', rendered: '<p>回复</p>' }
                ],
                metadata: { execution: { startAt: now - durationMs, finishAt: now } }
            });

        const seconds = createView();
        seconds.innerHTML = render(9_000, 'message-duration-seconds');
        expect((seconds.querySelector('[data-completed-process-toggle]') as HTMLElement).textContent).toContain(
            '查看过程（本轮共耗时 9 秒）'
        );

        const hours = createView();
        hours.innerHTML = render(2 * 3600_000 + 5 * 60_000, 'message-duration-hours');
        expect((hours.querySelector('[data-completed-process-toggle]') as HTMLElement).textContent).toContain(
            '查看过程（本轮共耗时 2 小时 5 分）'
        );

        const enView = createView();
        onSettingChanged?.({
            locale: 'en-US',
            gui_config: { output_mode: 'minimal', gui_reason_display: 'inline' }
        });
        enView.innerHTML = render(65_000, 'message-duration-en');
        expect((enView.querySelector('[data-completed-process-toggle]') as HTMLElement).textContent).toContain(
            'View process (took 1m 5s)'
        );
        onSettingChanged?.({ locale: 'zh-CN', gui_config: { output_mode: 'minimal', gui_reason_display: 'inline' } });
    });

    test('verbose output defaults every process segment and completed reasoning body open', () => {
        onSettingChanged?.({ locale: 'zh-CN', gui_config: { output_mode: 'verbose' } });
        const view = createView();
        view.innerHTML = view.renderAssistantMessage({
            message_id: 'message-2',
            content: transcript(),
            timestamp: Date.now()
        });

        const processSegments = view.querySelectorAll('.od-process-segment');
        expect(processSegments).toHaveLength(3);
        processSegments.forEach((segment: Element) => {
            // 详细模式卡片直接铺开，与卡片内容重复的摘要折叠头不再渲染
            expect(segment.querySelector('[data-process-toggle]')).toBeNull();
            expect(segment.querySelector('.od-process-detail')?.classList.contains('is-open')).toBe(true);
            expect(segment.querySelector('.reasoning-block-od')?.classList.contains('reasoning-expanded')).toBe(true);
            expect(segment.querySelector('.reasoning-full-area')?.textContent).not.toBe('');
        });
        expect(view.querySelectorAll('.mainline-tool-card')).toHaveLength(30);
        expect(view.querySelectorAll('.od-process-summary')).toHaveLength(0);
        expect(view.querySelector('.od-process-tool')).toBeNull();
    });

    test('verbose completed output omits the final result label and separates the final body', () => {
        onSettingChanged?.({ locale: 'zh-CN', gui_config: { output_mode: 'verbose' } });
        const view = createView();
        view.innerHTML = view.renderAssistantMessage({
            message_id: 'message-verbose-final-divider',
            content: transcript(),
            timestamp: Date.now()
        });

        expect(view.querySelector('.od-final-result-label')).toBeNull();
        const finalResult = view.querySelector('.od-final-result');
        expect(finalResult?.classList.contains('od-final-result-with-divider')).toBe(true);
        // 详细模式过程段无折叠头，最后一个子元素是铺开的 detail 层
        expect(finalResult?.previousElementSibling?.lastElementChild?.classList.contains('od-process-detail')).toBe(
            true
        );
        expect(taskViewStyles).toMatch(/\.od-final-result-with-divider\{[^}]*border-top:1pxsolidvar\(--od-border\);/);
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
            timestamp: Date.now()
        });

        const messageContent = view.querySelector('#message-content-message-mode-switch');
        const completedToggle = view.querySelector('[data-completed-process-toggle]') as HTMLElement;
        view._handleProcessToggleClick({ target: completedToggle, preventDefault() {}, stopPropagation() {} });

        onSettingChanged?.({ locale: 'zh-CN', gui_config: { output_mode: 'verbose' } });

        expect(window.taskManagerAPI.getFullTask as jest.Mock).not.toHaveBeenCalled();
        expect(view.querySelector('#message-content-message-mode-switch')).toBe(messageContent);
        expect(view.querySelector('.od-assistant-output-flow')?.getAttribute('data-output-mode')).toBe('verbose');
        // 切到详细模式后摘要折叠头消失，卡片直接铺开
        expect(view.querySelector('[data-process-toggle]')).toBeNull();

        onSettingChanged?.({ locale: 'zh-CN', gui_config: { output_mode: 'minimal' } });

        expect(view.querySelector('[data-completed-process-toggle]')?.getAttribute('aria-expanded')).toBe('true');
        view.remove();
    });

    test('bubble reasoning mode reuses the mainline reasoning card inside the process timeline', () => {
        onSettingChanged?.({
            locale: 'zh-CN',
            gui_config: { output_mode: 'verbose', gui_reason_display: 'bubble' }
        });
        const view = createView();
        view.innerHTML = view._renderAssistantOutputHtml(
            [{ type: 'reasoning', text: '正在分析', rendered: '正在分析', streaming: true }],
            { isRunning: true, messageId: 'message-bubble-streaming' }
        );

        const flow = view.querySelector('.od-assistant-output-flow') as HTMLElement;
        const reason = view.querySelector('.reasoning-block-od') as HTMLElement;
        const bubble = reason.querySelector('.reasoning-bubble') as HTMLElement;

        expect(flow.dataset.reasonDisplay).toBe('bubble');
        expect(reason.classList).toContain('reasoning-active');
        expect(bubble.classList).not.toContain('reasoning-bubble-hidden');
        expect(bubble.textContent).toContain('正在分析');
    });

    test('completed reasoning shows its persisted elapsed time', () => {
        onSettingChanged?.({
            locale: 'zh-CN',
            gui_config: { output_mode: 'verbose', gui_reason_display: 'inline' }
        });
        const view = createView();
        view.innerHTML = view._renderAssistantOutputHtml(
            [{ type: 'reasoning', rendered: '已完成的思考', elapsedSeconds: 8 }],
            { isRunning: false, messageId: 'message-reasoning-elapsed' }
        );

        expect(view.querySelector('.reasoning-time')?.textContent).toContain('8');
    });

    test('completed bubble reasoning can be pinned and unpinned without changing the process model', () => {
        onSettingChanged?.({
            locale: 'zh-CN',
            gui_config: { output_mode: 'minimal', gui_reason_display: 'bubble' }
        });
        const view = createView();
        view.innerHTML = view._renderAssistantOutputHtml([{ type: 'reasoning', rendered: '完整思考内容' }], {
            isRunning: false,
            messageId: 'message-bubble-completed'
        });

        const reason = view.querySelector('.reasoning-block-od') as HTMLElement;
        const header = reason.querySelector('.reasoning-header') as HTMLElement;
        const bubble = reason.querySelector('.reasoning-bubble') as HTMLElement;
        expect(bubble.classList).toContain('reasoning-bubble-hidden');

        view._handleReasoningToggleClick({ target: header, preventDefault() {}, stopPropagation() {} });
        expect(reason.classList).toContain('reasoning-bubble-pinned');
        expect(bubble.classList).not.toContain('reasoning-bubble-hidden');

        view._handleReasoningToggleClick({ target: header, preventDefault() {}, stopPropagation() {} });
        expect(reason.classList).not.toContain('reasoning-bubble-pinned');
        expect(bubble.classList).toContain('reasoning-bubble-hidden');
    });

    test('verbose completed bubble reasoning stays expanded by default', () => {
        onSettingChanged?.({
            locale: 'zh-CN',
            gui_config: { output_mode: 'verbose', gui_reason_display: 'bubble' }
        });
        const view = createView();
        view.innerHTML = view._renderAssistantOutputHtml([{ type: 'reasoning', rendered: '完整思考内容' }], {
            isRunning: false,
            messageId: 'message-bubble-completed-verbose'
        });

        const reason = view.querySelector('.reasoning-block-od') as HTMLElement;
        const bubble = reason.querySelector('.reasoning-bubble') as HTMLElement;
        expect(reason.classList).toContain('reasoning-bubble-pinned');
        expect(bubble.classList).not.toContain('reasoning-bubble-hidden');
        expect(bubble.textContent).toContain('完整思考内容');
    });

    test('a minimal-mode streaming bubble closes when reasoning completes', () => {
        onSettingChanged?.({
            locale: 'zh-CN',
            gui_config: { output_mode: 'minimal', gui_reason_display: 'bubble' }
        });
        const view = createView();
        view.task_id = 'task-bubble-completion';
        view.innerHTML = '<div id="taskview-chat-history"></div>';
        const history = view.querySelector('#taskview-chat-history');
        view._assistantRunningDetails.set('message-bubble-completion', true);

        view._renderAssistantProgress(
            {
                type: 'assistant',
                task_status: 'running',
                message_id: 'message-bubble-completion',
                last_part_index: 0,
                streaming: true,
                last_part: {
                    type: 'reasoning',
                    text: '分析中'
                }
            },
            history
        );

        expect(view.querySelector('.reasoning-bubble')?.classList).not.toContain('reasoning-bubble-hidden');

        view._renderAssistantProgress(
            {
                type: 'assistant',
                task_status: 'completed',
                message_id: 'message-bubble-completion',
                last_part_index: 0,
                streaming: false,
                last_part: { type: 'reasoning', rendered: '分析完成' }
            },
            history
        );

        expect(view.querySelector('.reasoning-bubble')?.classList).toContain('reasoning-bubble-hidden');
    });

    test('streaming reasoning patches the existing bubble and keeps the newest content visible', () => {
        onSettingChanged?.({
            locale: 'zh-CN',
            gui_config: { output_mode: 'verbose', gui_reason_display: 'bubble' }
        });
        const view = createView();
        view.task_id = 'task-bubble-streaming';
        view.innerHTML = '<div id="taskview-chat-history"></div>';
        const history = view.querySelector('#taskview-chat-history');

        view._renderAssistantProgress(
            {
                type: 'assistant',
                task_status: 'running',
                message_id: 'message-bubble-streaming-patch',
                last_part_index: 0,
                streaming: true,
                last_part: {
                    type: 'reasoning',
                    text: '第一段'
                }
            },
            history
        );

        const bubble = view.querySelector('.reasoning-bubble') as HTMLElement;
        Object.defineProperty(bubble, 'scrollHeight', { value: 240, configurable: true });
        bubble.scrollTop = 0;

        view._renderAssistantProgress(
            {
                type: 'assistant',
                task_status: 'running',
                message_id: 'message-bubble-streaming-patch',
                last_part_index: 0,
                streaming: true,
                last_part: { type: 'reasoning', text: '第一段第二段' }
            },
            history
        );

        expect(view.querySelector('.reasoning-bubble')).toBe(bubble);
        expect(bubble.textContent).toContain('第一段第二段');
        expect(bubble.scrollTop).toBe(240);
    });

    test('reason display changes rerender mounted assistant output without reloading the task', () => {
        const view = createView();
        view.setAttribute('task_id', 'task-reason-display-switch');
        view.task_id = 'task-reason-display-switch';
        view.connectedCallback = () => {};
        view.disconnectedCallback = () => {};
        document.body.appendChild(view);
        view.innerHTML = view.renderAssistantMessage({
            message_id: 'message-reason-display-switch',
            content: [{ type: 'reasoning', rendered: '分析配置路径' }],
            timestamp: Date.now()
        });

        const messageContent = view.querySelector('#message-content-message-reason-display-switch');
        expect(view.querySelector('.od-assistant-output-flow')?.getAttribute('data-reason-display')).toBe('inline');

        onSettingChanged?.({
            locale: 'zh-CN',
            gui_config: { output_mode: 'minimal', gui_reason_display: 'bubble' }
        });

        expect(window.taskManagerAPI.getFullTask as jest.Mock).not.toHaveBeenCalled();
        expect(view.querySelector('#message-content-message-reason-display-switch')).toBe(messageContent);
        expect(view.querySelector('.od-assistant-output-flow')?.getAttribute('data-reason-display')).toBe('bubble');
        expect(view.querySelector('.reasoning-block-od .reasoning-bubble')).not.toBeNull();
        view.remove();
    });

    test('bubble reasoning keeps the mainline overlay styles inside expanded process containers', () => {
        expect(taskViewStyles).toMatch(
            /\.reasoning-bubble\{[^}]*position:absolute;[^}]*width:600px;[^}]*max-height:300px;/
        );
        expect(taskViewStyles).toMatch(/\.reasoning-bubble\.reasoning-bubble-hidden\{[^}]*opacity:0;/);
        // 过程块已不限高，bubble 浮层不再需要额外的展开态溢出覆盖。
        expect(taskViewStyles).not.toMatch(
            /\.od-assistant-output-flow\[data-reason-display='bubble'\]\.od-process-detail/
        );
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
        expect(view.querySelector('.od-running-status')?.textContent).toContain('正在 Tool10');
        expect(view.querySelector('.od-running-status')?.textContent).toContain('，');
        expect(view.querySelector('.od-running-status')?.textContent).not.toContain('echo 10');

        const runningStatus = view.querySelector('.od-running-status') as HTMLElement;
        expect(runningStatus.querySelector('.od-running-status-icon')).not.toBeNull();
        const toolIcon = runningStatus.querySelector('.od-running-status-tool-icon');
        expect(toolIcon?.tagName.toLowerCase()).toBe('svg');
        expect(toolIcon?.getAttribute('fill')).toBe('none');
        expect(toolIcon?.getAttribute('stroke')).toBe('currentColor');
        expect(toolIcon?.getAttribute('stroke-width')).toBe('1.8');
        expect(toolIcon?.querySelector('[transform]')).toBeNull();
        expect(toolIcon?.querySelectorAll('path')).toHaveLength(1);
        expect(toolIcon?.querySelector('path')?.getAttribute('d')).toBe(
            'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94L14.7 6.3z'
        );
        expect(runningStatus.querySelector('.od-running-status-icon')?.classList).toContain('is-tool');
        expect(runningStatus.querySelector('.od-running-status-viewport .od-running-status-text')).not.toBeNull();
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

    test('minimal running attention tool grows naturally so its QR code is not clipped', () => {
        const view = createView();
        const tools = toolPart(1, 1);
        tools.rendered = '<div class="qr-code">SCAN QR CODE</div>';
        tools.toolcalls[0] = {
            ...tools.toolcalls[0],
            status: 'running',
            requires_user_attention: true
        };

        view.innerHTML = view._renderAssistantOutputHtml([tools], {
            isRunning: true,
            messageId: 'message-attention'
        });

        expect(view.querySelector('.od-running-process-detail')).not.toBeNull();
        expect(view.querySelector('.od-running-process-detail .qr-code')?.textContent).toBe('SCAN QR CODE');
        // 过程块统一按内容实际高度铺开，注意力卡片无需再单独解除限高。
        expect(taskViewStyles).not.toMatch(/\.od-user-attention-process-detail/);
        expect(taskViewStyles).toMatch(/\.od-process-detail\{[^}]*display:none;/);
        expect(taskViewStyles).not.toMatch(/\.od-process-detail\{[^}]*max-height:/);
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
            '深度思考，调用了Tool1、Tool2等 10个工具'
        );
        expect(view.querySelector('[data-running-output-toggle]')?.getAttribute('aria-expanded')).toBe('false');
        const flow = view.querySelector('.od-assistant-output-flow') as HTMLElement;
        expect(flow.lastElementChild?.classList.contains('od-running-status')).toBe(true);
        expect(flow.lastElementChild?.textContent).toContain('正在 Tool20');
    });

    test('minimal running output stays collapsed while a tool call is still streaming its arguments', () => {
        const view = createView();
        const streamingTool = {
            type: 'tool_call',
            rendered: '<div class="mainline-tool-card" data-mainline-tool="call-0">正在解析参数…</div>',
            toolcalls: []
        };
        view.innerHTML = view._renderAssistantOutputHtml([streamingTool], {
            isRunning: true,
            messageId: 'message-streaming-tool-collapsed'
        });

        expect(view.querySelector('.od-running-process-detail')).toBeNull();
        expect(view.querySelector('[data-running-output-toggle]')?.getAttribute('aria-expanded')).toBe('false');
        expect(view.querySelector('.od-running-status')?.textContent).toContain('正在');
        expect(view.querySelector('.od-running-status')?.textContent).not.toContain('正在调用');
    });

    test('minimal reasoning status hides reasoning content from the current-operation row', () => {
        const view = createView();
        const reasoning = [{ type: 'reasoning', rendered: '这是一段不应出现在状态行中的详细思考内容' }];
        view.innerHTML = view._renderAssistantOutputHtml(reasoning, {
            isRunning: true,
            messageId: 'message-reasoning-status'
        });

        const status = view.querySelector('.od-running-status')?.textContent || '';
        expect(status).toContain('正在 深度思考');
        expect(status).not.toContain('详细思考内容');
        const icon = view.querySelector('.od-running-status-icon');
        expect(icon?.classList).toContain('is-thinking');
        const thinkingIcon = icon?.querySelector('.od-running-status-thinking-icon');
        expect(thinkingIcon?.tagName.toLowerCase()).toBe('svg');
        expect(thinkingIcon?.getAttribute('fill')).toBe('none');
        expect(thinkingIcon?.getAttribute('stroke')).toBe('currentColor');
        expect(thinkingIcon?.getAttribute('stroke-width')).toBe('1.8');
    });

    test('verbose running reasoning shows its full content without a duplicate thinking row', () => {
        onSettingChanged?.({ locale: 'zh-CN', gui_config: { output_mode: 'verbose' } });
        const view = createView();
        view.innerHTML = view._renderAssistantOutputHtml(
            [{ type: 'reasoning', rendered: '这是详细模式中正在输出的完整思考内容' }],
            {
                isRunning: true,
                messageId: 'message-verbose-reasoning'
            }
        );

        expect(view.querySelector('.reasoning-full-area')?.textContent).toContain('完整思考内容');
        expect(view.querySelector('.od-running-status')).toBeNull();
        expect(view.textContent).not.toContain('正在思考');
        expect(view.textContent).not.toContain('已思考');
    });

    test('verbose streaming reasoning keeps the expanded full text live during streaming', () => {
        onSettingChanged?.({ locale: 'zh-CN', gui_config: { output_mode: 'verbose', gui_reason_display: 'inline' } });
        const view = createView();
        view.innerHTML = view._renderAssistantOutputHtml([{ type: 'reasoning', text: '第一段思考', streaming: true }], {
            isRunning: true,
            messageId: 'message-verbose-reasoning-streaming'
        });

        const block = view.querySelector('.reasoning-block-od') as HTMLElement;
        expect(block.classList).toContain('reasoning-active');
        expect(block.classList).toContain('reasoning-expanded');
        const fullArea = view.querySelector('.reasoning-full-area') as HTMLElement;
        expect(fullArea).not.toBeNull();
        const fullContent = fullArea.querySelector('.reasoning-content') as HTMLElement;

        // 初始快照已携带部分文本：展开的全文区必须立即可见
        expect(fullContent.textContent).toBe('第一段思考');

        // 流式推进：与 _renderAssistantProgress 的增量补丁路径一致，
        // 展开的全文区必须随快照刷新而不是空白到 finalize 才回填
        TaskViewClass.updateReasoningPreview(block, '第一段思考，第二段思考');
        expect(fullContent.textContent).toBe('第一段思考，第二段思考');

        // 最终快照固化：finalize 后全文保持完整
        TaskViewClass.finalizeReasoningBlock(block);
        expect(fullContent.textContent).toBe('第一段思考，第二段思考');
    });

    test('running tool status uses the pushed display name without exposing parameters', () => {
        const view = createView();
        const fileTool = toolPart(1, 1);
        fileTool.toolcalls[0] = {
            ...fileTool.toolcalls[0],
            tool_name: 'filemgr-readFile',
            display_name: '读取文件'
        };
        view.innerHTML = view._renderAssistantOutputHtml([fileTool], {
            isRunning: true,
            messageId: 'message-mainline-running-tool'
        });

        const status = view.querySelector('.od-running-status')?.textContent || '';
        expect(status).toContain('正在 读取文件');
        expect(status).not.toContain('package.json');
    });

    test('tool parts do not invent a second card when mainline rendered HTML is unavailable', () => {
        const view = createView();
        const tools = toolPart(1, 1);
        tools.toolcalls[0] = {
            ...tools.toolcalls[0],
            tool_name: 'plugin-opaqueOperation'
        };
        view.innerHTML = view._renderAssistantOutputHtml([tools], {
            isRunning: false,
            messageId: 'message-tool-fallback'
        });

        expect(view.querySelector('.od-process-tool')).toBeNull();
        expect(view.textContent).not.toContain('plugin-opaqueOperation');
    });

    test('expanded process entries keep reasoning rows and mainline tool cards', () => {
        const view = createView();
        view.innerHTML = view._renderAssistantOutputHtml(transcript().slice(0, 2), {
            isRunning: true,
            messageId: 'message-process-detail',
            showRunningDetails: true
        });

        const reason = view.querySelector('.reasoning-block-od') as HTMLElement;
        expect(reason.querySelector('.reasoning-header')?.textContent?.trim()).toBe('深度思考');
        expect(reason.querySelector('.reasoning-content')?.textContent).toBe('分析现有结构');
        expect(reason.classList).toContain('reasoning-completed');

        expect(view.querySelector('.od-process-tool')).toBeNull();
        expect(view.querySelectorAll('.mainline-tool-card')).toHaveLength(10);

        expect(view.querySelector('.od-running-process-detail')).not.toBeNull();
        expect(view.querySelector('.od-process-summary')).toBeNull();
        expect(view.querySelector('[data-running-output-toggle]')?.nextElementSibling?.classList).toContain(
            'od-running-process-detail'
        );
    });

    test('process labels show reasoning and unique mainline tool names without reasoning content', () => {
        const view = createView();
        const fileTools = toolPart(1, 3);
        fileTools.toolcalls = [
            {
                ...fileTools.toolcalls[0],
                tool_name: 'filemgr-readFile',
                display_name: '读取文件'
            },
            {
                ...fileTools.toolcalls[1],
                tool_name: 'filemgr-readFile',
                display_name: '读取文件'
            },
            {
                ...fileTools.toolcalls[2],
                tool_name: 'filemgr-grepFiles',
                display_name: '内容搜索'
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
        expect(summary).toBe('深度思考，调用了读取文件、内容搜索等 3个工具');
        expect(summary).not.toContain('分析项目结构');
    });

    test('process labels use the pushed display names', () => {
        const view = createView();
        const tools = toolPart(1, 2);
        tools.toolcalls = [
            {
                ...tools.toolcalls[0],
                tool_name: 'filemgr-globFiles',
                display_name: '模式匹配'
            },
            {
                ...tools.toolcalls[1],
                tool_name: 'memory-addMemory',
                display_name: '添加记忆'
            }
        ];
        view.innerHTML = view._renderAssistantOutputHtml([{ type: 'reasoning', rendered: '分析请求。' }, tools], {
            isRunning: false,
            messageId: 'message-readable-skill-search-summary'
        });

        const summary = view.querySelector('.od-process-summary-text')?.textContent || '';
        expect(summary).toBe('深度思考，调用了模式匹配、添加记忆等 2个工具');
    });

    test('process labels fall back to protocol names when no display name is pushed', () => {
        const view = createView();
        const tools = toolPart(1, 2);
        tools.toolcalls = [
            {
                ...tools.toolcalls[0],
                tool_name: 'filemgr-globFiles'
            },
            {
                ...tools.toolcalls[1],
                tool_name: 'memory-addMemory'
            }
        ];
        view.innerHTML = view._renderAssistantOutputHtml([{ type: 'reasoning', rendered: '分析请求。' }, tools], {
            isRunning: false,
            messageId: 'message-self-described-display-name'
        });

        const summary = view.querySelector('.od-process-summary-text')?.textContent || '';
        // 分隔符改为逗号后总长 39 字符仍在 40 字符预算内，无需缩短到单个名字
        expect(summary).toBe('深度思考，调用了filemgr-glo…、memory-addM…等 2个工具');
    });

    test('running tool status uses the self-described literal display name', () => {
        const view = createView();
        const fileTool = toolPart(1, 1);
        fileTool.toolcalls[0] = {
            ...fileTool.toolcalls[0],
            tool_name: 'filemgr-readFile',
            display_name: '读取文件'
        };
        view.innerHTML = view._renderAssistantOutputHtml([fileTool], {
            isRunning: true,
            messageId: 'message-running-self-described-tool'
        });

        const status = view.querySelector('.od-running-status')?.textContent || '';
        expect(status).toContain('正在 读取文件');
    });

    test('running tool status shows the count of completed tool calls', () => {
        const view = createView();
        const doneTools = toolPart(1, 2);
        doneTools.toolcalls = [
            {
                ...doneTools.toolcalls[0],
                tool_name: 'filemgr-grepFiles',
                display_name: '内容搜索',
                status: 'success'
            },
            {
                ...doneTools.toolcalls[1],
                tool_name: 'filemgr-globFiles',
                display_name: '模式匹配',
                status: 'error'
            }
        ];
        const runningTool = toolPart(3, 1);
        runningTool.toolcalls[0] = {
            ...runningTool.toolcalls[0],
            tool_name: 'filemgr-readFile',
            display_name: '读取文件',
            status: 'running'
        };
        view.innerHTML = view._renderAssistantOutputHtml([doneTools, runningTool], {
            isRunning: true,
            messageId: 'message-running-tool-with-done-count'
        });

        const status = view.querySelector('.od-running-status')?.textContent || '';
        expect(status).toContain('正在 读取文件');
        expect(status).toContain('已调用 2 个工具');
    });

    test('running thinking status shows completed tool names and count', () => {
        const view = createView();
        const doneTools = toolPart(1, 2);
        doneTools.toolcalls = [
            {
                ...doneTools.toolcalls[0],
                tool_name: 'filemgr-grepFiles',
                display_name: '内容搜索',
                status: 'success'
            },
            {
                ...doneTools.toolcalls[1],
                tool_name: 'filemgr-globFiles',
                display_name: '模式匹配',
                status: 'success'
            }
        ];
        const reasoning = { type: 'reasoning', rendered: '分析请求。' };
        view.innerHTML = view._renderAssistantOutputHtml([doneTools, reasoning], {
            isRunning: true,
            messageId: 'message-running-thinking-with-done-count'
        });

        const status = view.querySelector('.od-running-status')?.textContent || '';
        expect(status).toContain('正在 深度思考');
        expect(status).toContain('已调用 内容搜索、模式匹配 等 2 个工具');
    });

    test('running status without any completed tool call keeps the plain action', () => {
        const view = createView();
        const reasoning = { type: 'reasoning', rendered: '分析请求。' };
        view.innerHTML = view._renderAssistantOutputHtml([reasoning], {
            isRunning: true,
            messageId: 'message-running-no-done-tools'
        });

        const status = view.querySelector('.od-running-status')?.textContent?.replace(/\s+/g, ' ').trim() || '';
        expect(status).toBe('正在 深度思考 (已思考 0 秒)');
    });

    test('running tool status counts only the current tool block after a body boundary', () => {
        const view = createView();
        const earlierDone = toolPart(1, 2);
        earlierDone.toolcalls = [
            {
                ...earlierDone.toolcalls[0],
                tool_name: 'filemgr-grepFiles',
                display_name: '内容搜索',
                status: 'success'
            },
            {
                ...earlierDone.toolcalls[1],
                tool_name: 'filemgr-globFiles',
                display_name: '模式匹配',
                status: 'success'
            }
        ];
        const body = { type: 'text', text: '第一部分完成。' };
        const currentDone = toolPart(3, 1);
        currentDone.toolcalls[0] = {
            ...currentDone.toolcalls[0],
            tool_name: 'filemgr-extractText',
            display_name: '提取文本',
            status: 'success'
        };
        const runningTool = toolPart(4, 1);
        runningTool.toolcalls[0] = {
            ...runningTool.toolcalls[0],
            tool_name: 'filemgr-readFile',
            display_name: '读取文件',
            status: 'running'
        };
        view.innerHTML = view._renderAssistantOutputHtml([earlierDone, body, currentDone, runningTool], {
            isRunning: true,
            messageId: 'message-running-block-count'
        });

        const status = view.querySelector('.od-running-status')?.textContent || '';
        expect(status).toContain('正在 读取文件');
        expect(status).toContain('已调用 1 个工具');
        expect(status).not.toContain('内容搜索');
        expect(status).not.toContain('模式匹配');
    });

    test('status row renders label and current target as separate fade segments', () => {
        const view = createView();
        const doneTools = toolPart(1, 2);
        doneTools.toolcalls = [
            {
                ...doneTools.toolcalls[0],
                tool_name: 'filemgr-grepFiles',
                display_name: '内容搜索',
                status: 'success'
            },
            {
                ...doneTools.toolcalls[1],
                tool_name: 'filemgr-globFiles',
                display_name: '模式匹配',
                status: 'success'
            }
        ];
        const runningTool = toolPart(3, 1);
        runningTool.toolcalls[0] = {
            ...runningTool.toolcalls[0],
            tool_name: 'filemgr-readFile',
            display_name: '读取文件',
            status: 'running'
        };
        view.innerHTML = view._renderAssistantOutputHtml([doneTools, runningTool], {
            isRunning: true,
            messageId: 'message-status-segments'
        });

        const status = view.querySelector('.od-running-status')?.textContent?.replace(/\s+/g, ' ').trim() || '';
        expect(status).toBe('正在 读取文件，已调用 2 个工具');
        const label = view.querySelector('.od-running-status-label');
        const target = view.querySelector('.od-running-status-target');
        const done = view.querySelector('.od-running-status-done');
        expect(label?.classList.contains('od-running-status-fade--static')).toBe(true);
        expect(target?.classList.contains('od-running-status-fade--static')).toBe(false);
        expect(done?.classList.contains('od-running-status-fade--static')).toBe(false);
        // 分隔符不属于任何动画段，避免标点随文案一起淡入
        expect(label?.textContent?.trim()).toBe('正在');
        expect(target?.textContent?.trim()).toBe('读取文件');
        expect(done?.textContent?.trim()).toBe('已调用 2 个工具');
    });

    test('running status highlights verb and tool name as inline code', () => {
        const view = createView();
        const runningTool = toolPart(1, 1);
        runningTool.toolcalls[0] = {
            ...runningTool.toolcalls[0],
            tool_name: 'filemgr-readFile',
            display_name: '读取文件',
            status: 'running'
        };
        view.innerHTML = view._renderAssistantOutputHtml([runningTool], {
            isRunning: true,
            messageId: 'message-status-code-highlight'
        });

        // 动词"正在"保持普通文本，仅工具名包一层 code 呈现高亮
        const label = view.querySelector('.od-running-status-label');
        const target = view.querySelector('.od-running-status-target');
        expect(label?.querySelector('code')).toBeNull();
        expect(label?.textContent?.trim()).toBe('正在');
        expect(target?.querySelector('code')?.textContent).toBe('读取文件');
    });

    test('thinking status shows verb prefix and highlighted keyword like the tool status', () => {
        const view = createView();
        const parts = [{ type: 'reasoning', rendered: '分析请求。' }];
        view.innerHTML = view._renderAssistantOutputHtml(parts, {
            isRunning: true,
            messageId: 'message-status-code-highlight-thinking'
        });

        // 思考态与工具态同构："正在"为普通文本，"深度思考"用 code 高亮，中间以空格分隔
        const label = view.querySelector('.od-running-status-label');
        const target = view.querySelector('.od-running-status-target');
        expect(label?.querySelector('code')).toBeNull();
        expect(label?.textContent?.trim()).toBe('正在');
        expect(target?.querySelector('code')?.textContent).toBe('深度思考');
    });

    test('thinking status appends elapsed time as plain text after the keyword', () => {
        const view = createView();
        const start = Date.now() - 95000; // 1 分 35 秒前开始思考
        view._reasoningStatusStartByMessage = new Map([['message-status-thinking-time', start]]);
        const parts = [{ type: 'reasoning', rendered: '分析请求。' }];
        view.innerHTML = view._renderAssistantOutputHtml(parts, {
            isRunning: true,
            messageId: 'message-status-thinking-time'
        });

        const status = view.querySelector('.od-running-status')?.textContent || '';
        expect(status).toContain('正在 深度思考');
        expect(status).toContain('(已思考 1 分 35 秒)');
        // 时间不属于高亮段：code 元素不包含时间文案
        const codeTexts = Array.from(view.querySelectorAll('.od-running-status code'))
            .map((el) => el.textContent)
            .join('|');
        expect(codeTexts).not.toContain('已思考');
        // 时间位于独立纯文本分段
        const time = view.querySelector('.od-running-status-time');
        expect(time?.querySelector('code')).toBeNull();
        expect(time?.textContent?.trim()).toBe('(已思考 1 分 35 秒)');
    });

    test('thinking status elapsed time persists across re-renders and never replays fade', () => {
        const view = createView();
        const messageId = 'message-status-thinking-time-persist';
        view._reasoningStatusStartByMessage = new Map([[messageId, Date.now() - 5000]]);
        const parts = [{ type: 'reasoning', rendered: '分析请求。' }];
        const options = { isRunning: true, messageId };
        view.innerHTML = view._renderAssistantOutputHtml(parts, options);

        const time = view.querySelector('.od-running-status-time');
        expect(time?.textContent?.trim()).toBe('(已思考 5 秒)');
        // 首次渲染时间段正常淡入
        expect(time?.classList.contains('od-running-status-fade--static')).toBe(false);

        view.innerHTML = view._renderAssistantOutputHtml(parts, options);
        const nextTime = view.querySelector('.od-running-status-time');
        // 时间起点持久化：重渲染不重置为 0 秒
        expect(nextTime?.textContent?.trim()).toBe('(已思考 5 秒)');
        // 时间每秒变化，后续渲染静默更新，不重播淡入
        expect(nextTime?.classList.contains('od-running-status-fade--static')).toBe(true);
    });

    test('switching to a tool call resets the thinking elapsed timer', () => {
        const view = createView();
        const messageId = 'message-status-thinking-time-reset';
        const parts = [{ type: 'reasoning', rendered: '分析请求。' }];
        view.innerHTML = view._renderAssistantOutputHtml(parts, { isRunning: true, messageId });
        expect(view._reasoningStatusStartByMessage?.get(messageId)).toBeTruthy();

        view.innerHTML = view._renderAssistantOutputHtml([toolPart(1, 1)], { isRunning: true, messageId });
        expect(view._reasoningStatusStartByMessage?.has(messageId)).toBe(false);
    });

    test('running status time ticks every second while the view is connected', () => {
        jest.useFakeTimers();
        try {
            const view = createView();
            // linkedom 环境无法完整挂载视图（MutationObserver 支持不完整），
            // 用属性覆盖模拟已连接状态，直接驱动秒级刷新逻辑
            Object.defineProperty(view, 'isConnected', { value: true, configurable: true });
            const messageId = 'message-status-thinking-tick';
            view._reasoningStatusStartByMessage = new Map([[messageId, Date.now() - 3000]]);
            view.innerHTML = view._renderAssistantOutputHtml([{ type: 'reasoning', rendered: '分析请求。' }], {
                isRunning: true,
                messageId
            });
            view._syncRunningStatusTimeTicker();

            const time = view.querySelector('.od-running-status-time');
            expect(time?.textContent?.trim()).toBe('(已思考 3 秒)');
            jest.advanceTimersByTime(1000);
            expect(time?.textContent?.trim()).toBe('(已思考 4 秒)');
        } finally {
            jest.useRealTimers();
            for (const view of createdViews.splice(0)) {
                view._stopRunningStatusTimeTicker();
            }
        }
    });

    test('status row code segments only apply the markdown inline code text color', () => {
        const codeRule = taskViewStyles.match(/\.od-running-status-targetcode\{[^}]*\}/);
        expect(codeRule).not.toBeNull();
        expect(codeRule?.[0]).toContain('color:var(--chat-accent)');
        // 对齐修复：code 继承两侧文本字体，避免等宽字形与 UI 字体的基线/宽度错位
        expect(codeRule?.[0]).toContain('font-family:inherit');
        // 只改字体颜色：不得引入行内代码的字号或背景
        expect(codeRule?.[0]).not.toContain('font-size');
        expect(codeRule?.[0]).not.toContain('background');
    });

    test('status row keeps thinking label static while only the done count fades on change', () => {
        const view = createView();
        const doneTools = toolPart(1, 1);
        doneTools.toolcalls[0] = {
            ...doneTools.toolcalls[0],
            tool_name: 'filemgr-grepFiles',
            display_name: '内容搜索',
            status: 'success'
        };
        const options = { isRunning: true, messageId: 'message-thinking-fade' };
        view.innerHTML = view._renderAssistantOutputHtml(
            [doneTools, { type: 'reasoning', rendered: '分析请求。' }],
            options
        );

        const label = view.querySelector('.od-running-status-label');
        const done = view.querySelector('.od-running-status-done');
        expect(label?.textContent?.trim()).toBe('正在');
        expect(label?.classList.contains('od-running-status-fade--static')).toBe(true);
        expect(done?.textContent?.trim()).toBe('已调用 内容搜索 等 1 个工具');
        expect(done?.classList.contains('od-running-status-fade--static')).toBe(false);

        // 计数增长：label 静止，done 段重播淡入
        const secondTool = toolPart(2, 1);
        secondTool.toolcalls[0] = {
            ...secondTool.toolcalls[0],
            tool_name: 'filemgr-globFiles',
            display_name: '模式匹配',
            status: 'success'
        };
        view.innerHTML = view._renderAssistantOutputHtml(
            [doneTools, secondTool, { type: 'reasoning', rendered: '分析请求。' }],
            options
        );
        const nextLabel = view.querySelector('.od-running-status-label');
        const nextDone = view.querySelector('.od-running-status-done');
        expect(nextLabel?.classList.contains('od-running-status-fade--static')).toBe(true);
        expect(nextDone?.textContent?.trim()).toBe('已调用 模式匹配、内容搜索 等 2 个工具');
        expect(nextDone?.classList.contains('od-running-status-fade--static')).toBe(false);
    });

    test('status row suppresses fade only when the target text is unchanged', () => {
        const view = createView();
        const parts = [{ type: 'reasoning', rendered: '分析请求。' }];
        const options = { isRunning: true, messageId: 'message-target-unchanged' };
        view.innerHTML = view._renderAssistantOutputHtml(parts, options);
        // 思考状态与工具状态同构：label 为动词，target 为高亮关键词
        expect(view.querySelector('.od-running-status-target')?.querySelector('code')?.textContent).toBe('深度思考');
        expect(
            view.querySelector('.od-running-status-label')?.classList.contains('od-running-status-fade--static')
        ).toBe(true);
        expect(view.querySelector('.od-running-status-done')).toBeNull();

        // 同一段思考的流式快照：状态不变，label 保持静态
        view.innerHTML = view._renderAssistantOutputHtml(parts, options);
        expect(
            view.querySelector('.od-running-status-label')?.classList.contains('od-running-status-fade--static')
        ).toBe(true);

        // 状态切换为工具执行：label（"正在"）文案未变化保持静止，仅 target 作为新内容淡入
        view.innerHTML = view._renderAssistantOutputHtml([toolPart(1, 1)], options);
        expect(
            view.querySelector('.od-running-status-label')?.classList.contains('od-running-status-fade--static')
        ).toBe(true);
        expect(
            view.querySelector('.od-running-status-target')?.classList.contains('od-running-status-fade--static')
        ).toBe(false);
    });

    test('status fade uses a gentle opacity-only animation without vertical motion', () => {
        expect(taskViewStyles).not.toContain('od-status-page-in');
        expect(taskViewStyles).not.toContain('.od-running-status-line{');
        expect(taskViewStyles).toContain('@keyframesod-status-fade-in{0%{opacity:0;}100%{opacity:1;}}');
        expect(taskViewStyles).toMatch(
            /\.od-running-status-fade\{[^}]*animation:od-status-fade-in220msease-in-out;[^}]*\}/
        );
        expect(taskViewStyles).not.toMatch(/\.od-running-status-fade\{[^}]*transform/);
        expect(taskViewStyles).toMatch(/\.od-running-status-fade--static\{animation:none;\}/);
        expect(taskViewStyles).toMatch(
            /@media\(prefers-reduced-motion:reduce\)\{[^@]*\.od-running-status-fade\{animation:none;[^}]*\}/
        );
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
        expect(view.querySelector('.od-process-tool-status')).toBeNull();
    });

    test('verbose running output shows tool cards without a duplicate running status row', () => {
        onSettingChanged?.({ locale: 'zh-CN', gui_config: { output_mode: 'verbose' } });
        const view = createView();
        const doneTools = toolPart(1, 2);
        const runningTool = toolPart(3, 1);
        runningTool.toolcalls[0] = { ...runningTool.toolcalls[0], status: 'running' };
        view.innerHTML = view._renderAssistantOutputHtml([doneTools, runningTool], {
            isRunning: true,
            messageId: 'message-verbose-running-tools'
        });

        // 详细模式下每个工具都有自己的卡片，"正在 xx"状态行与卡片内容重复，不再渲染
        expect(view.querySelector('.od-running-status')).toBeNull();
        expect(view.textContent).not.toContain('正在 Tool3');
        expect(view.querySelectorAll('.od-process-segment')).toHaveLength(1);
    });

    test('process labels preserve the protocol name instead of using reasoning or parameters', () => {
        const view = createView();
        const browserTool = toolPart(1, 1);
        browserTool.toolcalls[0] = {
            ...browserTool.toolcalls[0],
            tool_name: 'webFetch'
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
        expect(summary).toBe('深度思考，调用了webFetch等 1个工具');
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
        expect(summary).toBe('深度思考，调用了very-long-s…等 4个工具');
    });

    test('process details reuse mainline reasoning and tool card classes', () => {
        expect(taskViewStyles).toMatch(/\.reasoning-block-od\.reasoning-full-area\{[^}]*display:none;/);
        expect(taskViewStyles).not.toContain('.od-process-tool{');
        expect(taskViewStyles).not.toContain('.od-process-entry-detail{');
    });

    test('process typography and row spacing stay compact', () => {
        expect(taskViewStyles).toMatch(
            /\.od-process-main-icon\{[^}]*width:14px;[^}]*height:14px;[^}]*color:var\(--od-text-muted\);/
        );
        expect(taskViewStyles).toMatch(
            /\.od-process-chevron\{[^}]*display:inline-flex;[^}]*width:14px;[^}]*height:14px;/
        );
        expect(taskViewStyles).toMatch(
            /\.od-completed-process-chevron\{[^}]*display:inline-flex;[^}]*width:14px;[^}]*height:14px;/
        );
        expect(taskViewStyles).toMatch(/\.reasoning-block-od\.reasoning-header\{[^}]*list-style:none;/);
        expect(taskViewStyles).toMatch(/\.od-process-segment\{[^}]*margin-bottom:0;/);
        expect(taskViewStyles).toMatch(/\.od-stage-body\{[^}]*margin:04px;/);
        expect(taskViewStyles).toMatch(
            /\.od-running-status-icon\{[^}]*display:flex;[^}]*align-items:center;[^}]*line-height:1;/
        );
        expect(taskViewStyles).toMatch(/\.od-running-status-icon\.is-thinking\{[^}]*color:#f59e0b;/);
        expect(taskViewStyles).toMatch(/\.od-running-status-icon\.is-tool\{[^}]*color:#f59e0b;/);
    });

    test('process summary and running status rows share one row metric', () => {
        // 阶段摘要行与"正在调用"运行状态行必须共用同一行规范，
        // 否则运行中的最新一轮会出现工具行与上下文本间距不一致（5px vs 8px）。
        expect(taskViewStyles).toMatch(/\.od-process-summary\{[^}]*min-height:var\(--od-process-row-min-height\);/);
        expect(taskViewStyles).toMatch(/\.od-running-status\{[^}]*min-height:var\(--od-process-row-min-height\);/);
        expect(taskViewStyles).toMatch(/\.od-running-status\{[^}]*padding:var\(--od-process-row-pad-block\)0;/);
        expect(taskViewStyles).toMatch(
            /\.od-assistant-output-flow\{[^}]*--od-process-row-min-height:28px;[^}]*--od-process-row-pad-block:3px;/
        );
        // 运行状态行的滚动视口高度跟随行规范收缩，保证文本垂直居中后与摘要行留白一致
        expect(taskViewStyles).toMatch(/\.od-running-status-viewport\{[^}]*height:22px;/);
    });

    test('streaming stage body zeroes first/last child margins to match completed output spacing', () => {
        // 运行态流式正文包在 .od-streaming-text wrapper 内，markdown-body 的
        // 直接子元素清零规则覆盖不到内部块；缺失时运行态段落顶部残留
        // .markdown-body p 的 margin-top（13px 字号下实测 6.5px），导致摘要行
        // 上下间距与已完成 turn 不对称。
        expect(taskViewStyles).toMatch(
            /task-view\.markdown-body>\.od-streaming-text>\*:first-child\{margin-top:0!important;\}/
        );
        expect(taskViewStyles).toMatch(
            /task-view\.markdown-body>\.od-streaming-text>\*:last-child\{margin-bottom:0!important;\}/
        );
    });

    test('expanded process blocks grow to their content height without an outer scroller', () => {
        expect(taskViewStyles).toMatch(
            /\.od-completed-process-detail\.is-open\{[^}]*display:block;[^}]*max-height:none;[^}]*overflow:visible;/
        );
        expect(taskViewStyles).not.toMatch(/\.od-completed-process-detail\{[^}]*max-height:/);
        expect(taskViewStyles).toMatch(
            /\.od-process-segment\{[^}]*overflow:visible;[^}]*background:transparent;[^}]*border:0;[^}]*border-radius:0;/
        );
        expect(taskViewStyles).toMatch(
            /\.od-process-summary\{[^}]*min-height:var\(--od-process-row-min-height\);[^}]*padding:var\(--od-process-row-pad-block\)0;[^}]*border-bottom:0;[^}]*border-radius:0;/
        );
        expect(taskViewStyles).not.toContain(".od-process-summary[aria-expanded='true']{border-bottom-color:");
        // 展开层不再自建滚动区：限高与滚动条样式全部下沉到卡片自身。
        expect(taskViewStyles).toMatch(/\.od-process-detail\{[^}]*margin:0;/);
        expect(taskViewStyles).not.toMatch(/\.od-process-detail\{[^}]*max-height:/);
        expect(taskViewStyles).not.toMatch(/\.od-process-detail\{[^}]*overflow-y:/);
        expect(taskViewStyles).not.toMatch(/\.od-process-detail\{[^}]*scrollbar-gutter:/);
        expect(taskViewStyles).not.toContain('.od-process-detail::-webkit-scrollbar');
        expect(taskViewStyles).not.toContain("html[data-theme='dark'] .od-process-detail");
    });

    test('GUI output does not maintain a message-level timer', () => {
        const view = createView();
        expect(view._assistantRunStartedAt).toBeUndefined();
    });

    test('process blocks no longer nest a scroller, so wheel gestures fall through to the chat history', () => {
        expect(taskViewStyles).not.toMatch(/\.od-process-detail\{[^}]*overscroll-behavior:/);
        expect(taskViewStyles).not.toMatch(/\.od-process-detail\{[^}]*overflow-y:auto;/);
    });

    test('running status labels exist in both locales', () => {
        expect(zhCn['renderer.taskview.output.status.thinkingPrefix']).toBe('正在');
        expect(zhCn['renderer.taskview.output.status.thinkingKeyword']).toBe('深度思考');
        expect(zhCn['renderer.taskview.output.status.toolPrefix']).toBe('正在');
        expect(zhCn['renderer.taskview.output.status.tool']).toBe('${name}');
        expect(enUs['renderer.taskview.output.status.thinkingPrefix']).toBe('Running');
        expect(enUs['renderer.taskview.output.status.thinkingKeyword']).toBe('deep thinking');
        expect(enUs['renderer.taskview.output.status.toolPrefix']).toBe('Running');
        expect(enUs['renderer.taskview.output.status.tool']).toBe('${name}');
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

    test('minimal running output preserves a manually expanded reasoning block while streaming', () => {
        const view = createView();
        view.task_id = 'task-1';
        view.innerHTML = '<div id="taskview-chat-history"></div>';
        view.handleAssistantReplace({
            task_status: 'running',
            message_id: 'message-reasoning-expanded',
            parts: [{ type: 'reasoning', rendered: '第一段思考' }]
        });

        const runningStatus = view.querySelector('[data-running-output-toggle]') as HTMLElement;
        view._handleProcessToggleClick({ target: runningStatus, preventDefault() {}, stopPropagation() {} });
        const reasoningHeader = view.querySelector('.reasoning-block-od .reasoning-header') as HTMLElement;
        view._handleReasoningToggleClick({ target: reasoningHeader, preventDefault() {}, stopPropagation() {} });
        expect(view.querySelector('.reasoning-block-od')?.classList).toContain('reasoning-expanded');

        view._renderAssistantProgress(
            {
                type: 'assistant',
                task_status: 'running',
                message_id: 'message-reasoning-expanded',
                last_part_index: 1,
                streaming: true,
                last_part: { type: 'text', text: '阶段正文', rendered: '<p>阶段正文</p>' }
            },
            view.querySelector('#taskview-chat-history')
        );

        expect(view.querySelector('.reasoning-block-od')?.classList).toContain('reasoning-expanded');
        expect(view.querySelector('.reasoning-full-area')?.textContent).toContain('第一段思考');
    });

    test('minimal running output preserves a pinned reasoning bubble while streaming', () => {
        onSettingChanged?.({
            locale: 'zh-CN',
            gui_config: { output_mode: 'minimal', gui_reason_display: 'bubble' }
        });
        const view = createView();
        view.task_id = 'task-1';
        view.innerHTML = '<div id="taskview-chat-history"></div>';
        view.handleAssistantReplace({
            task_status: 'running',
            message_id: 'message-reasoning-pinned',
            parts: [{ type: 'reasoning', rendered: '第一段思考' }]
        });

        const runningStatus = view.querySelector('[data-running-output-toggle]') as HTMLElement;
        view._handleProcessToggleClick({ target: runningStatus, preventDefault() {}, stopPropagation() {} });
        const reasoningHeader = view.querySelector('.reasoning-block-od .reasoning-header') as HTMLElement;
        view._handleReasoningToggleClick({ target: reasoningHeader, preventDefault() {}, stopPropagation() {} });
        expect(view.querySelector('.reasoning-block-od')?.classList).toContain('reasoning-bubble-pinned');

        view.handleAssistantReplace({
            task_status: 'running',
            message_id: 'message-reasoning-pinned',
            parts: [
                { type: 'reasoning', rendered: '第一段思考' },
                { type: 'text', rendered: '<p>阶段正文</p>' },
                toolPart(1, 1)
            ]
        });

        expect(view.querySelector('.reasoning-block-od')?.classList).toContain('reasoning-bubble-pinned');
        expect(view.querySelector('.reasoning-bubble')?.classList).not.toContain('reasoning-bubble-hidden');
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
        expect(flow.lastElementChild?.textContent).toContain('正在 Tool1');
    });

    test('streaming text snapshots render safe Markdown in one stable part without rebuilding the assistant output', () => {
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
                    text: '**hello**'
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
                    text: '**hello**\n\n- world'
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

    test('hidden history replaces the current streaming part with the latest snapshot', () => {
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
                text: 'hello world'
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
            ]
        });

        view._renderAssistantProgress(
            {
                type: 'assistant',
                task_status: 'running',
                message_id: 'message-terminal',
                last_part_index: 1,
                streaming: true,
                last_part: { type: 'text', text: 'complete stale' }
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
                    text: '## 最终'
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
                    }
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
                last_part: { type: 'text', text: '最终回复', rendered: '<p>最终回复</p>' }
            }
        ];

        updates.forEach((progress) => view._deferTaskUpdateDuringReload(progress));
        view._flushDeferredTaskUpdates();
        expect(history.children).toHaveLength(0);

        view._reloading = false;
        view._flushDeferredTaskUpdates();

        expect(view.querySelector('.od-final-result')?.textContent).toContain('最终回复');
        const completedToggle = view.querySelector('[data-completed-process-toggle]') as HTMLElement;
        expect(completedToggle?.textContent).toContain('查看过程');
        view._handleProcessToggleClick({ target: completedToggle, preventDefault() {}, stopPropagation() {} });
        expect(view.querySelector('.od-completed-process-detail')?.textContent).toContain('中间结论');
    });

    test('collapsing a process hides the mainline reasoning and tool cards together', () => {
        onSettingChanged?.({ locale: 'zh-CN', gui_config: { output_mode: 'verbose' } });
        const view = createView();
        view.innerHTML = view.renderAssistantMessage({
            message_id: 'message-3',
            content: transcript().slice(0, 3),
            timestamp: Date.now()
        });
        const process = view.querySelector('.od-process-segment') as HTMLElement;
        expect(process.querySelector('.reasoning-block-od')).not.toBeNull();
        expect(process.querySelectorAll('.mainline-tool-card')).toHaveLength(10);

        // 详细模式过程段没有可折叠头，卡片始终随内容铺开展示
        expect(process.querySelector('[data-process-toggle]')).toBeNull();
        expect(process.querySelector('.od-process-detail')?.classList).toContain('is-open');
    });

    test('minimal mode collapses terminal tool cards inside an expanded process block', () => {
        const view = createView();
        view.innerHTML = view.renderAssistantMessage({
            message_id: 'message-terminal-collapsed',
            content: [terminalToolPart(['tc-1', 'tc-2']), { type: 'text', rendered: '<p>最终正文</p>' }],
            timestamp: Date.now()
        });

        const completedToggle = view.querySelector('[data-completed-process-toggle]') as HTMLElement;
        view._handleProcessToggleClick({ target: completedToggle, preventDefault() {}, stopPropagation() {} });
        const processToggle = view.querySelector('[data-process-toggle]') as HTMLElement;
        view._handleProcessToggleClick({ target: processToggle, preventDefault() {}, stopPropagation() {} });

        const detail = view.querySelector('.od-process-detail') as HTMLElement;
        expect(detail.classList).toContain('is-open');
        const cards = detail.querySelectorAll('details.terminal-tool');
        expect(cards).toHaveLength(2);
        cards.forEach((card) => expect(card.hasAttribute('open')).toBe(false));
    });

    test('verbose mode keeps terminal tool cards expanded by default', () => {
        onSettingChanged?.({ locale: 'zh-CN', gui_config: { output_mode: 'verbose' } });
        const view = createView();
        view.innerHTML = view._renderAssistantOutputHtml([terminalToolPart(['tc-1', 'tc-2'])], {
            isRunning: false,
            messageId: 'message-terminal-verbose'
        });

        const cards = view.querySelectorAll('details.terminal-tool');
        expect(cards).toHaveLength(2);
        cards.forEach((card) => expect(card.hasAttribute('open')).toBe(true));
    });

    test('a manually expanded terminal card survives the re-render of its message', () => {
        const view = createView();
        const parts = [terminalToolPart(['tc-1', 'tc-2'])];
        const render = (disclosureState?: Map<string, boolean>) =>
            view._renderAssistantOutputHtml(parts, {
                isRunning: true,
                messageId: 'message-terminal-disclosure',
                showRunningDetails: true,
                disclosureState
            });
        view.innerHTML = render();

        const cards = view.querySelectorAll('details.terminal-tool');
        expect(cards).toHaveLength(2);
        (cards[1] as HTMLDetailsElement).open = true;

        // 流式快照重渲染：用户展开的卡片保持展开，另一张仍按模式默认值收起。
        view.innerHTML = render(view._captureProcessDisclosureState(view));

        const rerendered = view.querySelectorAll('details.terminal-tool');
        expect(rerendered).toHaveLength(2);
        expect((rerendered[0] as HTMLDetailsElement).hasAttribute('open')).toBe(false);
        expect((rerendered[1] as HTMLDetailsElement).hasAttribute('open')).toBe(true);
    });

    test('terminal card disclosure rewriting only touches terminal tool tags', () => {
        const html =
            terminalCardHtml('tc-1') +
            '<details class="file-tool-card" open><summary>file</summary><div>body</div></details>' +
            '<div class="text-open">open</div>';

        const collapsed = TaskViewClass._applyTerminalCardDisclosure(html, undefined, 'message-x', 0);
        expect(collapsed).toContain(
            '<details data-toolcall-id="tc-1" class="terminal-tool od-card-shadow"' +
                ' data-terminal-card-key="message-x-terminal-card-0-0">'
        );
        expect(collapsed).toContain('<details class="file-tool-card" open>');
        expect(collapsed).toContain('<div class="text-open">open</div>');
        expect(collapsed).not.toContain('terminal-tool od-card-shadow" open');
    });

    test('terminal card keys stay stable per part and card position', () => {
        const html = terminalCardHtml('tc-1') + terminalCardHtml('tc-2');
        const keys = (source: string) =>
            Array.from(source.matchAll(/data-terminal-card-key="([^"]*)"/g)).map((match) => match[1]);

        expect(keys(TaskViewClass._applyTerminalCardDisclosure(html, undefined, 'm1', 3))).toEqual([
            'm1-terminal-card-3-0',
            'm1-terminal-card-3-1'
        ]);
        // 输出内容变化后 key 不变，用户手动展开的卡片不会在流式刷新中串位。
        expect(
            keys(TaskViewClass._applyTerminalCardDisclosure(terminalCardHtml('tc-1', 'more'), undefined, 'm1', 3))
        ).toEqual(['m1-terminal-card-3-0']);
    });

    test('completed minimal output renders a stale streaming reasoning part as completed without a live timer', () => {
        const view = createView();
        view.innerHTML = view._renderAssistantOutputHtml(
            [
                { type: 'reasoning', rendered: '残留流式标记的思考', streaming: true },
                { type: 'text', text: '最终回复', rendered: '<p>最终回复</p>' }
            ],
            { isRunning: false, messageId: 'message-completed-stale-streaming' }
        );

        const reason = view.querySelector('.od-completed-process-detail .reasoning-block-od') as HTMLElement;
        expect(reason).not.toBeNull();
        expect(reason.classList).toContain('reasoning-completed');
        expect(reason.classList).not.toContain('reasoning-active');
        expect(reason.hasAttribute('data-reasoning-start')).toBe(false);
        expect(reason.querySelector('.reasoning-time')?.textContent ?? '').not.toMatch(/已思考/);

        // 展开详情重新渲染也保持 completed，不会因为 disclosure 重建重新启动计时。
        const completedToggle = view.querySelector('[data-completed-process-toggle]') as HTMLElement;
        view._handleProcessToggleClick({ target: completedToggle, preventDefault() {}, stopPropagation() {} });
        const reopened = view.querySelector('.od-completed-process-detail .reasoning-block-od') as HTMLElement;
        expect(reopened.classList).toContain('reasoning-completed');
        expect(reopened.classList).not.toContain('reasoning-active');
        expect(reopened.hasAttribute('data-reasoning-start')).toBe(false);
    });

    test('running minimal reasoning details keep the streaming state and live timer', () => {
        const view = createView();
        view.innerHTML = view._renderAssistantOutputHtml(
            [{ type: 'reasoning', rendered: '正在思考', streaming: true }],
            { isRunning: true, messageId: 'message-running-reasoning-detail', showRunningDetails: true }
        );

        const reason = view.querySelector('.od-running-process-detail .reasoning-block-od') as HTMLElement;
        expect(reason).not.toBeNull();
        expect(reason.classList).toContain('reasoning-active');
        expect(reason.hasAttribute('data-reasoning-start')).toBe(true);
    });

    test('a non-streaming snapshot freezes the finished reasoning block and its timer', () => {
        onSettingChanged?.({
            locale: 'zh-CN',
            gui_config: { output_mode: 'verbose', gui_reason_display: 'inline' }
        });
        const view = createView();
        view.task_id = 'task-freeze-timer';
        view.innerHTML = '<div id="taskview-chat-history"></div>';
        const history = view.querySelector('#taskview-chat-history');

        // part 0：思考块流式中
        view._renderAssistantProgress(
            {
                type: 'assistant',
                task_status: 'running',
                message_id: 'message-freeze-timer',
                last_part_index: 0,
                streaming: true,
                last_part: { type: 'reasoning', text: '第一段思考' }
            },
            history
        );
        const liveBlock = view.querySelector('.reasoning-block-od') as HTMLElement;
        expect(liveBlock.classList).toContain('reasoning-active');
        // 视图未挂载时 _syncReasoningTimers 因 isConnected 短路（与既有测试约定一致），
        // 这里手动等价调用模拟已挂载视图的流式同步，启动每秒计时器。
        TaskViewClass.updateReasoningPreview(liveBlock, '第一段思考');
        expect(liveBlock._reasoningTimeInterval).not.toBeNull();

        // part 0 结束：主进程发送非流式最终快照（streaming 标志消失，携带固化耗时）
        view._renderAssistantProgress(
            {
                type: 'assistant',
                task_status: 'running',
                message_id: 'message-freeze-timer',
                last_part_index: 0,
                last_part: { type: 'reasoning', rendered: '第一段思考', elapsedSeconds: 14 }
            },
            history
        );
        // 完成态渲染与活跃态 class 不同，morph 前先 finalize 活跃块：
        // 节点（无论被替换还是原地保留）必须定格为 completed 并显示固化耗时，
        // 旧节点的每秒计时器必须被清理。
        const frozenBlock = view.querySelector('.reasoning-block-od') as HTMLElement;
        expect(frozenBlock.classList).toContain('reasoning-completed');
        expect(view.querySelectorAll('.reasoning-block-od.reasoning-active')).toHaveLength(0);
        expect(liveBlock._reasoningTimeInterval).toBeNull();
        expect(frozenBlock._reasoningTimeInterval).toBeNull();
        expect(frozenBlock.querySelector('.reasoning-time')?.textContent).toContain('14');

        // part 1（工具执行中）的快照不得让已完成的思考块回到流式计时
        view._renderAssistantProgress(
            {
                type: 'assistant',
                task_status: 'running',
                message_id: 'message-freeze-timer',
                last_part_index: 1,
                last_part: { type: 'tool_call', rendered: '<div>tool</div>' }
            },
            history
        );
        const stillFrozen = view.querySelector('.reasoning-block-od') as HTMLElement;
        expect(stillFrozen.classList).toContain('reasoning-completed');
        expect(view.querySelectorAll('.reasoning-block-od.reasoning-active')).toHaveLength(0);
        expect(stillFrozen.querySelector('.reasoning-time')?.textContent).toContain('14');

        // 新的思考 part 开始流式：新块正常进入活跃计时，已完成块不受影响
        view._renderAssistantProgress(
            {
                type: 'assistant',
                task_status: 'running',
                message_id: 'message-freeze-timer',
                last_part_index: 2,
                streaming: true,
                last_part: { type: 'reasoning', text: '第二段思考' }
            },
            history
        );
        const blocks = view.querySelectorAll('.reasoning-block-od');
        expect(blocks).toHaveLength(2);
        expect(blocks[0].classList).toContain('reasoning-completed');
        expect(blocks[1].classList).toContain('reasoning-active');
        expect((blocks[1] as HTMLElement)._reasoningTimeInterval).not.toBeNull();
    });

    test('completed process rows keep symmetric spacing around the collapsed summary', () => {
        expect(taskViewStyles).toMatch(/\.od-completed-process\{[^}]*margin:008px;/);
        expect(taskViewStyles).toMatch(/\.od-completed-process-detail\{[^}]*padding:2px4px2px0;/);
    });
});
