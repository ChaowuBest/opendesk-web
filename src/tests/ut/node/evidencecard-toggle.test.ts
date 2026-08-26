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

function enableEvidenceCard(): void {
    Setting.updateInstanceData({
        task_config: {
            auto_retry: true,
            generate_taskname: true,
            termination_check: true,
            evidence_card: true
        }
    });
}

function makeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    options: { status?: 'success' | 'error'; result?: string } = {}
): any {
    return {
        id: `call-${toolName}`,
        tool_name: toolName,
        status: options.status ?? 'success',
        args_object: args,
        args_string: JSON.stringify(args),
        result: options.result ?? 'ok'
    };
}

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
        tool_name: 'terminal-executePowerShell',
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

test('EvidenceCard ledger records a file read inside a Skill wrapper', () => {
    Setting.updateInstanceData({
        task_config: {
            auto_retry: true,
            generate_taskname: true,
            termination_check: true,
            evidence_card: true
        }
    });
    const task = {
        enableEvidenceCard: true,
        evidencecard_state: createEvidenceCardState(true)
    };
    const toolCall = {
        id: 'call-skill-read',
        tool_name: 'skill-manager-CallSkillTool',
        status: 'success',
        args_object: {
            bundleName: 'example',
            skillName: 'coding',
            toolName: 'readFile',
            toolArgs: '{"file_path":"/repo/a.ts"}'
        },
        args_string:
            '{"bundleName":"example","skillName":"coding","toolName":"readFile","toolArgs":"{\\"file_path\\":\\"/repo/a.ts\\"}"}',
        result: 'export const value = 1;'
    } as any;

    recordEvidenceCardToolCall(task, toolCall);

    assert.equal(task.evidencecard_state.ledger.length, 1);
    assert.equal(task.evidencecard_state.ledger[0]?.target, 'file:read:/repo/a.ts:full');
    assert.equal(task.evidencecard_state.ledger[0]?.evidence_kind, 'full_file');
    assert.equal(task.evidencecard_state.ledger[0]?.phase, 'inspect');
    assert.equal(task.evidencecard_state.ledger[0]?.repeated_evidence, false);
});

test('successful stable reads and searches are repeated only after the first matching target', () => {
    enableEvidenceCard();
    const task = {
        enableEvidenceCard: true,
        evidencecard_state: createEvidenceCardState(true)
    };
    const readCall = makeToolCall('filemgr-readFile', { file_path: '/repo/a.ts' });
    const searchCall = makeToolCall('filemgr-grepFiles', { path: '/repo', pattern: 'EvidenceCard' });

    recordEvidenceCardToolCall(task, readCall);
    recordEvidenceCardToolCall(task, readCall);
    recordEvidenceCardToolCall(task, searchCall);
    recordEvidenceCardToolCall(task, searchCall);

    assert.deepEqual(
        task.evidencecard_state.ledger.map((entry) => entry.repeated_evidence),
        [false, true, false, true]
    );
    assert.equal(task.evidencecard_state.ledger[1]?.decision, 'reuse');
    assert.equal(task.evidencecard_state.ledger[3]?.decision, 'reuse');
    assert.equal(task.evidencecard_state.target_counts['file:read:/repo/a.ts:full'], 2);
    const searchTarget = task.evidencecard_state.ledger[2]?.target;
    assert.equal(searchTarget ? task.evidencecard_state.target_counts[searchTarget] : undefined, 2);
    assert.equal(task.evidencecard_state.repeated_evidence_count, 2);
});

test('EvidenceCard records only file and explicit shell read or search tools', () => {
    enableEvidenceCard();
    const task = {
        enableEvidenceCard: true,
        evidencecard_state: createEvidenceCardState(true)
    };
    const calls = [
        makeToolCall('filemgr-readFile', { file_path: '/repo/a.ts' }),
        makeToolCall('filemgr-editFile', { filePath: '/repo/a.ts', oldString: 'a', newString: 'b' }),
        makeToolCall('terminal-executeBash', { command: 'npm test' }),
        makeToolCall('browser-navigate', { url: 'https://example.com' }),
        makeToolCall('future-tools-readSomething', { resourceId: 'resource-1' })
    ];

    for (const call of calls) {
        recordEvidenceCardToolCall(task, call);
    }

    assert.deepEqual(
        task.evidencecard_state.ledger.map((entry) => entry.tool_name),
        ['filemgr-readFile']
    );
});

