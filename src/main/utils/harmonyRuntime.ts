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
import {
    createHarmonyRuntimeEnvironment,
    serializeHarmonyRuntimeEnvironment,
    type HarmonyRuntimeEnvironment
} from '../../common/harmonyRuntime.js';

export {
    createHarmonyRuntimeEnvironment,
    getHarmonyBrowseRoots,
    getHarmonyHomeDirectory,
    serializeHarmonyRuntimeEnvironment
} from '../../common/harmonyRuntime.js';
export type {
    HarmonyBrowseRoot,
    HarmonyBuildVariant,
    HarmonyRuntimeEnvironment,
    RuntimeEnvironmentSource
} from '../../common/harmonyRuntime.js';

let currentHarmonyRuntime: HarmonyRuntimeEnvironment | null | undefined;

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

export function getHarmonyWorkspaceDirectory(runtime: HarmonyRuntimeEnvironment): string {
    if (runtime.userHomeDir) {
        return path.posix.join(runtime.userHomeDir, 'Documents', 'OpenDesk');
    }
    return path.posix.join(runtime.appDataDir, 'workspace');
}
