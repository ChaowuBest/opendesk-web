import { expect, jest, test } from '@jest/globals';
import { fetchProviderModelNames } from '../../../main/utils/provider-models.js';

test('returns more than twenty models, with duplicates and malformed names removed', async () => {
    const data = Array.from({ length: 35 }, (_, i) => ({ id: `model-${i}` }));
    const fetch = jest.fn(async () => new Response(JSON.stringify({ data: [...data, data[0], { id: 4 }, {}] })));
    const names = await fetchProviderModelNames(
        { base_url: 'https://example.test/v1/', api_key: 'test', no_proxy: true },
        fetch
    );
    expect(names).toHaveLength(35);
    expect(fetch.mock.calls[0][1]).toBe('https://example.test/v1/models');
    expect(fetch.mock.calls[0][0].no_proxy).toBe(true);
});

test('uses the Anthropic endpoint and authentication headers', async () => {
    const fetch = jest.fn(async () => new Response(JSON.stringify({ data: [{ id: 'claude' }] })));
    await fetchProviderModelNames(
        { base_url: 'https://example.test', api_key: 'test', provider_type: 'anthropic', no_ssl: true },
        fetch
    );
    expect(fetch.mock.calls[0][1]).toBe('https://example.test/v1/models');
    expect(fetch.mock.calls[0][2].headers).toMatchObject({ 'x-api-key': 'test', 'anthropic-version': '2023-06-01' });
});

test('propagates HTTP, invalid response, and network failures instead of returning an empty list', async () => {
    const provider = { base_url: 'https://example.test/v1', api_key: '' };
    await expect(fetchProviderModelNames(provider, async () => new Response('', { status: 401 }))).rejects.toThrow(
        'MODEL_LIST_HTTP_401'
    );
    await expect(fetchProviderModelNames(provider, async () => new Response('{"error":"bad"}'))).rejects.toThrow(
        'MODEL_LIST_INVALID'
    );
    await expect(fetchProviderModelNames(provider, async () => new Response('<html>not JSON</html>'))).rejects.toThrow(
        'MODEL_LIST_INVALID'
    );
    await expect(
        fetchProviderModelNames(provider, async () => {
            throw new Error('timeout');
        })
    ).rejects.toThrow('timeout');
});
