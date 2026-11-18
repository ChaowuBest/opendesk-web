/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { threadId } from 'node:worker_threads';
import { logger } from '../../utils/logger.js';

type StartupPhase =
    | 'worker.prepare'
    | 'worker.presets'
    | 'staff.metadata'
    | 'staff.construct'
    | 'agents.construct'
    | 'agents.mcp'
    | 'agents.register'
    | 'services.restore';

export type StartupPhaseStatus = 'ready' | 'partial' | 'failed' | 'retry';

/** Internal diagnostics only: monotonic duration and numeric counts, never staff prompts or service tokens. */
export function recordAgentOfficeStartup(
    phase: StartupPhase,
    startedAt: number,
    status: StartupPhaseStatus,
    counts: Record<string, number> = {}
): void {
    try {
        logger.info(
            `AgentOfficeStartup ${JSON.stringify({
                phase,
                status,
                durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
                atMs: Date.now(),
                pid: process.pid,
                threadId,
                counts
            })}`
        );
    } catch {
        // Optional diagnostics must not change startup results or mask the original failure.
    }
}
