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

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { logger } from './logger.js';
import { findExecutableInPath, findOpenHarmonyBash } from './shellExec.js';
import {
    getHarmonyRuntimeEnvironment,
    type HarmonyBuildVariant,
    type HarmonyRuntimeEnvironment
} from './harmonyRuntime.js';

export type LocalRuntimeCapability = 'bash' | 'node' | 'python' | 'uv';
export type HarmonyLocalRuntimeFeature = 'terminal' | 'agentgate' | 'stdio-mcp' | 'python' | 'uv';
export type HarmonyLocalRuntimeUnavailableReason = 'tablet-local-runtime-disabled' | 'pc-local-runtime-missing';

export interface LocalRuntimeCapabilities {
    bash: boolean;
    node: boolean;
    python: boolean;
    uv: boolean;
}

export interface HarmonyLocalRuntimeState {
    variant: HarmonyBuildVariant;
    capabilities: LocalRuntimeCapabilities;
    commands: Partial<Record<LocalRuntimeCapability, string>>;
    missing: LocalRuntimeCapability[];
    status: 'available' | 'incomplete' | 'tablet-disabled';
}

export interface HarmonyLocalRuntimeFeatureAvailability {
    available: boolean;
    reason: HarmonyLocalRuntimeUnavailableReason | null;
    missing: LocalRuntimeCapability[];
}

type CommandProbe = (command: LocalRuntimeCapability) => string | null;

const CAPABILITIES: readonly LocalRuntimeCapability[] = ['bash', 'node', 'python', 'uv'];
const FEATURE_REQUIREMENTS: Record<Exclude<HarmonyLocalRuntimeFeature, 'stdio-mcp'>, LocalRuntimeCapability[]> = {
    terminal: ['bash'],
    agentgate: ['node'],
    python: ['python'],
    uv: ['uv']
};
const LOCAL_RUNTIME_STATE_ENV = 'OPENDESK_HARMONY_LOCAL_RUNTIME_STATE';

let currentHarmonyLocalRuntime: HarmonyLocalRuntimeState | null | undefined;
let didLogHarmonyLocalRuntime = false;

