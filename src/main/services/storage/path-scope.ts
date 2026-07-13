export function normalizePathDescendantOrSelfValue(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error('path_descendant_or_self operator requires a non-empty string value');
    }
    if (value === '/' || /^[A-Za-z]:\/$/.test(value)) {
        return value;
    }
    return value.replace(/\/+$/, '');
}

export function escapeSqlLikePattern(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export function pathDescendantOrSelfSqlValues(value: unknown): [string, string] {
    const normalizedPath = normalizePathDescendantOrSelfValue(value);
    const escapedPath = escapeSqlLikePattern(normalizedPath);
    return [normalizedPath, normalizedPath.endsWith('/') ? `${escapedPath}%` : `${escapedPath}/%`];
}
