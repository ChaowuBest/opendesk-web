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

export const MICROCOMPACTABLE_TOOL_NAMES = new Set<string>([
    'readFile',
    'extractText',
    'executePowerShell',
    'executePwsh',
    'executeBash',
    'executeZsh',
    'writeFile',
    'editFile',
    'searchReplace',
    'applyPatch',
    'globFiles',
    'grepFiles',
    'webFetch',
    'ExaSearch'
]);

export const TOOL_RESULT_BUDGET_EXCLUDED_TOOL_NAMES = new Set<string>(['readFile']);

export function matchesToolName(toolName: string, candidate: string): boolean {
    return toolName === candidate || toolName.endsWith(`-${candidate}`);
}

function matchesToolNameSet(toolName: string, candidates: Iterable<string>): boolean {
    for (const candidate of candidates) {
        if (matchesToolName(toolName, candidate)) {
            return true;
        }
    }
    return false;
}

export function isMicrocompactableToolName(toolName: string): boolean {
    if (toolName.endsWith('Search')) {
        return true;
    }

    return matchesToolNameSet(toolName, MICROCOMPACTABLE_TOOL_NAMES);
}

export function isToolResultBudgetExcludedToolName(
    toolName: string,
    extraExcludedToolNames?: Iterable<string>
): boolean {
    if (matchesToolNameSet(toolName, TOOL_RESULT_BUDGET_EXCLUDED_TOOL_NAMES)) {
        return true;
    }

    return extraExcludedToolNames ? matchesToolNameSet(toolName, extraExcludedToolNames) : false;
}
