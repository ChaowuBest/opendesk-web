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

export interface PresentationProgramStageEvent {
    operationId: string;
    stage: string;
    at: string;
    elapsedMs: number;
}

export interface PresentationProgramExecutionScope {
    signal: AbortSignal;
    reportStage(stage: string): void;
}

export interface PresentationProgramTimeoutOutcome {
    ok: false;
    error: {
        code: 'PRESENTATION_PROGRAM_TIMEOUT';
        message: string;
        details: {
            operationId: string;
            stage: string;
            timeoutMs: number;
            elapsedMs: number;
        };
    };
}

type PresentationProgramDeadlineOutcome<T> = { ok: true; value: T } | PresentationProgramTimeoutOutcome;

interface PresentationProgramDeadlineOptions {
    operationId: string;
    timeoutMs: number;
    onStage?: (event: PresentationProgramStageEvent) => void;
    log?: (event: PresentationProgramStageEvent) => void;
}

function safeNotify(
    callback: ((event: PresentationProgramStageEvent) => void) | undefined,
    event: PresentationProgramStageEvent
): void {
    try {
        callback?.(event);
    } catch {
        // Observability must not change presentation execution semantics.
    }
}

export async function runPresentationProgramWithDeadline<T>(
    operation: (scope: PresentationProgramExecutionScope) => Promise<T>,
    options: PresentationProgramDeadlineOptions
): Promise<PresentationProgramDeadlineOutcome<T>> {
    const startedAt = Date.now();
    const controller = new AbortController();
    let stage = 'starting';
    const publish = (nextStage: string): void => {
        stage = nextStage;
        const event: PresentationProgramStageEvent = {
            operationId: options.operationId,
            stage,
            at: new Date().toISOString(),
            elapsedMs: Date.now() - startedAt
        };
        safeNotify(options.onStage, event);
        safeNotify(options.log, event);
    };
    publish(stage);

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<PresentationProgramTimeoutOutcome>((resolve) => {
        timer = setTimeout(() => {
            const elapsedMs = Date.now() - startedAt;
            const timedOutStage = stage;
            controller.abort(new Error(`Presentation program timed out after ${options.timeoutMs}ms`));
            publish('timed-out');
            resolve({
                ok: false,
                error: {
                    code: 'PRESENTATION_PROGRAM_TIMEOUT',
                    message: `Presentation program timed out after ${options.timeoutMs}ms`,
                    details: {
                        operationId: options.operationId,
                        stage: timedOutStage,
                        timeoutMs: options.timeoutMs,
                        elapsedMs
                    }
                }
            });
        }, options.timeoutMs);
    });

    const execution = operation({ signal: controller.signal, reportStage: publish }).then((value) => {
        if (!controller.signal.aborted && stage !== 'completed') publish('completed');
        return { ok: true as const, value };
    });

    try {
        return await Promise.race([execution, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
