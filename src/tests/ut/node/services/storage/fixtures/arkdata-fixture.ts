import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import * as common from '../../../../../../platforms/bridges/common.js';
import { WorkerDatabaseKitProxy } from '../../../../../../platforms/bridges/worker.js';
import { serializeAppError } from '../../../../../../../packages/app-sdk/src/index.js';
import { Worker } from 'node:worker_threads';
import { WorkerRestartController } from '../../../../../../main/applications/worker-restart.js';

const require = createRequire(import.meta.url);
const strip = (source: string) =>
    stripTypeScriptTypes(
        source
            .replace(/^import[\s\S]*?;\s*/gm, '')
            .replace('@injectable()', '')
            .replace('@inject(MODULE_TYPE.Context) ', ''),
        { mode: 'transform' }
    ).replace(/^export /gm, '');
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
export function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
function source(relative: string): string {
    return fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
}
function load(code: string, dependencies: Record<string, unknown>, result: string): any {
    return new Function(...Object.keys(dependencies), strip(code) + '\nreturn ' + result)(
        ...Object.values(dependencies)
    );
}
export function registryDispatch(kit: any, worker: any) {
    const code = source('../../../../../../main/applications/registry.ts');
    const parsed = ts.createSourceFile('registry.ts', code, ts.ScriptTarget.Latest, true);
    let clause: ts.CaseClause | undefined;
    function visit(node: ts.Node) {
        if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'callApp')
            clause = node;
        ts.forEachChild(node, visit);
    }
    visit(parsed);
    const methods = parsed.statements.find(
        (node) =>
            ts.isVariableStatement(node) &&
            node.declarationList.declarations.some((d) => d.name.getText(parsed) === 'DATABASE_KIT_METHODS')
    );
    assert.ok(clause);
    assert.ok(methods);
    const dispatch = ts
        .transpileModule(
            methods.getText(parsed) +
                '\nfunction dispatch(event) { switch (event.type) {' +
                clause.getText(parsed) +
                '} }',
            { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
        )
        .outputText.replace(
            "await import('../../platforms/bridges/main.js')",
            '{ resolveNativeBridge: nativeBridgeResolver }'
        );
    return new Function(
        'worker',
        'serializeAppError',
        'nativeBridgeResolver',
        'logger',
        'ApplicationRegistry',
        dispatch + '\nreturn dispatch;'
    )(
        worker,
        serializeAppError,
        () => ({ getDatabaseKit: async () => kit }),
        { error() {}, warn() {} },
        {
            getApplication() {
                assert.fail('unexpected business dispatch');
            }
        }
    );
}

/** Execute production spawn/event/restart wiring with real Node workers and a shortened restart timer. */
export function registryWorkers(kit: any, directory: string, options?: { filename: URL; options: any }) {
    const parsed = ts.createSourceFile(
        'registry.ts',
        source('../../../../../../main/applications/registry.ts'),
        ts.ScriptTarget.Latest,
        true
    );
    const functions = parsed.statements
        .filter(
            (node) =>
                ts.isFunctionDeclaration(node) &&
                ['spawnGlobalWorker', 'scheduleWorkerRestart'].includes(node.name?.text ?? '')
        )
        .map((node) => node.getText(parsed))
        .join('\n');
    const code = ts
        .transpileModule(functions, {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
        })
        .outputText.replace(
            "await import('../../platforms/bridges/main.js')",
            '{ resolveNativeBridge: nativeBridgeResolver }'
        )
        .replace(/^export /gm, '');
    const workers: Worker[] = [];
    class TestWorker extends Worker {
        constructor(_file: string, _options: any) {
            super(
                options?.filename ??
                    "const {parentPort}=require('node:worker_threads'); parentPort.on('message', m => { if(m.crash) throw new Error('isolated exit'); if(m.exit !== undefined) process.exit(m.exit); });",
                options?.options ?? { eval: true }
            );
            workers.push(this);
        }
    }
    const registry = {
        globalWorker: null as Worker | null,
        pendingRequests: new Map(),
        pendingStreamRequests: new Map(),
        activeFetchReaders: new Map()
    };
    const controller = new WorkerRestartController(5, (callback) => setTimeout(callback, 1));
    const spawn = new Function(
        'Worker',
        'ApplicationRegistry',
        'Setting',
        'logger',
        'getPlatform',
        'getOpendeskDirectory',
        'path',
        'workerRestartController',
        'dispatchWorkerMessageSafely',
        'nativeBridgeResolver',
        'let cachedRuntimeOptions = {}; const MAX_WORKER_RESTARTS=5; const WORKER_STABLE_RESET_DELAY_MS=30000; let settingUpdateCallbackRegistered=false;\n' +
            code +
            '\nreturn spawnGlobalWorker;'
    )(
        TestWorker,
        registry,
        { afterSetDataCallbacks: [], getInstance: () => ({ getData: () => ({}) }) },
        { error() {}, warn() {}, info() {} },
        () => ({ getWorkerPath: () => 'isolated-worker' }),
        () => directory,
        path,
        controller,
        (event: any, worker: Worker) => {
            if (event.type === 'callApp') registryDispatch(kit, worker)(event);
        },
        () => ({ getDatabaseKit: async () => kit })
    );
    spawn({});
    return {
        registry,
        workers,
        async close() {
            controller.reset();
            controller.schedule = () => ({
                firstFailure: false,
                scheduled: false,
                exhausted: false,
                attempt: 0,
                delayMs: 0
            });
            await Promise.all(workers.map((worker) => worker.terminate()));
        }
    };
}

