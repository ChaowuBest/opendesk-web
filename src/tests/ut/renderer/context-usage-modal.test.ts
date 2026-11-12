import { afterEach, beforeAll, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { confirmModalMockShim } from '../../confirmModalMock.js';
import { zhCn } from '../../../locale/zh-cn.js';

jest.unstable_mockModule('../../../renderer/components/confirmModal.ts', () => confirmModalMockShim());

type ContextUsageModule = typeof import('../../../renderer/components/contextUsageModal.js');

let mod!: ContextUsageModule;

beforeAll(async () => {
    const { window } = parseHTML('<!doctype html><html><body></body></html>');
    Object.assign(globalThis, {
        window,
        document: window.document,
        HTMLElement: window.HTMLElement,
        Event: window.Event,
        KeyboardEvent: window.KeyboardEvent,
        CustomEvent: window.CustomEvent,
        DOMParser: window.DOMParser
    });
    mod = (await import('../../../renderer/components/contextUsageModal.js')) as ContextUsageModule;
});

afterEach(() => {
    document.body.innerHTML = '';
});

const t = (key: string) => zhCn[key] ?? key;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const baseReport = () => ({
    modelName: 'test-model',
    contextWindow: 1000,
    totalEstimatedTokens: 420,
    usageRatio: 0.42,
    categories: [
        { name: 'System prompt', tokens: 200 },
        { name: 'Tools', tokens: 0 },
        { name: 'Messages', tokens: 220 },
        { name: 'Free space', tokens: 580 }
    ]
});

test('formatCompactTokens matches the TUI compact token formatting', () => {
    expect(mod.formatCompactTokens(520)).toBe('520');
    expect(mod.formatCompactTokens(1000)).toBe('1k');
    expect(mod.formatCompactTokens(1234)).toBe('1.2k');
    expect(mod.formatCompactTokens(52300)).toBe('52.3k');
    expect(mod.formatCompactTokens(52000)).toBe('52k');
    expect(mod.formatCompactTokens(1234567)).toBe('1.2m');
    expect(mod.formatCompactTokens(125000000)).toBe('125m');
    expect(mod.formatCompactTokens(-1500)).toBe('-1.5k');
    expect(mod.formatCompactTokens(Number.NaN)).toBe('0');
});

test('contextCategoryColor reuses the TUI palette and falls back for unknown categories', () => {
    expect(mod.contextCategoryColor('System prompt', 0)).toBe('#FFAB00');
    expect(mod.contextCategoryColor('tools', 0)).toBe('#00C853');
    expect(mod.contextCategoryColor('Messages', 0)).toBe('#9C4DFF');
    expect(mod.contextCategoryColor('free space', 0)).toBe('#94A3B8');
    expect(mod.contextCategoryColor('unknown', 0)).toBe('#42A5F5');
    expect(mod.contextCategoryColor('unknown', 3)).toBe('#7E57C2');
});

test('buildContextUsageContent renders percent, the TUI-style circle grid and legend', () => {
    const content = mod.buildContextUsageContent(baseReport(), [], t);

    expect(content).toContain('42.0%');
    expect(content).toContain('420 / 1k');
    expect(content).toContain('test-model');

    const dom = new DOMParser().parseFromString(`<div>${content}</div>`, 'text/html');
    const circles = Array.from(dom.querySelectorAll('.od-contextusage-circle'));
    // 10×10 = 100 格，每格 ≈ 1% 窗口（对齐 TUI circle 可视化页）
    expect(circles).toHaveLength(100);
    // System prompt 200/1000 → 20 格，Messages 220/1000 → 22 格，Free space 580/1000 → 58 格空心
    const freeCircles = circles.filter((el) => el.classList.contains('is-free'));
    expect(freeCircles).toHaveLength(58);
    const solidByColor = new Map<string, number>();
    for (const el of circles) {
        if (el.classList.contains('is-free')) continue;
        const style = el.getAttribute('style') ?? '';
        solidByColor.set(style, (solidByColor.get(style) ?? 0) + 1);
    }
    expect(solidByColor.get('background: #FFAB00;')).toBe(20);
    expect(solidByColor.get('background: #9C4DFF;')).toBe(22);
    // Tools（0 tokens）被过滤不占格
    expect(solidByColor.size).toBe(2);
    // 不再渲染条形图与 80% 刻度线
    expect(dom.querySelector('.od-contextusage-bar-seg')).toBeNull();
    expect(dom.querySelector('.od-contextusage-bar-tick')).toBeNull();
    // 圆点粒度说明 + 图例 + 建议标题保持
    expect(content).toContain('每个圆点');
    const legendNames = Array.from(dom.querySelectorAll('.od-contextusage-legend-name')).map(
        (el) => el.textContent ?? ''
    );
    // tokens 为 0 的类目（Tools）被过滤，Free space 始终保留
    expect(legendNames).toEqual(['System Prompt', 'Messages', '剩余空间']);
    // 图例图标与圆点网格样式一致：剩余空间图标为空心（无内联背景），其余为实心
    const legendDots = Array.from(dom.querySelectorAll('.od-contextusage-legend-row .od-contextusage-dot'));
    const freeLegendDot = legendDots.find((el) => el.classList.contains('is-free'));
    expect(freeLegendDot).toBeTruthy();
    expect(freeLegendDot?.getAttribute('style')).toBeNull();
    expect(legendDots.filter((el) => !el.classList.contains('is-free'))).toHaveLength(2);
    expect(dom.querySelector('.od-contextusage-suggest-title')?.textContent).toContain('建议');
});

test('buildContextUsageContent maps known suggestion ids to localized copy and falls back otherwise', () => {
    const localized = mod.buildContextUsageContent(
        baseReport(),
        [{ id: 'near-auto-compact-threshold', severity: 'warn', title: 'server title', detail: 'server detail' }],
        t
    );
    expect(localized).toContain('接近自动压缩阈值');
    expect(localized).toContain('od-contextusage-suggestion warn');
    expect(localized).not.toContain('server title');

    const fallback = mod.buildContextUsageContent(
        baseReport(),
        [{ id: 'unknown-suggestion', severity: 'info', title: 'fallback title', detail: 'fallback detail' }],
        t
    );
    expect(fallback).toContain('fallback title');
    expect(fallback).toContain('od-contextusage-suggestion info');

    const none = mod.buildContextUsageContent(baseReport(), [], t);
    expect(none).toContain('当前未发现需要关注的问题');
});

test('buildContextUsageContent handles missing model and ratio gracefully', () => {
    const report = { ...baseReport(), modelName: undefined, usageRatio: undefined };
    const content = mod.buildContextUsageContent(report, [], t);
    expect(content).toContain('n/a');
    expect(content).not.toContain('od-contextusage-model');
});

test('showContextUsageModal fetches diagnostics through the preload channel and renders content', async () => {
    const calls: string[] = [];
    (window as { taskManagerAPI?: unknown }).taskManagerAPI = {
        getContextDiagnostics: async (taskId: string) => {
            calls.push(taskId);
            return { report: baseReport(), suggestions: [] };
        }
    };
    const overlay = mod.showContextUsageModal('task-1', t);
    // 挂载后立即进入 loading 态
    expect(overlay.querySelector('.od-contextusage-loading')).toBeTruthy();
    await settle();
    expect(calls).toEqual(['task-1']);
    expect(overlay.querySelector('.od-contextusage-percent')?.textContent).toContain('42.0%');
    expect(overlay.querySelector('.od-contextusage-loading')).toBeNull();
});

test('showContextUsageModal surfaces load failures', async () => {
    const overlay = mod.showContextUsageModal('task-1', t, {
        fetchDiagnostics: async () => {
            throw new Error('boom');
        }
    });
    await settle();
    const error = overlay.querySelector('.od-contextusage-error');
    expect(error?.textContent).toContain('boom');
});

test('showContextUsageModal honors the dark mode dep', () => {
    const overlay = mod.showContextUsageModal('task-1', t, {
        detectDark: () => true,
        fetchDiagnostics: async () => ({ report: baseReport(), suggestions: [] })
    });
    expect(overlay.classList.contains('od-modal-dark')).toBe(true);
});

test('close button animates out and removes the overlay', async () => {
    const overlay = mod.showContextUsageModal('task-1', t, {
        fetchDiagnostics: async () => ({ report: baseReport(), suggestions: [] })
    });
    await settle();
    (overlay.querySelector('[data-action="close"]') as HTMLElement).click();
    expect(overlay.classList.contains('od-modal-leaving')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(document.body.contains(overlay)).toBe(false);
});

test('escape key closes the modal', async () => {
    const overlay = mod.showContextUsageModal('task-1', t, {
        fetchDiagnostics: async () => ({ report: baseReport(), suggestions: [] })
    });
    await settle();
    // linkedom 未实现 KeyboardEvent 构造器，escHandler 只读取 e.key，用 Event 注入等价属性
    const escapeEvent = new window.Event('keydown', { bubbles: true });
    Object.defineProperty(escapeEvent, 'key', { value: 'Escape' });
    document.dispatchEvent(escapeEvent);
    expect(overlay.classList.contains('od-modal-leaving')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(document.body.contains(overlay)).toBe(false);
});
