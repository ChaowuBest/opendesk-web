import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { AssistantMessage, ToolCall, ToolCallMessagePart } from '../../../../../../main/aikernel/messages';
import { SkillRegistry } from '../../../../../../main/aikernel/skill';
import { logger } from '../../../../../../main/utils/logger';
import { TaskManagerState, TaskState } from '../../../../../../main/aikernel/states/tasks';
import {
    MANAGE_SKILLS_SKILL,
    MANAGE_SKILLS_SKILL_HARMONYOS
} from '../../../../../../main/applications/skillmgr/skills';
import {
    commandContainsDependencyToken,
    hasFailedBashBefore,
    onAfterExecuteNodeShell,
    onBeforeExecuteBash
} from '../../../../../../main/aikernel/harnesses/platform/harmonyos/skill-fallback';

function addCall(
    task: TaskState,
    name: string,
    args: Record<string, unknown>,
    resultObject: Record<string, unknown>,
    result = 'result'
): ToolCall {
    const call = new ToolCall(0, `call-${task.chat_context.messages.length}`, name, JSON.stringify(args));
    call.args_object = args;
    call.status = 'success';
    call.result = result;
    call.result_object = resultObject;
    const part = new ToolCallMessagePart();
    part.push(call);
    task.chat_context.appendMessage(new AssistantMessage([part]));
    return call;
}

const FALLBACK_FIELDS = {
    fallback: 'linux_vm',
    note: 'use Linux VM'
};

function fallbackRecord(
    name: string,
    recordedAt?: string,
    extra: Record<string, unknown> = {}
): Record<string, unknown> {
    return { name, ...FALLBACK_FIELDS, ...(recordedAt === undefined ? {} : { recordedAt }), ...extra };
}

async function runBeforeHook(
    skillDir: string,
    command: string
): Promise<{
    meta: any;
    append: jest.SpiedFunction<TaskState['appendInternalUserMessage']>;
}> {
    const task = new TaskState(new TaskManagerState());
    jest.spyOn(task, 'getLoadedSkillsFromContext').mockReturnValue([
        { bundleName: 'demo', skillName: 'demo-skill', turn: 1 }
    ]);
    jest.spyOn(SkillRegistry.getInstance(), 'getSkill').mockResolvedValue({ directory: skillDir } as any);
    const append = jest.spyOn(task, 'appendInternalUserMessage').mockResolvedValue();
    const call = new ToolCall(0, 'before-call', 'terminal-executeBash', JSON.stringify({ command }));
    call.args_object = { command };

    await onBeforeExecuteBash({ task, toolCall: call });

    return {
        meta: JSON.parse(fs.readFileSync(path.join(skillDir, 'opendesk_meta.json'), 'utf8')),
        append
    };
}

function expectFallbackCleared(record: Record<string, unknown>): void {
    expect(record).not.toHaveProperty('fallback');
    expect(record).not.toHaveProperty('note');
    expect(record).not.toHaveProperty('recordedAt');
}

