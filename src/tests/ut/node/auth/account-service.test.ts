import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    PluginAccountBackend,
    PluginAccountLoginFlow,
    PluginAccountLoginFlowRequest,
    PluginAccountSession
} from '../../../../../packages/plugin-sdk/src/index.js';
import { AccountService } from '../../../../main/applications/account/service.js';

function createBackend(): PluginAccountBackend & {
    requests: PluginAccountLoginFlowRequest[];
    initializeCalls: number;
} {
    const session: PluginAccountSession = {
        backendId: 'test-backend',
        kind: 'personal',
        baseUrl: 'https://personal.example.com/api/v1',
        user: { id: 'u-1', username: 'alice' }
    };
    return {
        id: 'test-backend',
        kinds: ['personal', 'enterprise'],
        requests: [],
        initializeCalls: 0,
        initialize() {
            this.initializeCalls++;
        },
        getSession: () => session,
        getUserInfo: async () => session.user,
        getLoginMethods: async () => [
            {
                id: 'password',
                type: 'form' as const,
                displayName: { en: 'Password', zh: '密码登录' },
                fields: [
                    { id: 'username', type: 'text' as const, label: { en: 'Username', zh: '用户名' }, required: true },
                    { id: 'password', type: 'password' as const, label: { en: 'Password', zh: '密码' }, required: true }
                ]
            }
        ],
        async createLoginFlow(request) {
            this.requests.push(request);
            const flow: PluginAccountLoginFlow = {
                getState: () => ({ status: 'ready' }),
                submit: async (values) => ({
                    status: 'completed',
                    session: { ...session, kind: request.kind, baseUrl: request.baseUrl }
                }),
                cancel: async () => undefined
            };
            return flow;
        },
        updateDisplayName: async (displayName) => ({ ...session.user, display_name: displayName }),
        refreshToken: async () => session,
        logout: async () => undefined
    };
}

test('initialization retries until the account backend is registered', () => {
    const backend = createBackend();
    let available = false;
    const service = new AccountService({
        getBaseUrl: () => '',
        getBackend: () => (available ? backend : undefined)
    });

    assert.equal(service.init(), false);
    available = true;
    assert.equal(service.init(), true);
    assert.equal(backend.initializeCalls, 1);
});

test('starting a login flow passes the private server address to the backend', async () => {
    const backend = createBackend();
    const service = new AccountService({
        getBaseUrl: (kind) =>
            kind === 'enterprise' ? 'https://enterprise.example.com/api/v1' : 'https://personal.example.com/api/v1',
        getBackend: () => backend
    });

    const started = await service.startLogin('enterprise', 'password');
    const completed = await service.submitLogin(started.flowId, { username: 'alice', password: 'secret' });

    assert.equal(started.state.status, 'ready');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.status === 'completed' && completed.session.kind, 'enterprise');
    assert.deepEqual(backend.requests, [
        {
            kind: 'enterprise',
            baseUrl: 'https://enterprise.example.com/api/v1',
            methodId: 'password'
        }
    ]);
});

test('personal login falls back to the backend-declared default base URL when unconfigured', async () => {
    const backend = createBackend();
    backend.getDefaultBaseUrl = (kind) =>
        kind === 'personal' ? 'https://plugin-default.example.com/api/v1' : undefined;
    const service = new AccountService({ getBaseUrl: () => '', getBackend: () => backend });

    await service.startLogin('personal', 'password');

    assert.deepEqual(backend.requests, [
        {
            kind: 'personal',
            baseUrl: 'https://plugin-default.example.com/api/v1',
            methodId: 'password'
        }
    ]);
});

test('configured base URL takes precedence over the backend default', async () => {
    const backend = createBackend();
    backend.getDefaultBaseUrl = () => 'https://plugin-default.example.com/api/v1';
    const service = new AccountService({
        getBaseUrl: () => 'https://configured.example.com/api/v1',
        getBackend: () => backend
    });

    await service.startLogin('personal', 'password');

    assert.equal(backend.requests[0]?.baseUrl, 'https://configured.example.com/api/v1');
});

test('login flow operations reject stale flow ids', async () => {
    const backend = createBackend();
    const service = new AccountService({ getBaseUrl: () => '', getBackend: () => backend });
    const first = await service.startLogin('personal', 'password');
    const second = await service.startLogin('personal', 'password');

    await assert.rejects(service.submitLogin(first.flowId, {}), { message: 'account:login_flow_not_found' });
    await assert.rejects(service.pollLogin(first.flowId), { message: 'account:login_flow_not_found' });
    await assert.rejects(service.cancelLogin(first.flowId), { message: 'account:login_flow_not_found' });
    await service.cancelLogin(second.flowId);
});

test('plugin sessions are validated and rebuilt before crossing the host boundary', () => {
    const backend = createBackend();
    backend.getSession = () =>
        ({
            backendId: 'test-backend',
            kind: 'personal',
            baseUrl: 'https://personal.example.com/api/v1',
            user: { id: 'u-1', username: 'alice' },
            accessToken: 'must-not-cross'
        }) as PluginAccountSession;
    const service = new AccountService({ getBaseUrl: () => '', getBackend: () => backend });

    assert.deepEqual(service.getSession(), {
        backendId: 'test-backend',
        kind: 'personal',
        baseUrl: 'https://personal.example.com/api/v1',
        user: { id: 'u-1', username: 'alice' }
    });
});

test('invalid plugin login methods are rejected at the host boundary', async () => {
    const backend = createBackend();
    backend.getLoginMethods = async () => [{ id: 'bad', type: 'script', displayName: 'Bad' } as never];
    const service = new AccountService({ getBaseUrl: () => '', getBackend: () => backend });

    await assert.rejects(service.getLoginMethods('personal'), { message: 'account:login_methods_invalid' });
});

test('login methods are resolved with the host-owned account kind and base URL', async () => {
    const backend = createBackend();
    const service = new AccountService({
        getBaseUrl: () => 'https://enterprise.example.com/api/v1',
        getBackend: () => backend
    });

    const methods = await service.getLoginMethods('enterprise');

    assert.equal(methods[0]?.id, 'password');
});

test('public sessions forwarded by the service do not contain tokens', () => {
    const backend = createBackend();
    const service = new AccountService({ getBaseUrl: () => '', getBackend: () => backend });

    const session = service.getSession();

    assert.equal('accessToken' in (session ?? {}), false);
    assert.equal('tokenType' in (session ?? {}), false);
});

test('login methods fail when no backend supports the requested account kind', async () => {
    const service = new AccountService({ getBaseUrl: () => '', getBackend: () => undefined });

    await assert.rejects(service.getLoginMethods('enterprise'), {
        message: 'account:backend_unavailable:enterprise'
    });
});

test('a disposed backend stops answering and a replacement backend takes over', () => {
    const first = createBackend();
    const second = createBackend();
    let current: ReturnType<typeof createBackend> | undefined = first;
    const service = new AccountService({
        getBaseUrl: () => '',
        getBackend: () => current
    });

    assert.equal(service.getSession()?.backendId, 'test-backend');

    // 插件停用：旧后端不再生效，而不是继续返回幽灵会话
    current = undefined;
    assert.throws(() => service.getSession(), { message: 'account:backend_unavailable' });

    // 插件重载：新后端完成自己的初始化并接管
    current = second;
    assert.equal(service.getSession()?.backendId, 'test-backend');
    assert.equal(first.initializeCalls, 1);
    assert.equal(second.initializeCalls, 1);
});
