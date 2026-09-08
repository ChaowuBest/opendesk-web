import assert from 'node:assert/strict';
import test from 'node:test';
import {
    AccountBuiltinModelProvider,
    OPENDESK_BUILTIN_PROVIDER_NAME,
    pickBuiltinDefaultModel,
    type AccountModelApi
} from '../../../../main/applications/account/model-provider.js';
import type { BuiltinModelFetch, Model } from '../../../../main/utils/setting.js';

function makeRelayCredential(): string {
    return 'sk-od-test-credential';
}

function chatModel(alias: string, providerName: string): Model {
    return {
        alias,
        provider_name: providerName,
        model_name: alias,
        model_type: 'chat',
        auto_parse_think_tags: false,
        reasoning_effort: ''
    };
}

function embeddingModel(alias: string, providerName: string): Model {
    return {
        alias,
        provider_name: providerName,
        model_name: alias,
        model_type: 'embedding',
        auto_parse_think_tags: false
    };
}

function modelsFetch(models: string[], onRequest?: (url: string, init: RequestInit) => void): BuiltinModelFetch {
    return async (input, init) => {
        onRequest?.(String(input), init ?? {});
        return new Response(JSON.stringify({ data: models }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        });
    };
}

test('内置提供方常量符合命名约定', () => {
    assert.equal(OPENDESK_BUILTIN_PROVIDER_NAME, 'opendesk');
});

test('refreshModels 通过模型 API 拉取并解析模型描述', async () => {
    const api: AccountModelApi = {
        baseUrl: 'https://ent.example.com/api/v1/relay/v1',
        token: makeRelayCredential()
    };
    let requestedUrl = '';
    let authHeader = '';
    const provider = new AccountBuiltinModelProvider(() => api);
    const models = await provider.refreshModels(
        modelsFetch(['opendesk/auto', 'vendor/model-b'], (url, init) => {
            requestedUrl = url;
            authHeader = (init.headers as Record<string, string>)?.Authorization ?? '';
        })
    );

    assert.equal(requestedUrl, 'https://ent.example.com/api/v1/relay/v1/models');
    assert.ok(authHeader.startsWith('Bearer '));
    assert.equal(models.length, 2);
    assert.equal(models[0].alias, 'opendesk/auto');
    assert.equal(models[0].provider_name, OPENDESK_BUILTIN_PROVIDER_NAME);
    assert.equal(models[0].model_name, 'auto');
    assert.equal(models[0].model_type, 'chat');
    assert.equal(models[1].alias, 'vendor/model-b');
    assert.equal(models[1].provider_name, 'vendor');
    assert.equal(models[1].model_name, 'model-b');
});

test('refreshModels 未登录时返回空列表', async () => {
    const provider = new AccountBuiltinModelProvider(() => null);
    const models = await provider.refreshModels(modelsFetch(['opendesk/auto']));
    assert.deepEqual(models, []);
});

test('refreshModels 接口失败时返回空列表', async () => {
    const api: AccountModelApi = { baseUrl: 'https://x.example.com/relay/v1', token: makeRelayCredential() };
    const provider = new AccountBuiltinModelProvider(() => api);
    const models = await provider.refreshModels(async () => new Response('oops', { status: 500 }));
    assert.deepEqual(models, []);
});

test('refreshModels 支持接口返回对象形式模型描述', async () => {
    const api: AccountModelApi = { baseUrl: 'https://x.example.com/relay/v1', token: makeRelayCredential() };
    const provider = new AccountBuiltinModelProvider(() => api);
    const fetchImpl: BuiltinModelFetch = async () =>
        new Response(JSON.stringify({ data: [{ id: 'obj/model-a' }, { name: 'obj/model-b' }] }), { status: 200 });
    const models = await provider.refreshModels(fetchImpl);
    assert.equal(models.length, 2);
    assert.equal(models[0].alias, 'obj/model-a');
    assert.equal(models[1].alias, 'obj/model-b');
});

test('resolveInstance 用 relay 凭据构造模型实例', () => {
    const token = makeRelayCredential();
    const api: AccountModelApi = { baseUrl: 'https://ent.example.com/api/v1/relay/v1', token };
    const provider = new AccountBuiltinModelProvider(() => api);
    const instance = provider.resolveInstance(
        { alias: 'opendesk/auto', provider_name: 'opendesk', model_name: 'auto', model_type: 'chat' },
        'chat'
    );
    assert.ok(instance);
    assert.equal(instance.model_name, 'opendesk/auto');
    assert.equal(instance.base_url, 'https://ent.example.com/api/v1/relay/v1');
    assert.equal(instance.api_key, token);
    assert.equal(instance.provider_type, 'openai');
    assert.equal(instance.provider_name, 'opendesk');
});

test('resolveInstance 未登录或 embedding 时不解析', () => {
    const api: AccountModelApi = { baseUrl: 'https://x.example.com/relay/v1', token: makeRelayCredential() };
    const model = { alias: 'opendesk/auto', provider_name: 'opendesk', model_name: 'auto', model_type: 'chat' };
    assert.equal(new AccountBuiltinModelProvider(() => null).resolveInstance(model, 'chat'), null);
    assert.equal(new AccountBuiltinModelProvider(() => api).resolveInstance(model, 'embedding'), null);
});

test('pickBuiltinDefaultModel 优先账号自带模型', () => {
    assert.equal(pickBuiltinDefaultModel([chatModel('vendor/x', 'vendor')]), 'vendor/x');
    assert.equal(
        pickBuiltinDefaultModel([
            chatModel('vendor/x', 'vendor'),
            chatModel('opendesk/auto', OPENDESK_BUILTIN_PROVIDER_NAME)
        ]),
        'opendesk/auto'
    );
});

test('pickBuiltinDefaultModel 跳过 embedding，空列表返回 null', () => {
    assert.equal(pickBuiltinDefaultModel([]), null);
    assert.equal(pickBuiltinDefaultModel([embeddingModel('opendesk/embed', OPENDESK_BUILTIN_PROVIDER_NAME)]), null);
    assert.equal(
        pickBuiltinDefaultModel([
            embeddingModel('opendesk/embed', OPENDESK_BUILTIN_PROVIDER_NAME),
            chatModel('opendesk/auto', OPENDESK_BUILTIN_PROVIDER_NAME)
        ]),
        'opendesk/auto'
    );
});
