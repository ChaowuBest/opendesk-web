import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
import { WorkerDatabaseKitProxy } from '../../../../../platforms/bridges/worker.js';
import { BaseWorker, serializeAppError } from '../../../../../../packages/app-sdk/src/index.js';

// Extract the production dispatch clause without booting Electron/app registry.
// Only the worker and application boundary are fixtures; clone behavior is real.
const source = fs.readFileSync(new URL('../../../../../main/applications/registry.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('registry.ts', source, ts.ScriptTarget.Latest, true);
let clause: ts.CaseClause | undefined;
function visit(node: ts.Node): void {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'callApp')
        clause = node;
    ts.forEachChild(node, visit);
}
visit(parsed);
assert.ok(clause);
const methods = parsed.statements.find(
    (node) =>
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some(
            (declaration) => declaration.name.getText(parsed) === 'DATABASE_KIT_METHODS'
        )
);
assert.ok(methods);
const code = ts.transpileModule(
    methods.getText(parsed) + '\nfunction dispatch(event) { switch (event.type) { ' + clause.getText(parsed) + ' } }',
    {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
    }
).outputText;
const dispatchCode = code.replace(
    "await import('../../platforms/bridges/main.js')",
    '{ resolveNativeBridge: nativeBridgeResolver }'
);
assert.ok(dispatchCode.includes('resolveNativeBridge: nativeBridgeResolver'));
const load = new Function(
    'ApplicationRegistry',
    'logger',
    'worker',
    'serializeAppError',
    'nativeBridgeResolver',
    dispatchCode + ';return dispatch;'
);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
for (const scenario of ['ordinary', 'sdk', 'delete-sdk', 'non-cloneable'])
    test(`production registry error reaches worker: ${scenario}`, async () => {
        const error = Object.assign(new Error('isolated application error'), {
            code:
                scenario === 'sdk'
                    ? 'operation_timeout'
                    : scenario === 'delete-sdk'
                      ? 'store_delete_failed'
                      : undefined,
            category: scenario === 'sdk' ? 'bridge' : scenario === 'delete-sdk' ? 'diagnostic' : undefined,
            details:
                scenario === 'sdk'
                    ? { opId: 'isolated-op' }
                    : scenario === 'delete-sdk'
                      ? {
                            sdkErrorCode: 14800011,
                            storeId: 'arkdata-base:fixture',
                            path: 'fixture-hash.db',
                            opId: 'delete-fixture',
                            operation: 'DeleteStoreStart'
                        }
                      : scenario === 'non-cloneable'
                        ? { callback() {} }
                        : undefined
        });
        const responses: any[] = [];
        const dispatch = load(
            {
                getApplication: () => ({
                    fail() {
                        throw error;
                    }
                })
            },
            { error() {} },
            {
                postMessage(value: any) {
                    responses.push(structuredClone(value));
                }
            },
            serializeAppError
        );
        let rejected: any;
        const reply = new Promise((resolve) => {
            BaseWorker.pendingAppRequests.set('isolated-rpc', {
                resolve,
                reject: (value) => {
                    rejected = value;
                    resolve(undefined);
                },
                timer: setTimeout(() => {}, 10_000)
            });
        });
        try {
            dispatch({
                type: 'callApp',
                bundleName: 'fixture',
                requestId: 'isolated-rpc',
                methodName: 'fail',
                args: []
            });
            await tick();
            assert.equal(responses.length, 1);
            BaseWorker.handleAppResponse(responses[0]);
            await reply;
            assert.equal(rejected.message, error.message);
            assert.equal(rejected.code, error.code);
            if (scenario === 'sdk' || scenario === 'delete-sdk') assert.deepEqual(rejected.details, error.details);
            if (scenario === 'non-cloneable') assert.equal(rejected.details, undefined);
            assert.equal(BaseWorker.pendingAppRequests.size, 0);
            // A late response must not settle a newer RPC or manufacture another error.
            BaseWorker.handleAppResponse({ id: 'isolated-rpc', status: 'ok', data: 'late' });
        } finally {
            const pending = BaseWorker.pendingAppRequests.get('isolated-rpc');
            if (pending) clearTimeout(pending.timer);
            BaseWorker.pendingAppRequests.delete('isolated-rpc');
        }
    });

for (const failed of [false, true])
    test(`production delete proxy and registry allowlist forward identity and outcome: failed=${failed}`, async () => {
        const requestId = `isolated-delete-${failed}`;
        const options = {
            path: process.env.OPENDESK_CONFIG_DIRECTORY + '/rpc-delete-arkdata-database.db',
            vector: true
        };
        const details = {
            sdkErrorCode: 14800011,
            storeId: 'arkdata-base:rpc',
            path: 'sdk-name-hash.db',
            opId: 'delete-rpc',
            operation: 'DeleteStoreStart'
        };
        const calls: unknown[][] = [];
        const dispatch = load(
            {
                getApplication() {
                    assert.fail('Database calls must use the native bridge');
                }
            },
            { error() {} },
            {
                postMessage(value: any) {
                    BaseWorker.handleAppResponse(structuredClone(value));
                }
            },
            serializeAppError,
            () => ({
                getDatabaseKit: async () => ({
                    deleteStore: async (...args: unknown[]) => {
                        calls.push(args);
                        if (failed)
                            throw Object.assign(new Error('isolated SDK delete failure'), {
                                code: 'store_delete_failed',
                                category: 'diagnostic',
                                details
                            });
                    }
                })
            })
        );
        const proxy = new WorkerDatabaseKitProxy({
            callAppWithResponse(methodName: string, ...args: unknown[]) {
                return new Promise((resolve, reject) => {
                    BaseWorker.pendingAppRequests.set(requestId, {
                        resolve,
                        reject,
                        timer: setTimeout(() => reject(new Error('isolated route timeout')), 2_000)
                    });
                    dispatch({ type: 'callApp', bundleName: 'fixture', requestId, methodName, args });
                });
            }
        } as any);
        try {
            const result = proxy.deleteStore('arkdata-base:rpc', options);
            if (failed)
                await assert.rejects(result, (error: any) => {
                    assert.equal(error.code, 'store_delete_failed');
                    assert.deepEqual(error.details, details);
                    return true;
                });
            else await result;
            assert.deepEqual(calls, [['arkdata-base:rpc', options]]);
            assert.equal(BaseWorker.pendingAppRequests.has(requestId), false);
        } finally {
            const pending = BaseWorker.pendingAppRequests.get(requestId);
            if (pending) clearTimeout(pending.timer);
            BaseWorker.pendingAppRequests.delete(requestId);
        }
    });
