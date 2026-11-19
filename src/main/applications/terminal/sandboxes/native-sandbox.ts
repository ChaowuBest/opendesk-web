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

import type { SandboxKit } from '../../../../platforms/bridges/common.js';
import { preparePosixSandbox, type PosixSandboxOptions } from './posix-sandbox.js';
import { sandboxUnavailableError } from './sandbox-errors.js';
import { t } from '../locale/index.js';

export { isSandboxUnavailableError, SANDBOX_UNAVAILABLE } from './sandbox-errors.js';

export function sandboxUnavailable(cause?: unknown): Error {
    return sandboxUnavailableError(t('sandbox.unavailable'), cause);
}

export async function prepareNativeSandbox(kit: SandboxKit, options: PosixSandboxOptions) {
    // Kit 自身以 SANDBOX_UNAVAILABLE 表示"组件缺失/宿主未实现"，调用方据此降级；
    // 策略、授权端点等其它故障保持原样抛出，不会被降级成宿主权限执行。
    return preparePosixSandbox(options, async ({ workspace, policyPath, endpoint, logPath, readOnly }) => {
        const launch = await kit.prepare({
            shellPath: options.shellPath,
            shellArgs: [...options.shellArgs],
            cwd: workspace,
            policyPath,
            endpoint,
            logPath,
            readOnly,
            deleteToTrash: readOnly ? false : options.deleteToTrash,
            trashDir: options.trashDir,
            trashExcludeDirs: options.trashExcludeDirs
        });
        return { ...launch, runtimePaths: launch.runtimePaths ?? { readExecute: [], writable: [] } };
    });
}
