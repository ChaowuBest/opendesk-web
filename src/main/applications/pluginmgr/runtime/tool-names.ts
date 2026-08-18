/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

const INVALID_MODEL_TOOL_NAME_CHARS = /[^a-zA-Z0-9_-]+/g;
const EDGE_SEPARATORS = /^[-_]+|[-_]+$/g;

export function sanitizeModelToolName(value: string): string {
    return value.trim().replace(INVALID_MODEL_TOOL_NAME_CHARS, '-').replace(EDGE_SEPARATORS, '') || 'tool';
}

export function qualifyPluginToolName(pluginId: string, name: string): string {
    const trimmed = name.trim();
    const localName = trimmed.startsWith(`${pluginId}.`) ? trimmed.slice(pluginId.length + 1) : trimmed;
    return `${sanitizeModelToolName(pluginId)}-${sanitizeModelToolName(localName)}`;
}
