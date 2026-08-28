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

export const TOOL_PRESENTATION_NAME_MAX_CHARS = 160;
export const TOOL_PRESENTATION_SUMMARY_MAX_CHARS = 512;
export const TOOL_PRESENTATION_RESOURCE_MAX_CHARS = 2048;

export interface LocalizedToolPresentationText {
    key: string;
    params?: Record<string, string | number>;
}

export type ToolPresentationText = string | LocalizedToolPresentationText;

export interface ToolCallPresentation {
    displayName: ToolPresentationText;
    summary?: ToolPresentationText;
    activity?: ToolPresentationText;
    resource?: {
        type: 'preview' | 'changes' | 'url';
        value: string;
    };
    resultFormat?: 'plain' | 'markdown';
}

interface ToolCallPresentationSource {
    tool_name: string;
    args_string?: string;
    args_object?: unknown;
}

export interface ResolvedToolCallPresentation extends Omit<
    ToolCallPresentation,
    'displayName' | 'summary' | 'activity'
> {
    displayName: string;
    summary?: string;
    activity?: string;
}

export type ToolPresentationTranslator = (key: string, params?: Record<string, string | number>) => string;

function truncateString(value: unknown, maxChars: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    if (!normalized) return undefined;
    return Array.from(normalized).slice(0, maxChars).join('');
}

function sanitizeText(value: unknown, maxChars: number): ToolPresentationText | undefined {
    const plainText = truncateString(value, maxChars);
    if (plainText) return plainText;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const candidate = value as Partial<LocalizedToolPresentationText>;
    const key = truncateString(candidate.key, TOOL_PRESENTATION_NAME_MAX_CHARS);
    if (!key) return undefined;
    const params = Object.fromEntries(
        Object.entries(candidate.params || {})
            .slice(0, 12)
            .flatMap(([paramKey, paramValue]) => {
                const safeKey = truncateString(paramKey, 64);
                const safeValue =
                    typeof paramValue === 'number' && Number.isFinite(paramValue)
                        ? paramValue
                        : truncateString(paramValue, maxChars);
                return safeKey && safeValue !== undefined ? [[safeKey, safeValue]] : [];
            })
    );
    return { key, ...(Object.keys(params).length > 0 ? { params } : {}) };
}

function resolveText(
    value: ToolPresentationText | undefined,
    translate: ToolPresentationTranslator
): string | undefined {
    if (typeof value === 'string') return value;
    return value ? translate(value.key, value.params) : undefined;
}

export function resolveToolCallPresentation(
    value: ToolCallPresentation,
    translate: ToolPresentationTranslator
): ResolvedToolCallPresentation {
    return {
        ...value,
        displayName: resolveText(value.displayName, translate) || '',
        summary: resolveText(value.summary, translate),
        activity: resolveText(value.activity, translate)
    };
}

export function sanitizeToolCallPresentation(
    value: ToolCallPresentation | undefined,
    fallbackName: string
): ToolCallPresentation {
    const displayName = sanitizeText(value?.displayName, TOOL_PRESENTATION_NAME_MAX_CHARS) ||
        truncateString(fallbackName, TOOL_PRESENTATION_NAME_MAX_CHARS) || { key: 'renderer.taskview.output.tool' };
    const summary = sanitizeText(value?.summary, TOOL_PRESENTATION_SUMMARY_MAX_CHARS);
    const activity = sanitizeText(value?.activity, TOOL_PRESENTATION_SUMMARY_MAX_CHARS);
    const resourceValue = truncateString(value?.resource?.value, TOOL_PRESENTATION_RESOURCE_MAX_CHARS);
    const resourceType = value?.resource?.type;
    const resource =
        resourceValue && (resourceType === 'preview' || resourceType === 'changes' || resourceType === 'url')
            ? { type: resourceType, value: resourceValue }
            : undefined;
    const resultFormat = value?.resultFormat === 'markdown' ? 'markdown' : undefined;
    return {
        displayName,
        ...(summary ? { summary } : {}),
        ...(activity ? { activity } : {}),
        ...(resource ? { resource } : {}),
        ...(resultFormat ? { resultFormat } : {})
    };
}

