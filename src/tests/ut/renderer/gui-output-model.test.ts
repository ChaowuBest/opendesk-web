import {
    buildAssistantOutputItems,
    getDefaultProcessExpanded,
    getVisibleAssistantOutputItems,
    normalizeGuiOutputMode
} from '../../../renderer/components/taskview-output.js';

function reasoning(label: string, elapsedSeconds: number = 1) {
    return { type: 'reasoning', rendered: label, elapsedSeconds };
}

function tools(start: number, count: number) {
    return {
        type: 'tool_call',
        rendered: '',
        toolcalls: Array.from({ length: count }, (_, offset) => ({
            id: `tool-${start + offset}`,
            index: start + offset - 1,
            tool_name: `Tool${start + offset}`,
            status: 'success',
            detail_available: true,
            presentation: { displayName: `Tool${start + offset}` },
            elapsedSeconds: 0.2
        }))
    };
}

function text(label: string) {
    return { type: 'text', rendered: `<p>${label}</p>`, text: label };
}

describe('GUI assistant output model', () => {
    test('uses only minimal and detailed output modes', () => {
        expect(normalizeGuiOutputMode('minimal')).toBe('minimal');
        expect(normalizeGuiOutputMode('detailed')).toBe('detailed');
        expect(normalizeGuiOutputMode('full')).toBe('minimal');
        expect(normalizeGuiOutputMode(undefined)).toBe('minimal');
    });

    test('splits process segments at assistant body boundaries instead of tool counts', () => {
        const parts = [
            reasoning('分析'),
            tools(1, 10),
            text('第一段正文'),
            reasoning('实现'),
            tools(11, 10),
            text('第二段正文'),
            reasoning('验证'),
            tools(21, 10),
            text('最终正文')
        ];

        const items = buildAssistantOutputItems(parts, { isRunning: false });

        expect(items.map((item) => item.type)).toEqual(['process', 'body', 'process', 'body', 'process', 'final']);
        expect(items.filter((item) => item.type === 'process').map((item: any) => item.toolCount)).toEqual([
            10, 10, 10
        ]);
        expect((items[0] as any).toolStart).toBe(1);
        expect((items[4] as any).toolEnd).toBe(30);
        expect((items[5] as any).part.text).toBe('最终正文');
        expect(items.filter((item) => item.type === 'process').every((item) => !('elapsedSeconds' in item))).toBe(true);
    });

    test('keeps a single process segment when more than ten tools occur without body text', () => {
        const items = buildAssistantOutputItems([reasoning('分析'), tools(1, 25), text('最终正文')], {
            isRunning: false
        });

        expect(items.map((item) => item.type)).toEqual(['process', 'final']);
        expect((items[0] as any).toolCount).toBe(25);
    });

    test('minimal running output commits completed stages once body text is available', () => {
        const items = buildAssistantOutputItems([reasoning('分析'), tools(1, 2), text('阶段正文'), tools(3, 1)], {
            isRunning: true
        });

        const visible = getVisibleAssistantOutputItems(items, { mode: 'minimal', isRunning: true });

        expect(visible.map((item) => item.type)).toEqual(['process', 'body', 'status']);
        expect((visible[2] as any).toolCount).toBe(3);

        const expanded = getVisibleAssistantOutputItems(items, {
            mode: 'minimal',
            isRunning: true,
            showRunningDetails: true
        });
        expect(expanded.map((item) => item.type)).toEqual(['process', 'body', 'status', 'process']);
    });

    test('minimal running output keeps only the current status before any body text exists', () => {
        const items = buildAssistantOutputItems([reasoning('分析'), tools(1, 2)], { isRunning: true });

        expect(
            getVisibleAssistantOutputItems(items, { mode: 'minimal', isRunning: true }).map((item) => item.type)
        ).toEqual(['status']);
    });

    test('running output does not append a finalizing status after visible text starts', () => {
        const items = buildAssistantOutputItems([reasoning('分析'), tools(1, 1), text('最终正文')], {
            isRunning: true
        });

        expect(
            getVisibleAssistantOutputItems(items, {
                mode: 'minimal',
                isRunning: true,
                parts: [reasoning('分析'), tools(1, 1), text('最终正文')]
            }).map((item) => item.type)
        ).toEqual(['process', 'body']);
    });

    test('minimal output preserves the alternating flow when execution ends and marks the last body final', () => {
        const parts = [reasoning('分析'), tools(1, 2), text('阶段正文'), tools(3, 1), text('最终正文')];
        const runningItems = buildAssistantOutputItems(parts, { isRunning: true });
        const completedItems = buildAssistantOutputItems(parts, { isRunning: false });

        expect(
            getVisibleAssistantOutputItems(runningItems, { mode: 'minimal', isRunning: true }).map((item) => item.type)
        ).toEqual(['process', 'body', 'process', 'body']);
        expect(
            getVisibleAssistantOutputItems(completedItems, { mode: 'minimal', isRunning: false }).map(
                (item) => item.type
            )
        ).toEqual(['process', 'body', 'process', 'final']);
    });

    test('detailed running output preserves the same process model and includes the current text', () => {
        const items = buildAssistantOutputItems([reasoning('分析'), tools(1, 2), text('当前正文')], {
            isRunning: true
        });

        const visible = getVisibleAssistantOutputItems(items, { mode: 'detailed', isRunning: true });

        expect(visible.map((item) => item.type)).toEqual(['process', 'body']);
    });

    test('process defaults differ by mode while inner detail remains user controlled', () => {
        expect(getDefaultProcessExpanded('minimal')).toBe(false);
        expect(getDefaultProcessExpanded('detailed')).toBe(true);
    });
});
