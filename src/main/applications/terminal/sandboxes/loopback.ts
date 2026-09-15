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

import { execFile } from 'node:child_process';
import { t } from '../locale/index.js';

const pending = new Map<string, Promise<void>>();

export function ensureSandboxLoopback(executable: string): Promise<void> {
    const existing = pending.get(executable);
    if (existing) return existing;
    // Only coalesce in-flight initialization. A later launch must notice if the
    // user or Windows removed the exemption instead of trusting an in-memory flag.
    const setup = new Promise<void>((resolve, reject) => {
        execFile(executable, ['network-ensure'], { windowsHide: true, timeout: 150000 }, (error, stdout) => {
            let code = String(error?.code ?? 'invalid-response');
            try {
                const response = JSON.parse(stdout);
                if (!error && response?.configured === true) {
                    resolve();
                    return;
                }
                if (typeof response?.errorCode === 'number') code = String(response.errorCode);
            } catch {
                // Startup errors need not produce a valid JSON protocol response.
            }
            reject(new Error(`${t('sandbox.loopbackSetupFailed')} (${code})`));
        });
    }).finally(() => pending.delete(executable));
    pending.set(executable, setup);
    return setup;
}