test('state observations, actions, verification, interaction, planning, and edits are not recorded', () => {
    enableEvidenceCard();
    const task = {
        enableEvidenceCard: true,
        evidencecard_state: createEvidenceCardState(true)
    };
    const calls = [
        makeToolCall('terminal-checkShellStatus', { pid: 1234, kill: false }),
        makeToolCall('browser-navigate', { url: 'https://example.com' }),
        makeToolCall('skill-manager-CallSkillTool', {
            bundleName: 'builtin',
            skillName: 'use-harmony',
            toolName: 'snapshot',
            toolArgs: { bundleName: 'com.example.app' }
        }),
        makeToolCall('skill-manager-CallSkillTool', {
            bundleName: 'builtin',
            skillName: 'use-harmony',
            toolName: 'clickRef',
            toolArgs: { snapshotId: 's1', ref: 'e1', position: 'center' }
        }),
        makeToolCall('skill-manager-CallSkillTool', {
            bundleName: 'builtin',
            skillName: 'use-harmony',
            toolName: 'input',
            toolArgs: { x: 10, y: 20, text: 'value', mode: 'replace' }
        }),
        makeToolCall('skill-manager-CallSkillTool', {
            bundleName: 'builtin',
            skillName: 'use-harmony',
            toolName: 'findElement',
            toolArgs: { role: 'button', name: 'Send' }
        }),
        makeToolCall('skill-manager-CallSkillTool', {
            bundleName: 'builtin',
            skillName: 'use-harmony',
            toolName: 'visualAssert',
            toolArgs: { mode: 'theme', expected: 'dark' }
        }),
        makeToolCall('todomgr-TodoWrite', { todos: [{ id: '1', status: 'pending' }] }),
        makeToolCall('interaction-askUser', { questions: [{ question: 'Continue?' }] }),
        makeToolCall('filemgr-editFile', { filePath: '/repo/a.ts', oldString: 'a', newString: 'b' }),
        makeToolCall('terminal-executeBash', { command: 'npm test' })
    ];

    for (const call of calls) {
        recordEvidenceCardToolCall(task, call);
        recordEvidenceCardToolCall(task, call);
    }

    assert.equal(task.evidencecard_state.ledger.length, 0);
    assert.equal(task.evidencecard_state.total_tool_tokens, 0);
    assert.equal(task.evidencecard_state.repeated_evidence_count, 0);
    assert.deepEqual(task.evidencecard_state.target_counts, {});
});

test('large recognized reads can still be compressed when their result exceeds budget', () => {
    enableEvidenceCard();
    const task = {
        enableEvidenceCard: true,
        evidencecard_state: createEvidenceCardState(true)
    };
    const call = makeToolCall('filemgr-readFile', { file_path: '/repo/a.ts' }, { result: 'x'.repeat(20_000) });

    recordEvidenceCardToolCall(task, call);

    assert.equal(task.evidencecard_state.ledger[0]?.decision, 'compress');
    assert.equal(task.evidencecard_state.ledger[0]?.repeated_evidence, false);
    assert.equal(task.evidencecard_state.target_counts['file:read:/repo/a.ts:full'], 1);
});

test('a failed stable read does not make a successful retry repeated', () => {
    enableEvidenceCard();
    const task = {
        enableEvidenceCard: true,
        evidencecard_state: createEvidenceCardState(true)
    };
    const args = { file_path: '/repo/missing.ts' };

    recordEvidenceCardToolCall(task, makeToolCall('filemgr-readFile', args, { status: 'error', result: 'not found' }));
    recordEvidenceCardToolCall(task, makeToolCall('filemgr-readFile', args, { result: 'export const found = true;' }));

    assert.deepEqual(
        task.evidencecard_state.ledger.map((entry) => entry.repeated_evidence),
        [false, false]
    );
    assert.equal(task.evidencecard_state.ledger[0]?.status, 'error');
    assert.equal(task.evidencecard_state.ledger[1]?.status, 'success');
    assert.equal(task.evidencecard_state.target_counts['file:read:/repo/missing.ts:full'], 1);
    assert.equal(task.evidencecard_state.repeated_evidence_count, 0);
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