function isExecutable(filePath: string | undefined): filePath is string {
    if (!filePath) return false;
    try {
        fs.accessSync(filePath, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function verifyCommand(commandPath: string): string | null {
    try {
        const result = spawnSync(commandPath, ['--version'], {
            timeout: 5000,
            stdio: 'ignore'
        });
        return result.status === 0 && !result.error ? commandPath : null;
    } catch {
        return null;
    }
}

function probeHarmonyCommand(command: LocalRuntimeCapability): string | null {
    let commandPath: string | null = null;
    switch (command) {
        case 'bash':
            commandPath = findOpenHarmonyBash();
            break;
        case 'node':
            commandPath = isExecutable(process.env.NODE_BINARY)
                ? process.env.NODE_BINARY
                : findExecutableInPath('node');
            break;
        case 'python':
            commandPath = findExecutableInPath('python3') || findExecutableInPath('python');
            break;
        case 'uv':
            commandPath = findExecutableInPath('uv');
            break;
    }
    return commandPath ? verifyCommand(commandPath) : null;
}

function isLocalRuntimeState(value: unknown, variant: HarmonyBuildVariant): value is HarmonyLocalRuntimeState {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<HarmonyLocalRuntimeState>;
    if (candidate.variant !== variant) return false;
    if (!candidate.capabilities || typeof candidate.capabilities !== 'object') return false;
    if (!candidate.commands || typeof candidate.commands !== 'object') return false;
    if (!Array.isArray(candidate.missing)) return false;
    if (!['available', 'incomplete', 'tablet-disabled'].includes(String(candidate.status))) return false;
    return CAPABILITIES.every((capability) => typeof candidate.capabilities?.[capability] === 'boolean');
}

function readSerializedState(
    runtime: HarmonyRuntimeEnvironment,
    environment: Readonly<Record<string, string | undefined>>
): HarmonyLocalRuntimeState | null {
    const serialized = environment[LOCAL_RUNTIME_STATE_ENV];
    if (!serialized) return null;
    try {
        const parsed: unknown = JSON.parse(serialized);
        return isLocalRuntimeState(parsed, runtime.variant) ? parsed : null;
    } catch {
        return null;
    }
}

export function createHarmonyLocalRuntimeState(
    runtime: HarmonyRuntimeEnvironment | null,
    probe: CommandProbe = probeHarmonyCommand,
    environment: Readonly<Record<string, string | undefined>> = process.env
): HarmonyLocalRuntimeState | null {
    if (!runtime) return null;

    const serializedState = readSerializedState(runtime, environment);
    if (serializedState) return serializedState;

    const commands: Partial<Record<LocalRuntimeCapability, string>> = {};
    if (runtime.variant === 'pc') {
        for (const capability of CAPABILITIES) {
            const commandPath = probe(capability);
            if (commandPath) commands[capability] = commandPath;
        }
    }

    const capabilities: LocalRuntimeCapabilities = {
        bash: Boolean(commands.bash),
        node: Boolean(commands.node),
        python: Boolean(commands.python),
        uv: Boolean(commands.uv)
    };
    const missing = CAPABILITIES.filter((capability) => !capabilities[capability]);
    return {
        variant: runtime.variant,
        capabilities,
        commands,
        missing,
        status: runtime.variant === 'tablet' ? 'tablet-disabled' : missing.length > 0 ? 'incomplete' : 'available'
    };
}

export function serializeHarmonyLocalRuntimeState(state: HarmonyLocalRuntimeState): Record<string, string> {
    return {
        [LOCAL_RUNTIME_STATE_ENV]: JSON.stringify(state)
    };
}

export function initializeHarmonyLocalRuntimeState(): HarmonyLocalRuntimeState | null {
    if (currentHarmonyLocalRuntime !== undefined) return currentHarmonyLocalRuntime;

    currentHarmonyLocalRuntime = createHarmonyLocalRuntimeState(
        getHarmonyRuntimeEnvironment(),
        probeHarmonyCommand,
        isMainThread ? {} : process.env
    );
    if (currentHarmonyLocalRuntime) {
        Object.assign(process.env, serializeHarmonyLocalRuntimeState(currentHarmonyLocalRuntime));
        if (!didLogHarmonyLocalRuntime) {
            didLogHarmonyLocalRuntime = true;
            if (currentHarmonyLocalRuntime.status === 'incomplete') {
                logger.error(
                    `[HarmonyRuntime] HNP local runtime installation is incomplete; missing: ${currentHarmonyLocalRuntime.missing.join(', ')}`
                );
            } else if (currentHarmonyLocalRuntime.status === 'tablet-disabled') {
                logger.info('[HarmonyRuntime] Local command runtimes are disabled for the tablet variant');
            } else {
                logger.info('[HarmonyRuntime] HNP local runtimes are available');
            }
        }
    }
    return currentHarmonyLocalRuntime;
}

export function getHarmonyLocalRuntimeState(): HarmonyLocalRuntimeState | null {
    return initializeHarmonyLocalRuntimeState();
}

export function getHarmonyLocalRuntimeFeatureAvailability(
    feature: HarmonyLocalRuntimeFeature,
    state: HarmonyLocalRuntimeState | null = getHarmonyLocalRuntimeState()
): HarmonyLocalRuntimeFeatureAvailability {
    if (!state) return { available: true, reason: null, missing: [] };
    if (state.variant === 'tablet') {
        const missing = feature === 'stdio-mcp' ? [] : FEATURE_REQUIREMENTS[feature];
        return {
            available: false,
            reason: 'tablet-local-runtime-disabled',
            missing: [...missing]
        };
    }
    if (feature === 'stdio-mcp') return { available: true, reason: null, missing: [] };

    const missing = FEATURE_REQUIREMENTS[feature].filter((capability) => !state.capabilities[capability]);
    return missing.length > 0
        ? { available: false, reason: 'pc-local-runtime-missing', missing }
        : { available: true, reason: null, missing: [] };
}

export function getHarmonyStdioCommandRequirement(command: string | undefined): LocalRuntimeCapability | null {
    const commandName = command ? path.basename(command).toLowerCase() : '';
    if (commandName === 'bash') return 'bash';
    if (commandName === 'node' || commandName === 'nodejs' || commandName === 'npm' || commandName === 'npx') {
        return 'node';
    }
    if (commandName === 'python' || commandName === 'python3' || /^python3\.\d+$/.test(commandName)) {
        return 'python';
    }
    if (commandName === 'uv' || commandName === 'uvx') return 'uv';
    return null;
}

export function getHarmonyStdioCommandAvailability(
    command: string | undefined,
    state: HarmonyLocalRuntimeState | null = getHarmonyLocalRuntimeState()
): HarmonyLocalRuntimeFeatureAvailability {
    const featureAvailability = getHarmonyLocalRuntimeFeatureAvailability('stdio-mcp', state);
    if (!featureAvailability.available || !state) return featureAvailability;

    const requirement = getHarmonyStdioCommandRequirement(command);
    if (!requirement || state.capabilities[requirement]) {
        return { available: true, reason: null, missing: [] };
    }
    return {
        available: false,
        reason: 'pc-local-runtime-missing',
        missing: [requirement]
    };
}
