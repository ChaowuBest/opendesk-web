import { describe, expect, test } from '@jest/globals';
import {
    ADMIN_STATS_SERVER_URL,
    ADMIN_STATS_SERVER_URL_ENV,
    adminApiFetch,
    fetchAdminFeedbackDetail,
    fetchAdminFeedbackList,
    resolveAdminStatsServerUrl
} from '../../../main/utils/admin-stats.js';

describe('admin stats server url resolution', () => {
    test('defaults to production server', () => {
        expect(resolveAdminStatsServerUrl({})).toBe(ADMIN_STATS_SERVER_URL);
    });

    test('env override wins and trailing slashes are trimmed', () => {
        expect(resolveAdminStatsServerUrl({ [ADMIN_STATS_SERVER_URL_ENV]: 'http://127.0.0.1:8788///' })).toBe(
            'http://127.0.0.1:8788'
        );
    });

    test('blank override falls back to production server', () => {
        expect(resolveAdminStatsServerUrl({ [ADMIN_STATS_SERVER_URL_ENV]: '   ' })).toBe(ADMIN_STATS_SERVER_URL);
    });
});

describe('adminApiFetch', () => {
    const token = 'secret-token';

    test('sends bearer token and returns json payload', async () => {
        const requests: Array<{ input: string | URL; init?: RequestInit }> = [];
        const fetchImpl = async (input: string | URL, init?: RequestInit) => {
            requests.push({ input, init });
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        };
        const data = await adminApiFetch('https://example.com/api/stats', token, { fetchImpl });
        expect(data).toEqual({ ok: true });
        const headers = new Headers(requests[0].init?.headers);
        expect(headers.get('authorization')).toBe(`Bearer ${token}`);
    });

    test('401 maps to unauthorized error with server message', async () => {
        const fetchImpl = async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
        await expect(adminApiFetch('https://example.com/api/stats', 'bad', { fetchImpl })).rejects.toEqual({
            status: 401,
            message: 'unauthorized'
        });
    });

    test('503 server message is preserved', async () => {
        const fetchImpl = async () =>
            new Response(JSON.stringify({ error: 'admin token not configured' }), { status: 503 });
        await expect(adminApiFetch('https://example.com/api/stats', token, { fetchImpl })).rejects.toEqual({
            status: 503,
            message: 'admin token not configured'
        });
    });

    test('network failure maps to status 0', async () => {
        const fetchImpl = async () => {
            throw new Error('ECONNREFUSED');
        };
        await expect(adminApiFetch('https://example.com/api/stats', token, { fetchImpl })).rejects.toEqual({
            status: 0,
            message: 'ECONNREFUSED'
        });
    });
});

describe('feedback list pagination and detail', () => {
    const token = 'secret-token';
    const server = 'https://stats.example';

    function recordingFetch() {
        const urls: string[] = [];
        const fetchImpl = async (input: string | URL) => {
            urls.push(String(input));
            return new Response(JSON.stringify({ ok: true, items: [] }), { status: 200 });
        };
        return { urls, fetchImpl };
    }

    test('list builds type and offset query params', async () => {
        const { urls, fetchImpl } = recordingFetch();
        await fetchAdminFeedbackList(token, 20, server, { fetchImpl }, { type: 'bug', offset: 40 });
        expect(urls[0]).toBe(`${server}/api/feedback/list?limit=20&type=bug&offset=40`);
    });

    test('list omits type and offset when not provided', async () => {
        const { urls, fetchImpl } = recordingFetch();
        await fetchAdminFeedbackList(token, 50, server, { fetchImpl });
        expect(urls[0]).toBe(`${server}/api/feedback/list?limit=50`);
    });

    test('detail hits the detail endpoint by id', async () => {
        const { urls, fetchImpl } = recordingFetch();
        await fetchAdminFeedbackDetail(token, 7, server, { fetchImpl });
        expect(urls[0]).toBe(`${server}/api/feedback/detail/7`);
    });
});
