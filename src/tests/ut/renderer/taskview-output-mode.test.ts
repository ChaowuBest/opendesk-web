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
        onSettingChanged?.({
            locale: 'zh-CN',
            gui_config: { output_mode: 'minimal', gui_reason_display: 'inline' }
        });
        window.taskManagerAPI = {
            getFullTask: jest.fn()
        } as any;
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
        return new TaskViewClass() as any;
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
            '深度思考 · 调用了Tool1、Tool2等 10个工具',
            '深度思考 · 调用了Tool11、Tool12等 10个工具',
            '深度思考 · 调用了Tool21、Tool22等 10个工具'
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
            expect(segment.querySelector('[data-process-toggle]')?.getAttribute('aria-expanded')).toBe('true');
            expect(segment.querySelector('.od-process-detail')?.classList.contains('is-open')).toBe(true);
            expect(segment.querySelector('.reasoning-block-od')?.classList.contains('reasoning-expanded')).toBe(true);
            expect(segment.querySelector('.reasoning-full-area')?.textContent).not.toBe('');
        });
        expect(view.querySelectorAll('.mainline-tool-card')).toHaveLength(30);
        expect(view.querySelector('.od-process-tool')).toBeNull();
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
        expect(view.querySelector('.od-process-summary[data-process-toggle]')?.getAttribute('aria-expanded')).toBe(
            'false'
        );

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
        expect(taskViewStyles).toMatch(
            /\.od-assistant-output-flow\[data-reason-display='bubble'\]\.od-process-detail\.is-open\{[^}]*overflow:visible;/
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
        expect(view.querySelector('.od-user-attention-process-detail .qr-code')?.textContent).toBe('SCAN QR CODE');
        expect(taskViewStyles).toMatch(
            /\.od-user-attention-process-detail\{[^}]*max-height:none;[^}]*overflow:visible;[^}]*scrollbar-gutter:auto;/
        );
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
            '深度思考 · 调用了Tool1、Tool2等 10个工具'
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
        expect(view.textContent).not.toContain('正在思考…');
    });

    test('running tool status uses the localized tool name without exposing parameters', () => {
        const view = createView();
        const fileTool = toolPart(1, 1);
        fileTool.toolcalls[0] = {
            ...fileTool.toolcalls[0],
            tool_name: 'filemgr-readFile',
            display_name_key: 'filemgr.readFile.name'
        };
        view.innerHTML = view._renderAssistantOutputHtml([fileTool], {
            isRunning: true,
            messageId: 'message-mainline-running-tool'
        });

        const status = view.querySelector('.od-running-status')?.textContent || '';
        expect(status).toContain('正在调用 读取文件…');
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
                display_name_key: 'filemgr.readFile.name'
            },
            {
                ...fileTools.toolcalls[1],
                tool_name: 'filemgr-readFile',
                display_name_key: 'filemgr.readFile.name'
            },
            {
                ...fileTools.toolcalls[2],
                tool_name: 'filemgr-grepFiles',
                display_name_key: 'filemgr.grep.name'
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
        expect(summary).toBe('深度思考 · 调用了读取文件、内容搜索等 3个工具');
        expect(summary).not.toContain('分析项目结构');
    });

    test('process labels translate protocol names with existing user-facing titles', () => {
        const view = createView();
        const tools = toolPart(1, 2);
        tools.toolcalls = [
            {
                ...tools.toolcalls[0],
                tool_name: 'filemgr-globFiles',
                display_name_key: 'filemgr.glob.name'
            },
            {
                ...tools.toolcalls[1],
                tool_name: 'memory-addMemory',
                display_name_key: 'tools.memory.add.name'
            }
        ];
        view.innerHTML = view._renderAssistantOutputHtml([{ type: 'reasoning', rendered: '分析请求。' }, tools], {
            isRunning: false,
            messageId: 'message-readable-skill-search-summary'
        });

        const summary = view.querySelector('.od-process-summary-text')?.textContent || '';
        expect(summary).toBe('深度思考 · 调用了模式匹配、添加记忆等 2个工具');
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
        expect(summary).toBe('深度思考 · 调用了webFetch等 1个工具');
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
        expect(summary).toBe('深度思考 · 调用了very-long-s…等 4个工具');
    });

    test('process details reuse mainline reasoning and tool card classes', () => {
        expect(taskViewStyles).toMatch(/\.reasoning-block-od\.reasoning-full-area\{[^}]*max-height:0;/);
        expect(taskViewStyles).not.toContain('.od-process-tool{');
        expect(taskViewStyles).not.toContain('.od-process-entry-detail{');
    });

    test('process typography and row spacing stay compact', () => {
        expect(taskViewStyles).toMatch(/\.od-process-main-icon\{[^}]*width:14px;[^}]*height:14px;/);
        expect(taskViewStyles).toMatch(/\.od-process-chevron\{[^}]*font-size:var\(--fs-sm\);/);
        expect(taskViewStyles).toMatch(/\.od-completed-process-chevron\{[^}]*font-size:var\(--fs-sm\);/);
        expect(taskViewStyles).toMatch(/\.reasoning-block-od\.reasoning-header\{[^}]*list-style:none;/);
    });

    test('expanded completed process grows naturally while nested process details keep their height limit', () => {
        expect(taskViewStyles).toMatch(
            /\.od-completed-process-detail\.is-open\{[^}]*display:block;[^}]*max-height:none;[^}]*overflow:visible;/
        );
        expect(taskViewStyles).not.toMatch(/\.od-completed-process-detail\{[^}]*max-height:/);
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
        expect(taskViewStyles).not.toMatch(/\.od-process-detail\{[^}]*overscroll-behavior:contain;/);
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
        expect(flow.lastElementChild?.textContent).toContain('正在调用 Tool1…');
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

        const processToggle = process.querySelector('[data-process-toggle]') as HTMLElement;
        view._handleProcessToggleClick({ target: processToggle, preventDefault() {}, stopPropagation() {} });

        expect(processToggle.getAttribute('aria-expanded')).toBe('false');
        expect(process.querySelector('.od-process-detail')?.classList).not.toContain('is-open');
    });
});
