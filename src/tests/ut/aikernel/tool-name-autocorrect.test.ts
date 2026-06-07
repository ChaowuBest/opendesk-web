/**
 * ChatContext.getTool() 工具名称自动纠错的单元测试。
 *
 * 覆盖范围：
 * - 精确匹配（正常路径）
 * - 等号→横线纠错（如 filemgr=readFile → filemgr-readFile）
 * - 补全包名纠错（如 readFile → filemgr-readFile）
 * - 等号替换后无匹配
 * - 包名补全时多个候选（唯一性检查）
 * - 包名补全时无匹配
 * - 边界情况
 */

import { ChatContext } from '../../../main/aikernel/messages';
import { BaseTool, BaseToolset } from '../../../main/aikernel/tool';
import { z } from 'zod';

function makeTool(name: string): BaseTool<z.ZodString> {
    return new BaseTool(name, `Tool: ${name}`, z.string());
}

function makeToolset(toolsetName: string, toolNames: string[]): BaseToolset {
    const toolset = new BaseToolset(toolsetName);
    for (const name of toolNames) {
        toolset.addTool(makeTool(name));
    }
    return toolset;
}

describe('ChatContext.getTool() 工具名称自动纠错', () => {
    let chatContext: ChatContext;

    beforeEach(() => {
        chatContext = new ChatContext();
        chatContext.attachToolsets(
            makeToolset('filemgr', ['ReadFile', 'WriteFile', 'EditFile', 'GlobFiles', 'GrepFiles']),
            makeToolset('search', ['WebSearch', 'AcademicSearch', 'WebFetch']),
            makeToolset('todomgr', ['GetCurrentTime', 'TodoWrite'])
        );
    });

    // ========== 精确匹配 ==========

    describe('精确匹配', () => {
        test('完整 toolsetName-toolName 精确匹配', () => {
            const tool = chatContext.getTool('filemgr-ReadFile');
            expect(tool).toBeDefined();
            expect(tool!.name).toBe('ReadFile');
        });

        test('不存在的工具返回 undefined', () => {
            const tool = chatContext.getTool('nonexistent-Tool');
            expect(tool).toBeUndefined();
        });
    });

    // ========== 等号→横线纠错 ==========

    describe('等号→横线自动纠错', () => {
        test('单个等号替换为横线后匹配成功', () => {
            const tool = chatContext.getTool('filemgr=ReadFile');
            expect(tool).toBeDefined();
            expect(tool!.name).toBe('ReadFile');
        });

        test('多个等号替换为横线后匹配成功', () => {
            const tool = chatContext.getTool('filemgr=GlobFiles');
            expect(tool).toBeDefined();
            expect(tool!.name).toBe('GlobFiles');
        });

        test('等号替换后无匹配返回 undefined', () => {
            const tool = chatContext.getTool('filemgr=NonExistent');
            expect(tool).toBeUndefined();
        });

        test('toolsetName 和 toolName 之间用等号，精确匹配', () => {
            const tool = chatContext.getTool('search=WebSearch');
            expect(tool).toBeDefined();
            expect(tool!.name).toBe('WebSearch');
        });
    });

    // ========== 补全包名纠错 ==========

    describe('漏掉包名的自动纠错', () => {
        test('只输出工具名，有唯一匹配时自动补全包名', () => {
            const tool = chatContext.getTool('ReadFile');
            expect(tool).toBeDefined();
            expect(tool!.name).toBe('ReadFile');
        });

        test('只输出工具名，匹配到其他 toolset 的工具', () => {
            const tool = chatContext.getTool('WebSearch');
            expect(tool).toBeDefined();
            expect(tool!.name).toBe('WebSearch');
        });

        test('只输出工具名，无任何匹配返回 undefined', () => {
            const tool = chatContext.getTool('NonExistentTool');
            expect(tool).toBeUndefined();
        });
    });

    // ========== 唯一性检查 ==========

    describe('唯一性检查', () => {
        test('多个 toolset 中存在同名工具时放弃纠错', () => {
            chatContext.attachToolsets(makeToolset('anothermgr', ['ReadFile', 'OtherTool']));

            const tool = chatContext.getTool('ReadFile');
            expect(tool).toBeUndefined();
        });

        test('有多个同名工具但输入带完整包名时不受影响', () => {
            chatContext.attachToolsets(makeToolset('anothermgr', ['ReadFile']));

            // 精确匹配仍然能工作
            const tool = chatContext.getTool('filemgr-ReadFile');
            expect(tool).toBeDefined();
            expect(tool!.name).toBe('ReadFile');
        });
    });

    // ========== 边界情况 ==========

    describe('边界情况', () => {
        test('包含横线但不精确匹配时，不触发补全包名逻辑', () => {
            const tool = chatContext.getTool('some-random-Name');
            expect(tool).toBeUndefined();
        });

        test('包含等号且等号在末尾', () => {
            const tool = chatContext.getTool('filemgr=');
            expect(tool).toBeUndefined();
        });

        test('包含等号且等号在开头', () => {
            const tool = chatContext.getTool('=ReadFile');
            expect(tool).toBeUndefined();
        });

        test('空字符串输入', () => {
            const tool = chatContext.getTool('');
            expect(tool).toBeUndefined();
        });

        test('GetCurrentTime 跨 toolset 唯一匹配', () => {
            const tool = chatContext.getTool('GetCurrentTime');
            expect(tool).toBeDefined();
            expect(tool!.name).toBe('GetCurrentTime');
        });
    });

    // ========== 纠错不影响正常流程 ==========

    describe('纠错不影响正常流程', () => {
        test('精确匹配正常工作', () => {
            expect(chatContext.getTool('filemgr-ReadFile')!.name).toBe('ReadFile');
            expect(chatContext.getTool('search-WebSearch')!.name).toBe('WebSearch');
            expect(chatContext.getTool('todomgr-TodoWrite')!.name).toBe('TodoWrite');
        });

        test('不存在的工具不影响后续查询', () => {
            expect(chatContext.getTool('unknown-Tool')).toBeUndefined();
            expect(chatContext.getTool('UnknownTool')).toBeUndefined();
            // 之后仍然能正常查询
            expect(chatContext.getTool('filemgr-ReadFile')).toBeDefined();
        });
    });
});
