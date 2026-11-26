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

import { isMainThread } from 'node:worker_threads';
import type { CommandLineArgs, OpenDeskTUI } from '../../tui/entry.js';
import type { MobileHostPlan } from './acp/mobile/hosts/lifecycle.js';
import { attachMobileHost, mobileInteractionRuntime, type MobileAccessApplication } from './app.js';
import type { TuiHostCapabilitySource } from './acp/mobile/hosts/tui-capabilities.js';
import { logTuiRemoteDiagnostic } from './acp/mobile/hosts/tui-diagnostics.js';
import { GlobalState } from '../../aikernel/states/global.js';
import { getExecutionNode } from '../devicemgr/execution.js';
import { createMobileSessionModelSource } from './acp/mobile/hosts/model-source.js';

export interface TuiRuntimeShape {
    releaseName: string | undefined;
    bunVersion: string | undefined;
    mainThread: boolean;
}
export function startTuiRemoteEntry(input: {
    args: Pick<CommandLineArgs, 'command' | 'headless' | 'resume'>;
    route: 'interactive' | 'subcommand';
    lifecycle: { start(input: MobileHostPlan): void };
    load: MobileHostPlan['prepare'];
    ready: MobileHostPlan['waitUntilReady'];
    runtime?: TuiRuntimeShape;
}): boolean {
    const runtime = input.runtime ?? {
        releaseName: process.release?.name,
        bunVersion: process.versions.bun,
        mainThread: isMainThread
    };
    if (runtime.releaseName !== 'node' || runtime.bunVersion !== undefined) return false;
    if (!runtime.mainThread || input.route !== 'interactive' || input.args.headless || input.args.command !== undefined)
        return false;
    input.lifecycle.start({ prepare: input.load, waitUntilReady: input.ready });
    return true;
}

type TuiState = Pick<OpenDeskTUI, 'taskManagerState' | 'model' | 'activeMode' | 'workspace'>;

export function createTuiCapabilitySource(tui: TuiState): TuiHostCapabilitySource {
    return {
        taskManager: tui.taskManagerState,
        getModelOverride: () => tui.model,
        getMainMode: () => tui.activeMode,
        getDefaultWorkspace: () => tui.workspace,
        sessionModelSource: createMobileSessionModelSource(() => tui.model),
        getDefaultExecutionNodeId: () => GlobalState.getInstance().getDefaultExecutionNodeId(),
        getExecutionNode,
        diagnose: (event) => logTuiRemoteDiagnostic('session', event)
    };
}

export function startTuiMobileAccess(app: MobileAccessApplication, tui: TuiState, args: CommandLineArgs): void {
    startTuiRemoteEntry({
        args,
        route: 'interactive',
        lifecycle: {
            start: (plan) =>
                app[attachMobileHost](plan, { diagnose: (event) => logTuiRemoteDiagnostic('lifecycle', event) })
        },
        ready: async () => undefined,
        load: async (signal) => {
            // Keep Node WebRTC out of help, headless, worker and Bun entry points.
            const { prepareTuiNetwork } = await import('./acp/mobile/hosts/tui-network.js');
            return prepareTuiNetwork(
                {
                    capabilitySource: createTuiCapabilitySource(tui),
                    interactionRuntime: app[mobileInteractionRuntime]
                },
                signal
            );
        }
    });
}
