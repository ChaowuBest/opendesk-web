import { OPENDESK_PLUGIN_CAPABILITIES, type ChatMessage } from '../../../../packages/plugin-sdk/src/index.js';

function readPrimaryText(message: ChatMessage): string {
    if (message.role === 'compact_separator') return message.summary;

    const part = message.content[0];
    if (!part) return '';
    if (part.type === 'text') return part.text;
    if (part.type === 'reasoning') return part.content;
    return '';
}

describe('OpenDesk plugin chat contract', () => {
    test('does not expose agent as a plugin capability', () => {
        expect(OPENDESK_PLUGIN_CAPABILITIES).not.toContain('agent');
    });

    test('narrows serialized messages and message parts by their discriminants', () => {
        const messages: ChatMessage[] = [
            {
                role: 'user',
                message_id: 'user-1',
                content: [{ type: 'text', text: 'hello' }],
                timestamp: 1
            },
            {
                role: 'assistant',
                message_id: 'assistant-1',
                content: [{ type: 'reasoning', content: 'thinking', source: 'reasoning_content' }]
            },
            {
                role: 'compact_separator',
                summary: 'summary',
                metadata: {
                    boundary_id: 'boundary-1',
                    summary_version: 1,
                    created_at: '2026-08-15T00:00:00.000Z'
                }
            }
        ];

        expect(messages.map(readPrimaryText)).toEqual(['hello', 'thinking', 'summary']);
    });
});
