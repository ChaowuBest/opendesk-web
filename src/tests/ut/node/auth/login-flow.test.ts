import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    PluginAccountLoginFlowState,
    PluginAccountLoginMethod
} from '../../../../../packages/plugin-sdk/src/index.js';
import {
    LOGIN_FLOW_POLL_INTERVAL_MS,
    LOGIN_FLOW_TIMEOUT_MS,
    describeLoginError,
    runLoginFlow,
    type LoginFlowIo
} from '../../../../main/applications/account/login-flow.js';
import { setRuntimeLocale } from '../../../../locale/index.js';
import type { AccountSession } from '../../../../main/applications/account/types.js';

interface FakeFlowService {
    startLoginRequests: Array<{ kind: string; methodId: string }>;
    submitRequests: Array<Record<string, string>>;
    pollRequests: number;
    cancelled: string[];
    startLogin(kind: string, methodId: string): Promise<{ flowId: string; state: PluginAccountLoginFlowState }>;
    submitLogin(flowId: string, values: Record<string, string>): Promise<PluginAccountLoginFlowState>;
    pollLogin(flowId: string): Promise<PluginAccountLoginFlowState>;
    cancelLogin(flowId: string): Promise<void>;
}

function createService(options: {
    startStates: PluginAccountLoginFlowState[];
    submitStates?: PluginAccountLoginFlowState[];
    pollStates?: PluginAccountLoginFlowState[];
    session?: AccountSession;
}): FakeFlowService {
    let startIndex = 0;
    let submitIndex = 0;
    const service: FakeFlowService = {
        startLoginRequests: [],
        submitRequests: [],
        pollRequests: 0,
        cancelled: [],
        startLogin(kind: string, methodId: string) {
            service.startLoginRequests.push({ kind, methodId });
            const state = options.startStates[startIndex] ?? { status: 'ready' };
            startIndex++;
            return Promise.resolve({ flowId: 'flow-1', state });
        },
        submitLogin(_flowId: string, values: Record<string, string>) {
            service.submitRequests.push(values);
            const state = options.submitStates?.[submitIndex] ?? {
                status: 'completed',
                session: options.session ?? {
                    backendId: 'opendesk',
                    kind: 'personal',
                    baseUrl: 'https://personal.example.com/api/v1',
                    user: { id: 'u-1', username: 'alice' }
                }
            };
            submitIndex++;
            return Promise.resolve(state);
        },
        pollLogin(_flowId: string) {
            service.pollRequests++;
            const states = options.pollStates ?? [{ status: 'completed', session: options.session } as never];
            const state = states[Math.min(service.pollRequests - 1, states.length - 1)];
            return Promise.resolve(state);
        },
        cancelLogin(flowId: string) {
            service.cancelled.push(flowId);
            return Promise.resolve();
        }
    };
    return service;
}

const formMethod: PluginAccountLoginMethod = {
    id: 'password',
    type: 'form',
    displayName: { en: 'Password', zh: '密码登录' },
    fields: [
        { id: 'username', type: 'text', label: { en: 'Username', zh: '用户名' }, required: true },
        { id: 'password', type: 'password', label: { en: 'Password', zh: '密码' }, required: true }
    ]
};

const browserMethod: PluginAccountLoginMethod = { id: 'sso', type: 'browser', displayName: { en: 'SSO' } };

function createIo(overrides: Partial<LoginFlowIo> = {}): LoginFlowIo & {
    prompts: Array<{ label: string; secret: boolean }>;
    status: string[];
    currentTime: number;
    answers: Record<string, string>;
} {
    const io = {
        prompts: [] as Array<{ label: string; secret: boolean }>,
        status: [] as string[],
        currentTime: 0,
        answers: { Username: 'alice', Password: 'secret' } as Record<string, string>,
        resolveText: (displayName: unknown) => {
            const text = displayName as { en?: string } | undefined;
            return text?.en ?? '';
        },
        promptText: (label: string) => {
            io.prompts.push({ label, secret: false });
            return Promise.resolve(io.answers[label] ?? '');
        },
        promptSecret: (label: string) => {
            io.prompts.push({ label, secret: true });
            return Promise.resolve(io.answers[label] ?? '');
        },
        showStatus: (message: string) => {
            io.status.push(message);
        },
        delay: (ms: number) => {
            io.currentTime += ms;
            return Promise.resolve();
        },
        now: () => io.currentTime
    };
    return Object.assign(io, overrides) as LoginFlowIo & typeof io;
}

