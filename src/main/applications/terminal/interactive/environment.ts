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

/** Interactive shells inherit the user's environment, without agent non-interactive overrides. */
export function terminalEnvironment(
    base: NodeJS.ProcessEnv,
    injected: Record<string, string> = {},
    configured: Record<string, string> = {},
    platform: string = process.platform
): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...base, ...injected, ...configured })) {
        if (typeof value === 'string')
            result[platform === 'win32' && key.toLowerCase() === 'path' ? 'PATH' : key] = value;
    }
    // Electron/Node bootstrap variables must not turn user-launched applications into helpers.
    delete result.ELECTRON_RUN_AS_NODE;
    delete result.NODE_OPTIONS;
    delete result.NODE_CHANNEL_FD;
    delete result.NODE_CHANNEL_SERIALIZATION_MODE;
    return { ...result, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'OpenDesk' };
}