describe('HarmonyOS fallback hooks', () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('uses token boundaries for dependency advisory matching', () => {
        expect(commandContainsDependencyToken('python -m pip install curl', 'curl')).toBe(true);
        expect(commandContainsDependencyToken('/usr/bin/curl --version', 'curl')).toBe(true);
        expect(commandContainsDependencyToken('echo curl-helper', 'curl')).toBe(true);
        expect(commandContainsDependencyToken('echo scurling', 'curl')).toBe(false);
    });

    test('documents the dedicated fallback record tool only in the HarmonyOS appendix', () => {
        expect(MANAGE_SKILLS_SKILL).not.toContain('recordHarmonyosFallback');
        expect(MANAGE_SKILLS_SKILL_HARMONYOS).toContain('recordHarmonyosFallback');
        expect(MANAGE_SKILLS_SKILL_HARMONYOS).toContain('opendesk_meta.json');
        expect(MANAGE_SKILLS_SKILL_HARMONYOS).toContain('通用文件写工具');
        expect(MANAGE_SKILLS_SKILL_HARMONYOS).toContain('LoadSkill');
    });

    test('finds a failed Bash within the five-call sliding window', () => {
        const task = new TaskState(new TaskManagerState());
        addCall(task, 'terminal-executeBash', { command: 'A failed' }, { exitCode: 1 }, 'A error');
        for (let index = 0; index < 4; index++) {
            addCall(task, 'unrelatedTool', { index }, {});
        }
        const current = addCall(
            task,
            'devicemgr-executeNodeShell',
            { command: 'final fallback chosen by the LLM' },
            { exitCode: 0, nodeId: 'opendesk-headless-localhost' },
            'ok'
        );

        expect(hasFailedBashBefore(task, current)).toBe(true);
    });

    test('finds a failed Zsh within the five-call sliding window', () => {
        const task = new TaskState(new TaskManagerState());
        addCall(task, 'terminal-executeZsh', { command: 'A failed' }, { exitCode: 1 }, 'A error');
        for (let index = 0; index < 4; index++) {
            addCall(task, 'unrelatedTool', { index }, {});
        }
        const current = addCall(
            task,
            'devicemgr-executeNodeShell',
            { command: 'final fallback chosen by the LLM' },
            { exitCode: 0, nodeId: 'opendesk-headless-localhost' },
            'ok'
        );

        expect(hasFailedBashBefore(task, current)).toBe(true);
    });

    test('ignores a failed Bash outside the five-call sliding window', () => {
        const task = new TaskState(new TaskManagerState());
        addCall(task, 'terminal-executeBash', { command: 'old failure' }, { exitCode: 1 });
        for (let index = 0; index < 5; index++) {
            addCall(task, 'unrelatedTool', { index }, {});
        }
        const current = addCall(
            task,
            'devicemgr-executeNodeShell',
            { command: 'unrelated node command' },
            { exitCode: 0, nodeId: 'opendesk-headless-localhost' }
        );

        expect(hasFailedBashBefore(task, current)).toBe(false);
    });

    test('adds an internal LLM prompt without changing the node tool result', async () => {
        const task = new TaskState(new TaskManagerState());
        jest.spyOn(task, 'getLoadedSkillsFromContext').mockReturnValue([
            { bundleName: 'demo', skillName: 'demo-skill', turn: 1 }
        ]);
        jest.spyOn(SkillRegistry.getInstance(), 'getSkill').mockResolvedValue({ directory: '/skills/demo' } as any);
        const append = jest.spyOn(task, 'appendInternalUserMessage').mockResolvedValue();
        addCall(task, 'terminal-executeBash', { command: 'broken local command' }, { exitCode: 2 }, 'failed');
        const current = addCall(
            task,
            'devicemgr-executeNodeShell',
            { command: 'working remote command' },
            { exitCode: 0, nodeId: 'opendesk-headless-localhost' },
            'node output'
        );

        await onAfterExecuteNodeShell({ task, toolCall: current });

        expect(append).toHaveBeenCalledTimes(1);
        const prompt = append.mock.calls[0]?.[0] ?? '';
        expect(prompt).toContain('bundleName="skillmgr"');
        expect(prompt).toContain('skillName="manage-skills"');
        expect(prompt).toContain('toolName="recordHarmonyosFallback"');
        expect(prompt).toContain('toolArgs.bundleName');
        expect(prompt).toContain('当前任务的完整对话和工具调用记录');
        expect(prompt).not.toContain('broken local command');
        expect(prompt).not.toContain('failed');
        expect(prompt).not.toContain('working remote command');
        expect(prompt).not.toContain('node output');
        expect(current.result).toBe('node output');
    });

    test.each([
        [{ exitCode: 1, nodeId: 'opendesk-headless-localhost' }, 'failed node'],
        [{ exitCode: 0, nodeId: 'another-node' }, 'wrong node']
    ])('does not prompt for %s', async (details) => {
        const task = new TaskState(new TaskManagerState());
        const append = jest.spyOn(task, 'appendInternalUserMessage').mockResolvedValue();
        addCall(task, 'executeBash', { command: 'failed' }, { exitCode: 1 });
        const current = addCall(task, 'executeNodeShell', { command: 'node' }, details);

        await onAfterExecuteNodeShell({ task, toolCall: current });
        expect(append).not.toHaveBeenCalled();
    });

    test('does not trigger without a prior failed Bash', async () => {
        const task = new TaskState(new TaskManagerState());
        const append = jest.spyOn(task, 'appendInternalUserMessage').mockResolvedValue();
        addCall(task, 'executeBash', { command: 'successful local command' }, { exitCode: 0 });
        const current = addCall(
            task,
            'executeNodeShell',
            { command: 'node' },
            { exitCode: 0, nodeId: 'opendesk-headless-localhost' }
        );

        await onAfterExecuteNodeShell({ task, toolCall: current });
        expect(append).not.toHaveBeenCalled();
    });

    test('keeps earlier failures available after an intervening node as trigger metadata', () => {
        const task = new TaskState(new TaskManagerState());
        addCall(task, 'executeBash', { command: 'A failed' }, { exitCode: 1 });
        addCall(
            task,
            'executeNodeShell',
            { command: 'A fallback' },
            { exitCode: 0, nodeId: 'opendesk-headless-localhost' }
        );
        const bNode = addCall(
            task,
            'executeNodeShell',
            { command: 'B' },
            { exitCode: 0, nodeId: 'opendesk-headless-localhost' }
        );

        expect(hasFailedBashBefore(task, bNode)).toBe(true);
    });

    test.each([
        ['missing recordedAt', undefined],
        ['invalid recordedAt', 'not-a-date']
    ])('awaits sunset cleanup for a matched fallback with %s', async (_label, recordedAt) => {
        const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-sunset-invalid-'));
        fs.writeFileSync(
            path.join(skillDir, 'opendesk_meta.json'),
            JSON.stringify({
                dependencies: { binaries: [fallbackRecord('ffmpeg', recordedAt, { installHint: 'keep' })] }
            }),
            'utf8'
        );

        try {
            const { meta, append } = await runBeforeHook(skillDir, 'ffmpeg -version');
            expectFallbackCleared(meta.dependencies.binaries[0]);
            expect(meta.dependencies.binaries[0].installHint).toBe('keep');
            expect(append).not.toHaveBeenCalled();
        } finally {
            fs.rmSync(skillDir, { recursive: true, force: true });
        }
    });

    test('cleans only the snapshotted category when another category has the same name', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-07-24T00:00:00.000Z'));
        const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-sunset-category-'));
        const expiredAt = '2026-06-23T23:59:59.999Z';
        const freshAt = '2026-07-23T00:00:00.000Z';
        fs.writeFileSync(
            path.join(skillDir, 'opendesk_meta.json'),
            JSON.stringify({
                dependencies: {
                    binaries: [fallbackRecord('shared-tool', expiredAt, { marker: 'expired binary' })],
                    npmPackages: [fallbackRecord('shared-tool', freshAt, { marker: 'fresh npm' })]
                }
            }),
            'utf8'
        );

        try {
            const { meta, append } = await runBeforeHook(skillDir, 'shared-tool --version');
            expectFallbackCleared(meta.dependencies.binaries[0]);
            expect(meta.dependencies.binaries[0].marker).toBe('expired binary');
            expect(meta.dependencies.npmPackages[0]).toMatchObject({
                ...FALLBACK_FIELDS,
                recordedAt: freshAt,
                marker: 'fresh npm'
            });
            expect(append).toHaveBeenCalledTimes(1);
        } finally {
            fs.rmSync(skillDir, { recursive: true, force: true });
        }
    });

    test('cleans only the snapshotted index when the same category contains duplicate names', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-07-24T00:00:00.000Z'));
        const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-sunset-index-'));
        const expiredAt = '2026-06-23T23:59:59.999Z';
        const freshAt = '2026-07-23T00:00:00.000Z';
        fs.writeFileSync(
            path.join(skillDir, 'opendesk_meta.json'),
            JSON.stringify({
                dependencies: {
                    binaries: [
                        fallbackRecord('duplicate', expiredAt, { marker: 'index zero' }),
                        fallbackRecord('duplicate', freshAt, { marker: 'index one' })
                    ]
                }
            }),
            'utf8'
        );

        try {
            const { meta } = await runBeforeHook(skillDir, 'duplicate --help');
            expectFallbackCleared(meta.dependencies.binaries[0]);
            expect(meta.dependencies.binaries[0].marker).toBe('index zero');
            expect(meta.dependencies.binaries[1]).toMatchObject({
                ...FALLBACK_FIELDS,
                recordedAt: freshAt,
                marker: 'index one'
            });
        } finally {
            fs.rmSync(skillDir, { recursive: true, force: true });
        }
    });

    test('keeps valid advisory when sunset cleanup fails', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-07-24T00:00:00.000Z'));
        const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-sunset-failure-'));
        const metaPath = path.join(skillDir, 'opendesk_meta.json');
        fs.writeFileSync(
            metaPath,
            JSON.stringify({
                dependencies: {
                    binaries: [
                        fallbackRecord('shared-tool', '2026-06-23T23:59:59.999Z'),
                        fallbackRecord('shared-tool', '2026-07-23T00:00:00.000Z')
                    ]
                }
            }),
            'utf8'
        );
        const rename = jest.spyOn(fs.promises, 'rename').mockRejectedValue(new Error('read-only filesystem'));
        const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

        try {
            const { append } = await runBeforeHook(skillDir, 'shared-tool --version');

            expect(append).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to remove expired fallback metadata'));
            expect(JSON.parse(fs.readFileSync(metaPath, 'utf8')).dependencies.binaries[0]).toHaveProperty(
                'fallback',
                'linux_vm'
            );
        } finally {
            rename.mockRestore();
            fs.rmSync(skillDir, { recursive: true, force: true });
        }
    });

    test.each([
        ['not expired', '2026-06-24T00:00:00.001Z'],
        ['exactly 30 days old', '2026-06-24T00:00:00.000Z']
    ])('retains and advises for a matched fallback that is %s', async (_label, recordedAt) => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-07-24T00:00:00.000Z'));
        const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-sunset-boundary-'));
        const original = fallbackRecord('boundary-tool', recordedAt, { marker: 'preserved' });
        fs.writeFileSync(
            path.join(skillDir, 'opendesk_meta.json'),
            JSON.stringify({ dependencies: { binaries: [original] } }),
            'utf8'
        );

        try {
            const { meta, append } = await runBeforeHook(skillDir, 'boundary-tool run');
            expect(meta.dependencies.binaries[0]).toEqual(original);
            expect(append).toHaveBeenCalledTimes(1);
        } finally {
            fs.rmSync(skillDir, { recursive: true, force: true });
        }
    });
});
