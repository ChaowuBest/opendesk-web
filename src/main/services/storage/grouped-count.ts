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

export interface BaseCountGroup {
    values: Record<string, unknown>;
    count: number;
}

// Alias group keys so a schema column named "count" cannot shadow the aggregate.
export function groupedCountSql(fields: string[], validFields: string[], whereClause: string): string {
    if (fields.length === 0 || new Set(fields).size !== fields.length) {
        throw new Error('Grouped counts require distinct fields');
    }
    for (const field of fields) {
        if (!validFields.includes(field)) throw new Error(`Invalid group field: ${field}`);
    }
    const columns = fields.map((field) => '"' + field.replace(/"/g, '""') + '"');
    return (
        `SELECT ${columns.map((column, i) => `${column} AS group_${i}`).join(', ')}, COUNT(*) AS group_count ` +
        `FROM base_index${whereClause ? ` WHERE ${whereClause}` : ''} GROUP BY ${columns.join(', ')}`
    );
}

export function decodeCountGroups(fields: string[], rows: Record<string, unknown>[]): BaseCountGroup[] {
    return rows.map((row) => ({
        values: Object.fromEntries(fields.map((field, i) => [field, row[`group_${i}`]])),
        count: Number(row.group_count)
    }));
}
