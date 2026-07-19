import test from 'node:test';
import assert from 'node:assert/strict';
import { Setting } from '../../../main/utils/setting.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { AssistantMessage, UserMessage } from '../../../main/aikernel/messages.js';
import {
    createEvidenceCardState,
    recordEvidenceCardToolCall,
    syncEvidenceCardTaskState
} from '../../../main/utils/evidencecard.js';

test.beforeEach(() => {
    Setting.clearCache();
});

test.afterEach(() => {
    Setting.clearCache();
});

test('EvidenceCard task state follows task_config.evidence_card', () => {
    Setting.updateInstanceData({
        task_config: {
            auto_retry: true,
            generate_taskname: true,
            termination_check: true,
            evidence_card: false
        }
    });

    const task = {
        enableEvidenceCard: true,
        evidencecard_state: createEvidenceCardState(true)
    };

    assert.equal(syncEvidenceCardTaskState(task), false);
    assert.equal(task.enableEvidenceCard, false);
    assert.equal(task.evidencecard_state.enabled, false);

    Setting.updateInstanceData({
        task_config: {
            auto_retry: true,
            generate_taskname: true,
            termination_check: true,
            evidence_card: true
        }
    });

    assert.equal(syncEvidenceCardTaskState(task), true);
    assert.equal(task.enableEvidenceCard, true);
    assert.equal(task.evidencecard_state.enabled, true);
});

test('EvidenceCard ledger records tool calls only when evidence_card is enabled', () => {
    const task = {
        enableEvidenceCard: false,
        evidencecard_state: createEvidenceCardState(false)
    };
    const toolCall = {
        tool_name: 'terminal-exec',
        status: 'success',
        args_object: {
            command: 'Get-Content src/main/aikernel/states/tasks.ts',
            workingDirectory: 'E:/Huawei/OpenDesk'
        },
        args_string:
            '{"command":"Get-Content src/main/aikernel/states/tasks.ts","workingDirectory":"E:/Huawei/OpenDesk"}',
        result: 'export const demo = 1;',
        result_storage: {
            original_chars: 128
        }
    } as any;

    Setting.updateInstanceData({
        task_config: {
            auto_retry: true,
            generate_taskname: true,
            termination_check: true,
            evidence_card: false
        }
    });

    syncEvidenceCardTaskState(task);
    recordEvidenceCardToolCall(task, toolCall);
    assert.equal(task.evidencecard_state.ledger.length, 0);

    Setting.updateInstanceData({
        task_config: {
            auto_retry: true,
            generate_taskname: true,
            termination_check: true,
            evidence_card: true
        }
    });

    syncEvidenceCardTaskState(task);
    recordEvidenceCardToolCall(task, toolCall);
    assert.equal(task.evidencecard_state.ledger.length, 1);
    assert.equal(task.evidencecard_state.ledger[0]?.source, 'tool');
});

test('EvidenceCard state is not serialized into task JSON', () => {
    Setting.updateInstanceData({
        task_config: {
            auto_retry: true,
            generate_taskname: true,
            termination_check: true,
            evidence_card: true
        }
    });

    const task = new TaskState(new TaskManagerState());
    task.evidencecard_state.ledger.push({
        id: 'ec_test',
        step: 1,
        created_at: new Date().toISOString(),
        source: 'tool',
        phase: 'inspect',
        evidence_kind: 'full_file',
        target: 'src/main/aikernel/states/tasks.ts',
        planned_budget_tokens: 100,
        actual_tokens: 50,
        remaining_budget_tokens: 50,
        evidence_score: 0.9,
        budget_pressure: 'low',
        decision: 'collect',
        repeated_evidence: false,
        stop_rule: 'evidence recorded'
    });

    const json = task.toJSON() as Record<string, unknown>;

    assert.equal('enableEvidenceCard' in json, false);
    assert.equal('evidencecard_state' in json, false);
});

test('EvidenceCard state resets after task rewind', async () => {
    Setting.updateInstanceData({
        task_config: {
            auto_retry: true,
            generate_taskname: true,
            termination_check: true,
            evidence_card: true
        }
    });

    const task = new TaskState(new TaskManagerState());
    const user = new UserMessage('first');
    const assistant = new AssistantMessage();
    task.chat_context.messages.push(user, assistant);
    task.evidencecard_state.ledger.push({
        id: 'ec_test',
        step: 1,
        created_at: new Date().toISOString(),
        source: 'tool',
        phase: 'inspect',
        evidence_kind: 'full_file',
        target: 'src/main/aikernel/states/tasks.ts',
        planned_budget_tokens: 100,
        actual_tokens: 50,
        remaining_budget_tokens: 50,
        evidence_score: 0.9,
        budget_pressure: 'low',
        decision: 'collect',
        repeated_evidence: false,
        stop_rule: 'evidence recorded'
    });

    await task.rewindToUserMessage(user.message_id, { resubmit: false, source: 'tui' });

    assert.equal(task.evidencecard_state.ledger.length, 0);
    assert.equal(task.enableEvidenceCard, true);
});
