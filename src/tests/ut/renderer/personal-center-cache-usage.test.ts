import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/** 组件模块顶层 extends HTMLElement，必须在动态 import 前就绪（幂等） */
function setupGlobalThis(): void {
    if ((globalThis as any).HTMLElement) {
        return;
    }
    const { window } = parseHTML('<!doctype html><html><body></body></html>');
    Object.assign(globalThis, {
        window,
        document: window.document,
        HTMLElement: window.HTMLElement,
        Element: window.Element,
        CustomEvent: window.CustomEvent,
        Event: window.Event,
        customElements: window.customElements,
        requestAnimationFrame: (callback: FrameRequestCallback) => {
            callback(0);
            return 0;
        },
        cancelAnimationFrame: () => undefined
    });
    if (!(window.HTMLElement.prototype as any).getBoundingClientRect) {
        (window.HTMLElement.prototype as any).getBoundingClientRect = () => ({
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            width: 0,
            height: 0
        });
    }
}

describe('clampTooltipPosition', () => {
    let clampTooltipPosition: (typeof import('../../../renderer/components/personal_center.js'))['clampTooltipPosition'];

    beforeAll(async () => {
        setupGlobalThis();
        ({ clampTooltipPosition } = await import('../../../renderer/components/personal_center.js'));
    });

    const WRAP_W = 680;
    const WRAP_H = 170;
    const TOOLTIP_W = 170;
    const TOOLTIP_H = 100;

    test('数据点上方空间充足时显示在点上方并水平居中', () => {
        const { left, top } = clampTooltipPosition(340, 120, TOOLTIP_W, TOOLTIP_H, WRAP_W, WRAP_H);
        expect(left).toBe(340 - TOOLTIP_W / 2);
        expect(top).toBe(120 - TOOLTIP_H - 10);
    });

    test('鼠标在图表底部时 tooltip 不溢出容器（回归：趋势面板滚动条闪烁）', () => {
        // 右下角：上方放不下翻转到点下方，仍需夹取在容器内
        const bottomRight = clampTooltipPosition(640, 165, TOOLTIP_W, TOOLTIP_H, WRAP_W, WRAP_H);
        expect(bottomRight.top).toBeLessThanOrEqual(WRAP_H - TOOLTIP_H - 4);
        expect(bottomRight.top).toBeGreaterThanOrEqual(4);
        expect(bottomRight.left).toBeLessThanOrEqual(WRAP_W - TOOLTIP_W - 4);
        // 右缘：水平居中会超出，夹取到右边界
        expect(bottomRight.left).toBe(WRAP_W - TOOLTIP_W - 4);
    });

    test('左上角数据点翻转到点下方且水平夹取到左边界', () => {
        const { left, top } = clampTooltipPosition(10, 30, TOOLTIP_W, TOOLTIP_H, WRAP_W, WRAP_H);
        expect(left).toBe(4);
        // 上方放不下：翻转到点下方
        expect(top).toBe(30 + 14);
    });

    test('tooltip 高于容器时贴顶显示', () => {
        const { top } = clampTooltipPosition(340, 80, TOOLTIP_W, 200, WRAP_W, 170);
        expect(top).toBe(4);
    });
});

