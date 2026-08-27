import { describe, expect, it, beforeAll, beforeEach } from '@jest/globals';
import { parseHTML } from 'linkedom';

type ModalModule = typeof import('../../../renderer/components/feedbackModal.ts');
let FEEDBACK_MODAL_OPTIONS: ModalModule['FEEDBACK_MODAL_OPTIONS'];
let buildFeedbackModalCard: ModalModule['buildFeedbackModalCard'];
let createFeedbackModalOverlay: ModalModule['createFeedbackModalOverlay'];
let buildFeedbackFormPane: ModalModule['buildFeedbackFormPane'];
let composeFeedbackContent: ModalModule['composeFeedbackContent'];
let bindFeedbackModal: ModalModule['bindFeedbackModal'];
let buildTaskSelectOptions: ModalModule['buildTaskSelectOptions'];
let FEEDBACK_TASK_OPTION_LIMIT: ModalModule['FEEDBACK_TASK_OPTION_LIMIT'];

/** 用中括号包裹 key，便于断言"该文案确实取自 locale 而非硬编码" */
const t = (key: string, params?: Record<string, string | number>) =>
    params ? `[${key}:${JSON.stringify(params)}]` : `[${key}]`;

beforeAll(async () => {
    const { window } = parseHTML('<!doctype html><html><body></body></html>');
    Object.assign(globalThis, {
        window,
        document: window.document,
        HTMLElement: window.HTMLElement,
        Event: window.Event
    });
    const mod = await import('../../../renderer/components/feedbackModal.ts');
    FEEDBACK_MODAL_OPTIONS = mod.FEEDBACK_MODAL_OPTIONS;
    buildFeedbackModalCard = mod.buildFeedbackModalCard;
    createFeedbackModalOverlay = mod.createFeedbackModalOverlay;
    buildFeedbackFormPane = mod.buildFeedbackFormPane;
    composeFeedbackContent = mod.composeFeedbackContent;
    bindFeedbackModal = mod.bindFeedbackModal;
    buildTaskSelectOptions = mod.buildTaskSelectOptions;
    FEEDBACK_TASK_OPTION_LIMIT = mod.FEEDBACK_TASK_OPTION_LIMIT;
});

describe('反馈弹窗首屏', () => {
    it('两个选项各自渲染小图标 + 标题 + 子解释 + 底部行动文案', () => {
        const html = buildFeedbackModalCard(t);

        for (const option of FEEDBACK_MODAL_OPTIONS) {
            expect(html).toContain(`data-feedback-option="${option.id}"`);
            expect(html).toContain(t(option.titleKey));
            expect(html).toContain(t(option.descKey));
            expect(html).toContain(t(option.actionKey));
        }
        expect(html.match(/class="od-feedback-option-icon"/g)).toHaveLength(2);
        expect(html.match(/class="od-feedback-option-action"/g)).toHaveLength(2);
    });

    it('两个选项图标均为 24×24 视窗小图标，与侧边栏图标同族（2px 描边、无填充）', () => {
        for (const option of FEEDBACK_MODAL_OPTIONS) {
            expect(option.iconSvg).toContain('viewBox="0 0 24 24"');
            expect(option.iconSvg).toContain('fill="none"');
            expect(option.iconSvg).toContain('stroke-width="2"');
            expect(option.iconSvg).toContain('stroke-linecap="round"');
            expect(option.iconSvg).not.toMatch(/fill="(?!none)[^"]+"/);
        }
    });

    it('底部行动文案分别为「提出新功能需求」与「提出问题反馈」对应的 locale key', () => {
        const [wish, bug] = FEEDBACK_MODAL_OPTIONS;
        expect(wish.actionKey).toBe('renderer.feedback.wish.action');
        expect(bug.actionKey).toBe('renderer.feedback.bug.action');
    });

    it('两个选项使用不同语义色，并通过 tone class 落到卡片上', () => {
        const html = buildFeedbackModalCard(t);
        const [wish, bug] = FEEDBACK_MODAL_OPTIONS;

        expect(wish.tone).not.toBe(bug.tone);
        expect(html).toContain(`od-feedback-option od-feedback-option-${wish.tone}`);
        expect(html).toContain(`od-feedback-option od-feedback-option-${bug.tone}`);
    });

    it('选项 id 覆盖许愿池与 Bug 两类，且顺序为许愿池在前', () => {
        expect(FEEDBACK_MODAL_OPTIONS.map((option) => option.id)).toEqual(['wish', 'bug']);
    });

    it('颜文字独立成 span 以便套用主题色，且不与描述正文混排', () => {
        const html = buildFeedbackModalCard(t);

        for (const option of FEEDBACK_MODAL_OPTIONS) {
            expect(html).toContain(`<span class="od-feedback-emoticon">${t(option.emoticonKey)}</span>`);
        }
        expect(html.match(/class="od-feedback-emoticon"/g)).toHaveLength(2);
    });

    it('所有可见文案均来自 locale，卡片内不残留中文硬编码', () => {
        const html = buildFeedbackModalCard(t);
        const textOnly = html.replace(/<[^>]*>/g, '').replace(/\[[^\]]*\]/g, '');
        expect(textOnly).not.toMatch(/[\u4e00-\u9fa5]/);
    });

    it('颜文字使用卡片语义色变量，而非硬编码色值', () => {
        const overlay = createFeedbackModalOverlay(t, { detectDark: () => false });
        const style = overlay.querySelector('style')!.textContent!;

        expect(style).toMatch(/\.od-feedback-emoticon\s*\{[^}]*var\(--fo-tone\)/);
    });

    it('深色模式下为遮罩挂上 od-modal-dark', () => {
        const light = createFeedbackModalOverlay(t, { detectDark: () => false });
        const dark = createFeedbackModalOverlay(t, { detectDark: () => true });

        expect(light.classList.contains('od-modal-dark')).toBe(false);
        expect(dark.classList.contains('od-modal-dark')).toBe(true);
    });
});