test('form login prompts fields in order and submits collected values', async () => {
    const service = createService({ startStates: [{ status: 'ready' }] });
    const io = createIo();

    const session = await runLoginFlow(service as never, 'personal', formMethod, io);

    assert.deepEqual(service.startLoginRequests, [{ kind: 'personal', methodId: 'password' }]);
    assert.deepEqual(io.prompts, [
        { label: 'Username', secret: false },
        { label: 'Password', secret: true }
    ]);
    assert.deepEqual(service.submitRequests, [{ username: 'alice', password: 'secret' }]);
    assert.equal(service.pollRequests, 0);
    assert.equal(session.user.username, 'alice');
});

test('required empty field aborts with a mapped field error', async () => {
    const service = createService({ startStates: [{ status: 'ready' }] });
    const io = createIo({ answers: { Username: 'alice', Password: '' } });

    await assert.rejects(runLoginFlow(service as never, 'personal', formMethod, io), {
        message: 'account:field_required:Password'
    });
    assert.equal(service.submitRequests.length, 0);
    setRuntimeLocale('en-US');
    try {
        assert.equal(describeLoginError(new Error('account:field_required:Password')), '"Password" is required');
    } finally {
        setRuntimeLocale(null);
    }
});

test('device-code login shows the code and polls until completion', async () => {
    const service = createService({
        startStates: [{ status: 'device-code', code: 'ABCD-1234', verificationUrl: 'https://example.com/activate' }],
        pollStates: [
            { status: 'waiting', message: { en: 'Waiting for approval' } },
            {
                status: 'completed',
                session: { backendId: 'x', kind: 'personal', baseUrl: '', user: { id: 'u', username: 'bob' } }
            }
        ]
    });
    const io = createIo();

    const session = await runLoginFlow(service as never, 'enterprise', browserMethod, io);

    assert.deepEqual(io.status, ['ABCD-1234 · https://example.com/activate', 'Waiting for approval']);
    assert.equal(service.pollRequests, 2);
    assert.equal(io.currentTime, LOGIN_FLOW_POLL_INTERVAL_MS * 2);
    assert.equal(session.user.username, 'bob');
});

test('browser login shows the opened URL before polling', async () => {
    const service = createService({
        startStates: [{ status: 'opening-browser', url: 'https://sso.example.com/authorize' }],
        pollStates: [
            {
                status: 'completed',
                session: { backendId: 'x', kind: 'personal', baseUrl: '', user: { id: 'u', username: 'bob' } }
            }
        ]
    });
    const io = createIo();

    await runLoginFlow(service as never, 'personal', browserMethod, io);

    assert.deepEqual(io.status, ['https://sso.example.com/authorize']);
});

test('failed flow state surfaces the plugin error code', async () => {
    const service = createService({
        startStates: [{ status: 'ready' }],
        submitStates: [{ status: 'failed', errorCode: 'account:credentials_required' }]
    });

    await assert.rejects(runLoginFlow(service as never, 'personal', formMethod, createIo()), {
        message: 'account:credentials_required'
    });
});

test('login times out when polling never reaches a terminal state', async () => {
    const service = createService({
        startStates: [{ status: 'device-code', code: 'C', verificationUrl: 'https://example.com' }],
        pollStates: [{ status: 'waiting' } as PluginAccountLoginFlowState]
    });
    const io = createIo({ now: () => io.currentTime + LOGIN_FLOW_TIMEOUT_MS });

    await assert.rejects(runLoginFlow(service as never, 'personal', browserMethod, io), {
        message: 'account:login_timeout'
    });
    assert.deepEqual(service.cancelled, ['flow-1']);
});

test('describeLoginError maps host error codes to localized copy', () => {
    setRuntimeLocale('zh-CN');
    try {
        assert.equal(describeLoginError(new Error('account:credentials_required')), '请输入用户名和密码');
        assert.equal(describeLoginError(new Error('account:login_timeout')), '登录超时，请重试');
        assert.equal(
            describeLoginError(new Error('account:backend_unavailable:enterprise')),
            '账号服务暂不可用，请稍后重试'
        );
        assert.equal(describeLoginError(new Error('account:login_method_unavailable:sso')), '登录方式不可用：sso');
        // 未知错误码原样透出
        assert.equal(describeLoginError(new Error('account:plugin_custom_failure')), 'account:plugin_custom_failure');
        assert.equal(describeLoginError(new Error('plain message')), 'plain message');
    } finally {
        setRuntimeLocale(null);
    }
});