/** SQLite executes the actual production SQL; only the ArkData SDK API is simulated. */
export function arkDataFixture(options: { directory?: string } = {}) {
    const adapterDirectory = process.env.OPENDESK_ARKDATA_ADAPTER_DIR;
    assert.ok(adapterDirectory, 'OPENDESK_ARKDATA_ADAPTER_DIR is required before reading host sources');
    const host = (name: string) => fs.readFileSync(path.join(adapterDirectory, name), 'utf8');
    const resultBudget = { rows: 5000 };
    const contractSource = host('ArkDataAdapterContract.ets')
        .replace(/^export const MAX_RESULT_ROWS:.*\n/m, '')
        .replace(/\bMAX_RESULT_ROWS\b/g, 'resultBudget.rows');
    const adapterSource = host('ArkDataAdapter.ets');
    const bindingSource = host('../jsbindings/ArkDataAdapterBind.ets');
    const directory = options.directory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'arkdata-objects-'));
    const databaseDirectory = path.join(directory, 'rdb');
    fs.mkdirSync(databaseDirectory, { recursive: true });
    const Sqlite = require('better-sqlite3');
    const connections = new Set<any>();
    const calls: Array<{ operation: string; config?: any; sql?: string; params?: any[]; mode?: string }> = [];
    const control = {
        resultBudget,
        transactionQueriesMustBeReadonly: false,
        before: async (_operation: string, _detail?: any) => {},
        closeResultSet: () => {},
        clock: { now: () => Date.now() }
    };
    function connect(name: string, readonly = false) {
        const db = new Sqlite(path.join(databaseDirectory, name), { readonly });
        connections.add(db);
        if (!readonly) db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = OFF');
        return db;
    }
    function resultSet(db: any, sql: string, params: any[], objectTransaction = false) {
        const statement = db.prepare(sql);
        // OpenHarmony StepResultSet rejects statements for which sqlite3_stmt_readonly is false.
        // Opt in when reproducing that SDK boundary; better-sqlite3 .all() alone permits these PRAGMAs.
        if (objectTransaction && control.transactionQueriesMustBeReadonly && !statement.readonly) {
            return {
                columnCount: 0,
                rowCount: -1,
                getColumnName: () => {
                    throw new Error('No SDK result columns');
                },
                goToNextRow: () => false,
                getValue: () => {
                    throw new Error('No SDK result values');
                },
                close: () => control.closeResultSet()
            };
        }
        const rows = statement.all(...params);
        const columns = statement.columns().map((column: any) => column.name);
        let cursor = -1;
        return {
            columnCount: columns.length,
            rowCount: rows.length,
            getColumnName: (i: number) => columns[i],
            goToNextRow: () => ++cursor < rows.length,
            getValue: (i: number) => rows[cursor][columns[i]],
            close: () => control.closeResultSet()
        };
    }
    function close(db: any) {
        if (db.open) db.close();
        connections.delete(db);
    }
    const sdk = {
        SecurityLevel: { S1: 1, S2: 2, S3: 3, S4: 4 },
        TransactionType: { DEFERRED: 0, IMMEDIATE: 1, EXCLUSIVE: 2 },
        getRdbStore: async (_context: any, config: any) => {
            calls.push({ operation: 'open', config: structuredClone(config) });
            await control.before('open', config);
            const db = connect(config.name, config.isReadOnly);
            return {
                close: async () => {
                    calls.push({ operation: 'close' });
                    await control.before('close');
                    close(db);
                },
                executeSync: (sql: string, params: any[] = []) => db.prepare(sql).run(...params),
                querySqlSync: (sql: string) => resultSet(db, sql, []),
                querySql: async (sql: string, params: any[]) => {
                    calls.push({ operation: 'legacy-query', sql, params });
                    await control.before('legacy-query', sql);
                    return resultSet(db, sql, params);
                },
                execute: async (sql: string, paramsOrTx: any, params?: any[]) =>
                    db.prepare(sql).run(...(typeof paramsOrTx === 'number' ? (params ?? []) : (paramsOrTx ?? []))),
                beginTrans: async () => {
                    db.exec('BEGIN');
                    return 1;
                },
                commit: async (_id: number) => db.exec('COMMIT'),
                rollback: async (_id: number) => db.exec('ROLLBACK'),
                createTransaction: async (options: any) => {
                    const mode =
                        options.transactionType === 0
                            ? 'DEFERRED'
                            : options.transactionType === 1
                              ? 'IMMEDIATE'
                              : 'EXCLUSIVE';
                    calls.push({ operation: 'create', mode });
                    await control.before('create', mode);
                    const tx = connect(config.name);
                    tx.exec('BEGIN ' + mode);
                    return {
                        querySql: async (sql: string, params: any[] = []) => {
                            calls.push({ operation: 'query', sql, params });
                            await control.before('query', sql);
                            return resultSet(tx, sql, params, true);
                        },
                        execute: async (sql: string, params: any[] = []) => {
                            calls.push({ operation: 'execute', sql, params });
                            await control.before('execute', sql);
                            tx.prepare(sql).run(...params);
                        },
                        commit: async () => {
                            calls.push({ operation: 'commit' });
                            await control.before('commit');
                            tx.exec('COMMIT');
                            close(tx);
                        },
                        rollback: async () => {
                            calls.push({ operation: 'rollback' });
                            await control.before('rollback');
                            tx.exec('ROLLBACK');
                            close(tx);
                        }
                    };
                }
            };
        },
        deleteRdbStore: async (_context: any, config: any) => {
            calls.push({ operation: 'delete', config: structuredClone(config) });
            await control.before('delete', config);
            for (const suffix of ['', '-wal', '-shm'])
                fs.rmSync(path.join(databaseDirectory, config.name + suffix), { force: true });
        }
    };
    const logs: unknown[][] = [];
    const quiet = {
        info(...args: unknown[]) {
            logs.push(args);
        },
        warn(...args: unknown[]) {
            logs.push(args);
        },
        error(...args: unknown[]) {
            logs.push(args);
        },
        debug(...args: unknown[]) {
            logs.push(args);
        }
    };
    const Adapter = load(
        contractSource + '\n' + adapterSource,
        {
            resultBudget,
            Date: control.clock,
            relationalStore: sdk,
            BaseAdapter: class {},
            LogUtil: quiet
        },
        'ArkDataAdapter'
    );
    const adapter = new Adapter({ databaseDir: directory });
    const bindings = new Map<string, (...args: any[]) => any>();
    load(
        bindingSource,
        {
            JsBindingUtils: { bindFunction: (name: string, fn: (...args: any[]) => any) => bindings.set(name, fn) },
            Inject: { getOrCreate: () => adapter },
            ArkDataAdapter: Adapter
        },
        'ArkDataAdapterBind'
    ).bind();
    const constants = source('../../../../../../platforms/bridges/harmonyos/arkts.ts');
    const methodsCode = constants.slice(
        constants.indexOf('export const EtsBridgeMethods'),
        constants.indexOf('function unwrapArkTSValue')
    );
    const methods = load(methodsCode, {}, 'EtsBridgeMethods');
    const Bridge = load(
        source('../../../../../../platforms/bridges/harmonyos/database.ts'),
        {
            ...common,
            createHash,
            logger: quiet,
            EtsBridgeMethods: methods,
            hasArkTSAdapter: () => true,
            callArkTS: async (name: string, _type: string, args: any[]) => {
                assert.ok(bindings.has(name), 'actual host binding is registered: ' + name);
                return bindings.get(name)!(...args);
            },
            Date: control.clock
        },
        '{ HarmonyOSDatabaseKit, arkDataStoreName }'
    );
    const kit = new Bridge.HarmonyOSDatabaseKit();
    function proxy() {
        const caller = {};
        let sequence = 0;
        const pending = new Map<string, { resolve: (value: any) => void; reject: (error: unknown) => void }>();
        const worker = Object.assign(caller, {
            postMessage(message: any) {
                const waiter = pending.get(message.id)!;
                pending.delete(message.id);
                if (message.status === 'ok') waiter.resolve(structuredClone(message.data));
                else waiter.reject(Object.assign(new Error(message.message), structuredClone(message)));
            }
        });
        const dispatch = registryDispatch(kit, worker);
        const proxy = new WorkerDatabaseKitProxy({
            callAppWithResponse(methodName: string, ...args: any[]) {
                return new Promise((resolve, reject) => {
                    const requestId = String(++sequence);
                    pending.set(requestId, { resolve, reject });
                    dispatch({ type: 'callApp', bundleName: 'fixture', requestId, methodName, args });
                });
            }
        } as any);
        return { proxy, worker };
    }
    return {
        kit,
        adapter,
        bindings,
        calls,
        control,
        directory,
        proxy,
        logs,
        storeName: Bridge.arkDataStoreName,
        cleanup() {
            for (const tx of adapter.objectTransactions.values()) clearTimeout(tx.idleTimer);
            for (const db of connections) close(db);
            if (!options.directory) fs.rmSync(directory, { recursive: true, force: true });
        }
    };
}
