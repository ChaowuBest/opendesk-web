import { z } from 'zod';
import { BaseTool } from '../../../main/aikernel/tool.js';

/**
 * BaseTool.getJsonSchema() 应在工具实例层面缓存 params 的 JSON Schema，
 * 避免每次校验/权限声明/上下文统计都重新执行 zod 的 toJSONSchema 全量计算。
 * 缓存按 params 引用失效：params 被替换后必须重新生成。
 */
describe('BaseTool.getJsonSchema caching', () => {
    test('同一 params 引用下重复调用复用同一对象', () => {
        const tool = new BaseTool('cacheTool', 'cache tool', z.object({ a: z.string() }));
        const first = tool.getJsonSchema();
        const second = tool.getJsonSchema();
        expect(second).toBe(first);
    });

    test('toJSON 的 params 复用同一缓存对象', () => {
        const tool = new BaseTool('cacheTool', 'cache tool', z.object({ a: z.string() }));
        const json = tool.toJSON() as any;
        expect(json.params).toBe(tool.getJsonSchema());
    });

    test('params 被替换后缓存失效并重新生成', () => {
        const tool = new BaseTool('cacheTool', 'cache tool', z.object({ a: z.string() }));
        const stale = tool.getJsonSchema();

        const SchemaB = z.object({ b: z.number() });
        tool.params = SchemaB as any;
        const fresh = tool.getJsonSchema();

        expect(fresh).not.toBe(stale);
        expect(Object.keys((fresh as any).properties)).toEqual(['b']);
    });
});
