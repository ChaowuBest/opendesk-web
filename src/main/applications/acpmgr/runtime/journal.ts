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

import fs from 'node:fs';
import path from 'node:path';

export type AcpJournalDirection = 'inbound' | 'outbound' | 'lifecycle';

export interface AcpJournalEntry {
    sequence: number;
    timestamp: string;
    direction: AcpJournalDirection;
    method: string;
    payload: unknown;
}

function toJsonValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'bigint') return value.toString();
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value !== 'object') return String(value);
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) {
        return value.map((item) => toJsonValue(item, seen));
    }
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        output[key] = toJsonValue(item, seen);
    }
    return output;
}

export class AcpEventJournal {
    readonly filePath: string;
    private sequence: number;

    constructor(taskArtifactDirectory: string) {
        const directory = path.join(taskArtifactDirectory, 'acp');
        this.filePath = path.join(directory, 'events.jsonl');
        fs.mkdirSync(directory, { recursive: true });
        this.sequence = this.readAll().reduce((maximum, entry) => Math.max(maximum, entry.sequence), 0);
    }

    append(direction: AcpJournalDirection, method: string, payload: unknown): AcpJournalEntry {
        const entry: AcpJournalEntry = {
            sequence: ++this.sequence,
            timestamp: new Date().toISOString(),
            direction,
            method,
            payload: toJsonValue(payload)
        };
        fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
        return entry;
    }

    readAll(): AcpJournalEntry[] {
        if (!fs.existsSync(this.filePath)) return [];
        const content = fs.readFileSync(this.filePath, 'utf8');
        const entries: AcpJournalEntry[] = [];
        for (const line of content.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
                const entry = JSON.parse(line) as Partial<AcpJournalEntry>;
                if (
                    typeof entry.sequence === 'number' &&
                    typeof entry.timestamp === 'string' &&
                    (entry.direction === 'inbound' ||
                        entry.direction === 'outbound' ||
                        entry.direction === 'lifecycle') &&
                    typeof entry.method === 'string'
                ) {
                    entries.push(entry as AcpJournalEntry);
                }
            } catch {
                // A partially written final line must not hide earlier durable events.
            }
        }
        return entries;
    }

    get lastSequence(): number {
        return this.sequence;
    }
}
