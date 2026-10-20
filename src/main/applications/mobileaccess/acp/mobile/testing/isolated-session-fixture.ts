/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import type { HostSessionConfigurableTask } from '../remote-session-service/host-binding.js';
import type { SourceChatMessage } from '../remote-session-service/session-projector.js';
/** 隔离会话 fixture 的三档规模；原先定义在旧 loopback 传输配置里。 */
export type IsolatedSessionFixtureName = 'empty' | 'mixed' | 'large';

const FIXTURE_CWD = '/tmp/opendesk-isolated-session-fixture';

function root(name: IsolatedSessionFixtureName, messages: SourceChatMessage[]): HostSessionConfigurableTask {
    return {
        task_id: `isolated-session-fixture-${name}`,
        task_name: `Isolated ${name} session fixture`,
        task_status: 'stopped',
        completion_status: 'success',
        workspace: FIXTURE_CWD,
        created_at: '2026-08-22T00:00:00.000Z',
        updated_at: '2026-08-22T00:00:01.000Z',
        internal: false,
        name_pending: false,
        chat_context: { messages },
        getTurnGeneration: () => 1,
        stop() {},
        async submitUserMessage() {
            throw new Error('the isolated session fixture does not support Prompt');
        },
        async waitUntilFinished() {
            throw new Error('the isolated session fixture does not support Prompt');
        },
        persistLater() {
            throw new Error('the isolated session fixture has no configuration to persist');
        }
    };
}

function mixedMessages(): SourceChatMessage[] {
    return [
        {
            role: 'user',
            message_id: 'fixture-user',
            timestamp: 1,
            content: [
                { type: 'text', text: '# User Markdown\n\n- [x] rendered' },
                { type: 'image_url', image_url: 'isolated://unavailable' },
                { type: 'file', path: 'isolated://unavailable' }
            ]
        },
        {
            role: 'assistant',
            message_id: 'fixture-assistant',
            timestamp: 2,
            content: [
                { type: 'reasoning', content: 'Public reasoning fixture', elapsedSeconds: 3 },
                {
                    type: 'tool_call',
                    toolcalls: [
                        {
                            id: 'fixture-tool',
                            tool_name: 'executeBash',
                            status: 'success',
                            result: 'printf "fixture"'
                        }
                    ]
                },
                { type: 'error', title: 'Fixture error', message: 'Isolated error body' },
                {
                    type: 'text',
                    text: 'Assistant **Markdown**\n\n```sh\nprintf "fixture"\n```\n\n[safe](https://EXAMPLE.com/a) [blocked](file:///secret)'
                }
            ]
        },
        { role: 'compact_separator' },
        { role: 'assistant', message_id: 'fixture-empty', content: [] }
    ];
}

function largeMessages(): SourceChatMessage[] {
    const messages: SourceChatMessage[] = [];
    for (let index = 0; index < 6; index += 1) {
        messages.push({
            role: 'assistant',
            message_id: `fixture-large-${index}`,
            content: [{ type: 'text', text: String(index).repeat(1_000_000) }]
        });
    }
    messages.push({
        role: 'assistant',
        message_id: 'fixture-large-tool',
        content: [
            {
                type: 'tool_call',
                toolcalls: [
                    {
                        id: 'fixture-large-result',
                        tool_name: 'executeBash',
                        status: 'success',
                        result: 'r'.repeat(1_900_000)
                    }
                ]
            }
        ]
    });
    return messages;
}

export function createIsolatedSessionFixture(name: IsolatedSessionFixtureName): HostSessionConfigurableTask {
    if (name === 'empty') return root(name, []);
    if (name === 'mixed') return root(name, mixedMessages());
    return root(name, largeMessages());
}
