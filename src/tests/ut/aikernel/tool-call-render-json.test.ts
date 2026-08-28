import { ToolCall, ToolCallMessagePart } from '../../../main/aikernel/messages.js';
import { serializeTaskUpdateForRender } from '../../../platforms/electron-task-update-render.js';
import { ReadFileTool } from '../../../main/applications/filemgr/tools.js';
import { ExecuteBashTool, ExecuteZshTool } from '../../../main/applications/terminal/tools.js';
import { WebFetchTool } from '../../../main/applications/search/tools/webfetch.js';
import { BrowserNavigateTool } from '../../../main/applications/browser/tools.js';

describe('ToolCall GUI render payload', () => {
    test('keeps the task snapshot lightweight without exposing tool arguments', () => {
        const call = new ToolCall(0, 'call-1', 'terminal-executeZsh', '{"command":"npm test"}');
        call.args_object = { command: 'npm test' };
        call.result = '6 passed';
        call.status = 'success';
        call.elapsedSeconds = 1.4;
        call.rendered = '<div>terminal result</div>';
        call.setTool(new ExecuteZshTool());

        expect(call.toRenderJSON()).toEqual({
            index: 0,
            id: 'call-1',
            tool_name: 'terminal-executeZsh',
            status: 'success',
            detail_available: true,
            presentation: {
                displayName: 'Zsh',
                summary: { key: 'renderer.taskview.output.purpose.shell' }
            },
            elapsedSeconds: 1.4
        });
    });

    test('never includes tool arguments or the raw tool result', () => {
        const call = new ToolCall(0, 'call-large', 'terminal-executeZsh', `{"command":"${'x'.repeat(10_000)}"}`);
        call.result = 'sensitive output';

        const payload = call.toRenderJSON() as Record<string, unknown>;

        expect(payload).not.toHaveProperty('args_string');
        expect(payload).not.toHaveProperty('args_preview');
        expect(payload).not.toHaveProperty('args_truncated');
        expect(payload).not.toHaveProperty('result');
        expect(payload).not.toHaveProperty('rendered');
    });

    test('only advertises rendered-only detail after an explicit custom-detail opt-in', () => {
        const unsafe = new ToolCall(0, 'call-unsafe-render', 'terminal-executeZsh', '{"command":"secret"}');
        unsafe.rendered = '<details class="terminal-tool">secret</details>';

        const safe = new ToolCall(1, 'call-safe-render', 'plugin-safeDetail', '{}');
        safe.rendered = '<div class="tool-card">safe detail</div>';
        safe.presentation = { displayName: 'Safe detail', detailMode: 'custom' };

        expect(unsafe.toRenderJSON()).toMatchObject({ detail_available: false });
        expect(safe.toRenderJSON()).toMatchObject({ detail_available: true });
    });

    test('does not expose missing arguments from legacy task data', () => {
        const call = new ToolCall(0, 'call-legacy', 'Legacy', '{}');
        (call as any).args_string = undefined;

        expect(call.toRenderJSON()).toMatchObject({ detail_available: false });
    });

    test('serializes bounded presentation metadata supplied by the tool', () => {
        const call = new ToolCall(0, 'call-presentation', 'plugin-inspectArtifact', '{}');
        call.setTool({
            getToolCallPresentation: () => ({
                displayName: 'Inspect artifact',
                summary: 'Inspect report.txt',
                resource: { type: 'preview', value: '/workspace/report.txt' },
                resultFormat: 'markdown'
            })
        } as any);

        expect(call.toRenderJSON()).toMatchObject({
            presentation: {
                displayName: 'Inspect artifact',
                summary: 'Inspect report.txt',
                resource: { type: 'preview', value: '/workspace/report.txt' },
                resultFormat: 'markdown'
            }
        });
    });

    test('bounds untrusted presentation text and rejects unsupported resource actions', () => {
        const call = new ToolCall(0, 'call-untrusted-presentation', 'plugin-untrusted', '{}');
        call.setTool({
            getToolCallPresentation: () => ({
                displayName: 'n'.repeat(1_000),
                summary: 's'.repeat(4_000),
                activity: 'a'.repeat(4_000),
                resource: { type: 'execute', value: '/workspace/report.txt' }
            })
        } as any);

        const presentation = (call.toRenderJSON() as any).presentation;
        expect(Array.from(presentation.displayName)).toHaveLength(160);
        expect(Array.from(presentation.summary)).toHaveLength(512);
        expect(Array.from(presentation.activity)).toHaveLength(512);
        expect(presentation).not.toHaveProperty('resource');
    });

    test('keeps the core fallback independent from built-in tool names', () => {
        const call = new ToolCall(
            0,
            'call-default-presentation',
            'filemgr-readFile',
            '{"file_path":"/workspace/package.json"}'
        );

        expect(call.getPresentation()).toEqual({ displayName: 'filemgr-readFile' });
    });

    test('gets file presentation semantics from the file tool owner', () => {
        const call = new ToolCall(
            0,
            'call-file-presentation',
            'filemgr-readFile',
            '{"file_path":"/workspace/package.json"}'
        );
        call.args_object = { file_path: '/workspace/package.json' };
        call.setTool(new ReadFileTool());

        expect(call.getPresentation()).toMatchObject({
            summary: {
                key: 'renderer.taskview.output.purpose.readFile',
                params: { name: 'package.json' }
            },
            resource: { type: 'preview', value: '/workspace/package.json' },
            detailMode: 'resource'
        });
        expect(call.getPresentation().displayName).not.toBe('filemgr-readFile');
    });

    test('persists an owner-provided presentation for history when the tool is unavailable', () => {
        const call = new ToolCall(
            0,
            'call-persisted-presentation',
            'filemgr-readFile',
            '{"file_path":"/workspace/package.json"}'
        );
        call.args_object = { file_path: '/workspace/package.json' };
        call.setTool(new ReadFileTool());

        const restored = ToolCall.assign(JSON.parse(JSON.stringify(call)));

        expect(restored.tool).toBeUndefined();
        expect(restored.getPresentation()).toMatchObject({
            displayName: { key: 'filemgr.readFile.name' },
            resource: { type: 'preview', value: '/workspace/package.json' },
            detailMode: 'resource'
        });
    });

    test('uses a localized action name for Bash execution', () => {
        const call = new ToolCall(0, 'call-bash', 'terminal-executeBash', '{"command":"pwd"}');
        call.args_object = { command: 'pwd' };
        call.setTool(new ExecuteBashTool());

        expect(call.getPresentation().displayName).toEqual({
            key: 'renderer.taskview.output.toolName.executeCommand'
        });
    });

    test('gets Markdown and URL semantics from the search tool owner', () => {
        const call = new ToolCall(0, 'call-web-fetch', 'search-webFetch', '{"url":"https://example.com/docs"}');
        call.args_object = { url: 'https://example.com/docs' };
        call.setTool(new WebFetchTool());

        expect(call.getPresentation()).toEqual({
            displayName: { key: 'search.webfetch.name' },
            summary: {
                key: 'renderer.taskview.output.purpose.openUrl',
                params: { url: 'https://example.com/docs' }
            },
            resource: { type: 'url', value: 'https://example.com/docs' },
            resultFormat: 'markdown'
        });
    });

    test('gets navigation semantics from the browser tool owner', () => {
        const call = new ToolCall(0, 'call-navigate', 'browser-navigate', '{"url":"https://example.com"}');
        call.args_object = { url: 'https://example.com' };
        call.setTool(new BrowserNavigateTool({} as any));

        expect(call.getPresentation()).toMatchObject({
            displayName: { key: 'renderer.taskview.output.toolName.navigate' },
            resource: { type: 'url', value: 'https://example.com/' }
        });
    });

    test('serializes live Electron assistant updates through the lightweight render contract', () => {
        const call = new ToolCall(0, 'call-live', 'terminal-executeZsh', '{"command":"npm test"}');
        call.result = 'live result';
        const part = new ToolCallMessagePart();
        part.toolcalls.push(call);

        const update = serializeTaskUpdateForRender({
            type: 'assistant',
            task_id: 'task-1',
            task_status: 'running',
            message_id: 'message-1',
            last_part_index: 0,
            last_part: part
        });
        const tool = (update as any).last_part.toolcalls[0];

        expect(tool).not.toHaveProperty('args_preview');
        expect(tool).not.toHaveProperty('args_truncated');
        expect(tool).not.toHaveProperty('args_string');
        expect(tool).not.toHaveProperty('args_string');
        expect(tool).not.toHaveProperty('result');
        expect((update as any).last_part).not.toHaveProperty('rendered');
    });

    test('records elapsed execution time once finalized', () => {
        const call = new ToolCall(0, 'call-1', 'Search', '{}');
        call.startTiming(1_000);
        call.finalizeTiming(2_450);

        expect(call.elapsedSeconds).toBe(1.5);
        call.finalizeTiming(9_000);
        expect(call.elapsedSeconds).toBe(1.5);
    });
});
