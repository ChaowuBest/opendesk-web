import { describe, expect, jest, test } from '@jest/globals';
import { BrowserController, type BrowserScriptGenerators } from '../main';

/**
 * use-browser 压测报告回归测试：操作护栏。
 *
 * 覆盖"静默失败"族问题：
 *  - type 写入 disabled/readonly 输入框（BUG-21）→ 现在显式报错；
 *  - type 目标不存在仍返回 typed: N（BUG-06）→ 现在显式报错；
 *  - selectOption 传不存在的 value 谎报成功（BUG-19）→ 现在回传真实选中状态；
 *  - explore 未命中仍返回 success:true（BUG-23/10）→ 现在按失败返回；
 *  - pressKey 未知键名返回 success（BUG-22）→ 现在报错。
 */

const mockScriptGen: BrowserScriptGenerators = { beforeCallRenderer: [] };

function makeCtrl(session: any) {
    const win = {
        isDestroyed: () => false,
        focus: jest.fn(),
        webContents: {
            executeJavaScript: jest.fn(async () => ({ result: null }))
        }
    };
    const ctrl = new BrowserController('t-guardrails', win as any, mockScriptGen);
    (ctrl as any).requireCDP = jest.fn(async () => session);
    (ctrl as any).getCDPSession = jest.fn(async () => session);
    return ctrl;
}

function makeSession(sendImpl?: (method: string, params: any) => Promise<any>) {
    const session: any = {
        webContentsId: 5,
        webContents: { focus: jest.fn(), isDestroyed: () => false, isLoading: () => false },
        isHealthy: jest.fn(async () => true),
        waitForPageReady: jest.fn(async () => {}),
        waitForDOMStable: jest.fn(async () => {}),
        ensureDialogHandling: jest.fn(async () => {}),
        takeLastDialog: jest.fn(() => null),
        send: jest.fn(sendImpl ?? (async () => ({ result: { value: undefined } })))
    };
    return session;
}

describe('type 护栏', () => {
    test('disabled 输入框显式报错，不再绕过写入（BUG-21）', async () => {
        const session = makeSession(async (_method, params) => {
            const expr: string = params?.expression || '';
            if (expr.includes('element-locked')) return { result: { value: 'element-locked' } };
            return { result: { value: undefined } };
        });
        const ctrl = makeCtrl(session);

        await expect(ctrl.type('e5', 'should-not-apply')).rejects.toThrow('disabled 或 readonly');
    });

    test('readonly 输入框同样被拒绝（BUG-21 补充）', async () => {
        const session = makeSession(async (_method, params) => {
            const expr: string = params?.expression || '';
            if (expr.includes('readOnly')) return { result: { value: 'element-locked' } };
            return { result: { value: undefined } };
        });
        const ctrl = makeCtrl(session);

        await expect(ctrl.type('e4', 'overwrite-readonly')).rejects.toThrow('disabled 或 readonly');
    });

    test('目标元素不存在时报错而不是静默返回 typed: N（BUG-06）', async () => {
        const session = makeSession(async (_method, params) => {
            const expr: string = params?.expression || '';
            if (expr.includes("'no-element'")) return { result: { value: 'no-element' } };
            return { result: { value: undefined } };
        });
        const ctrl = makeCtrl(session);

        await expect(ctrl.type('e95', 'hello')).rejects.toThrow('not found');
    });
});

describe('selectOption 真实状态回传（BUG-19）', () => {
    test('全部未命中时按失败返回并列出可用选项', async () => {
        const session = makeSession(async () => ({
            result: {
                value: JSON.stringify({
                    unmatchedAll: true,
                    matched: [],
                    available: ['apple', 'banana', 'cherry']
                })
            }
        }));
        const ctrl = makeCtrl(session);

        await expect(ctrl.selectOption('e13', ['zzz-not-exist'])).rejects.toThrow(
            /zzz-not-exist[\s\S]*apple, banana, cherry/
        );
    });

    test('部分未命中时回传真实选中值并附警告', async () => {
        const session = makeSession(async () => ({
            result: {
                value: JSON.stringify({
                    selected: ['apple', 'ghost'],
                    actual: ['apple'],
                    available: ['apple', 'banana', 'cherry']
                })
            }
        }));
        const ctrl = makeCtrl(session);

        const result = await ctrl.selectOption('e13', ['apple', 'ghost']);
        expect(result.selected).toEqual(['apple']);
        expect(result.warning).toContain('ghost');
    });

    test('全部命中时回传真实选中值且无警告', async () => {
        const session = makeSession(async () => ({
            result: {
                value: JSON.stringify({ selected: ['apple'], actual: ['apple'], available: ['apple', 'banana'] })
            }
        }));
        const ctrl = makeCtrl(session);

        const result = await ctrl.selectOption('e13', ['apple']);
        expect(result).toEqual({ selected: ['apple'] });
    });
});

describe('explore 未命中按失败返回（BUG-23/10）', () => {
    test('ref 不存在时抛出统一错误', async () => {
        // captureSnapshot 走 executeJavaScriptOnAllFrames —— mock 一个空树
        const session = makeSession();
        const emptyFrameResult = JSON.stringify({
            url: 'https://example.com/',
            title: 'T',
            viewport: { width: 800, height: 600 },
            scroll: { x: 0, y: 0 },
            root: { role: 'fragment', name: '', props: {}, children: [] },
            iframeUrls: []
        });
        session.executeJavaScriptOnAllFrames = jest.fn(async () => ({
            mainResult: emptyFrameResult,
            frameResults: {}
        }));
        const ctrl = makeCtrl(session);

        await expect(ctrl.explore('e9999')).rejects.toThrow(
            'Element ref "e9999" not found. Page may have changed — call snapshot to refresh.'
        );
    });
});

describe('pressKey 未知键名（BUG-22）', () => {
    test('未知键名报错而不是返回 success', async () => {
        const session = makeSession();
        const ctrl = makeCtrl(session);

        await expect(ctrl.pressKey('NotAKey')).rejects.toThrow('未知按键名');
        // 不应向页面派发任何按键
        expect(session.send).not.toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.anything());
    });
});

describe('evaluate 错误转译（压测发现）', () => {
    test('Electron 不支持 prompt 时给出可行动提示，而不是原始英文报错', async () => {
        const session = makeSession(async (method) => {
            if (method === 'Runtime.evaluate') throw new Error('prompt() is not supported.');
            return { result: { value: undefined } };
        });
        const ctrl = makeCtrl(session);

        await expect(ctrl.evaluate("prompt('name?', 'default')")).rejects.toThrow('Electron 不支持 window.prompt()');
    });

    test('表达式内抛出 prompt 不支持（exceptionDetails 路径）同样给出提示', async () => {
        const session = makeSession(async (method) => {
            if (method === 'Runtime.evaluate') {
                return {
                    exceptionDetails: {
                        text: 'Uncaught',
                        exception: { description: 'Error: prompt() is not supported.' }
                    },
                    result: {}
                };
            }
            return { result: { value: undefined } };
        });
        const ctrl = makeCtrl(session);

        await expect(ctrl.evaluate("prompt('name?', 'default')")).rejects.toThrow('Electron 不支持 window.prompt()');
    });

    test('返回值不可序列化时仍给出 JSON.stringify 提示（BUG-17 不回归）', async () => {
        const session = makeSession(async (method) => {
            if (method === 'Runtime.evaluate') throw new Error('An object could not be cloned.');
            return { result: { value: undefined } };
        });
        const ctrl = makeCtrl(session);

        await expect(ctrl.evaluate('window')).rejects.toThrow('返回值无法序列化');
    });
});
