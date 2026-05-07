export const MICROCOMPACTABLE_TOOL_NAMES = new Set<string>([
    'readFile',
    'executePowerShell',
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
