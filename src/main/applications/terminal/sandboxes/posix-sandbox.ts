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

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { TaskState } from '../../../aikernel/states/tasks.js';
import type { PermissionRule } from '../../../aikernel/security/permission.js';
import type { NativeSandboxLaunch } from '../../../../platforms/bridges/common.js';
import { getLogDirectory, getOpendeskDirectory } from '../../../utils/setting.js';
import { createSandboxDecideEndpoint } from './sandbox-decide.js';
import { policyTextLinux, isReadonlyModeRules } from './dynabox-policy.js';
import { serializePolicyForSandbox } from './policy-guard.js';
import type { DynamicSandboxLaunch } from './linux-sandbox.js';
import { t } from '../locale/index.js';

export interface PosixSandboxOptions {
    shellPath: string;
    shellArgs: string[];
    command: string;
    cwd?: string;
    taskState?: TaskState;
    toolName?: string;
    deleteToTrash?: boolean;
    trashDir?: string;
    trashExcludeDirs?: string[];
    onPermissionWaitChange?: (waiting: boolean) => void;
}

export interface PosixSandboxContext {
    workspace: string;
    policyPath: string;
    endpoint: string;
    logPath: string;
    readOnly: boolean;
}

/** Shared policy/approval ownership for transparent-path launchers. Hosts only prepare a launch plan. */
export async function preparePosixSandbox(
    options: PosixSandboxOptions,
    prepare: (context: PosixSandboxContext) => Promise<NativeSandboxLaunch>,
    policyHome?: string
): Promise<DynamicSandboxLaunch> {
    const workspace = options.cwd || options.taskState?.getWorkspace();
    if (!workspace) throw new Error(t('sandbox.cwdMissing.linux'));
    if (!path.isAbsolute(workspace) || !fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
        throw new Error(t('sandbox.cwdUnsupported.linux', { path: workspace }));
    }
    const configDirectory = getOpendeskDirectory();
    const runId = `dynamic-sandbox-${crypto.randomUUID()}`;
    const policyPath = path.join(configDirectory, `${runId}.toml`);
    const logDirectory = path.join(getLogDirectory(), 'sandbox');
    fs.mkdirSync(configDirectory, { recursive: true });
    fs.mkdirSync(logDirectory, { recursive: true });
    const logPath = path.join(logDirectory, `${runId}.log`);
    const rules: PermissionRule[] | undefined = options.taskState?.harnessContext.permission?.getRules?.();
    const readOnly = options.taskState?.activeModeId === 'readonly' || isReadonlyModeRules(rules);
    const decide = await createSandboxDecideEndpoint({
        taskState: options.taskState,
        onPermissionWaitChange: options.onPermissionWaitChange,
        pathMapper: (value) => value,
        invocation: { toolName: options.toolName, command: options.command }
    });
    let launch: NativeSandboxLaunch | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () => {
        if (!cleanupPromise)
            cleanupPromise = (async () => {
                try {
                    await launch?.cleanup?.();
                } finally {
                    try {
                        await decide.cleanup();
                    } finally {
                        fs.rmSync(policyPath, { force: true });
                    }
                }
            })();
        return cleanupPromise;
    };
    try {
        launch = await prepare({ workspace, policyPath, endpoint: decide.endpoint, logPath, readOnly });
        if (
            !launch ||
            typeof launch.file !== 'string' ||
            !launch.file ||
            !Array.isArray(launch.args) ||
            launch.args.some((argument) => typeof argument !== 'string')
        ) {
            throw new Error(t('sandbox.unavailable'));
        }
        const runtimePaths = launch.runtimePaths;
        fs.writeFileSync(
            policyPath,
            serializePolicyForSandbox(
                policyTextLinux(
                    decide.endpoint,
                    decide.token,
                    workspace,
                    rules,
                    policyHome,
                    configDirectory,
                    runtimePaths ? { runtimePaths, readOnly } : undefined
                ),
                {
                    keepPrefixes: [
                        workspace,
                        ...(runtimePaths?.readExecute ?? []),
                        ...(readOnly ? [] : (runtimePaths?.writable ?? []))
                    ]
                }
            ),
            { encoding: 'utf8', mode: 0o600 }
        );
        fs.chmodSync(policyPath, 0o600);
        return {
            file: launch.file,
            args: launch.args,
            cwd: launch.cwd,
            env: launch.env,
            detached: launch.detached,
            cleanup,
            attach(proc) {
                const finish = () => {
                    void cleanup().catch((error) => console.warn('Shell sandbox cleanup failed', error));
                };
                proc.once('exit', finish);
                proc.once('close', finish);
                proc.once('error', finish);
            }
        };
    } catch (error) {
        await cleanup();
        throw error;
    }
}