function getToolKind(toolName: string): string {
    return toolName
        .split(/[-./:]/)
        .pop()!
        .replace(/Tool$/i, '')
        .toLowerCase();
}

function getArgumentRecord(toolCall: ToolCallPresentationSource): Record<string, unknown> {
    if (toolCall.args_object && typeof toolCall.args_object === 'object' && !Array.isArray(toolCall.args_object)) {
        const args = toolCall.args_object as Record<string, unknown>;
        if (Object.keys(args).length > 0) return args;
    }
    try {
        const parsed = JSON.parse(toolCall.args_string || '');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function basename(value: unknown): string {
    if (typeof value !== 'string') return '';
    const normalized = value.replace(/[\\/]+$/, '');
    return normalized.split(/[\\/]/).pop() || normalized;
}

function normalizeBrowserUrl(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    try {
        const url = new URL(value.trim());
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
    } catch {
        return undefined;
    }
}

function getDisplayName(kind: string, toolName: string): ToolPresentationText {
    const localizedNames: Record<string, string> = {
        readfile: 'filemgr.readFile.name',
        readimage: 'filemgr.readImage.name',
        askimage: 'filemgr.askImage.name',
        extracttext: 'filemgr.extractText.name',
        semanticsearch: 'filemgr.semanticSearch.name',
        writefile: 'filemgr.writeFile.name',
        editfile: 'filemgr.editFile.name',
        searchreplace: 'filemgr.searchReplace.name',
        applypatch: 'filemgr.applyPatch.name',
        globfiles: 'renderer.taskview.output.toolName.glob',
        grepfiles: 'renderer.taskview.output.toolName.grep',
        navigate: 'renderer.taskview.output.toolName.navigate',
        webfetch: 'search.webfetch.name',
        websearch: 'renderer.taskview.output.toolName.webSearch',
        loadskill: 'renderer.taskview.output.toolName.loadSkill',
        callskill: 'renderer.taskview.output.toolName.callSkill',
        todowrite: 'renderer.taskview.output.toolName.todoWrite',
        executebash: 'renderer.taskview.output.toolName.executeCommand',
        getcurrenttime: 'tools.getCurrentTime.name',
        listrecenttasks: 'tools.listRecentTasks.name',
        gettaskhistory: 'tools.getTaskHistory.name',
        checkshellstatus: 'tools.checkShellStatus.name',
        askfromtask: 'tools.askFromTask.name',
        deletetasks: 'tools.deleteTasks.name',
        createsubtask: 'tools.createSubTask.name',
        waitsubtask: 'tools.waitSubTask.name',
        attachtosubtask: 'tools.attachToSubTask.name',
        askuser: 'tools.askUser.name'
    };
    if (localizedNames[kind]) return { key: localizedNames[kind] };
    if (kind === 'executezsh') return 'Zsh';
    if (kind === 'executepowershell') return 'PowerShell';
    return toolName;
}

function getGlobSummary(args: Record<string, unknown>): ToolPresentationText | undefined {
    if (typeof args.pattern !== 'string' || !args.pattern.trim()) return undefined;
    const pattern = args.pattern.trim().replaceAll('\\', '/');
    const typedFiles = pattern.match(/^(?:(.+?)\/)?(?:\*\*\/)?\*\.([a-zA-Z0-9]+)$/);
    if (!typedFiles) return { key: 'renderer.taskview.output.purpose.glob', params: { pattern } };
    const [, patternDirectory, extension] = typedFiles;
    const typeNames: Record<string, string> = {
        c: 'C',
        cpp: 'C++',
        css: 'CSS',
        go: 'Go',
        html: 'HTML',
        java: 'Java',
        js: 'JavaScript',
        json: 'JSON',
        jsx: 'JavaScript React',
        md: 'Markdown',
        py: 'Python',
        rs: 'Rust',
        ts: 'TypeScript',
        tsx: 'TypeScript React',
        yaml: 'YAML',
        yml: 'YAML'
    };
    const type = typeNames[extension.toLowerCase()] || extension.toUpperCase();
    const directory = patternDirectory || args.path;
    return directory
        ? {
              key: 'renderer.taskview.output.purpose.globTypedFilesIn',
              params: { directory: String(directory), type }
          }
        : { key: 'renderer.taskview.output.purpose.globTypedFiles', params: { type } };
}

function getSummary(kind: string, args: Record<string, unknown>): ToolPresentationText | undefined {
    for (const key of ['description', 'purpose', 'task']) {
        const value = args[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    if ((kind === 'loadskill' || kind === 'callskill') && typeof args.skillName === 'string') {
        return args.skillName.trim() || undefined;
    }
    const path = args.file_path ?? args.filePath ?? args.path;
    const name = basename(path);
    if (kind === 'readfile' && name) {
        return { key: 'renderer.taskview.output.purpose.readFile', params: { name } };
    }
    if ((kind === 'readimage' || kind === 'askimage') && name) {
        return { key: 'renderer.taskview.output.purpose.readImage', params: { name } };
    }
    if (kind === 'extracttext' && name) {
        return { key: 'renderer.taskview.output.purpose.extractText', params: { name } };
    }
    if (kind === 'writefile' && name) {
        return { key: 'renderer.taskview.output.purpose.writeFile', params: { name } };
    }
    if (kind === 'editfile' && name) {
        return { key: 'renderer.taskview.output.purpose.editFile', params: { name } };
    }
    if (kind === 'searchreplace' && name) {
        return { key: 'renderer.taskview.output.purpose.searchReplace', params: { name } };
    }
    if (kind === 'applypatch') return { key: 'renderer.taskview.output.purpose.applyPatch' };
    if (kind === 'globfiles') return getGlobSummary(args);
    if (kind === 'grepfiles' && args.pattern) {
        return { key: 'renderer.taskview.output.purpose.grep', params: { pattern: String(args.pattern) } };
    }
    if (kind === 'semanticsearch' && args.query) {
        return { key: 'renderer.taskview.output.purpose.search', params: { query: String(args.query) } };
    }
    if (kind === 'executebash' || kind === 'executezsh' || kind === 'executepowershell') {
        return { key: 'renderer.taskview.output.purpose.shell' };
    }
    const browserUrl = normalizeBrowserUrl(args.url);
    if (browserUrl) return { key: 'renderer.taskview.output.purpose.openUrl', params: { url: browserUrl } };
    for (const key of ['query', 'pattern', 'url', 'command', 'path', 'file_path']) {
        if (args[key] !== undefined) return String(args[key]);
    }
    return undefined;
}

export function getDefaultToolCallPresentation(toolCall: ToolCallPresentationSource): ToolCallPresentation {
    const kind = getToolKind(toolCall.tool_name);
    const args = getArgumentRecord(toolCall);
    const path = args.file_path ?? args.filePath ?? args.path;
    const browserUrl = normalizeBrowserUrl(args.url);
    const resource =
        typeof path === 'string' && path.trim() && kind === 'readfile'
            ? { type: 'preview' as const, value: path.trim() }
            : typeof path === 'string' &&
                path.trim() &&
                (kind === 'writefile' || kind === 'editfile' || kind === 'searchreplace')
              ? { type: 'changes' as const, value: path.trim() }
              : browserUrl
                ? { type: 'url' as const, value: browserUrl }
                : undefined;
    return sanitizeToolCallPresentation(
        {
            displayName: getDisplayName(kind, toolCall.tool_name),
            summary: getSummary(kind, args),
            activity:
                kind === 'readfile' && typeof path === 'string' && path.trim()
                    ? { key: 'display.minimal.running.reading', params: { path: path.trim() } }
                    : undefined,
            resource,
            resultFormat: kind === 'webfetch' || kind.endsWith('search') ? 'markdown' : undefined
        },
        toolCall.tool_name
    );
}
