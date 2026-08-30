export function normalizePathDescendantOrSelfValue(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error('path_descendant_or_self operator requires a non-empty string value');
    }
    if (value === '/' || /^[A-Za-z]:\/$/.test(value)) {
        return value;
    }
    if (/^\/+$/u.test(value) || /^[A-Za-z]:\/+$/u.test(value)) {
        throw new Error('path_descendant_or_self operator requires a non-empty string value');
    }
    const normalized = value.replace(/\/+$/, '');
    if (!normalized) {
        throw new Error('path_descendant_or_self operator requires a non-empty string value');
    }
    return normalized;
}

export function normalizePathDescendantOrSelfValues(value: unknown): string[] {
    const values = Array.isArray(value) ? Array.from(value) : [value];
    if (values.length === 0) {
        throw new Error(
            'path_descendant_or_self operator requires a non-empty string or non-empty string array value'
        );
    }
    return values.map((entry) => normalizePathDescendantOrSelfValue(entry));
}

export function escapeSqlLikePattern(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export function pathDescendantOrSelfSqlValues(value: unknown): [string, string] {
    const normalizedPath = normalizePathDescendantOrSelfValue(value);
    const escapedPath = escapeSqlLikePattern(normalizedPath);
    return [normalizedPath, normalizedPath.endsWith('/') ? `${escapedPath}%` : `${escapedPath}/%`];
}
