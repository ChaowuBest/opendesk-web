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

import { createRequire } from 'node:module';
import {
    compileTaskSearch,
    normalizeSearchText,
    TASK_SEARCH_MAX_RESULTS,
    type TaskSearchHit
} from '../../../common/task-search.js';
import { extractSearchDocuments, isSearchableTask, type SearchTask } from './extract.js';

type Row = Record<string, string | number>;
interface Database {
    run(sql: string, params?: (string | number)[]): unknown;
    all(sql: string, params?: (string | number)[]): Row[];
    function(name: string, callback: (text: string) => number): void;
    close(): void;
}
const require = createRequire(import.meta.url);

// Safe ASCII tokens let both SQLite backends index arbitrary CJK/code characters.
// Short queries use their own 1/2-character terms; longer queries use trigrams.
function grams(text: string, lengths: number[]): string[] {
    const chars = Array.from(text);
    const result = new Set<string>();
    for (const length of lengths) {
        for (let i = 0; i <= chars.length - length; i++) {
            result.add(
                'g' +
                    chars
                        .slice(i, i + length)
                        .map((char) => char.codePointAt(0)!.toString(16))
                        .join('z')
            );
        }
    }
    return [...result];
}

function makeMatchExpression(text: string): string {
    return grams(text, [Math.min(3, Array.from(text).length)])
        .map((token) => '"' + token + '"')
        .join(' AND ');
}

export class TaskSearchIndex {
    private wildcardMatcher = compileTaskSearch('').find;

