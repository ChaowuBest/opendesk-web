import { ToolCall, ToolCallMessagePart } from '../../../main/aikernel/messages.js';
import { serializeTaskUpdateForRender } from '../../../main/aikernel/task/update-render.js';
import { getToolDisplayNameKey, humanizeToolName } from '../../../common/tool-display-name.js';
import { enUs } from '../../../locale/en-us.js';
import { setRuntimeLocale } from '../../../locale/index.js';
import { zhCn } from '../../../locale/zh-cn.js';

describe('ToolCall GUI render payload', () => {
    beforeEach(() => {
        setRuntimeLocale('zh-CN');
    });

    afterEach(() => {
        setRuntimeLocale(null);
    });

    test('humanizes generic tool names without changing the protocol identifier', () => {
        expect(getToolDisplayNameKey('filemgr-readFile')).toBe('renderer.taskview.toolName.readFile');
        expect(getToolDisplayNameKey('filemgr-grep')).toBe('renderer.taskview.toolName.grep');
        expect(getToolDisplayNameKey('filemgr-grepFiles')).toBe('renderer.taskview.toolName.grep');
        expect(getToolDisplayNameKey('skill-manager-LoadSkill')).toBe('renderer.taskview.toolName.loadSkill');
        expect(getToolDisplayNameKey('search-WebSearch')).toBe('renderer.taskview.toolName.webSearch');
        expect(humanizeToolName('plugin-demo-fetchRecords')).toBe('plugin / demo / fetch Records');
        expect(humanizeToolName('')).toBe('');
    });

    test.each([
        ['browser-navigate', 'renderer.taskview.toolName.browserNavigate'],
        ['browser-snapshot', 'renderer.taskview.toolName.browserSnapshot'],
        ['browser-click', 'renderer.taskview.toolName.browserClick'],
        ['browser-type', 'renderer.taskview.toolName.browserType'],
        ['filemgr-readImage', 'renderer.taskview.toolName.readImage'],
        ['terminal-checkShellStatus', 'tools.checkShellStatus.name'],
        ['search-bingSearch', 'search.bing.name'],
        ['task-info-listRecentTasks', 'tools.listRecentTasks.name'],
        ['mailbox-getEmailList', 'renderer.taskview.toolName.getEmailList'],
        ['knowledgebase-operate-askKnowledgeBase', 'renderer.taskview.toolName.askKnowledgeBase'],
        ['global-todos-listGlobalTodos', 'renderer.taskview.toolName.listGlobalTodos'],
        ['mcp-manage-listMcpServers', 'renderer.taskview.toolName.listMcpServers'],
        ['devicemgr-executeNodeShell', 'renderer.taskview.toolName.executeNodeShell'],
        ['devicemgr-readNodeFile', 'renderer.taskview.toolName.readNodeFile'],
        ['channel-outbound-SendFile', 'renderer.taskview.toolName.SendFile'],
        ['workflow-agent-CompleteWorkflowAgent', 'renderer.taskview.toolName.CompleteWorkflowAgent'],
        ['current-presentation-open_presentation', 'renderer.taskview.toolName.open_presentation']
    ])('registers a display name for built-in tool %s', (toolName, expectedKey) => {
        expect(getToolDisplayNameKey(toolName)).toBe(expectedKey);
    });

    test('distinguishes HarmonyOS operations from browser operations with the same short name', () => {
        expect(getToolDisplayNameKey('browser-click')).toBe('renderer.taskview.toolName.browserClick');
        expect(getToolDisplayNameKey('use-harmony-click')).toBe('renderer.taskview.toolName.harmonyClick');
        expect(getToolDisplayNameKey('browser-snapshot')).toBe('renderer.taskview.toolName.browserSnapshot');
        expect(getToolDisplayNameKey('use-harmony-snapshot')).toBe('renderer.taskview.toolName.harmonySnapshot');
    });

    test('keeps every task-view tool label localized in Chinese and English', () => {
        const prefix = 'renderer.taskview.toolName.';
        const zhKeys = Object.keys(zhCn)
            .filter((key) => key.startsWith(prefix))
            .sort();
        const enKeys = Object.keys(enUs)
            .filter((key) => key.startsWith(prefix))
            .sort();

        expect(enKeys).toEqual(zhKeys);
        expect(zhKeys.length).toBeGreaterThan(190);
        for (const key of zhKeys) {
            expect(zhCn[key]).toBeTruthy();
            expect(enUs[key]).toBeTruthy();
        }
    });

    test('uses a localized human-readable label in the generic fallback card', async () => {
        const call = new ToolCall(0, 'call-generic', 'filemgr-readFile', '{}');
        const html = await call.render();
        expect(html).toContain(zhCn['renderer.taskview.toolName.readFile']);
        expect(html).not.toContain('filemgr-readFile');
    });

    test('uses the concise Chinese label for Bash commands', async () => {
        const call = new ToolCall(0, 'call-bash', 'terminal-executeBash', '{}');
        const html = await call.render();
        expect(html).toContain(zhCn['renderer.taskview.toolName.executeBash']);
        expect(html).not.toContain('执行 Bash 命令');
    });

    test('uses the same human-readable label for generic error cards', async () => {
        const call = new ToolCall(0, 'call-error', 'filemgr-readFile', '{}');
        call.status = 'error';
        call.result = '读取失败';
        const html = await call.render();
        expect(html).toContain(zhCn['renderer.taskview.toolName.readFile']);
        expect(html).not.toContain('filemgr-readFile');
    });

    test('uses the mainline rendered card and excludes raw arguments and results', () => {
        const call = new ToolCall(0, 'call-1', 'terminal-executeZsh', '{"command":"npm test"}');
        call.args_object = { command: 'npm test' };
        call.result = '6 passed';
        call.status = 'success';
        call.rendered = '<details class="terminal-tool">terminal result</details>';

        expect(call.toRenderJSON()).toEqual({
            index: 0,
            id: 'call-1',
            tool_name: 'terminal-executeZsh',
            status: 'success',
            rendered: '<details class="terminal-tool">terminal result</details>'
        });
        expect(call.toRenderJSON()).not.toHaveProperty('args_string');
        expect(call.toRenderJSON()).not.toHaveProperty('args_object');
        expect(call.toRenderJSON()).not.toHaveProperty('result');
    });

    test('supports legacy task data with missing arguments', () => {
        const call = new ToolCall(0, 'call-legacy', 'Legacy', '{}');
        (call as any).args_string = undefined;

        expect(call.toRenderJSON()).toEqual({
            index: 0,
            id: 'call-legacy',
            tool_name: 'Legacy',
            status: 'pending',
            rendered: undefined
        });
    });

    test('serializes live Electron updates with the complete mainline tool-card snapshot', () => {
        const call = new ToolCall(0, 'call-live', 'terminal-executeZsh', '{"command":"npm test"}');
        call.result = 'live result';
        const part = new ToolCallMessagePart();
        part.toolcalls.push(call);
        part.rendered = '<div class="terminal-tool">mainline terminal card</div>';

        const update = serializeTaskUpdateForRender({
            type: 'assistant',
            task_id: 'task-1',
            task_status: 'running',
            message_id: 'message-1',
            last_part_index: 0,
            last_part: part
        });
        const tool = (update as any).last_part.toolcalls[0];

        expect(tool).not.toHaveProperty('args_string');
        expect(tool).not.toHaveProperty('result');
        expect((update as any).last_part.rendered).toBe('<div class="terminal-tool">mainline terminal card</div>');
    });
});
