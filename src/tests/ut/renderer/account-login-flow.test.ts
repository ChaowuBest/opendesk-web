import { describe, expect, test } from '@jest/globals';
import {
    ACCOUNT_LOGIN_TIMEOUT_MS,
    describeAccountError,
    describeLoginFlowStatus,
    formatAccountLoginError,
    resolveLocalizedText,
    runAccountLoginFlow,
    splitLoginMethods,
    type AccountApi,
    type AccountLoginMethod
} from '../../../renderer/utils/account-login.ts';

const translate = (key: string, params?: Record<string, string | number>): string => {
    const table: Record<string, string> = {
        'renderer.account.errors.credentialsRequired': '请输入用户名和密码',
        'renderer.account.errors.loginCancelled': '登录已取消',
        'renderer.account.errors.loginTimeout': '登录超时，请重试',
        'renderer.account.errors.notLoggedIn': '尚未登录账号',
        'renderer.account.errors.backendUnavailable': '账号服务暂不可用，请稍后重试',
        'renderer.account.errors.loginFlowNotSubmittable': '当前登录方式不支持表单提交',
        'renderer.account.errors.loginFlowNotPollable': '当前登录方式不支持状态轮询',
        'renderer.account.errors.loginMethodUnavailable': '登录方式不可用：${detail}',
        'renderer.account.errors.fieldRequired': '请输入${field}',
        'renderer.account.loginFailed': '登录失败'
    };
    let text = table[key] ?? key;
    if (params) {
        for (const [name, value] of Object.entries(params)) {
            text = text.replace(new RegExp(`\\$\\{${name}\\}`, 'g'), String(value));
        }
    }
    return text;
};

const formMethod: AccountLoginMethod = {
    id: 'password',
    type: 'form',
    displayName: { en: 'Password', zh: '密码登录' },
    fields: []
};

const deviceMethod: AccountLoginMethod = { id: 'device', type: 'device-code', displayName: 'Device' };

const session = {
    backendId: 'opendesk',
    kind: 'personal' as const,
    baseUrl: 'https://personal.example.com/api/v1',
    user: { id: 'u-1', username: 'alice' }
};

function createApi(
    states: unknown[]
): AccountApi & { statusShown: string[]; submitted: Array<Record<string, string>> } {
    let index = 0;
    const api = {
        statusShown: [] as string[],
        submitted: [] as Array<Record<string, string>>,
        startLogin: async () => ({ flowId: 'flow-1', state: states[index++] ?? { status: 'completed', session } }),
        pollLogin: async () => states[index++] ?? { status: 'completed', session },
        submitLogin: async (_flowId: string, values: Record<string, string>) => {
            api.submitted.push(values);
            return states[index++] ?? { status: 'completed', session };
        }
    };
    return api as never;
}

describe('account login flow driver', () => {
    test('form method submits values and returns the completed session', async () => {
        const api = createApi([{ status: 'ready' }]);
        const result = await runAccountLoginFlow({ api, kind: 'personal', method: formMethod, values: { u: '1' } });
        expect(result).toEqual(session);
        expect(api.submitted).toEqual([{ u: '1' }]);
    });

    test('device-code method renders status and polls until completion', async () => {
        const api = createApi([
            { status: 'device-code', code: 'ABCD', verificationUrl: 'https://example.com/activate' },
            { status: 'waiting', message: { en: 'Waiting', zh: '等待确认' } },
            { status: 'completed', session }
        ]);
        const delays: number[] = [];
        const result = await runAccountLoginFlow({
            api,
            kind: 'personal',
            method: deviceMethod,
            onStatus: (message) => {
                if (message !== undefined) api.statusShown.push(message);
            },
            resolveText: (value) => resolveLocalizedText(value, 'zh-CN'),
            delay: async (ms) => {
                delays.push(ms);
            },
            now: () => 0
        });
        expect(api.statusShown).toEqual(['ABCD · https://example.com/activate', '等待确认']);
        expect(delays).toEqual([1000, 1000]);
        expect(result).toEqual(session);
    });

    test('browser method routes the auth URL to onBrowserUrl instead of the status text', async () => {
        const api = createApi([
            { status: 'opening-browser', url: 'https://sso.example.com/authorize' },
            { status: 'completed', session }
        ]);
        const browserUrls: string[] = [];
        const statuses: string[] = [];
        const result = await runAccountLoginFlow({
            api,
            kind: 'personal',
            method: { id: 'gitcode', type: 'browser', displayName: 'GitCode' },
            onStatus: (message) => {
                if (message !== undefined) statuses.push(message);
            },
            onBrowserUrl: (url) => browserUrls.push(url),
            delay: async () => {},
            now: () => 0
        });
        expect(result).toEqual(session);
        expect(browserUrls).toEqual(['https://sso.example.com/authorize']);
        expect(statuses).toEqual([]);
    });

    test('polling exceeds the timeout and fails with the shared timeout code', async () => {
        const api = createApi([
            { status: 'device-code', code: 'A', verificationUrl: 'https://example.com' },
            { status: 'waiting' },
            { status: 'waiting' }
        ]);
        let advanced = 0;
        await expect(
            runAccountLoginFlow({
                api,
                kind: 'personal',
                method: deviceMethod,
                delay: async () => {
                    advanced += ACCOUNT_LOGIN_TIMEOUT_MS;
                },
                now: () => advanced
            })
        ).rejects.toThrow('account:login_timeout');
    });

    test('failed terminal state surfaces the plugin error code', async () => {
        const api = createApi([{ status: 'ready' }]);
        api.submitLogin = async () => ({ status: 'failed', errorCode: 'account:credentials_required' });
        await expect(runAccountLoginFlow({ api, kind: 'personal', method: formMethod, values: {} })).rejects.toThrow(
            'account:credentials_required'
        );
    });

    test('missing host api surfaces the backend-unavailable code', async () => {
        await expect(
            runAccountLoginFlow({ api: {}, kind: 'personal', method: formMethod, values: {} })
        ).rejects.toThrow('account:backend_unavailable');
    });
});

