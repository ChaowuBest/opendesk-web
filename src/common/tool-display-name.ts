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

function splitCamelCase(value: string): string {
    return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

/** Makes an unknown plugin/tool identifier readable without changing its protocol name. */
export function humanizeToolName(toolName: unknown): string {
    const normalized = typeof toolName === 'string' ? toolName.trim() : '';
    if (!normalized) return '';
    return normalized
        .split(/[-_.:\s]+/)
        .filter(Boolean)
        .map((segment) => splitCamelCase(segment))
        .join(' / ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Resolves display metadata owned by the tool, with a readable fallback for legacy calls and plugins. */
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
    return humanizeToolName(toolName) || translate('renderer.taskview.output.tool');
}
