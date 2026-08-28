import { ToolCall, ToolCallMessagePart } from '../../../main/aikernel/messages.js';
import { serializeTaskUpdateForRender } from '../../../main/aikernel/task/update-render.js';

describe('ToolCall GUI render payload', () => {
    test('keeps the task snapshot lightweight while preserving a bounded argument preview', () => {
        const call = new ToolCall(0, 'call-1', 'terminal-executeZsh', '{"command":"npm test"}');
        call.args_object = { command: 'npm test' };
        call.result = '6 passed';
        call.status = 'success';
        call.elapsedSeconds = 1.4;
        call.rendered = '<div>terminal result</div>';

        expect(call.toRenderJSON()).toEqual({
            index: 0,
            id: 'call-1',
            tool_name: 'terminal-executeZsh',
            status: 'success',
            args_preview: '{"command":"npm test"}',
            args_truncated: false,
            detail_available: true,
            presentation: {
                displayName: 'Zsh',
                summary: { key: 'renderer.taskview.output.purpose.shell' }
            },
            elapsedSeconds: 1.4
        });
    });

    test('caps argument previews and never includes the raw tool result', () => {
        const call = new ToolCall(0, 'call-large', 'terminal-executeZsh', `{"command":"${'x'.repeat(10_000)}"}`);
        call.result = 'sensitive output';

        const payload = call.toRenderJSON() as Record<string, unknown>;

        expect(String(payload.args_preview).length).toBeLessThanOrEqual(2048);
        expect(payload.args_truncated).toBe(true);
        expect(payload).not.toHaveProperty('args_string');
        expect(payload).not.toHaveProperty('result');
        expect(payload).not.toHaveProperty('rendered');
    });

    test('normalizes missing arguments from legacy task data', () => {
        const call = new ToolCall(0, 'call-legacy', 'Legacy', '{}');
        (call as any).args_string = undefined;

        expect(call.toRenderJSON()).toMatchObject({
            args_preview: '',
            args_truncated: false
        });
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

    test('uses the shared default presentation for built-in tools without a runtime tool instance', () => {
        const call = new ToolCall(
            0,
            'call-default-presentation',
            'filemgr-readFile',
            '{"file_path":"/workspace/package.json"}'
        );

        expect(call.getPresentation()).toMatchObject({
            summary: {
                key: 'renderer.taskview.output.purpose.readFile',
                params: { name: 'package.json' }
            },
            resource: { type: 'preview', value: '/workspace/package.json' }
        });
        expect(call.getPresentation().displayName).not.toBe('filemgr-readFile');
    });

    test('uses a localized action name for Bash execution', () => {
        const call = new ToolCall(0, 'call-bash', 'terminal-executeBash', '{"command":"pwd"}');

        expect(call.getPresentation().displayName).toEqual({
            key: 'renderer.taskview.output.toolName.executeCommand'
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

        expect(tool.args_preview).toBe('{"command":"npm test"}');
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
