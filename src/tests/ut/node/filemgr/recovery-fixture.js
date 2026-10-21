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
import os from 'node:os';
import path from 'node:path';
import FileManagerWorker from '../../../../main/applications/filemgr/worker.js';
import { FSStorage } from '../../../../main/applications/filemgr/storage.js';
import { Setting } from '../../../../main/utils/setting.js';
import { scanPath } from './fixture-paths.js';

export const clone = (value) => JSON.parse(JSON.stringify(value));
export const entry = (root, excludes = []) => ({ root, include_patterns: ['**/*'], exclude_patterns: excludes });
export function setFileMtimeAfterCheckpoint(filePath, checkpoint) {
    fs.utimesSync(filePath, fs.statSync(filePath).atime, new Date(checkpoint + 1000));
    return Math.floor(fs.statSync(filePath).mtimeMs);
}
// Existing orchestration fixtures replace state-file I/O, while retaining the real scoped commits.
export function withMemoryStateWriter(storage) {
    storage.scannerState ??= { roots: {}, unavailable_roots: {} };
    storage.scannerState.roots ??= {};
    storage.scannerState.unavailable_roots ??= {};
    storage.commitRootScanState ??= FSStorage.prototype.commitRootScanState;
    storage.pruneUnownedUnavailableRoots ??= FSStorage.prototype.pruneUnownedUnavailableRoots;
    storage._clearPerRootCountsCache ??= FSStorage.prototype._clearPerRootCountsCache;
    storage._writeScannerStateSnapshot = async (_snapshot, commit) => {
        await storage.saveScannerState?.();
        commit();
    };
    return storage;
}
export async function flush() {
    for (let i = 0; i < 50; i++) await Promise.resolve();
}
export function deferred(t) {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    t?.after(() => resolve());
    return { promise, resolve, reject };
}

export async function fixture(t, names = ['A', 'B'], { start = true, files = ['one.txt'], paused = [] } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'filemgr-recovery-'));
    const stateDirectory = path.join(directory, 'state');
    fs.mkdirSync(stateDirectory);
    const roots = names.map((name) => path.join(directory, 'files', name));
    for (const root of roots)
        for (const file of files) {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            fs.writeFileSync(path.join(root, file), 'isolated recovery fixture');
        }
    let settings = { default_workspace: '', applications: {} };
    t.mock.method(Setting, 'getInstance', () => ({
        getData: () => settings,
        getDefaultEmbeddingModelInstance: () => null
    }));
    t.mock.method(Setting, 'updateInstanceData', (next) => {
        settings = next;
    });
    const worker = new FileManagerWorker('filemgr', stateDirectory);
    const storage = new FSStorage(stateDirectory);
    const rows = new Map();
    const writes = [];
    const matches = (row, conditions = []) =>
        conditions.every(({ field, operator, value }) => {
            if (operator === '=') return row[field] === value;
            if (operator === 'in') return value.includes(row[field]);
            if (operator === '>=') return row[field] >= value;
            if (operator === '<') return row[field] < value;
            if (operator === '>') return row[field] > value;
            throw Error('fixture: unsupported DB operator ' + operator);
        });
    const db = {
        search: async (conditions) => ({
            items: [...rows.values()].filter((row) => matches(row, conditions)).map((item) => ({ item: clone(item) }))
        }),
        upsert: async (items) => {
            writes.push(clone(items));
            for (const item of items) rows.set(item.item_id, { ...rows.get(item.item_id), ...clone(item) });
        },
        update: async (items) => {
            for (const item of items) Object.assign(rows.get(item.item_id), clone(item));
        },
        delete: async (ids) => {
            for (const id of ids) rows.delete(id);
        },
        close: async () => {},
        dropIndexers: async () => rows.clear(),
        getStatus: async () => ({ BaseIndexer: { size: rows.size } }),
        countGrouped: async (fields, conditions) => {
            const groups = new Map();
            for (const row of rows.values())
                if (matches(row, conditions)) {
                    const values = Object.fromEntries(fields.map((field) => [field, row[field] ?? null]));
                    const key = JSON.stringify(values);
                    if (!groups.has(key)) groups.set(key, { values, count: 0 });
                    groups.get(key).count++;
                }
            return [...groups.values()];
        }
    };
    storage.storage = db;
    for (const root of roots)
        storage.scannerState.roots[root] = {
            last_full_scan: 100,
            last_scan_at: 100,
            total_files: 1,
            last_file_count: 1,
            paused: paused.includes(path.relative(path.join(directory, 'files'), root))
        };
    await storage.saveScannerState();
    worker.storage = storage;
    worker.config = worker._normalizeConfig({ entries: roots.map((root) => entry(root)) });
    worker._lastConfig = worker.config;
    worker.status = 'running';
    t.after(async () => {
        await worker._stopScanners();
        worker.taskQueue.start();
        await worker.taskQueue.onIdle();
        await storage.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    if (start) {
        await worker._startScanners(worker.config.entries);
        await worker.taskQueue.onIdle();
    }
    return {
        directory,
        stateDirectory,
        roots,
        worker,
        storage,
        db,
        rows,
        writes,
        disk: () => JSON.parse(fs.readFileSync(storage._scannerStatePath, 'utf8')),
        config: (chosen) => ({ entries: chosen.map((root) => entry(root)) }),
        add: (root, file, refs = [root]) => {
            const id = scanPath(path.join(root, file));
            rows.set(id, {
                item_id: id,
                type: 'file',
                modified: 1,
                embedded: 1,
                embedding_generation: 0,
                root_refs: JSON.stringify(refs),
                ref_count: refs.length
            });
            return id;
        }
    };
}

export function failRename(t, storage) {
    let failing = true;
    const rename = fs.promises.rename.bind(fs.promises);
    t.mock.method(fs.promises, 'rename', async (from, to) => {
        if (failing && to === storage._scannerStatePath)
            throw Object.assign(Error('fixture: state rename failed'), { code: 'ENOSPC' });
        return rename(from, to);
    });
    return () => {
        failing = false;
    };
}
