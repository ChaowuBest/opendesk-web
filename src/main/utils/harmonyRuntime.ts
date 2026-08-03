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

import path from 'node:path';

export type HarmonyBuildVariant = 'pc' | 'tablet';

export interface HarmonyRuntimeEnvironment {
    variant: HarmonyBuildVariant;
    deviceType: string;
    appDataDir: string;
    tempDir: string;
    cacheDir: string;
    userHomeDir?: string;
}

export interface HarmonyBrowseRoot {
    kind: 'userHome' | 'appSandbox';
    path: string;
}

interface RuntimeEnvironmentSource {
    platform?: string;
    argv?: readonly string[];
    environment?: Readonly<Record<string, string | undefined>>;
}

const RUNTIME_FIELDS = {
    variant: {
        switchName: 'opendesk-build-variant',
        environmentName: 'OPENDESK_HARMONY_BUILD_VARIANT'
    },
    deviceType: {
        switchName: 'opendesk-device-type',
        environmentName: 'OPENDESK_HARMONY_DEVICE_TYPE'
    },
    appDataDir: {
        switchName: 'opendesk-app-data-dir',
        environmentName: 'OPENDESK_HARMONY_APP_DATA_DIR'
    },
    tempDir: {
        switchName: 'opendesk-temp-dir',
        environmentName: 'OPENDESK_HARMONY_TEMP_DIR'
    },
    cacheDir: {
        switchName: 'opendesk-cache-dir',
        environmentName: 'OPENDESK_HARMONY_CACHE_DIR'
    },
    userHomeDir: {
        switchName: 'opendesk-user-home-dir',
        environmentName: 'OPENDESK_HARMONY_USER_HOME_DIR'
    }
} as const;

let currentHarmonyRuntime: HarmonyRuntimeEnvironment | null | undefined;

function readSwitch(argv: readonly string[], switchName: string): string | undefined {
    const prefix = `--${switchName}`;
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument.startsWith(`${prefix}=`)) {
            return argument.slice(prefix.length + 1);
        }
        if (argument === prefix) {
            return argv[index + 1];
        }
    }
    return undefined;
}

function readField(
    source: RuntimeEnvironmentSource,
    field: (typeof RUNTIME_FIELDS)[keyof typeof RUNTIME_FIELDS]
): string | undefined {
    const argvValue = readSwitch(source.argv ?? [], field.switchName);
    const value = argvValue ?? source.environment?.[field.environmentName];
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

function requireField(
    source: RuntimeEnvironmentSource,
    field: (typeof RUNTIME_FIELDS)[keyof typeof RUNTIME_FIELDS]
): string {
    const value = readField(source, field);
    if (!value) {
        throw new Error(`Harmony runtime requires --${field.switchName}`);
    }
    return value;
}

function freezeRuntime(runtime: HarmonyRuntimeEnvironment): HarmonyRuntimeEnvironment {
    return Object.freeze({ ...runtime });
}

export function createHarmonyRuntimeEnvironment(
    source: RuntimeEnvironmentSource = {}
): HarmonyRuntimeEnvironment | null {
    const platform = source.platform ?? process.platform;
    if (platform !== 'openharmony') {
        return null;
    }

    const variantValue = requireField(source, RUNTIME_FIELDS.variant);
    if (variantValue !== 'pc' && variantValue !== 'tablet') {
        throw new Error(`Invalid Harmony build variant: ${variantValue}`);
    }

    const userHomeDir = readField(source, RUNTIME_FIELDS.userHomeDir);
    if (variantValue === 'tablet' && userHomeDir) {
        throw new Error('Harmony tablet runtime must not expose a user home directory');
    }

    const runtime: HarmonyRuntimeEnvironment = {
        variant: variantValue,
        deviceType: requireField(source, RUNTIME_FIELDS.deviceType),
        appDataDir: requireField(source, RUNTIME_FIELDS.appDataDir),
        tempDir: requireField(source, RUNTIME_FIELDS.tempDir),
        cacheDir: requireField(source, RUNTIME_FIELDS.cacheDir)
    };
    if (userHomeDir) {
        runtime.userHomeDir = userHomeDir;
    }
    return freezeRuntime(runtime);
}

export function serializeHarmonyRuntimeEnvironment(runtime: HarmonyRuntimeEnvironment): Record<string, string> {
    const serialized: Record<string, string> = {
        [RUNTIME_FIELDS.variant.environmentName]: runtime.variant,
        [RUNTIME_FIELDS.deviceType.environmentName]: runtime.deviceType,
        [RUNTIME_FIELDS.appDataDir.environmentName]: runtime.appDataDir,
        [RUNTIME_FIELDS.tempDir.environmentName]: runtime.tempDir,
        [RUNTIME_FIELDS.cacheDir.environmentName]: runtime.cacheDir,
        USER_DATA_PATH: runtime.appDataDir,
        HOME: getHarmonyHomeDirectory(runtime),
        TMPDIR: runtime.tempDir,
        TMP: runtime.tempDir,
        TEMP: runtime.tempDir,
        XDG_CACHE_HOME: runtime.cacheDir
    };
    if (runtime.userHomeDir) {
        serialized[RUNTIME_FIELDS.userHomeDir.environmentName] = runtime.userHomeDir;
    }
    return serialized;
}

export function initializeHarmonyRuntimeEnvironment(): HarmonyRuntimeEnvironment | null {
    if (currentHarmonyRuntime !== undefined) {
        return currentHarmonyRuntime;
    }

    currentHarmonyRuntime = createHarmonyRuntimeEnvironment({
        platform: process.platform,
        argv: process.argv,
        environment: process.env
    });
    if (currentHarmonyRuntime) {
        Object.assign(process.env, serializeHarmonyRuntimeEnvironment(currentHarmonyRuntime));
    }
    return currentHarmonyRuntime;
}

export function getHarmonyRuntimeEnvironment(): HarmonyRuntimeEnvironment | null {
    return initializeHarmonyRuntimeEnvironment();
}

export function getHarmonyHomeDirectory(runtime: HarmonyRuntimeEnvironment): string {
    return runtime.userHomeDir ?? runtime.appDataDir;
}

export function getHarmonyWorkspaceDirectory(runtime: HarmonyRuntimeEnvironment): string {
    if (runtime.userHomeDir) {
        return path.posix.join(runtime.userHomeDir, 'Documents', 'OpenDesk');
    }
    return path.posix.join(runtime.appDataDir, 'workspace');
}

export function getHarmonyBrowseRoots(runtime: HarmonyRuntimeEnvironment): HarmonyBrowseRoot[] {
    const roots: HarmonyBrowseRoot[] = [];
    if (runtime.userHomeDir) {
        roots.push({ kind: 'userHome', path: runtime.userHomeDir });
    }
    if (!roots.some((root) => root.path === runtime.appDataDir)) {
        roots.push({ kind: 'appSandbox', path: runtime.appDataDir });
    }
    return roots;
}
