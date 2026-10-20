import type {
    PublicSessionIdentifierCandidate,
    PublicSessionIdentifierPlan
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';
import type {
    LoadedPublicSessionTask,
    RemoteSessionTaskEntry,
    SourceChatMessage
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/session-projector.js';
import {
    HostSessionModelConfigurationError,
    type HostSessionConfigurableTask,
    type RemoteSessionConfigurationHostBinding
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/host-binding.js';

export const unavailableSessionConfigurationBinding: RemoteSessionConfigurationHostBinding = {
    readSessionModelConfiguration: () => undefined,
    setSessionModelConfiguration() {
        throw new HostSessionModelConfigurationError('configuration_unavailable');
    }
};

export const UUID_1 = '550e8400-e29b-41d4-a716-446655440000';
export const UUID_2 = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

// Host 绑定要求的是可配置任务（在加载任务之上多一个 persistLater），fixture 按该合同提供；
// 需要更窄的 LoadedPublicSessionTask 的调用方仍然适用，因为前者继承后者。
export function sourceTask(
    overrides: Partial<RemoteSessionTaskEntry> & { messages?: SourceChatMessage[] } = {}
): HostSessionConfigurableTask {
    return {
        task_id: 's1',
        task_name: ' Session ',
        task_status: 'running',
        completion_status: null,
        workspace: '/work',
        created_at: '2026-08-20T00:00:00.000Z',
        updated_at: '2026-08-22T00:00:00.000Z',
        finished_at: undefined,
        internal: false,
        name_pending: false,
        parent_id: undefined,
        chat_context: { messages: overrides.messages ?? [] },
        getTurnGeneration: () => 1,
        stop() {},
        async submitUserMessage() {
            throw new Error('session projector fixture does not support Prompt');
        },
        async waitUntilFinished() {
            throw new Error('session projector fixture does not support Prompt');
        },
        persistLater() {},
        ...overrides
    } as HostSessionConfigurableTask;
}

export function candidatePlan(candidates: readonly PublicSessionIdentifierCandidate[]): PublicSessionIdentifierPlan {
    const messages = new Map<number, string>();
    const tools = new Map<string, string>();
    candidates.forEach((candidate, ordinal) => {
        messages.set(candidate.sourceMessageIndex, ordinal === 0 ? UUID_1 : UUID_2);
        candidate.toolCalls.forEach((call) => {
            tools.set(
                `${candidate.sourceMessageIndex}:${call.partIndex}:${call.callIndex}`,
                `00000000-0000-5000-8000-${String(call.callIndex + 1).padStart(12, '0')}`
            );
        });
    });
    return {
        hasMessage: (index) => messages.has(index),
        hasToolCall: (index, partIndex, callIndex) => tools.has(`${index}:${partIndex}:${callIndex}`),
        messageId(index) {
            const value = messages.get(index);
            if (!value) throw new Error(`unknown message ${index}`);
            return value;
        },
        toolCallId(index, partIndex, callIndex) {
            const value = tools.get(`${index}:${partIndex}:${callIndex}`);
            if (!value) throw new Error('unknown tool');
            return value;
        },
        registerMessage() {
            throw new Error('not used by the projector fixture');
        },
        registerToolCall() {
            throw new Error('not used by the projector fixture');
        },
        rebindMessageToolCalls() {
            throw new Error('not used by the projector fixture');
        }
    };
}