describe('personal center cache usage rendering', () => {
    beforeAll(async () => {
        setupGlobalThis();
        await import('../../../renderer/components/personal_center.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        delete (globalThis as any).usageAPI;
        delete (globalThis as any).window.usageAPI;
        delete (globalThis as any).window.settingAPI;
    });

    function periodSummary(overrides: Record<string, number>) {
        return {
            task_count: 3,
            request_count: 12,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            cache_read_input_tokens: 0,
            cache_miss_input_tokens: 0,
            ...overrides
        };
    }

    async function renderWithSummary(
        summary: Record<string, unknown>,
        rankings?: { tasks: unknown[]; models: unknown[] }
    ): Promise<ShadowRoot> {
        (globalThis as any).window.usageAPI = {
            getDashboardSummary: jest.fn(async () => summary),
            getRankings: jest.fn(async () => rankings ?? { tasks: [], models: [] })
        };
        const element = document.createElement('personal-center');
        document.body.appendChild(element);
        for (let i = 0; i < 5; i++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        return (element as any).shadowRoot as ShadowRoot;
    }

    test('命中/未命中与命中率并入输入行', async () => {
        const shadowRoot = await renderWithSummary({
            today: periodSummary({ input_tokens: 400, cache_read_input_tokens: 100, cache_miss_input_tokens: 300 }),
            week: periodSummary({ input_tokens: 300, cache_read_input_tokens: 200, cache_miss_input_tokens: 100 }),
            daily_trend: [],
            hourly_trend: [],
            month_top_tasks: [],
            month_top_models: []
        });

        const html = shadowRoot.innerHTML;
        // 今日: 100 / 400 = 25%
        expect(html).toContain(
            '输入: 400<span class="cache-breakdown">（缓存命中 100 / 命中率 25.0% / 未命中 300）</span>'
        );
        // 本周: 200 / 300 ≈ 66.7%
        expect(html).toContain('（缓存命中 200 / 命中率 66.7% / 未命中 100）');
        // 缓存明细不再单独占行
        expect(shadowRoot.querySelectorAll('.metric-cache')).toHaveLength(0);
    });

    test('无缓存数据时不显示缓存明细', async () => {
        const shadowRoot = await renderWithSummary({
            today: periodSummary({ input_tokens: 0 }),
            week: periodSummary({ input_tokens: 0 }),
            daily_trend: [],
            hourly_trend: [],
            month_top_tasks: [],
            month_top_models: []
        });

        const html = shadowRoot.innerHTML;
        expect(html).not.toContain('cache-breakdown');
        expect(html).not.toContain('缓存命中率');
        expect(html).toContain('输入: 0');
    });

    test('趋势图 tooltip 与排行榜副标题展示缓存命中情况', async () => {
        const shadowRoot = await renderWithSummary(
            {
                today: periodSummary({ input_tokens: 0 }),
                week: periodSummary({ input_tokens: 0 }),
                daily_trend: [
                    {
                        day: '2026-07-09',
                        input_tokens: 400,
                        output_tokens: 10,
                        total_tokens: 410,
                        cache_read_input_tokens: 100,
                        cache_miss_input_tokens: 300
                    }
                ],
                hourly_trend: [],
                month_top_tasks: [],
                month_top_models: []
            },
            {
                tasks: [
                    {
                        task_id: 'task-1',
                        task_name: '缓存任务',
                        model: 'deepseek-v4.1-flash',
                        provider: 'InferChat',
                        input_tokens: 400,
                        output_tokens: 10,
                        total_tokens: 410,
                        cache_read_input_tokens: 100,
                        request_count: 3,
                        last_used_at: '2026-07-09T10:00:00.000Z'
                    }
                ],
                models: [
                    {
                        model: 'deepseek-v4.1-flash',
                        provider: 'InferChat',
                        input_tokens: 400,
                        output_tokens: 10,
                        total_tokens: 410,
                        cache_read_input_tokens: 100,
                        request_count: 3
                    }
                ]
            }
        );

        const html = shadowRoot.innerHTML;
        // 排行榜右侧数值区追加命中率行（100/400 = 25%），悬停显示带小数的命中率
        expect((html.match(/class="rank-detail-cache"/g) ?? []).length).toBe(2);
        expect(html).toContain('缓存命中 25%');
        expect((html.match(/title="缓存命中率 25.0%"/g) ?? []).length).toBe(2);
        // 副标题不再拼接命中率（长模型名会被 ellipsis 截断）
        expect(html).toContain('deepseek-v4.1-flash · InferChat');
        // 趋势图 tooltip 预置缓存行（仅在有数据的图表上渲染；悬停时填充命中/未命中数值）
        expect(shadowRoot.querySelectorAll('.chart-tooltip-cache').length).toBe(1);
        expect(html).toContain('缓存命中 / 未命中');
    });
});
