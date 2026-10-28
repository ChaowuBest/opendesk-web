import assert from 'node:assert/strict';
import test from 'node:test';
import {
    runPresentationProgramWithDeadline,
    type PresentationProgramStageEvent
} from '../../../../main/office/presentationProgramExecution.js';

test('presentation deadline reports the last observable stage and aborts the host operation', async () => {
    const stages: PresentationProgramStageEvent[] = [];
    let observedAbort = false;

    const outcome = await runPresentationProgramWithDeadline(
        async ({ signal, reportStage }) => {
            reportStage('rendering-slides');
            await new Promise<void>((resolve) => {
                signal.addEventListener(
                    'abort',
                    () => {
                        observedAbort = true;
                        resolve();
                    },
                    { once: true }
                );
            });
            return 'late-result';
        },
        {
            operationId: 'operation-test',
            timeoutMs: 20,
            onStage: (event) => stages.push(event),
            log: () => undefined
        }
    );

    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, 'PRESENTATION_PROGRAM_TIMEOUT');
    assert.equal(outcome.error.details.operationId, 'operation-test');
    assert.equal(outcome.error.details.stage, 'rendering-slides');
    assert.equal(observedAbort, true);
    assert.deepEqual(
        stages.map((event) => event.stage),
        ['starting', 'rendering-slides', 'timed-out']
    );
});

test('presentation deadline preserves successful results and completion telemetry', async () => {
    const stages: string[] = [];
    const outcome = await runPresentationProgramWithDeadline(
        async ({ reportStage }) => {
            reportStage('executing-program');
            return { ok: true as const };
        },
        {
            operationId: 'operation-success',
            timeoutMs: 100,
            onStage: (event) => stages.push(event.stage),
            log: () => undefined
        }
    );

    assert.deepEqual(outcome, { ok: true, value: { ok: true } });
    assert.deepEqual(stages, ['starting', 'executing-program', 'completed']);
});
