/**
 * BaseTool.validateArgs 标量类型强制转换的单元测试。
 *
 * 覆盖范围：
 * - 模型将 boolean 输出为字符串 "true"/"false" → 正确转换为 boolean
 * - 模型将 number 输出为字符串 "0"/"42" → 正确转换为 number
 * - 已正确类型的值不被修改
 * - string 字段不被错误转换
 * - 包装层 (optional + default) 正确剥离
 * - 非对象参数原样返回
 */

import { BaseTool } from '../../../main/aikernel/tool';
import { z } from 'zod';

// 模拟真实工具 schema 结构（与 planning/tools.ts、filemgr/tools.ts 一致）
const testSchema = z.object({
    title: z.string(),
    isAsync: z.boolean().default(false),
    caseSensitive: z.boolean().optional().default(false),
    ignoreCase: z.boolean().optional().default(true),
    contextLines: z.number().min(0).max(100).optional().default(2),
    maxResults: z.number().int().min(1).max(500).default(50),
    name: z.string().optional()
});

function makeTool(): BaseTool<typeof testSchema> {
    return new BaseTool('testTool', 'test tool for coercion', testSchema);
}

describe('BaseTool.validateArgs 标量类型强制转换', () => {
    it('字符串 "false" 的 isAsync 被转换为 boolean false', () => {
        const tool = makeTool();
        const result = tool.validateArgs({
            title: 'test',
            isAsync: 'false'
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.isAsync).toBe(false);
        }
    });

    it('字符串 "true" 的 isAsync 被转换为 boolean true', () => {
        const tool = makeTool();
        const result = tool.validateArgs({
            title: 'test',
            isAsync: 'true'
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.isAsync).toBe(true);
        }
    });

    it('字符串 "false" 的 ignoreCase (optional+default 包装) 被转换', () => {
        const tool = makeTool();
        const result = tool.validateArgs({
            title: 'test',
            ignoreCase: 'false'
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.ignoreCase).toBe(false);
        }
    });

    it('字符串 "0" 的 contextLines 被转换为 number 0', () => {
        const tool = makeTool();
        const result = tool.validateArgs({
            title: 'test',
            contextLines: '0'
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.contextLines).toBe(0);
        }
    });

    it('字符串 "42" 的 maxResults 被转换为 number 42', () => {
        const tool = makeTool();
        const result = tool.validateArgs({
            title: 'test',
            maxResults: '42'
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.maxResults).toBe(42);
        }
    });

    it('多个字符串参数同时被正确转换', () => {
        const tool = makeTool();
        const result = tool.validateArgs({
            title: 'test',
            isAsync: 'true',
            ignoreCase: 'false',
            contextLines: '5',
            caseSensitive: 'true',
            maxResults: '100'
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.isAsync).toBe(true);
            expect(result.data.ignoreCase).toBe(false);
            expect(result.data.contextLines).toBe(5);
            expect(result.data.caseSensitive).toBe(true);
            expect(result.data.maxResults).toBe(100);
        }
    });

    it('已正确类型的 boolean 参数不被修改', () => {
        const tool = makeTool();
        const result = tool.validateArgs({
            title: 'test',
            isAsync: false,
            ignoreCase: true
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.isAsync).toBe(false);
            expect(result.data.ignoreCase).toBe(true);
        }
    });

    it('已正确类型的 number 参数不被修改', () => {
        const tool = makeTool();
        const result = tool.validateArgs({
            title: 'test',
            contextLines: 10,
            maxResults: 200
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.contextLines).toBe(10);
            expect(result.data.maxResults).toBe(200);
        }
    });

    it('string 字段值为 "true"/"false" 时不被错误转换为 boolean', () => {
        const tool = makeTool();
        const result = tool.validateArgs({
            title: 'true',
            name: 'false'
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.title).toBe('true');
            expect(result.data.name).toBe('false');
        }
    });

    it('非 boolean/number 的字符串值不被转换', () => {
        const tool = makeTool();
        const result = tool.validateArgs({
            title: 'test',
            isAsync: 'maybe' // 不是 "true"/"false"，不会被转换，Zod 校验应失败
        });
        expect(result.success).toBe(false);
    });

    it('非数字字符串的 number 字段不被转换', () => {
        const tool = makeTool();
        const result = tool.validateArgs({
            title: 'test',
            maxResults: 'abc' // 不是数字，不会被转换，Zod 校验应失败
        });
        expect(result.success).toBe(false);
    });

    it('非对象参数原样返回（Zod 自行处理）', () => {
        const tool = makeTool();
        const result = tool.validateArgs('not an object');
        expect(result.success).toBe(false);
    });

    it('null 参数原样返回', () => {
        const tool = makeTool();
        const result = tool.validateArgs(null);
        expect(result.success).toBe(false);
    });

    it('空字符串数字被转换（"0" → 0 但 "" 不转换）', () => {
        const tool = makeTool();
        // 空字符串不是有效数字，不应被转换
        const result = tool.validateArgs({
            title: 'test',
            contextLines: ''
        });
        expect(result.success).toBe(false);
    });
});