    private constructor(
        readonly dbPath: string,
        private readonly db: Database
    ) {
        db.run('PRAGMA journal_mode = WAL');
        db.run('PRAGMA busy_timeout = 1000');
        db.run(
            'CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT, workspace TEXT, activity TEXT, fingerprint TEXT)'
        );
        db.run(
            'CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY, task_id TEXT, doc_key TEXT, message_id TEXT, text TEXT, normalized TEXT, priority INTEGER, UNIQUE(task_id, doc_key))'
        );
        // Only row membership is needed; exact substring verification uses documents.
        // Contentless-delete avoids retaining a second copy of every token for deletes.
        db.run(
            "CREATE VIRTUAL TABLE IF NOT EXISTS terms USING fts5(tokens, content='', contentless_delete=1, detail=none, tokenize='ascii')"
        );
        db.run(
            'CREATE TRIGGER IF NOT EXISTS remove_terms BEFORE DELETE ON documents BEGIN DELETE FROM terms WHERE rowid=old.id; END'
        );
        db.function('task_search_wildcard', (text) => {
            const lower = text.toLowerCase();
            const match = this.wildcardMatcher(lower);
            return match ? Array.from(lower.slice(...match)).length : 0;
        });
    }
    static async open(dbPath: string, forceWasm = false): Promise<TaskSearchIndex> {
        let db: Database;
        try {
            if (
                forceWasm ||
                (process.platform as string) === 'openharmony' ||
                (process.platform === 'win32' && process.arch === 'arm64')
            ) {
                throw Object.assign(new Error('WASM selected'), { code: 'WASM_SELECTED' });
            }
            const Native = require('better-sqlite3');
            const native = new Native(dbPath);
            db = {
                run: (sql, params = []) => native.prepare(sql).run(...params),
                all: (sql, params = []) => native.prepare(sql).all(...params),
                function: (name, callback) => native.function(name, callback),
                close: () => native.close()
            };
        } catch (error) {
            const { code, message } = error as { code?: string; message: string };
            if (
                code !== 'WASM_SELECTED' &&
                code !== 'MODULE_NOT_FOUND' &&
                code !== 'ERR_DLOPEN_FAILED' &&
                !message.includes('bindings file') &&
                !message.includes('NODE_MODULE_VERSION')
            )
                throw error;
            const { Database: Wasm } = require('node-sqlite3-wasm');
            db = new Wasm(dbPath) as Database;
        }
        try {
            return new TaskSearchIndex(dbPath, db);
        } catch (error) {
            db.close();
            throw error;
        }
    }
    fingerprints(): Map<string, string> {
        return new Map(
            this.db.all('SELECT id, fingerprint FROM tasks').map((row) => [String(row.id), String(row.fingerprint)])
        );
    }
    removeTask(id: string): void {
        this.transaction(() => {
            this.db.run('DELETE FROM documents WHERE task_id = ?', [id]);
            this.db.run('DELETE FROM tasks WHERE id = ?', [id]);
        });
    }
    replaceTask(task: SearchTask, fingerprint: string): void {
        if (!isSearchableTask(task)) {
            this.removeTask(task.task_id);
            return;
        }
        const documents = extractSearchDocuments(task);
        const previous = new Map(
            this.db
                .all('SELECT * FROM documents WHERE task_id = ?', [task.task_id])
                .map((row) => [String(row.doc_key), row])
        );
        this.transaction(() => {
            this.db.run(
                'INSERT INTO tasks VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,workspace=excluded.workspace,activity=excluded.activity,fingerprint=excluded.fingerprint',
                [
                    task.task_id,
                    task.task_name || '',
                    task.workspace || '',
                    [task.updated_at, task.finished_at, task.created_at].filter(Boolean).sort().at(-1) || '',
                    fingerprint
                ]
            );
            for (const doc of documents) {
                const old = previous.get(doc.key);
                previous.delete(doc.key);
                if (old?.text === doc.text) continue;
                if (old) this.db.run('DELETE FROM documents WHERE id = ?', [old.id]);
                const normalized = normalizeSearchText(doc.text);
                this.db.run(
                    'INSERT INTO documents(task_id,doc_key,message_id,text,normalized,priority) VALUES (?,?,?,?,?,?)',
                    [task.task_id, doc.key, doc.messageId, doc.text, normalized, doc.priority]
                );
                const id = this.db.all('SELECT last_insert_rowid() AS id')[0].id;
                const tokens = grams(normalized, [1, 2, 3]).join(' ');
                this.db.run('INSERT INTO terms(rowid,tokens) VALUES (?,?)', [id, tokens]);
            }
            for (const old of previous.values()) this.db.run('DELETE FROM documents WHERE id = ?', [old.id]);
        });
    }
    search(rawQuery: string, requestedLimit: number): { items: TaskSearchHit[]; hasMore: boolean } {
        const { query, literal, anchor, find } = compileTaskSearch(rawQuery);
        const limit = Math.max(1, Math.min(TASK_SEARCH_MAX_RESULTS, Math.floor(requestedLimit) || 20));
        if (!query) return { items: [], hasMore: false };
        const wildcard = literal === undefined;
        const indexedText = literal ?? anchor;
        const source = indexedText ? 'terms JOIN documents d ON d.id=terms.rowid' : 'documents d';
        const params: (string | number)[] = [literal ?? ''];
        if (indexedText) params.push(makeMatchExpression(indexedText));
        if (literal !== undefined) params.push(literal);
        this.wildcardMatcher = find;
        // Use literal text to find candidates, then verify the entire query within each chunk.
        const rows = this.db.all(
            `WITH hits AS ${wildcard ? 'MATERIALIZED ' : ''}(
            SELECT d.task_id, ${wildcard ? 'd.id' : 'MIN(d.id)'} AS doc_id,
                d.priority + CASE WHEN d.priority=2 AND d.normalized=? THEN 1 ELSE 0 END AS score
                ${wildcard ? ', task_search_wildcard(d.text) AS match_length' : ''}
            FROM ${source}
            ${indexedText ? 'WHERE terms MATCH ?' : ''}
            ${wildcard ? '' : 'AND instr(d.normalized,?) > 0 GROUP BY d.task_id, score'}
        ), best AS (
            SELECT *, row_number() OVER (
                PARTITION BY task_id ORDER BY score DESC, ${wildcard ? 'match_length, ' : ''}doc_id
            ) AS n FROM hits ${wildcard ? 'WHERE match_length > 0' : ''}
        ), selected AS (
            SELECT b.*, t.title, t.workspace, t.activity FROM best b JOIN tasks t ON t.id=b.task_id
            WHERE n=1 ORDER BY score DESC, activity DESC, task_id LIMIT ?
        ) SELECT s.*, d.text, d.message_id FROM selected s JOIN documents d ON d.id=s.doc_id
          ORDER BY s.score DESC, s.activity DESC, s.task_id`,
            [...params, limit + 1]
        );
        return {
            hasMore: rows.length > limit,
            items: rows.slice(0, limit).map((row) => {
                const text = String(row.text);
                const [matchStart, matchEnd] = find(wildcard ? text.toLowerCase() : normalizeSearchText(text)) ?? [
                    0, 0
                ];
                const start = Math.max(0, matchStart - 45);
                const end = start + Math.max(170, matchEnd - matchStart + 90);
                return {
                    taskId: String(row.task_id),
                    title: String(row.title),
                    workspace: String(row.workspace),
                    messageId: row.message_id ? String(row.message_id) : undefined,
                    snippet: row.message_id
                        ? (start ? '… ' : '') + text.slice(start, end) + (text.length > end ? ' …' : '')
                        : '',
                    priority: Number(row.score)
                };
            })
        };
    }
    close(): void {
        this.db.close();
    }
    private transaction(action: () => void): void {
        this.db.run('BEGIN IMMEDIATE');
        try {
            action();
            this.db.run('COMMIT');
        } catch (error) {
            this.db.run('ROLLBACK');
            throw error;
        }
    }
}