describe('account error copy', () => {
    test('known host error codes are localized', () => {
        expect(describeAccountError(new Error('account:credentials_required'), translate)).toBe('请输入用户名和密码');
        expect(describeAccountError(new Error('account:login_timeout'), translate)).toBe('登录超时，请重试');
        expect(describeAccountError(new Error('account:backend_unavailable:enterprise'), translate)).toBe(
            '账号服务暂不可用，请稍后重试'
        );
        expect(describeAccountError(new Error('account:login_method_unavailable:sso'), translate)).toBe(
            '登录方式不可用：sso'
        );
        expect(describeAccountError(new Error('account:field_required:密码'), translate)).toBe('请输入密码');
    });

    test('unknown codes pass through unchanged', () => {
        expect(describeAccountError(new Error('account:plugin_custom'), translate)).toBe('account:plugin_custom');
        expect(describeAccountError(new Error('boom'), translate)).toBe('boom');
        expect(describeAccountError('raw', translate)).toBe('raw');
    });

    test('login failures render as `<prefix>：<reason>`', () => {
        expect(formatAccountLoginError(new Error('account:login_timeout'), translate, '登录失败')).toBe(
            '登录失败：登录超时，请重试'
        );
    });
});

describe('login method partitioning', () => {
    const gitcode: AccountLoginMethod = { id: 'gitcode', type: 'browser', displayName: 'GitCode' };
    const gitee: AccountLoginMethod = { id: 'gitee', type: 'browser', displayName: 'Gitee' };

    test('keeps the password form separate and preserves provider order', () => {
        const { passwordMethod, providerMethods } = splitLoginMethods([formMethod, gitcode, gitee]);
        expect(passwordMethod?.id).toBe('password');
        expect(providerMethods.map((method) => method.id)).toEqual(['gitcode', 'gitee']);
    });

    test('handles provider-only and empty method lists', () => {
        expect(splitLoginMethods([gitcode]).passwordMethod).toBeNull();
        expect(splitLoginMethods([gitcode]).providerMethods).toEqual([gitcode]);
        expect(splitLoginMethods(null)).toEqual({ passwordMethod: null, providerMethods: [] });
        expect(splitLoginMethods([])).toEqual({ passwordMethod: null, providerMethods: [] });
    });
});

describe('localized text resolution', () => {
    test('prefers exact locale then same primary language then first entry', () => {
        expect(resolveLocalizedText({ en: 'Password', zh: '密码' }, 'zh-CN')).toBe('密码');
        expect(resolveLocalizedText({ 'pt-BR': 'Senha', en: 'Password' }, 'pt-PT')).toBe('Senha');
        expect(resolveLocalizedText({ 'pt-BR': 'Senha', en: 'Password' }, 'ja-JP')).toBe('Senha');
        expect(resolveLocalizedText('plain', 'zh-CN')).toBe('plain');
        expect(resolveLocalizedText(undefined, 'zh-CN')).toBe('');
    });

    test('status rendering covers device-code, waiting and browser states', () => {
        expect(
            describeLoginFlowStatus(
                { status: 'device-code', code: 'X1', verificationUrl: 'https://e.com' },
                () => 'ignored'
            )
        ).toBe('X1 · https://e.com');
        expect(
            describeLoginFlowStatus({ status: 'waiting', message: { en: 'Wait' } }, (value) =>
                resolveLocalizedText(value, 'en-US')
            )
        ).toBe('Wait');
        expect(describeLoginFlowStatus({ status: 'opening-browser', url: 'https://sso' }, () => 'ignored')).toBe(
            'https://sso'
        );
        expect(describeLoginFlowStatus({ status: 'ready' }, () => 'ignored')).toBeUndefined();
        expect(describeLoginFlowStatus({ status: 'waiting' }, () => 'ignored')).toBeUndefined();
    });
});
