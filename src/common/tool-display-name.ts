/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 * See the Mulan PSL v2 for more details.
 */

/** Resolves an existing localized title and otherwise preserves the protocol name used by mainline. */
export function resolveToolDisplayName(
    toolName: unknown,
    displayNameKey: unknown,
    translate: (key: string) => string
): string {
    const key = typeof displayNameKey === 'string' ? displayNameKey.trim() : '';
    if (key) {
        const translated = translate(key);
        if (translated && translated !== key) return translated;
    }
    const protocolName = typeof toolName === 'string' ? toolName.trim() : '';
    return protocolName || translate('renderer.taskview.output.tool');
}