describe('反馈弹窗关闭行为', () => {
    it('点击遮罩外部不关闭：不注册任何遮罩 mousedown / mouseup 监听', () => {
        const registered: string[] = [];
        const overlay = createFeedbackModalOverlay(t, { detectDark: () => false });
        const original = overlay.addEventListener.bind(overlay);
        overlay.addEventListener = ((type: string, ...rest: unknown[]) => {
            registered.push(type);
            return (original as (...args: unknown[]) => void)(type, ...rest);
        }) as typeof overlay.addEventListener;

        overlay.dispatchEvent(new Event('mousedown', { bubbles: true }));
        overlay.dispatchEvent(new Event('mouseup', { bubbles: true }));

        expect(registered.filter((type) => type === 'mousedown' || type === 'mouseup')).toHaveLength(0);
        expect(overlay.classList.contains('od-modal-leaving')).toBe(false);
    });

    it('提供关闭按钮作为唯一鼠标关闭入口', () => {
        const overlay = createFeedbackModalOverlay(t, { detectDark: () => false });
        expect(overlay.querySelector('[data-action="close"]')).not.toBeNull();
    });
});

describe('反馈表单结构', () => {
    it('许愿池表单包含新功能名称单行输入与需求内容多行文本框', () => {
        const html = buildFeedbackFormPane('wish', t);

        expect(html).toContain('data-field="name"');
        expect(html).toContain('data-field="content"');
        expect(html).toContain('<textarea');
        expect(html).toContain(t('renderer.feedback.wish.nameLabel'));
        expect(html).toContain(t('renderer.feedback.wish.contentLabel'));
    });

    it('许愿池表单没有附件复选框', () => {
        const html = buildFeedbackFormPane('wish', t);
        expect(html).not.toContain('data-attachment=');
    });

    it('Bug 表单只有问题内容多行文本框，没有名称字段', () => {
        const html = buildFeedbackFormPane('bug', t);

        expect(html).not.toContain('data-field="name"');
        expect(html).toContain('data-field="content"');
        expect(html).toContain(t('renderer.feedback.bug.contentLabel'));
    });

    it('Bug 表单含两个附件复选框：系统日志默认勾选，当前任务默认不勾选', () => {
        const html = buildFeedbackFormPane('bug', t);

        expect(html).toContain('data-attachment="systemLog"');
        expect(html).toContain('data-attachment="taskJson"');
        expect(html).toContain(t('renderer.feedback.attachments.systemLog'));
        expect(html).toContain(t('renderer.feedback.attachments.taskJson'));

        const { document } = parseHTML(`<div>${html}</div>`);
        const log = document.querySelector('[data-attachment="systemLog"]') as HTMLInputElement;
        const task = document.querySelector('[data-attachment="taskJson"]') as HTMLInputElement;
        expect(log.hasAttribute('checked')).toBe(true);
        expect(task.hasAttribute('checked')).toBe(false);
    });

    it('任务下拉独占一行放在复选框列表之后，避免与复选框同行改变行高', () => {
        const html = buildFeedbackFormPane('bug', t);

        // 下拉不在任何 label 内部，而是复选框之后的独立容器
        expect(html).toContain('data-task-picker');
        expect(html.indexOf('data-attachment="taskJson"')).toBeLessThan(html.indexOf('data-task-picker'));

        const { document } = parseHTML(`<div>${html}</div>`);
        const picker = document.querySelector('[data-task-picker]')!;
        expect(picker.closest('label')).toBeNull();
        // 默认未勾选，故下拉处于收起态（无 is-visible）
        expect(picker.classList.contains('is-visible')).toBe(false);
    });

    it('任务下拉前带「任务名称」标签', () => {
        const html = buildFeedbackFormPane('bug', t);
        expect(html).toContain(t('renderer.feedback.attachments.taskNameLabel'));

        const { document } = parseHTML(`<div>${html}</div>`);
        const picker = document.querySelector('[data-task-picker]')!;
        expect(picker.querySelector('.od-feedback-task-picker-label')).not.toBeNull();
        expect(picker.querySelector('[data-task-select]')).not.toBeNull();
    });

    it('两类表单都提供提交按钮与返回按钮', () => {
        for (const id of ['wish', 'bug'] as const) {
            const html = buildFeedbackFormPane(id, t);
            expect(html).toContain('data-action="submit"');
            expect(html).toContain('data-action="back"');
        }
    });

    it('表单文案全部来自 locale，不残留中文硬编码', () => {
        for (const id of ['wish', 'bug'] as const) {
            const html = buildFeedbackFormPane(id, t);
            const textOnly = html.replace(/<[^>]*>/g, '').replace(/\[[^\]]*\]/g, '');
            expect(textOnly).not.toMatch(/[\u4e00-\u9fa5]/);
        }
    });
});

