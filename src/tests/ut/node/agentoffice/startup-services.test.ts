import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentOfficeApplication } from '../../../../main/applications/agentoffice/app.js';
import { logger } from '../../../../main/utils/logger.js';
import {
    normalizeStaffLocalService,
    type StaffLocalService
} from '../../../../main/applications/agentoffice/common.js';

type RestoreState = {
    restoreLocalServices(attempt?: number): Promise<void>;
    localServiceRestoreDone: boolean;
    localServiceRestoreTimer?: ReturnType<typeof setTimeout>;
    schedulerStopping: boolean;
};

test('service startup restores enabled staff from lightweight metadata and preserves config', async (context) => {
    const application = new AgentOfficeApplication();
    const state = application as unknown as RestoreState;
    const config = normalizeStaffLocalService({
        enabled: true,
        port: 9054,
        host: '127.0.0.1',
        manage_token: 'test-token',
        https: true
    });
    const applied: Array<{ id: string; config: StaffLocalService }> = [];
    const methods: string[] = [];
    context.mock.method(application, 'callWorker', async (method: string) => {
        methods.push(method);
        return {
            status: 'ok',
            data: [
                { id: 'active', enabled: true, local_service: config },
                { id: 'disabled-staff', enabled: false, local_service: config },
                { id: 'disabled-service', enabled: true, local_service: { ...config, enabled: false } },
                { id: 'no-service', enabled: true }
            ]
        };
    });
    context.mock.method(application as any, 'getLocalService', () => ({
        apply: async (id: string, localConfig: StaffLocalService) => {
            applied.push({ id, config: localConfig });
        }
    }));
    context.after(() => {
        if (state.localServiceRestoreTimer) clearTimeout(state.localServiceRestoreTimer);
    });
    await state.restoreLocalServices();
    assert.deepEqual(methods, ['listStaffStartupInfo']);
    assert.deepEqual(applied, [{ id: 'active', config }]);
    assert.equal(state.localServiceRestoreDone, true);
    await state.restoreLocalServices();
    assert.equal(applied.length, 1);
});

test('service restoration retries worker startup failures and does not restore after stopping', async (context) => {
    const application = new AgentOfficeApplication();
    const state = application as unknown as RestoreState;
    let calls = 0;
    context.mock.method(application, 'callWorker', async () => {
        calls++;
        if (calls === 1) throw new Error('worker is not ready');
        return { status: 'ok', data: [] };
    });
    context.after(() => {
        if (state.localServiceRestoreTimer) clearTimeout(state.localServiceRestoreTimer);
    });
    await state.restoreLocalServices();
    assert.equal(state.localServiceRestoreDone, false);
    assert.ok(state.localServiceRestoreTimer);
    clearTimeout(state.localServiceRestoreTimer);
    await state.restoreLocalServices(1);
    assert.equal(state.localServiceRestoreDone, true);
    assert.equal(calls, 2);
    state.localServiceRestoreDone = false;
    state.schedulerStopping = true;
    await state.restoreLocalServices();
    assert.equal(calls, 2);
});

test('partial service application failure remains retryable instead of being marked restored', async (context) => {
    const application = new AgentOfficeApplication();
    const state = application as unknown as RestoreState;
    const config = normalizeStaffLocalService({ enabled: true, manage_token: 'test-token' });
    context.mock.method(application, 'callWorker', async () => ({
        status: 'ok',
        data: [
            { id: 'first', enabled: true, local_service: config },
            { id: 'second', enabled: true, local_service: config }
        ]
    }));
    const applied: string[] = [];
    let fail = true;
    context.mock.method(application as any, 'getLocalService', () => ({
        apply: async (id: string) => {
            if (id === 'second' && fail) throw new Error('port unavailable');
            applied.push(id);
        }
    }));
    context.after(() => {
        if (state.localServiceRestoreTimer) clearTimeout(state.localServiceRestoreTimer);
    });
    await state.restoreLocalServices();
    assert.equal(state.localServiceRestoreDone, false);
    assert.ok(state.localServiceRestoreTimer);
    assert.deepEqual(applied, ['first']);
    clearTimeout(state.localServiceRestoreTimer);
    fail = false;
    await state.restoreLocalServices(1);
    assert.equal(state.localServiceRestoreDone, true);
    assert.deepEqual(applied, ['first', 'first', 'second']);
});

test('MCP registration failures remain nonfatal but cannot be logged as ready', async (context) => {
    const application = new AgentOfficeApplication();
    const phases: Array<{ phase: string; status: string }> = [];
    context.mock.method(logger, 'info', (message: string) => {
        if (message.startsWith('AgentOfficeStartup ')) {
            phases.push(JSON.parse(message.slice('AgentOfficeStartup '.length)));
        }
    });
    context.mock.method(logger, 'warn', () => {});
    context.mock.method(application as any, 'loadStaffAgents', async () => {});
    (application as any).registry = {
        getApplication: () => ({
            replaceAgentServers: async () => {
                throw new Error('MCP worker unavailable');
            }
        })
    };
    await assert.doesNotReject(application.getAgents());
    assert.equal(phases.find((entry) => entry.phase === 'agents.mcp')?.status, 'failed');
});
