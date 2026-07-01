import { AssistantMessage, ReasoningMessagePart, TextMessagePart } from '../../../main/aikernel/messages';

function parseDelta(delta: object): AssistantMessage {
    return AssistantMessage.parseOpenAIMessage(delta);
}

describe('AssistantMessage think tag parsing', () => {
    test('parses a leading orphan closing think tag as reasoning in one chunk', () => {
        const message = new AssistantMessage();

        message.mergeChunk(parseDelta({ content: 'hidden reasoning</think>visible answer' }));

        expect(message.content).toHaveLength(2);
        expect(message.content[0].type).toBe('reasoning');
        expect((message.content[0] as ReasoningMessagePart).source).toBe('think_tag');
        expect((message.content[0] as ReasoningMessagePart).content).toBe('hidden reasoning');
        expect(message.content[1].type).toBe('text');
        expect((message.content[1] as TextMessagePart).text).toBe('visible answer');
    });

    test('keeps quoted leading closing think tags as text', () => {
        const quotedTags = [
            'The literal "</think>" marker should stay visible.',
            "The literal '</think>' marker should stay visible.",
            '讨论「</think>」这个标签。',
            'The literal `</think>` marker should stay visible.',
            '```html\n</think>\n```\nshould stay visible.'
        ];

        for (const text of quotedTags) {
            const message = new AssistantMessage();

            message.mergeChunk(parseDelta({ content: text }));

            expect(message.content).toHaveLength(1);
            expect(message.content[0].type).toBe('text');
            expect((message.content[0] as TextMessagePart).text).toBe(text);
        }
    });

    test('keeps quoted explicit think tag pairs as text', () => {
        const message = new AssistantMessage();
        const text = 'The literal "<think>hidden</think>" marker should stay visible.';

        message.mergeChunk(parseDelta({ content: text }));

        expect(message.content).toHaveLength(1);
        expect(message.content[0].type).toBe('text');
        expect((message.content[0] as TextMessagePart).text).toBe(text);
    });

    test('skips quoted closing think tags before the structural implicit close', () => {
        const message = new AssistantMessage();

        message.mergeChunk(parseDelta({ content: 'thinking about "</think>" as syntax</think>visible answer' }));

        expect(message.content).toHaveLength(2);
        expect(message.content[0].type).toBe('reasoning');
        expect((message.content[0] as ReasoningMessagePart).content).toBe('thinking about "</think>" as syntax');
        expect(message.content[1].type).toBe('text');
        expect((message.content[1] as TextMessagePart).text).toBe('visible answer');
    });

    test('skips quoted closing think tags before the structural explicit close', () => {
        const message = new AssistantMessage();

        message.mergeChunk(parseDelta({ content: '<think>thinking about "</think>" as syntax</think>visible answer' }));

        expect(message.content).toHaveLength(2);
        expect(message.content[0].type).toBe('reasoning');
        expect((message.content[0] as ReasoningMessagePart).content).toBe('thinking about "</think>" as syntax');
        expect(message.content[1].type).toBe('text');
        expect((message.content[1] as TextMessagePart).text).toBe('visible answer');
    });

    test('keeps accumulating streamed leading content until an orphan closing think tag arrives', () => {
        const message = new AssistantMessage();

        message.mergeChunk(parseDelta({ content: 'step 1\n' }));
        expect(message.isImplicitThinkCandidatePart(0)).toBe(true);

        message.mergeChunk(parseDelta({ content: 'step 2</think>' }));
        message.mergeChunk(parseDelta({ content: '\nFinal answer' }));

        expect(message.content).toHaveLength(2);
        expect(message.content[0].type).toBe('reasoning');
        expect((message.content[0] as ReasoningMessagePart).content).toBe('step 1\nstep 2');
        expect(message.isImplicitThinkCandidatePart(0)).toBe(false);
        expect(message.content[1].type).toBe('text');
        expect((message.content[1] as TextMessagePart).text).toBe('\nFinal answer');
    });

    test('does not treat non-leading open think tags as structural tags', () => {
        const message = new AssistantMessage();

        message.mergeChunk(parseDelta({ content: 'The literal <think> marker is being discussed.' }));

        expect(message.content).toHaveLength(1);
        expect(message.content[0].type).toBe('text');
        expect((message.content[0] as TextMessagePart).text).toBe('The literal <think> marker is being discussed.');
    });

    test('keeps non-leading open think tags inside implicit reasoning content', () => {
        const message = new AssistantMessage();

        message.mergeChunk(parseDelta({ content: 'hidden discussion of <think> markers</think>visible answer' }));

        expect(message.content).toHaveLength(2);
        expect(message.content[0].type).toBe('reasoning');
        expect((message.content[0] as ReasoningMessagePart).content).toBe('hidden discussion of <think> markers');
        expect(message.content[1].type).toBe('text');
        expect((message.content[1] as TextMessagePart).text).toBe('visible answer');
    });

    test('does not treat later closing think tags as implicit reasoning after explicit tags', () => {
        const message = new AssistantMessage();

        message.mergeChunk(parseDelta({ content: '<think>hidden</think>visible </think> tail' }));

        expect(message.content).toHaveLength(2);
        expect(message.content[0].type).toBe('reasoning');
        expect((message.content[0] as ReasoningMessagePart).content).toBe('hidden');
        expect(message.content[1].type).toBe('text');
        expect((message.content[1] as TextMessagePart).text).toBe('visible </think> tail');
    });

    test('keeps later literal think tags as text after an implicit think close', () => {
        const message = new AssistantMessage();

        message.mergeChunk(parseDelta({ content: 'hidden reasoning</think>visible answer' }));
        message.mergeChunk(parseDelta({ content: '\nDiscussing <think>' }));
        message.mergeChunk(parseDelta({ content: ' and </think> tags should continue.' }));

        expect(message.content).toHaveLength(2);
        expect(message.content[0].type).toBe('reasoning');
        expect((message.content[0] as ReasoningMessagePart).content).toBe('hidden reasoning');
        expect(message.content[1].type).toBe('text');
        expect((message.content[1] as TextMessagePart).text).toBe(
            'visible answer\nDiscussing <think> and </think> tags should continue.'
        );
    });
});
