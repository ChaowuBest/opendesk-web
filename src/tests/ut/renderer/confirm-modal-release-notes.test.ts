import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { renderReleaseNotesHtml, showWhatsNewModal } from '../../../renderer/components/confirmModal.ts';

/**
 * What's New 弹窗的更新说明渲染（renderReleaseNotesHtml）：
 * notes 来自更新 feed 的 news 详情页抓取，属于不可信输入，渲染必须只输出
 * 本函数生成的受控标签，文本内容全部经 escapeHtml 转义。
 * 行级标记约定：行首 "# " 总标题、"## " 章节标题、"- "/"· "/"• " 列表项、
 * 其余非空行为段落、空行分段。
 * 以及 showWhatsNewModal 的深浅色主题跟随（od-modal-dark）。
 */
describe('renderReleaseNotesHtml', () => {
    it('空内容与纯空白', () => {
        expect(renderReleaseNotesHtml('')).toBe('');
        expect(renderReleaseNotesHtml('   \n  \n')).toBe('');
    });

    it('"# " 总标题渲染为 lead 块', () => {
        expect(renderReleaseNotesHtml('# OpenDesk 0.3.10 发布')).toBe(
            '<div class="od-whats-new-lead">OpenDesk 0.3.10 发布</div>'
        );
    });

    it('"## " 章节标题渲染为 heading 块', () => {
        expect(renderReleaseNotesHtml('## 主要更新')).toBe('<div class="od-whats-new-heading">主要更新</div>');
    });

    it('"#" 与 "###" 不识别为标记，按段落输出', () => {
        expect(renderReleaseNotesHtml('#无空格')).toBe('<div class="od-whats-new-paragraph">#无空格</div>');
        expect(renderReleaseNotesHtml('### 三级')).toBe('<div class="od-whats-new-paragraph">### 三级</div>');
    });

    it('-、·、• 三种列表标记合并进同一列表', () => {
        const html = renderReleaseNotesHtml('- 甲\n· 乙\n• 丙');
        expect(html).toBe('<ul class="od-whats-new-list"><li>甲</li><li>乙</li><li>丙</li></ul>');
    });

    it('普通非空行渲染为段落', () => {
        expect(renderReleaseNotesHtml('相对上一版本的说明文字')).toBe(
            '<div class="od-whats-new-paragraph">相对上一版本的说明文字</div>'
        );
    });

    it('空行与标题会中断当前列表', () => {
        const html = renderReleaseNotesHtml('- 甲\n\n- 乙\n## 章节\n- 丙');
        expect(html).toBe(
            '<ul class="od-whats-new-list"><li>甲</li></ul>' +
                '<ul class="od-whats-new-list"><li>乙</li></ul>' +
                '<div class="od-whats-new-heading">章节</div>' +
                '<ul class="od-whats-new-list"><li>丙</li></ul>'
        );
    });

    it('HTML 字符全部转义，杜绝 XSS 注入', () => {
        const html = renderReleaseNotesHtml('- <img src=x onerror=alert(1)>\n## <script>alert(2)</script>');
        expect(html).not.toContain('<img');
        expect(html).not.toContain('<script');
        expect(html).toContain('&lt;img');
    });

    it('完整章节结构：标题 + 章节段落 + 列表', () => {
        const notes = '# OpenDesk 0.3.10 发布\n\n## 主要更新\n\n- 新增 A\n- 优化 B\n\n## 问题修复\n\n- 修复 C';
        const html = renderReleaseNotesHtml(notes);
        expect(html).toBe(
            '<div class="od-whats-new-lead">OpenDesk 0.3.10 发布</div>' +
                '<div class="od-whats-new-heading">主要更新</div>' +
                '<ul class="od-whats-new-list"><li>新增 A</li><li>优化 B</li></ul>' +
                '<div class="od-whats-new-heading">问题修复</div>' +
                '<ul class="od-whats-new-list"><li>修复 C</li></ul>'
        );
    });

    it('行首空白被忽略，列表项内部保留原文（含连字符）', () => {
        const html = renderReleaseNotesHtml('  - 支持 -v 参数');
        expect(html).toBe('<ul class="od-whats-new-list"><li>支持 -v 参数</li></ul>');
    });
});

describe('showWhatsNewModal 深浅色跟随', () => {
    const baseOptions = {
        title: 'OpenDesk 0.4.2 更新',
        notes: '## 主要更新\n- 条目甲',
        noNotesText: '暂无说明',
        communityText: '欢迎加入社区：',
        communityLinkText: '社区首页',
        communityUrl: 'https://example.com/community',
        confirmText: '知道了'
    };

    beforeAll(() => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            Event: window.Event
        });
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        document.documentElement.dataset.theme = 'light';
    });

    /** 复现主题切换链路：html[data-theme] 先更新，再派发 opendesk-theme-changed（见 theme-iframe-bridge） */
    function switchTheme(effective: 'light' | 'dark'): void {
        document.documentElement.dataset.theme = effective;
        document.dispatchEvent(new CustomEvent('opendesk-theme-changed', { detail: { effective } }));
    }

    function openOverlay(): HTMLElement {
        void showWhatsNewModal({ ...baseOptions });
        return document.querySelector('.od-confirm-modal-overlay') as HTMLElement;
    }

    it('打开时按当前主题决定 od-modal-dark 挂载与否', () => {
        document.documentElement.dataset.theme = 'dark';
        const dark = openOverlay();
        expect(dark.classList.contains('od-modal-dark')).toBe(true);
        dark.remove();

        document.documentElement.dataset.theme = 'light';
        expect(openOverlay().classList.contains('od-modal-dark')).toBe(false);
    });

    it('弹窗存活期间切到深色主题时即时跟随', () => {
        const overlay = openOverlay();
        expect(overlay.classList.contains('od-modal-dark')).toBe(false);

        switchTheme('dark');
        expect(overlay.classList.contains('od-modal-dark')).toBe(true);
    });

    it('弹窗存活期间从深色切回浅色时同样跟随', () => {
        document.documentElement.dataset.theme = 'dark';
        const overlay = openOverlay();
        expect(overlay.classList.contains('od-modal-dark')).toBe(true);

        switchTheme('light');
        expect(overlay.classList.contains('od-modal-dark')).toBe(false);
    });

    it('关闭弹窗时移除主题监听，避免泄漏', async () => {
        jest.useFakeTimers();
        try {
            const removeSpy = jest.spyOn(document, 'removeEventListener');
            const closed = showWhatsNewModal({ ...baseOptions });
            const overlay = document.querySelector('.od-confirm-modal-overlay') as HTMLElement;

            (overlay.querySelector('[data-action="confirm"]') as HTMLElement).click();
            jest.advanceTimersByTime(300);
            await closed;

            expect(document.querySelector('.od-confirm-modal-overlay')).toBeNull();
            expect(removeSpy).toHaveBeenCalledWith('opendesk-theme-changed', expect.any(Function));
        } finally {
            jest.useRealTimers();
        }
    });
});
