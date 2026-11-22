import { z } from 'zod';
import { ToolCall } from '../../../main/aikernel/messages.js';
import { BaseTool, BaseToolset } from '../../../main/aikernel/tool.js';
import { DefaultToolCallView } from '../../../main/tui/components/toolcall.js';
import { setRuntimeLocale } from '../../../locale/index.js';

function stripAnsi(value: string): string {
    return value.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('tool display names', () => {
    beforeAll(() => setRuntimeLocale('zh-CN'));
    afterAll(() => setRuntimeLocale(null));

    test('resolves the self-described bilingual name per locale in renderers', async () => {
        const tool = new BaseTool('readFile', 'desc', z.object({}), undefined, {
            'zh-CN': '读取文件',
            'en-US': 'Read File'
        });
        const call = new ToolCall(0, 'call-1', 'readFile', '{}');
        call.setTool(tool);

        expect(tool.getResolvedDisplayName('zh-CN')).toBe('读取文件');
        expect(tool.getResolvedDisplayName('en-US')).toBe('Read File');
        expect(await call.render()).toContain('读取文件');
        expect(stripAnsi(new DefaultToolCallView(call).render(80).join('\n'))).toContain('读取文件');
    });

    test('keeps custom tool rendering authoritative', async () => {
        const tool = new BaseTool('custom-tool', 'Custom tool', z.object({}), undefined, '自定义');
        tool.renderToolCall = async () => '<div>Custom title</div>';
        const call = new ToolCall(0, 'call-2', 'custom-tool', '{}');
        call.setTool(tool);

        // 自定义渲染结果仍是卡片主体，原样保留；外层仅由 ToolCall.render 包一层
        // data-toolcall-id 标识（渲染端按 toolcall 粒度做增量卡片替换时依赖此定位）
        expect(await call.render()).toBe('<div data-toolcall-id="call-2"><div>Custom title</div></div>');
    });

    test('falls back to the protocol name when the tool has no display name', () => {
        const tool = new BaseTool('bareTool', 'desc', z.object({}));
        expect(tool.getResolvedDisplayName('zh-CN')).toBe('bareTool');
    });

    test('falls back to an explicit legacy display-name key only when provided', () => {
        const tool = new BaseTool('globFiles', 'desc', z.object({}), 'filemgr.glob.name');
        expect(tool.getResolvedDisplayName('zh-CN')).toBe('模式匹配');
        expect(tool.getResolvedDisplayName('en-US')).toBe('Glob');
    });

    test('registration builds a bilingual display name from an explicit locale key', () => {
        const tool = new BaseTool('globFiles', 'desc', z.object({}), 'filemgr.glob.name');
        new BaseToolset('filemgr').addTool(tool);

        expect(tool.getDisplayName()).toEqual({ 'zh-CN': '模式匹配', 'en-US': 'Glob' });
        expect(tool.getResolvedDisplayName('zh-CN')).toBe('模式匹配');
        expect(tool.getResolvedDisplayName('en-US')).toBe('Glob');
    });

    test('registration keeps an explicitly declared display name', () => {
        const tool = new BaseTool('addMemory', 'desc', z.object({}), undefined, {
            'zh-CN': '写入记忆',
            'en-US': 'Store Memory'
        });
        new BaseToolset('memory').addTool(tool);

        expect(tool.getResolvedDisplayName('zh-CN')).toBe('写入记忆');
        expect(tool.getResolvedDisplayName('en-US')).toBe('Store Memory');
    });
});

describe('ToolCall render-data contract', () => {
    beforeAll(() => setRuntimeLocale('zh-CN'));
    afterAll(() => setRuntimeLocale(null));

    test('toRenderJSON pushes the current-locale display name and never persists it', () => {
        const tool = new BaseTool('readFile', 'desc', z.object({}), undefined, {
            'zh-CN': '读取文件',
            'en-US': 'Read File'
        });
        const call = new ToolCall(0, 'call-1', 'readFile', '{}');
        call.setTool(tool);

        const renderJson = call.toRenderJSON() as Record<string, unknown>;
        expect(renderJson['display_name']).toBe('读取文件');

        // 序列化（持久化）数据只含 identifier，不含显示名
        const persisted = call.toJSON() as Record<string, unknown>;
        expect(persisted['display_name']).toBeUndefined();
        expect(persisted['display_name_key']).toBeUndefined();
        expect(persisted['tool_name']).toBe('readFile');

        // 渲染数据随当前语言实时变化
        expect(tool.getResolvedDisplayName('en-US')).toBe('Read File');
    });

    test('an orphan tool call without a tool instance falls back to the protocol name', () => {
        const call = new ToolCall(0, 'call-2', 'plugin-opaqueOperation', '{}');
        expect((call.toRenderJSON() as Record<string, unknown>)['display_name']).toBe('plugin-opaqueOperation');
    });

    test('never returns a non-string when the provider omits the tool name', () => {
        // 分片工具调用可能缺 function.name；旧实现会透传 undefined，
        // 导致渲染层 undefined.split 抛出未捕获异常并让 CLI 直接退出。
        const call = new ToolCall(0, 'call-nameless', undefined as any, '{}');
        expect(call.getResolvedToolDisplayName()).toBe('未命名工具');
        expect((call.toRenderJSON() as Record<string, unknown>)['display_name']).toBe('未命名工具');
    });

    test('ignores a tool instance that resolves to an empty display name', () => {
        const tool = new BaseTool('', 'desc', z.object({}), undefined, '   ');
        const call = new ToolCall(0, 'call-blank-name', 'readFile', '{}');
        call.setTool(tool);
        expect(call.getResolvedToolDisplayName()).toBe('readFile');
    });

    test('tool serialization keeps the display name for cross-boundary tool definitions', () => {
        const tool = new BaseTool('readFile', 'desc', z.object({}), undefined, {
            'zh-CN': '读取文件',
            'en-US': 'Read File'
        });
        const restored = BaseTool.fromJSON(tool.toJSON());
        expect(restored.getResolvedDisplayName('en-US')).toBe('Read File');
    });
});
