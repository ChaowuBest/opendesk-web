import { describe, expect, test } from '@jest/globals';
import { OpenAIAdapter } from '../../../main/aikernel/adapters/openai.js';
import {
    AssistantMessage,
    ChatContext,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../main/aikernel/messages.js';
import { buildFullCompactPlan, buildFullCompactSummaryText } from '../../../main/aikernel/compaction/full-compact.js';
import { serializeActiveContextForSessionMemory } from '../../../main/aikernel/compaction/session-memory-compact.js';
import { buildActiveContextView } from '../../../main/aikernel/compaction/context-view.js';
import { buildToolResultReplacementText } from '../../../main/aikernel/compaction/tool-results.js';

const artifactPath = `C:\\任务 资料\\${'nested-directory\\'.repeat(24)}完整结果.txt`;
const previewBody = 'Visible preview '.repeat(20).slice(0, 300) + 'OMITTED_PREVIEW_BODY'.repeat(180);

function contextWithResult() {
    const context = new ChatContext();
    context.appendMessage(new UserMessage('original goal'));
    const assistant = new AssistantMessage();
    const call = new ToolCall(0, 'summary-call', 'web_search', '{}');
    call.status = 'success';
    call.result = 'RAW_TOOL_RESULT '.repeat(1_000);
    const part = new ToolCallMessagePart();
    part.push(call);
    assistant.appendToolCallPart(part);
    context.appendMessage(assistant);
    context.appendMessage(new UserMessage('recent question'));
    context.appendMessage(new AssistantMessage());
    return { context, call };
}

const serializers = [
    {
        name: 'full compact',
        serialize: (
            context: ChatContext,
            options: { toolResultOverrides?: Map<string, string>; toolResultPreviewChars?: number }
        ) => {
            const plan = buildFullCompactPlan(context, {
                tailMessageCount: 2,
                tailAssistantToolMessageCount: 0,
                tailAssistantErrorMessageCount: 0,
                tailPlanMessageCount: 0
            });
            expect(plan).toBeDefined();
            return buildFullCompactSummaryText(plan!, options);
        }
    },
    {
        name: 'session memory',
        serialize: (
            context: ChatContext,
            options: { toolResultOverrides?: Map<string, string>; toolResultPreviewChars?: number }
        ) => serializeActiveContextForSessionMemory(buildActiveContextView(context), options)
    }
];

describe.each(serializers)('$name tool result previews', ({ serialize }) => {
    test.each(['persisted', 'runtime'] as const)(
        '%s replacements use 300 body characters and retain the full artifact path',
        (source) => {
            const { context, call } = contextWithResult();
            const replacement = buildToolResultReplacementText(previewBody, artifactPath);
            call.ensureResultStorage({
                result_id: 'summary-result',
                relative_path: 'artifacts/task/tool-results/summary-result.txt',
                replacement_text: source === 'persisted' ? replacement : 'STALE_PERSISTED_PREVIEW'
            });
            const options =
                source === 'runtime' ? { toolResultOverrides: new Map([['summary-result', replacement]]) } : {};
            const before = JSON.stringify(context);
            const input = serialize(context, options);

            expect(input).toContain(previewBody.slice(0, 300) + '...');
            expect(input).toContain(`完整输出已保存至: ${artifactPath}`);
            expect(input).not.toContain('OMITTED_PREVIEW_BODY');
            expect(input).not.toContain('STALE_PERSISTED_PREVIEW');
            expect(input).not.toContain('RAW_TOOL_RESULT');
            expect(JSON.stringify(context)).toBe(before);
            const request = OpenAIAdapter.buildMessages(context, true, options) as Array<{
                role: string;
                content: string;
            }>;
            expect(request.find((message) => message.role === 'tool')?.content).toBe(replacement);
        }
    );

    test('ordinary results retain the 300 character default', () => {
        const { context, call } = contextWithResult();
        call.result = previewBody;
        const input = serialize(context, {});
        expect(input).toContain(previewBody.slice(0, 300));
        expect(input).not.toContain('OMITTED_PREVIEW_BODY');
    });

    test('short previews honor explicit limits while preserving long paths exactly once', () => {
        const { context, call } = contextWithResult();
        const replacement = buildToolResultReplacementText('a short description', artifactPath).replaceAll(
            '\n',
            '\r\n'
        );
        call.ensureResultStorage({ replacement_text: replacement });
        const input = serialize(context, { toolResultPreviewChars: 8 });
        expect(input).toContain('a short ...');
        expect(input).not.toContain('description');
        expect(input).toContain(artifactPath);
        expect(input.match(/完整输出已保存至/g)).toHaveLength(1);
    });

    test('artifact references remain separate when they start inside the preview limit', () => {
        const { context, call } = contextWithResult();
        call.ensureResultStorage({ replacement_text: buildToolResultReplacementText('short preview', artifactPath) });
        const input = serialize(context, {});
        expect(input).toContain(artifactPath);
        expect(input.match(/完整输出已保存至/g)).toHaveLength(1);
        expect(input.length).toBeLessThan(artifactPath.length + 600);
    });

    test('metadata provides the complete relative path when replacement text has no footer', () => {
        const { context, call } = contextWithResult();
        const relativePath = `artifacts/task/${'long-directory/'.repeat(30)}result.txt`;
        call.ensureResultStorage({ relative_path: relativePath, replacement_text: previewBody });
        const input = serialize(context, {});
        expect(input).toContain(relativePath);
        expect(input).not.toContain('OMITTED_PREVIEW_BODY');
        expect(input).not.toContain('RAW_TOOL_RESULT');
    });

    test('microcompact artifact paths survive preview truncation', () => {
        const { context, call } = contextWithResult();
        call.result = `[旧工具结果已被 microcompact 清理，以减少上下文体积。]\n${previewBody}\n完整输出可查看: ${artifactPath}`;
        const input = serialize(context, {});
        expect(input).toContain(`完整输出可查看: ${artifactPath}`);
        expect(input).not.toContain('OMITTED_PREVIEW_BODY');
    });

    test('trailing replacement text does not bypass the preview limit', () => {
        const { context, call } = contextWithResult();
        call.ensureResultStorage({
            replacement_text:
                buildToolResultReplacementText(previewBody, artifactPath) + '\n' + 'UNNEEDED_TRAILING_TEXT'.repeat(500)
        });
        const input = serialize(context, {});
        expect(input).toContain(artifactPath);
        expect(input).not.toContain('OMITTED_PREVIEW_BODY');
        expect(input).not.toContain('UNNEEDED_TRAILING_TEXT');
        expect(input.length).toBeLessThan(artifactPath.length + 900);
    });

    test('legacy references keep precedence and do not leak replacement paths', () => {
        const { context, call } = contextWithResult();
        call.compress_id = 'legacy-result-reference';
        call.ensureResultStorage({ relative_path: 'STALE_ARTIFACT.txt', replacement_text: previewBody });
        const input = serialize(context, {
            toolResultOverrides: new Map([
                [call.result_storage!.result_id, buildToolResultReplacementText(previewBody, artifactPath)]
            ])
        });
        expect(input).toContain(call.getLegacyCompressedResultText());
        expect(input).not.toContain(artifactPath);
        expect(input).not.toContain('STALE_ARTIFACT');
        expect(input).not.toContain('OMITTED_PREVIEW_BODY');
    });
});