describe('composeFeedbackContent', () => {
    it('许愿池将名称与需求内容拼成带标题的正文', () => {
        const content = composeFeedbackContent('wish', { name: '分屏模式', content: '希望支持左右分屏' });
        expect(content).toContain('分屏模式');
        expect(content).toContain('希望支持左右分屏');
    });

    it('Bug 直接使用问题内容作为正文', () => {
        expect(composeFeedbackContent('bug', { content: '点击就崩溃' })).toBe('点击就崩溃');
    });

    it('首尾空白会被清理', () => {
        expect(composeFeedbackContent('bug', { content: '  崩溃  ' })).toBe('崩溃');
    });
});

describe('反馈弹窗滑动切换与提交', () => {
    let overlay: HTMLElement;
    let submitted: unknown[];
    let submitResult: { status: string; message?: string };

    function mount(currentTaskId: string | null = 'task-1', tasks?: Array<{ taskId: string; name: string }>) {
        submitted = [];
        submitResult = { status: 'ok' };
        overlay = createFeedbackModalOverlay(t, { detectDark: () => false });
        document.body.appendChild(overlay);
        bindFeedbackModal(overlay, t, {
            getCurrentTaskId: () => currentTaskId,
            listRecentTasks: async () => tasks ?? [],
            submitFeedback: async (submission: unknown) => {
                submitted.push(submission);
                return submitResult;
            },
            onClose: () => {}
        });
        return overlay;
    }

    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('点击许愿池卡片后卡片区左移并展示对应表单', () => {
        mount();
        const track = overlay.querySelector('.od-feedback-track')!;
        expect(track.classList.contains('is-form')).toBe(false);

        (overlay.querySelector('[data-feedback-option="wish"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );

        expect(track.classList.contains('is-form')).toBe(true);
        expect(overlay.querySelector('[data-feedback-form="wish"]')).not.toBeNull();
        expect(overlay.querySelector('[data-field="name"]')).not.toBeNull();
    });

    it('点击 Bug 卡片后展示带附件复选框的问题表单', () => {
        mount();
        (overlay.querySelector('[data-feedback-option="bug"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );

        expect(overlay.querySelector('[data-feedback-form="bug"]')).not.toBeNull();
        expect(overlay.querySelector('[data-attachment="systemLog"]')).not.toBeNull();
        expect(overlay.querySelector('[data-field="name"]')).toBeNull();
    });

    it('返回按钮把卡片区滑回首屏', () => {
        mount();
        (overlay.querySelector('[data-feedback-option="bug"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );
        const track = overlay.querySelector('.od-feedback-track')!;
        expect(track.classList.contains('is-form')).toBe(true);

        (overlay.querySelector('[data-action="back"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );
        expect(track.classList.contains('is-form')).toBe(false);
    });

    it('许愿池提交时以 feature 类型上报，正文含名称与内容，且不带附件', async () => {
        mount();
        (overlay.querySelector('[data-feedback-option="wish"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );
        (overlay.querySelector('[data-field="name"]') as HTMLInputElement).value = '分屏模式';
        (overlay.querySelector('[data-field="content"]') as HTMLTextAreaElement).value = '希望支持左右分屏';

        (overlay.querySelector('[data-action="submit"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );
        await new Promise((r) => setTimeout(r, 0));

        expect(submitted).toHaveLength(1);
        const payload = submitted[0] as Record<string, unknown>;
        expect(payload.type).toBe('feature');
        expect(String(payload.content)).toContain('分屏模式');
        expect(String(payload.content)).toContain('希望支持左右分屏');
        expect(payload.includeSystemLog).toBe(false);
        expect(payload.includeTaskJson).toBe(false);
    });

    it('Bug 提交时以 bug 类型上报，默认带系统日志、不带任务内容', async () => {
        mount();
        (overlay.querySelector('[data-feedback-option="bug"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );
        (overlay.querySelector('[data-field="content"]') as HTMLTextAreaElement).value = '点击就崩溃';

        (overlay.querySelector('[data-action="submit"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );
        await new Promise((r) => setTimeout(r, 0));

        const payload = submitted[0] as Record<string, unknown>;
        expect(payload.type).toBe('bug');
        expect(payload.content).toBe('点击就崩溃');
        expect(payload.includeSystemLog).toBe(true);
        expect(payload.includeTaskJson).toBe(false);
    });

    it('勾选当前任务后提交会带上当前任务 id', async () => {
        mount('task-42');
        (overlay.querySelector('[data-feedback-option="bug"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );
        (overlay.querySelector('[data-field="content"]') as HTMLTextAreaElement).value = '任务卡住了';
        (overlay.querySelector('[data-attachment="taskJson"]') as HTMLInputElement).checked = true;

        (overlay.querySelector('[data-action="submit"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );
        await new Promise((r) => setTimeout(r, 0));

        const payload = submitted[0] as Record<string, unknown>;
        expect(payload.includeTaskJson).toBe(true);
        expect(payload.taskId).toBe('task-42');
    });

    it('取消勾选系统日志后提交不附加日志', async () => {
        mount();
        (overlay.querySelector('[data-feedback-option="bug"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );
        (overlay.querySelector('[data-field="content"]') as HTMLTextAreaElement).value = '有问题';
        (overlay.querySelector('[data-attachment="systemLog"]') as HTMLInputElement).checked = false;

        (overlay.querySelector('[data-action="submit"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );
        await new Promise((r) => setTimeout(r, 0));

        expect((submitted[0] as Record<string, unknown>).includeSystemLog).toBe(false);
    });

    it('内容为空时不提交，并在对应控件下方显示红字错误提示', async () => {
        mount();
        (overlay.querySelector('[data-feedback-option="bug"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );

        (overlay.querySelector('[data-action="submit"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );
        await new Promise((r) => setTimeout(r, 0));

        expect(submitted).toHaveLength(0);
        const error = overlay.querySelector('[data-error-for="content"]')!;
        expect(error.textContent).toContain(t('renderer.feedback.error.contentRequired'));
    });

    it('许愿池缺少名称时不提交，并在名称字段下提示', async () => {
        mount();
        (overlay.querySelector('[data-feedback-option="wish"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );
        (overlay.querySelector('[data-field="content"]') as HTMLTextAreaElement).value = '有内容但没名称';

        (overlay.querySelector('[data-action="submit"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );
        await new Promise((r) => setTimeout(r, 0));

        expect(submitted).toHaveLength(0);
        const error = overlay.querySelector('[data-error-for="name"]')!;
        expect(error.textContent).toContain(t('renderer.feedback.error.nameRequired'));
    });

    it('提交失败时保留表单内容并显示错误信息', async () => {
        mount();
        (overlay.querySelector('[data-feedback-option="bug"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );
        const textarea = overlay.querySelector('[data-field="content"]') as HTMLTextAreaElement;
        textarea.value = '崩溃了';
        submitResult = { status: 'error', message: 'HTTP 500' };

        (overlay.querySelector('[data-action="submit"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );
        await new Promise((r) => setTimeout(r, 0));

        // 表单未被替换，用户输入仍在
        expect((overlay.querySelector('[data-field="content"]') as HTMLTextAreaElement).value).toBe('崩溃了');
        const error = overlay.querySelector('[data-error-for="submit"]')!;
        expect(error.textContent).toContain('HTTP 500');
    });

    it('提交进行中禁用提交按钮，避免重复提交', async () => {
        let release: (value: { status: string }) => void = () => {};
        overlay = createFeedbackModalOverlay(t, { detectDark: () => false });
        document.body.appendChild(overlay);
        const calls: unknown[] = [];
        bindFeedbackModal(overlay, t, {
            getCurrentTaskId: () => null,
            submitFeedback: (submission: unknown) => {
                calls.push(submission);
                return new Promise((resolve) => {
                    release = resolve;
                });
            },
            onClose: () => {}
        });

        (overlay.querySelector('[data-feedback-option="bug"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );
        (overlay.querySelector('[data-field="content"]') as HTMLTextAreaElement).value = '内容';
        const submitBtn = overlay.querySelector('[data-action="submit"]') as HTMLButtonElement;

        submitBtn.dispatchEvent(new Event('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
        expect(submitBtn.disabled).toBe(true);

        // 第二次点击在挂起期间不应再次提交
        submitBtn.dispatchEvent(new Event('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
        expect(calls).toHaveLength(1);

        release({ status: 'ok' });
    });

    it('提交成功后展示成功态', async () => {
        mount();
        (overlay.querySelector('[data-feedback-option="bug"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );
        (overlay.querySelector('[data-field="content"]') as HTMLTextAreaElement).value = '内容';

        (overlay.querySelector('[data-action="submit"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );
        await new Promise((r) => setTimeout(r, 0));

        expect(overlay.querySelector('.od-feedback-success')).not.toBeNull();
    });
});

describe('反馈弹窗高度过渡', () => {
    it('viewport 声明 height 过渡，切换面板时高度平滑变化而非跳变', () => {
        const overlay = createFeedbackModalOverlay(t, { detectDark: () => false });
        const style = overlay.querySelector('style')!.textContent!;

        const viewportRule = style.match(/\.od-feedback-viewport\s*\{[^}]*\}/)![0];
        expect(viewportRule).toMatch(/transition:[^;]*height/);
        expect(viewportRule).toContain('overflow: hidden');
    });

    it('滑轨用 flex-start 对齐，两个面板各自保持自然高度而非被拉成等高', () => {
        const overlay = createFeedbackModalOverlay(t, { detectDark: () => false });
        const style = overlay.querySelector('style')!.textContent!;

        const trackRule = style.match(/\.od-feedback-track\s*\{[^}]*\}/)![0];
        expect(trackRule).toContain('align-items: flex-start');
    });

    it('CSS 滑动时长与 JS 中使用的时长一致，避免动画与清理时机错位', () => {
        const overlay = createFeedbackModalOverlay(t, { detectDark: () => false });
        const style = overlay.querySelector('style')!.textContent!;

        const trackRule = style.match(/\.od-feedback-track\s*\{[^}]*\}/)![0];
        const viewportRule = style.match(/\.od-feedback-viewport\s*\{[^}]*\}/)![0];
        // 两者都应为 0.32s，与 SLIDE_DURATION_MS = 320 对应
        expect(trackRule).toContain('0.32s');
        expect(viewportRule).toContain('0.32s');
    });

    it('bindFeedbackModal 返回清理函数，关闭时可断开尺寸监听', () => {
        const overlay = createFeedbackModalOverlay(t, { detectDark: () => false });
        document.body.appendChild(overlay);
        const dispose = bindFeedbackModal(overlay, t, {
            getCurrentTaskId: () => null,
            listRecentTasks: async () => [],
            submitFeedback: async () => ({ status: 'ok' }),
            onClose: () => {}
        });

        expect(typeof dispose).toBe('function');
        expect(() => dispose()).not.toThrow();
    });

    it('任务下拉展开/收起走 max-height 过渡，避免勾选时高度突变', () => {
        const overlay = createFeedbackModalOverlay(t, { detectDark: () => false });
        const style = overlay.querySelector('style')!.textContent!;

        const pickerRule = style.match(/\.od-feedback-task-picker\s*\{[^}]*\}/)![0];
        expect(pickerRule).toMatch(/transition:[^;]*max-height/);
        expect(pickerRule).toContain('max-height: 0');
        expect(style).toMatch(/\.od-feedback-task-picker\.is-visible\s*\{[^}]*max-height/);
    });

    it('任务下拉自适应剩余宽度，而非固定窄宽', () => {
        const overlay = createFeedbackModalOverlay(t, { detectDark: () => false });
        const style = overlay.querySelector('style')!.textContent!;

        const selectRule = style.match(/\.od-feedback-task-select\s*\{[^}]*\}/)![0];
        expect(selectRule).toContain('flex: 1');
    });
});

describe('任务下拉选项', () => {
    it('当前任务排首位并标注「(当前任务)」，且默认选中', () => {
        const html = buildTaskSelectOptions(
            [
                { taskId: 'a', name: '任务 A' },
                { taskId: 'b', name: '任务 B' },
                { taskId: 'c', name: '任务 C' }
            ],
            'b',
            t
        );

        const { document } = parseHTML(`<select>${html}</select>`);
        const options = [...document.querySelectorAll('option')];
        expect(options[0].getAttribute('value')).toBe('b');
        expect(options[0].hasAttribute('selected')).toBe(true);
        expect(options[0].textContent).toContain('renderer.feedback.attachments.taskCurrent');
        // 其余任务保持原有顺序
        expect(options.slice(1).map((o) => o.getAttribute('value'))).toEqual(['a', 'c']);
    });

    it('没有当前任务时按原顺序展示，且不标注当前任务', () => {
        const html = buildTaskSelectOptions(
            [
                { taskId: 'a', name: '任务 A' },
                { taskId: 'b', name: '任务 B' }
            ],
            null,
            t
        );

        const { document } = parseHTML(`<select>${html}</select>`);
        const options = [...document.querySelectorAll('option')];
        expect(options.map((o) => o.getAttribute('value'))).toEqual(['a', 'b']);
        expect(options.some((o) => o.hasAttribute('selected'))).toBe(false);
        expect(html).not.toContain('taskCurrent');
    });

    it('当前任务不在候选列表中时不强行插入', () => {
        const html = buildTaskSelectOptions([{ taskId: 'a', name: '任务 A' }], 'not-in-list', t);

        const { document } = parseHTML(`<select>${html}</select>`);
        expect([...document.querySelectorAll('option')].map((o) => o.getAttribute('value'))).toEqual(['a']);
        expect(html).not.toContain('taskCurrent');
    });

    it('无候选任务时给出空态选项', () => {
        const html = buildTaskSelectOptions([], null, t);
        expect(html).toContain(t('renderer.feedback.attachments.taskEmpty'));
        expect(html).toContain('value=""');
    });

    it('任务名称做 HTML 转义，避免注入', () => {
        const html = buildTaskSelectOptions([{ taskId: 'x', name: '<img src=x onerror=1>' }], null, t);
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img');
    });

    it('下拉最多展示 10 条任务', () => {
        expect(FEEDBACK_TASK_OPTION_LIMIT).toBe(10);
    });
});

describe('任务下拉与提交联动', () => {
    let overlay: HTMLElement;
    let submitted: unknown[];

    function mountWithTasks(currentTaskId: string | null, tasks: Array<{ taskId: string; name: string }>) {
        submitted = [];
        overlay = createFeedbackModalOverlay(t, { detectDark: () => false });
        document.body.appendChild(overlay);
        bindFeedbackModal(overlay, t, {
            getCurrentTaskId: () => currentTaskId,
            listRecentTasks: async () => tasks,
            submitFeedback: async (submission: unknown) => {
                submitted.push(submission);
                return { status: 'ok' };
            },
            onClose: () => {}
        });
        (overlay.querySelector('[data-feedback-option="bug"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );
        return overlay;
    }

    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('勾选后下拉展开并按最近任务填充选项', async () => {
        mountWithTasks('task-1', [
            { taskId: 'task-1', name: '当前任务' },
            { taskId: 'task-2', name: '另一个任务' }
        ]);

        const checkbox = overlay.querySelector('[data-attachment="taskJson"]') as HTMLInputElement;
        const picker = overlay.querySelector('[data-task-picker]')!;
        expect(picker.classList.contains('is-visible')).toBe(false);

        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));

        expect(picker.classList.contains('is-visible')).toBe(true);
        const select = overlay.querySelector('[data-task-select]') as HTMLSelectElement;
        expect(select.querySelectorAll('option')).toHaveLength(2);
    });

    it('取消勾选后下拉收起', async () => {
        mountWithTasks('task-1', [{ taskId: 'task-1', name: '当前任务' }]);
        const checkbox = overlay.querySelector('[data-attachment="taskJson"]') as HTMLInputElement;
        const picker = overlay.querySelector('[data-task-picker]')!;

        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
        expect(picker.classList.contains('is-visible')).toBe(true);

        checkbox.checked = false;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        expect(picker.classList.contains('is-visible')).toBe(false);
    });

    it('在下拉中改选其它任务后，提交带上所选任务而非当前任务', async () => {
        mountWithTasks('task-1', [
            { taskId: 'task-1', name: '当前任务' },
            { taskId: 'task-9', name: '另一个任务' }
        ]);
        (overlay.querySelector('[data-field="content"]') as HTMLTextAreaElement).value = '有问题';

        const checkbox = overlay.querySelector('[data-attachment="taskJson"]') as HTMLInputElement;
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));

        // linkedom 的 select.value 是只读的，改选通过 option.selected 模拟
        const select = overlay.querySelector('[data-task-select]') as HTMLSelectElement;
        [...select.querySelectorAll('option')].forEach((option) => {
            option.selected = option.getAttribute('value') === 'task-9';
        });
        (overlay.querySelector('[data-action="submit"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );
        await new Promise((r) => setTimeout(r, 0));

        expect((submitted[0] as Record<string, unknown>).taskId).toBe('task-9');
    });

    it('下拉未加载出选项时回落到当前任务 id', async () => {
        mountWithTasks('task-fallback', []);
        (overlay.querySelector('[data-field="content"]') as HTMLTextAreaElement).value = '有问题';
        (overlay.querySelector('[data-attachment="taskJson"]') as HTMLInputElement).checked = true;

        (overlay.querySelector('[data-action="submit"]') as HTMLElement).dispatchEvent(
            new Event('click', { bubbles: true })
        );
        await new Promise((r) => setTimeout(r, 0));

        expect((submitted[0] as Record<string, unknown>).taskId).toBe('task-fallback');
    });
});
