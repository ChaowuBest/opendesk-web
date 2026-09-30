import { z } from 'zod';
import { enUs } from '../../../locale/en-us.js';
import { zhCn } from '../../../locale/zh-cn.js';
import { BaseTool, BaseToolset } from '../../../main/aikernel/tool.js';

function register(toolsetName: string, toolName: string): BaseTool<any> {
    const tool = new BaseTool(toolName, 'test tool', z.object({}));
    new BaseToolset(toolsetName).addTool(tool);
    return tool;
}

describe('existing built-in tool display names', () => {
    test.each([
        ['filemgr', 'globFiles', 'filemgr.glob.name'],
        ['knowledgebase-operate', 'askKnowledgeBase', 'search.kb.ask.name'],
        ['knowledgebase-operate', 'retrieveFromKnowledgeBase', 'search.kb.retrieve.name'],
        ['mailbox', 'searchEmails', 'search.email.name'],
        ['memory', 'addMemory', 'tools.memory.add.name'],
        ['planning', 'waitSubTask', 'tools.waitSubTask.name'],
        ['search', 'webFetch', 'search.webfetch.name'],
        ['task-info', 'listRecentTasks', 'tools.listRecentTasks.name'],
        ['user_portrait', 'updateUserPortrait', 'tools.memory.updateUserPortrait.name']
    ])('reuses the existing locale key for %s:%s', (toolsetName, toolName, expectedKey) => {
        const tool = register(toolsetName, toolName);

        expect(tool.displayNameKey).toBe(expectedKey);
        expect(zhCn[expectedKey]).toBeTruthy();
        expect(enUs[expectedKey]).toBeTruthy();
    });

    test('does not invent display metadata for a tool without an existing mainline title', () => {
        expect(register('calendar', 'getCalendarItems').displayNameKey).toBeUndefined();
        expect(register('plugin-example', 'opaqueOperation').displayNameKey).toBeUndefined();
    });

    test('keeps an explicit display key supplied by a dynamic tool', () => {
        const tool = new BaseTool('opaqueOperation', 'test tool', z.object({}), 'plugin.tool.name');
        new BaseToolset('plugin-example').addTool(tool);

        expect(tool.displayNameKey).toBe('plugin.tool.name');
    });
});
