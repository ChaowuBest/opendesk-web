import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSlidesSkill, createSlidesToolset } from '../../../../main/applications/slides/skill.js';

const taskState = { task_id: 'task-a', task_name: '季度汇报', getWorkspace: () => '/workspace' };

describe('presentation automation skill', () => {
    it('exposes the presentation skill and its three direct tools', () => {
        const skill = buildSlidesSkill();
        assert.equal(skill.frontmatter.name, 'automate-presentation');
        assert.equal(skill.isModelInvocable, true);
        const toolset = createSlidesToolset(
            async () => ({}) as never,
            async () => ({}) as never
        );
        assert.deepEqual(
            [...toolset.tools.keys()],
            ['get_presentation_capabilities', 'open_presentation', 'run_presentation_program']
        );
    });

    it('resolves workspace-relative program paths before execution', async () => {
        const calls: Array<{ taskId: string; input: unknown }> = [];
        const toolset = createSlidesToolset(
            async (taskId, input) => {
                calls.push({ taskId, input });
                return {
                    apiVersion: 'presentation/v1',
                    ok: true,
                    committed: false
                } as never;
            },
            async () => ({}) as never
        );

        const result = await toolset.tools.get('run_presentation_program')!.execute(
            {
                program: 'return deck.inspect();',
                startFrom: 'blank',
                expectedSlideCount: 5,
                outputPath: 'deck.pptx',
                assets: { hero: 'assets/cover.png' }
            },
            undefined,
            taskState as never
        );

        assert.equal(result.status, 'success');
        assert.deepEqual(calls, [
            {
                taskId: 'task-a',
                input: {
                    program: 'return deck.inspect();',
                    startFrom: 'blank',
                    expectedSlideCount: 5,
                    outputPath: '/workspace/deck.pptx',
                    assets: { hero: '/workspace/assets/cover.png' },
                    workspace: '/workspace',
                    suggestedName: '季度汇报'
                }
            }
        ]);
    });

    it('returns structured program failures without hiding their diagnostics', async () => {
        const toolset = createSlidesToolset(
            async () =>
                ({
                    apiVersion: 'presentation/v1',
                    ok: false,
                    error: {
                        code: 'PROGRAM_EXECUTION_ERROR',
                        message: 'bad program'
                    }
                }) as never,
            async () => ({}) as never
        );

        const result = await toolset.tools
            .get('run_presentation_program')!
            .execute(
                { program: 'throw new Error();', startFrom: 'blank', expectedSlideCount: 5 },
                undefined,
                taskState as never
            );

        assert.equal(result.status, 'success');
        assert.deepEqual(JSON.parse(result.result), {
            apiVersion: 'presentation/v1',
            ok: false,
            error: {
                code: 'PROGRAM_EXECUTION_ERROR',
                message: 'bad program'
            }
        });
    });

    it('opens a workspace-relative presentation for the current task', async () => {
        const calls: Array<{ taskId: string; filePath: string }> = [];
        const toolset = createSlidesToolset(
            async () => ({}) as never,
            async (taskId, filePath) => {
                calls.push({ taskId, filePath });
                return { status: 'opened', filePath };
            }
        );

        const result = await toolset.tools
            .get('open_presentation')!
            .execute({ filePath: 'deck.pptx' }, undefined, taskState as never);

        assert.equal(result.status, 'success');
        assert.deepEqual(calls, [{ taskId: 'task-a', filePath: '/workspace/deck.pptx' }]);
    });
});

it('requires the planned slide count before starting a new generator', async () => {
    let executed = false;
    const tools = createSlidesToolset(
        async () => {
            executed = true;
            return {} as never;
        },
        async () => ({}) as never
    );
    const result = await tools.tools
        .get('run_presentation_program')!
        .execute({ program: 'return deck.inspect();', startFrom: 'blank' });
    assert.equal(result.status, 'error');
    assert.equal(executed, false);
});
