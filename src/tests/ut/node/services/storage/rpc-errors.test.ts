import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
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
const code = ts.transpileModule('function dispatch(event) { switch (event.type) { ' + clause.getText(parsed) + ' } }', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const load = new Function('ApplicationRegistry', 'logger', 'worker', 'serializeAppError', code + ';return dispatch;');
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
for (const scenario of ['ordinary', 'sdk', 'non-cloneable'])
    test(`production registry error reaches worker: ${scenario}`, async () => {
        const error = Object.assign(new Error('isolated application error'), {
            code: scenario === 'sdk' ? 'operation_timeout' : undefined,
            category: scenario === 'sdk' ? 'bridge' : undefined,
            details:
                scenario === 'sdk'
                    ? { opId: 'isolated-op' }
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
            if (scenario === 'sdk') assert.deepEqual(rejected.details, error.details);
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
