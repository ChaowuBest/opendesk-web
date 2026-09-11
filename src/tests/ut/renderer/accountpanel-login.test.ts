import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('个人中心账号面板重新登录', () => {
    let accountAPI: Record<string, jest.Mock>;
    let sessionChangedCallback: ((session: unknown) => void) | null;
    let win: ReturnType<typeof parseHTML>['window'];

    const enterpriseSession = {
        backendId: 'opendesk',
        kind: 'enterprise',
        baseUrl: 'https://enterprise.example.com',
        user: { id: 'u1', username: 'alice', display_name: 'Alice' }
    };

    const loginMethods = [
        {
            id: 'password',
            type: 'form',
            displayName: { en: 'Password', zh: '密码登录' },
            fields: [
                {
                    id: 'username',
                    type: 'text',
                    label: { en: 'Username', zh: '用户名' },
                    autocomplete: 'username',
                    required: true
                },
                {
                    id: 'password',
                    type: 'password',
                    label: { en: 'Password', zh: '密码' },
                    autocomplete: 'current-password',
                    required: true
                }
            ]
        }
    ];

    const flush = async (): Promise<void> => {
        for (let index = 0; index < 8; index += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    };

    const setInput = (root: ShadowRoot, selector: string, value: string): void => {
        const input = root.querySelector(selector) as HTMLInputElement;
        input.value = value;
        input.dispatchEvent(new win.Event('input', { bubbles: true }));
    };

    const submitLoginForm = (root: ShadowRoot): void => {
        const form = root.querySelector('[data-form="login"]') as HTMLFormElement;
        form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    };

    const openLoginPopover = async (): Promise<ShadowRoot> => {
        const panel = document.createElement('account-panel');
        document.body.appendChild(panel);
        await flush();
        const root = panel.shadowRoot!;
        (root.querySelector('.trigger') as HTMLButtonElement).click();
        await flush();
        return root;
    };

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html lang="zh-CN"><body></body></html>');
        win = window;
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            HTMLInputElement: window.HTMLInputElement,
            HTMLButtonElement: window.HTMLButtonElement,
            customElements: window.customElements,
            Event: window.Event,
            CSS: { escape: (value: string) => value }
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });
        await jest.unstable_mockModule('../../../renderer/styles/accountpanel.css?inline', () => ({ default: '' }));
        await import('../../../renderer/components/accountpanel.ts');
    });

    beforeEach(() => {
        sessionChangedCallback = null;
        accountAPI = {
            getConfig: jest.fn(async () => ({
                mode: 'enterprise',
                default_base_url: 'http://127.0.0.1:8000/api/v1',
                enterprise_base_url: 'https://enterprise.example.com'
            })),
            configure: jest.fn(async () => ({})),
            isSetupComplete: jest.fn(async () => true),
            isAvailable: jest.fn(async () => true),
            getSession: jest.fn(async () => null),
            getUserInfo: jest.fn(async () => null),
            getLoginMethods: jest.fn(async () =>
                loginMethods.map((method) => ({ ...method, fields: method.fields.map((field) => ({ ...field })) }))
            ),
            startLogin: jest.fn(async () => ({ flowId: 'flow-1', state: { status: 'ready' } })),
            submitLogin: jest.fn(async () => ({ status: 'completed', session: enterpriseSession })),
            pollLogin: jest.fn(async () => ({ status: 'failed', errorCode: 'account:login_cancelled' })),
            cancelLogin: jest.fn(async () => ({})),
            updateDisplayName: jest.fn(async () => ({})),
            refreshToken: jest.fn(async () => enterpriseSession),
            logout: jest.fn(async () => undefined),
            onSessionChanged: jest.fn((callback: (session: unknown) => void) => {
                sessionChangedCallback = callback;
                return () => {
                    sessionChangedCallback = null;
                };
            })
        };
        // preload 中的 accountAPI 没有 login 方法（账号后端已迁移到插件 flow API）
        (win as any).accountAPI = accountAPI;
        (win as any).settingAPI = {
            loadSettingObject: async () => ({ locale: 'zh-CN', debug: { experimental_feature: true } })
        };
        document.body.replaceChildren();
    });

    test('登出后重新登录：面板应通过 flow API 完成企业账号登录而非报账号服务不可用', async () => {
        accountAPI.getSession.mockResolvedValue(enterpriseSession);
        const panel = document.createElement('account-panel');
        document.body.appendChild(panel);
        await flush();
        const root = panel.shadowRoot!;
        expect(root.querySelector('.trigger')?.textContent).toContain('Alice');

        // 登出
        (root.querySelector('[data-action="toggle"]') as HTMLButtonElement).click();
        await flush();
        (root.querySelector('[data-action="ask-logout"]') as HTMLButtonElement).click();
        await flush();
        (root.querySelector('[data-action="do-logout"]') as HTMLButtonElement).click();
        await flush();
        expect(accountAPI.logout).toHaveBeenCalled();
        expect(root.querySelector('.trigger')?.textContent).toContain('登录');

        // 重新登录
        (root.querySelector('[data-action="toggle"]') as HTMLButtonElement).click();
        await flush();
        expect(accountAPI.getLoginMethods).toHaveBeenCalledWith('enterprise');
        expect(root.querySelector('[data-login-field="username"]')).not.toBeNull();
        expect(root.innerHTML).not.toContain('账号服务不可用');

        // 企业服务器地址应预填登出前保存的值
        const urlInput = root.querySelector('[data-enterprise-base-url]') as HTMLInputElement;
        expect(urlInput?.value).toBe('https://enterprise.example.com');

        setInput(root, '[data-login-field="username"]', 'alice');
        setInput(root, '[data-login-field="password"]', 'secret');
        submitLoginForm(root);
        await flush();

        expect(accountAPI.startLogin).toHaveBeenCalledWith('enterprise', 'password');
        expect(accountAPI.submitLogin).toHaveBeenCalledWith('flow-1', { username: 'alice', password: 'secret' });
        expect(root.innerHTML).not.toContain('账号服务不可用');
        expect(root.querySelector('.error-text')).toBeNull();
        expect(root.querySelector('.trigger')?.textContent).toContain('Alice');
    });

    test('企业服务器地址为空时提示必填，填写后先保存再登录', async () => {
        accountAPI.getConfig.mockResolvedValue({
            mode: 'enterprise',
            default_base_url: 'http://127.0.0.1:8000/api/v1',
            enterprise_base_url: ''
        });
        const root = await openLoginPopover();

        setInput(root, '[data-login-field="username"]', 'alice');
        setInput(root, '[data-login-field="password"]', 'secret');
        submitLoginForm(root);
        await flush();

        expect(root.querySelector('.error-text')?.textContent).toContain('请输入企业服务器地址');
        expect(accountAPI.startLogin).not.toHaveBeenCalled();

        setInput(root, '[data-enterprise-base-url]', 'https://corp.example.com/api');
        submitLoginForm(root);
        await flush();

        expect(accountAPI.configure).toHaveBeenCalledWith({ enterprise_base_url: 'https://corp.example.com/api' });
        expect(accountAPI.startLogin).toHaveBeenCalledWith('enterprise', 'password');
        expect(accountAPI.submitLogin).toHaveBeenCalledWith('flow-1', { username: 'alice', password: 'secret' });
        expect(root.querySelector('.error-text')).toBeNull();
        expect(root.querySelector('.trigger')?.textContent).toContain('Alice');
    });

    test('登录失败时向用户展示本地化的错误信息', async () => {
        accountAPI.submitLogin.mockResolvedValue({ status: 'failed', errorCode: 'account:credentials_required' });
        const root = await openLoginPopover();

        setInput(root, '[data-login-field="username"]', 'alice');
        setInput(root, '[data-login-field="password"]', 'wrong');
        submitLoginForm(root);
        await flush();

        expect(root.querySelector('.error-text')?.textContent).toContain('登录失败');
        expect(root.querySelector('.error-text')?.textContent).toContain('请输入用户名和密码');
        expect(root.querySelector('[data-login-field="username"]')).not.toBeNull();
    });

    test('存在多个登录方式时允许用户选择后再启动对应流程', async () => {
        accountAPI.getLoginMethods.mockResolvedValue([
            ...loginMethods,
            { id: 'sso', type: 'browser', displayName: { en: 'SSO', zh: '单点登录' } }
        ]);
        accountAPI.startLogin.mockResolvedValue({
            flowId: 'flow-sso',
            state: { status: 'completed', session: enterpriseSession }
        });
        const root = await openLoginPopover();

        const ssoButton = root.querySelector('[data-login-method="sso"]') as HTMLButtonElement;
        expect(ssoButton?.textContent).toContain('单点登录');
        ssoButton.click();
        await flush();
        submitLoginForm(root);
        await flush();

        expect(accountAPI.startLogin).toHaveBeenCalledWith('enterprise', 'sso');
        expect(accountAPI.submitLogin).not.toHaveBeenCalled();
        expect(root.querySelector('.trigger')?.textContent).toContain('Alice');
    });

    test('首次会话拉取失败（后端未注册）时仍建立推送订阅并重试', async () => {
        // 启动时序：账号后端（插件）激活晚于页面加载，getSession 首次失败
        accountAPI.getSession.mockRejectedValueOnce(new Error('account:backend_unavailable'));
        accountAPI.getSession.mockRejectedValueOnce(new Error('account:backend_unavailable'));
        accountAPI.getSession.mockResolvedValue(enterpriseSession);

        const panel = document.createElement('account-panel');
        document.body.appendChild(panel);
        await flush();
        // 订阅必须在首次拉取失败的情况下依然建立
        expect(accountAPI.onSessionChanged).toHaveBeenCalled();
        // 重试成功后恢复登录态（轮询等待，避免固定退避时长的抖动）
        const waitUntil = async (check: () => boolean, timeoutMs = 3000): Promise<void> => {
            const start = Date.now();
            while (!check() && Date.now() - start < timeoutMs) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        };
        await waitUntil(() => Boolean(panel.shadowRoot?.querySelector('.trigger')?.textContent?.includes('Alice')));
        expect(panel.shadowRoot?.querySelector('.trigger')?.textContent).toContain('Alice');

        // 后端激活推送能送达面板
        sessionChangedCallback?.(enterpriseSession);
        await flush();
        expect(panel.shadowRoot?.querySelector('.trigger')?.textContent).toContain('Alice');
    });
});
