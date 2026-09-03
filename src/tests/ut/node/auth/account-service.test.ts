import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthenticationError } from '@bitclub.ai/opendesk-server-sdk';
import type { LoginRequest, ProfileUpdate, Token, UserOut } from '@bitclub.ai/opendesk-server-sdk';
import { AccountService } from '../../../../main/applications/account/service.js';
import type {
    AccountClient,
    AccountKind,
    AccountSessionFile,
    AccountSessionStore
} from '../../../../main/applications/account/types.js';

class MemoryAccountSessionStore implements AccountSessionStore {
    session: AccountSessionFile | null = null;

    load(): AccountSessionFile | null {
        return this.session ? structuredClone(this.session) : null;
    }

    save(session: AccountSessionFile): void {
        this.session = structuredClone(session);
    }

    clear(): void {
        this.session = null;
    }
}

interface FakeAuth {
    loginCalls: LoginRequest[];
    meData: UserOut;
    updateCalls: ProfileUpdate[];
    refreshResult: Token;
    logoutCalls: number;
    login(data: LoginRequest): Promise<Token>;
    getMe(): Promise<UserOut>;
    updateMe(data: ProfileUpdate): Promise<UserOut>;
    refresh(): Promise<Token>;
    logout(): Promise<{ message: string }>;
}

interface FakeClient {
    auth: FakeAuth;
    token: string | null;
    setToken(token: string): void;
}

function makeFakeClient(): FakeClient {
    const client = {
        auth: null as unknown as FakeAuth,
        token: null as string | null,
        setToken(token: string) {
            this.token = token;
        }
    };
    const meData: UserOut = {
        id: 'u-1',
        username: 'alice',
        email: 'alice@example.com',
        display_name: 'Alice',
        avatar_url: null,
        is_active: true,
        is_super_admin: false,
        created_at: '2026-01-01T00:00:00Z',
        oauth_accounts: []
    };
    client.auth = {
        loginCalls: [],
        meData,
        updateCalls: [],
        refreshResult: { access_token: 'refreshed-token', token_type: 'Bearer' },
        logoutCalls: 0,
        async login(data) {
            this.loginCalls.push(data);
            this.meData = { ...this.meData, username: data.username };
            client.setToken('access-token-123');
            return { access_token: 'access-token-123', token_type: 'Bearer' };
        },
        async getMe() {
            return this.meData;
        },
        async updateMe(data) {
            this.updateCalls.push(data);
            this.meData = { ...this.meData, display_name: data.display_name ?? null };
            return this.meData;
        },
        async refresh() {
            return this.refreshResult;
        },
        async logout() {
            this.logoutCalls++;
            return { message: 'ok' };
        }
    };
    return client;
}

function createFixture() {
    const store = new MemoryAccountSessionStore();
    const client = makeFakeClient();
    const service = new AccountService({
        store,
        getBaseUrl: (kind: AccountKind) =>
            kind === 'personal' ? 'http://127.0.0.1:8000/api/v1' : 'http://enterprise.example.com/api/v1',
        clientFactory: () => client as unknown as AccountClient,
        isAuthenticationError: (error) => error instanceof AuthenticationError
    });
    return { store, client, service };
}

test('login builds a session, persists it and returns it', async () => {
    const { store, client, service } = createFixture();
    const session = await service.login('personal', 'alice', 'secret');

    assert.equal(session.kind, 'personal');
    assert.equal(session.baseUrl, 'http://127.0.0.1:8000/api/v1');
    assert.equal(session.accessToken, 'access-token-123');
    assert.equal(session.user.username, 'alice');
    assert.deepEqual(client.auth.loginCalls, [{ username: 'alice', password: 'secret' }]);
    assert.equal(client.token, 'access-token-123');
    assert.deepEqual(service.getSession(), session);
    assert.equal(store.load()?.accessToken, 'access-token-123');
});

test('init restores the persisted session', async () => {
    const { store, client, service } = createFixture();
    await service.login('enterprise', 'bob', 'pw');
    const restored = new AccountService({
        store,
        getBaseUrl: () => '',
        clientFactory: () => client as unknown as AccountClient,
        isAuthenticationError: (error) => error instanceof AuthenticationError
    });

    restored.init();

    assert.equal(restored.getSession()?.kind, 'enterprise');
    assert.equal(restored.getSession()?.user.username, 'bob');
    assert.equal(client.token, 'access-token-123');
});

test('getUserInfo returns null when not logged in', async () => {
    const { service } = createFixture();
    assert.equal(await service.getUserInfo(), null);
});

test('getUserInfo returns null when the token is unauthorized', async () => {
    const { client, service } = createFixture();
    await service.login('personal', 'alice', 'secret');
    client.auth.getMe = async () => {
        throw new AuthenticationError('unauthorized');
    };
    assert.equal(await service.getUserInfo(), null);
});

test('updateDisplayName persists the new display name', async () => {
    const { store, client, service } = createFixture();
    await service.login('personal', 'alice', 'secret');

    const user = await service.updateDisplayName('Alice Smith');

    assert.equal(user.display_name, 'Alice Smith');
    assert.deepEqual(client.auth.updateCalls, [{ display_name: 'Alice Smith' }]);
    assert.equal(store.load()?.user.display_name, 'Alice Smith');
});

test('refreshToken rotates the token and persists it', async () => {
    const { store, client, service } = createFixture();
    await service.login('personal', 'alice', 'secret');

    const session = await service.refreshToken();

    assert.equal(session.accessToken, 'refreshed-token');
    assert.equal(client.token, 'refreshed-token');
    assert.equal(store.load()?.accessToken, 'refreshed-token');
});

test('logout clears the in-memory session and the store', async () => {
    const { store, service } = createFixture();
    await service.login('personal', 'alice', 'secret');

    await service.logout();

    assert.equal(service.getSession(), null);
    assert.equal(store.load(), null);
});
