import { describe, expect, jest, test } from '@jest/globals';
import vm from 'node:vm';
import { BrowserController, type BrowserScriptGenerators } from '../main.js';
import {
    diffTrees,
    findNodeByRef,
    mergeFrameTrees,
    navigateToFrame,
    renderAriaTreeToYaml,
    type AriaNode
} from '../cdp/aria.js';
import { resolveKey, describeRuntimeException } from '../cdp/utils.js';
import { OD_COMPOSED_ANCESTOR_HELPER } from '../cdp/refQueryScript.js';
import { makeNavInterceptScript, makeOpenerBridgeScript } from '../../../renderer/webviewScripts.js';

/**
 * use-browser 压测报告（iframe 专项）回归测试。
 *
 * 覆盖：折叠标记泄漏（BUG-08）、repeated 折叠兄弟 ref 不可见（BUG-24）、
 * diff 缺 iframe 归属锚点（BUG-27）、iframe 加载失败不可见（BUG-26）、
 * 可滚动容器不可定位（BUG-09）、iframe 导航后静默命中旧 frame（BUG-04）、
 * iframe 被移除后的误导性报错（BUG-10）、未知键名谎报成功（BUG-22）、
 * evaluate 异常信息丢失（BUG-16）、信令脚本顶层守卫（BUG-01/34/36）。
 */

function node(partial: Partial<AriaNode> & { role: string }): AriaNode {
    return { name: '', children: [], props: {}, ...partial } as AriaNode;
}

describe('BUG-08: 折叠标记只在紧凑快照输出', () => {
    const tree = node({
        role: 'section',
        name: 'root',
        children: [
            node({
                role: 'button',
                name: '动态插入 iframe',
                ref: 'e26',
                collapsed: true,
                collapsedCount: 0,
                children: []
            })
        ]
    });

    test('explore/diff（collapse=false）不输出 [collapsed] 标记', () => {
        const yaml = renderAriaTreeToYaml(tree, false);
        expect(yaml).not.toContain('collapsed');
        expect(yaml).toContain('[ref=e26]');
    });

    test('紧凑快照（collapse=true）保留折叠摘要', () => {
        const yaml = renderAriaTreeToYaml(tree, true);
        expect(yaml).toContain('[collapsed, 0 descendants');
    });
});

describe('BUG-24: repeated 折叠标记列出可定位的兄弟 ref', () => {
    const makeIframe = (ref: string): AriaNode =>
        node({
            role: 'iframe',
            name: 'IFRAME-CONTENT-MARKER',
            ref,
            frameSrc: 'https://f.example/x.html',
            children: []
        });

    test('折叠兄弟的 ref 出现在标记中', () => {
        const rep = makeIframe('e6');
        rep.repeatCount = 20;
        rep.collapsedSiblings = ['e8', 'e10', 'e12', 'e14', 'e16', 'e18', 'e20', 'e22', 'e24', 'e26'].map(makeIframe);
        const tree = node({ role: 'generic', name: 'list', children: [rep] });

        const yaml = renderAriaTreeToYaml(tree, true);
        expect(yaml).toContain('[repeated x20');
        expect(yaml).toContain('refs: e8, e10, e12, e14, e16, e18, e20, e22');
        expect(yaml).toContain('+2 more');
    });

    test('折叠兄弟仍可按 ref 查找', () => {
        const rep = makeIframe('e6');
        rep.repeatCount = 3;
        rep.collapsedSiblings = [makeIframe('e8'), makeIframe('e10')];
        const tree = node({ role: 'generic', name: 'list', children: [rep] });
        expect(findNodeByRef(tree, 'e10')?.ref).toBe('e10');
    });
});

describe('BUG-27: diff 输出带 iframe 归属锚点', () => {
    test('嵌套 ref 的变化子树前输出外层 iframe 锚点行', () => {
        const before = node({
            role: 'fragment',
            children: [
                node({
                    role: 'iframe',
                    name: 'SCROLL-FRAME-MARKER',
                    ref: 'e8',
                    frameSrc: 'https://f.example/s.html',
                    children: [
                        node({
                            role: 'generic',
                            ref: 'e8-e0',
                            children: [node({ role: 'text', ref: 'e8-e1', children: [] })]
                        })
                    ]
                })
            ]
        });
        const after = node({
            role: 'fragment',
            children: [
                node({
                    role: 'iframe',
                    name: 'SCROLL-FRAME-MARKER',
                    ref: 'e8',
                    frameSrc: 'https://f.example/s.html',
                    children: [
                        node({
                            role: 'generic',
                            ref: 'e8-e0',
                            children: [node({ role: 'text', ref: 'e8-e1', name: 'changed', children: [] })]
                        })
                    ]
                })
            ]
        });

        const diff = diffTrees(before, after);
        expect(diff.yaml).toContain('inside iframe [ref=e8]');
        expect(diff.yaml).toContain('SCROLL-FRAME-MARKER');
        // 锚点在变化子树之前
        expect(diff.yaml.indexOf('inside iframe [ref=e8]')).toBeLessThan(diff.yaml.indexOf('e8-e1'));
    });

    test('同一 iframe 的多个变化只输出一次锚点', () => {
        const mk = (textName: string) =>
            node({
                role: 'fragment',
                children: [
                    node({
                        role: 'iframe',
                        ref: 'e8',
                        children: [
                            node({ role: 'text', ref: 'e8-e1', name: textName, children: [] }),
                            node({ role: 'text', ref: 'e8-e2', name: textName + '-2', children: [] })
                        ]
                    })
                ]
            });
        const diff = diffTrees(mk('a'), mk('b'));
        expect(diff.yaml.split('inside iframe [ref=e8]').length - 1).toBe(1);
    });
});

describe('BUG-26: 内容 frame 加载失败在快照中可见', () => {
    test('失败 frame 的 iframe 节点带 [load-failed] 标记', () => {
        const root = node({
            role: 'fragment',
            children: [
                node({
                    role: 'iframe',
                    name: '',
                    ref: 'e5',
                    frameSrc: 'http://127.0.0.1:9/refused',
                    frameIndex: 0,
                    children: []
                })
            ]
        });
        mergeFrameTrees(root, {
            tokenA: { mainResult: null, frameResults: {}, error: 'net::ERR_CONNECTION_REFUSED' }
        });
        const yaml = renderAriaTreeToYaml(root, true);
        expect(yaml).toContain('[load-failed:');
        expect(yaml).toContain('ERR_CONNECTION_REFUSED');
    });

    test('正常 frame 结果不受错误标记影响', () => {
        const root = node({
            role: 'fragment',
            children: [
                node({
                    role: 'iframe',
                    name: '',
                    ref: 'e5',
                    frameSrc: 'https://ok.example/',
                    frameIndex: 0,
                    children: []
                })
            ]
        });
        mergeFrameTrees(root, {
            tokenA: {
                mainResult: JSON.stringify({
                    url: 'https://ok.example/',
                    title: 'OK',
                    viewport: { width: 800, height: 600 },
                    scroll: { x: 0, y: 0 },
                    root: {
                        role: 'fragment',
                        name: '',
                        props: {},
                        children: [node({ role: 'heading', name: 'H', ref: 'e0' })]
                    },
                    iframeUrls: []
                }),
                frameResults: {}
            }
        });
        const yaml = renderAriaTreeToYaml(root, true);
        expect(yaml).not.toContain('load-failed');
        expect(yaml).toContain('heading');
    });

    test('错误页 frame（chrome-error，不抛错的加载失败）同样打 load-failed 标记且不记录 frameUrl', () => {
        // 压测实测：连接拒绝的 iframe 落在 chrome-error://chromewebdata/ 错误页上，
        // 该文档仍可执行快照脚本返回空树（不抛错），执行失败路径覆盖不到
        const root = node({
            role: 'fragment',
            children: [
                node({
                    role: 'iframe',
                    name: '',
                    ref: 'e6',
                    frameSrc: 'http://127.0.0.1:9/dead',
                    frameIndex: 0,
                    children: []
                })
            ]
        });
        mergeFrameTrees(root, {
            tokenA: {
                mainResult: JSON.stringify({
                    url: 'chrome-error://chromewebdata/',
                    title: '',
                    viewport: { width: 300, height: 80 },
                    scroll: { x: 0, y: 0 },
                    root: {
                        role: 'fragment',
                        name: '',
                        props: {},
                        children: [node({ role: 'generic', ref: 'e0', children: [] })]
                    },
                    iframeUrls: []
                }),
                frameResults: {}
            }
        });
        const yaml = renderAriaTreeToYaml(root, true);
        expect(yaml).toContain('[load-failed:');
        expect(yaml).toContain('chrome-error');
        // 错误页噪音内容被丢弃
        expect(yaml).not.toContain('e6-e0');
        // frameUrl 不记录（帧内 chrome-error 与父侧原始 URL 不一致，会污染帧 URL 校验）
        expect(root.children[0].frameUrl).toBeUndefined();
    });

    test('validateChildFrameUrl 对 chrome-error 期望值跳过校验（防旧缓存误报已导航）', async () => {
        // 旧快照树可能仍记录了 chrome-error 的 frameUrl：父侧 frame.url 是原始
        // 目标 URL，比对必然不一致 —— 必须跳过而不是误报"已在快照后导航"
        const mkFrame = (url: string, descriptor: unknown): any => ({
            url,
            frames: [],
            executeJavaScript: jest.fn(async () => descriptor)
        });
        const navigatedChild = mkFrame('http://127.0.0.1:9/dead', JSON.stringify({}));
        const main = mkFrame('https://host.example/', { found: true, index: 0, src: 'http://127.0.0.1:9/dead' });
        (main as any).frames = [navigatedChild];

        const frame = await navigateToFrame(main, 'e6-e3', new Map([['e6', 'chrome-error://chromewebdata/']]));
        expect(frame.elementRef).toBe('e3');
    });
});

describe('BUG-09: 可滚动容器渲染 [scrollable] 标记', () => {
    test('box.scrollable 的节点在快照中可见且带 ref', () => {
        const tree = node({
            role: 'fragment',
            children: [
                node({
                    role: 'generic',
                    name: 'scroll-row-1 scroll-row-2',
                    ref: 'e30',
                    box: { width: 300, height: 1000, visible: true, inViewport: true, scrollable: true },
                    children: []
                })
            ]
        });
        const yaml = renderAriaTreeToYaml(tree, true);
        expect(yaml).toContain('[scrollable]');
        expect(yaml).toContain('[ref=e30]');
    });
});

describe('BUG-04: iframe 快照后导航导致 ref 失效时显式报错', () => {
    function makeFrame(url: string, descriptor: unknown): any {
        return {
            url,
            frames: [],
            executeJavaScript: jest.fn(async () => descriptor)
        };
    }

    test('frame 当前 URL 与快照记录一致时正常解析', async () => {
        // 主 frame 返回 iframe e8 的描述符；子 frame 命中后 URL 一致
        const child = makeFrame('https://f.example/basic.html', JSON.stringify({}));
        const main = makeFrame('https://host.example/', { found: true, index: 0, src: 'https://f.example/basic.html' });
        (main as any).frames = [child];

        const frame = await navigateToFrame(main, 'e8-e3', new Map([['e8', 'https://f.example/basic.html']]));
        expect(frame.elementRef).toBe('e3');
    });

    test('iframe 在快照后导航 → 抛出明确错误而不是静默命中旧 frame', async () => {
        // iframe 已导航到新文档：旧 src 匹配不到任何 frame，DOM 序号回落命中
        // 的 frame URL 与快照记录不一致
        const navigatedChild = makeFrame('https://f.example/target.html', JSON.stringify({}));
        const main = makeFrame('https://host.example/', { found: true, index: 0, src: 'https://f.example/basic.html' });
        (main as any).frames = [navigatedChild];

        await expect(navigateToFrame(main, 'e8-e3', new Map([['e8', 'https://f.example/basic.html']]))).rejects.toThrow(
            '已在快照后导航'
        );
    });

    test('iframe 元素被移除时报"元素不存在"而不是误导性的跨域错误（BUG-10）', async () => {
        const main = makeFrame('https://host.example/', { found: false, index: -1, src: '' });
        await expect(navigateToFrame(main, 'e8-e3')).rejects.toThrow('may have been removed');
    });
});

describe('BUG-22: 未知键名不谎报成功', () => {
    test('多字符未知键名标记 recognized: false', () => {
        expect(resolveKey('NotAKey').recognized).toBe(false);
    });

    test('标准键名与单字符仍正常解析', () => {
        expect(resolveKey('Enter').keyCode).toBe(13);
        expect(resolveKey('a').keyCode).toBe(65);
        expect(resolveKey('@').keyCode).toBe(50);
        expect(resolveKey('NotAKey').key).toBe('NotAKey');
    });
});

describe('BUG-16: evaluate 异常信息完整回传', () => {
    test('description（含 message+stack）优先于 "Uncaught" 前缀', () => {
        const details = {
            text: 'Uncaught',
            exception: { type: 'object', description: 'Error: BOOM-INTENTIONAL\n    at <anonymous>:1:16' }
        };
        expect(describeRuntimeException(details)).toContain('BOOM-INTENTIONAL');
        expect(describeRuntimeException(details)).not.toBe('Uncaught');
    });

    test('无 description 时回落到 text', () => {
        expect(describeRuntimeException({ text: 'Uncaught' })).toBe('Uncaught');
    });
});

describe('信令脚本的安全守卫（BUG-01/34/36）', () => {
    test('NAV_INTERCEPT_SCRIPT 只安装在顶层文档', () => {
        expect(makeNavInterceptScript('tok')).toContain('window.top !== window.self');
    });

    test('合成 opener 只安装在顶层文档（iframe 无 opener 语义）', () => {
        expect(makeOpenerBridgeScript('tok')).toContain('window.top !== window.self');
    });
});

// ---------------------------------------------------------------------------
// BUG-32 / BUG-31：嵌套 ref 在 webview 已持有焦点时走 CDP 原生输入
// ---------------------------------------------------------------------------

const stressScriptGen: BrowserScriptGenerators = { beforeCallRenderer: [] };

function makeNativeCtrl(session: any) {
    const win = {
        isDestroyed: () => false,
        focus: jest.fn(),
        webContents: {
            executeJavaScript: jest.fn(async (script: string) => {
                if (script.includes('browserHasActiveWebviewFocus')) return { result: true };
                if (script.includes('browserGetWebContentsId')) return { result: 5 };
                if (script.includes('browserListTabs'))
                    return { result: [{ id: 5, title: 'T', url: 'https://host.example/', active: true }] };
                return { result: null };
            })
        }
    };
    const ctrl = new BrowserController('t-stress-native', win as any, stressScriptGen);
    (ctrl as any)._newTabPollIntervalMs = 1;
    (ctrl as any)._newTabDetectWindowMs = 60;
    (ctrl as any).requireCDP = jest.fn(async () => session);
    (ctrl as any).getCDPSession = jest.fn(async () => session);
    return ctrl;
}

/** 构造 e1（主 frame iframe）→ e2/e3（内容 frame 元素）的两层 frame 树 mock。 */
function makeNestedFrameMocks() {
    let frameValue = '';
    const innerFrame: any = {
        url: 'https://nested.example/form',
        frames: [],
        executeJavaScript: jest.fn(async (script: string) => {
            // resolveNestedRefCoords 最后一段：目标元素坐标
            if (script.includes('scrollIntoView') && script.includes('getBoundingClientRect')) {
                return JSON.stringify({ x: 30, y: 40, tag: 'textarea', text: '' });
            }
            // type 预检
            if (script.includes("'no-element'")) return 'ok';
            // 清空脚本
            if (script.includes('setter.call(el, "")')) frameValue = '';
            // 回读
            if (script.includes('return el.value')) return frameValue;
            return undefined;
        })
    };
    const mainFrame: any = {
        url: 'https://host.example/',
        frames: [innerFrame],
        executeJavaScript: jest.fn(async (script: string) => {
            // resolveNestedRefCoords 第一段：iframe 元素矩形
            if (script.includes('scrollIntoView') && script.includes('getBoundingClientRect')) {
                return JSON.stringify({ x: 10, y: 20, tag: 'iframe', text: '', src: innerFrame.url });
            }
            // findChildFrame 描述符
            if (script.includes('IFRAME')) {
                return { found: true, index: 0, src: innerFrame.url };
            }
            return undefined;
        })
    };
    return { innerFrame, mainFrame, value: () => frameValue, write: (t: string) => (frameValue += t) };
}

function makeNativeSession(opts: { onKeyEvent?: (params: any) => void } = {}) {
    const inputCalls: Array<{ method: string; params: any }> = [];
    const session: any = {
        webContentsId: 5,
        webContents: { focus: jest.fn(), isDestroyed: () => false, isLoading: () => false },
        isHealthy: jest.fn(async () => true),
        waitForPageReady: jest.fn(async () => {}),
        waitForDOMStable: jest.fn(async () => {}),
        ensureDialogHandling: jest.fn(async () => {}),
        takeLastDialog: jest.fn(() => null),
        send: jest.fn(async (method: string, params: any) => {
            if (method.startsWith('Input.')) {
                inputCalls.push({ method, params });
                // 真实按键在 mock 里无法由页面侧观察：带 text 的 keyDown 即落键，
                // 回放到 frame 状态（模拟页面接收按键后的输入）
                if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown' && params.text) {
                    opts.onKeyEvent?.(params);
                }
                return {};
            }
            const expr = params?.expression || '';
            if (expr.trim() === 'location.href') return { result: { value: 'https://host.example/' } };
            if (expr.includes('scrollY')) {
                return {
                    result: {
                        value: JSON.stringify({
                            url: 'https://host.example/',
                            title: 'T',
                            scrollY: 0,
                            scrollHeight: 1000,
                            viewportHeight: 800
                        })
                    }
                };
            }
            return { result: { value: undefined } };
        })
    };
    return { session, inputCalls };
}

describe('BUG-32/31: 嵌套 ref 走 CDP 原生输入（webview 已持有焦点）', () => {
    test('slowly 逐字符输入走 Input.dispatchKeyEvent（受控编辑器可捕获的真实按键）', async () => {
        const frames = makeNestedFrameMocks();
        const { session, inputCalls } = makeNativeSession({
            // 真实 char 按键回放为 frame 值变化（模拟页面接收按键后的输入）
            onKeyEvent: (params) => frames.write(params.text)
        });
        session.webContents.mainFrame = frames.mainFrame;
        const ctrl = makeNativeCtrl(session);

        const result = await ctrl.type('e1-e2', 'X', { slowly: true });

        expect(result.typed).toBe(1);
        expect(result.warning).toBeUndefined();
        // 焦点点击 + 逐字符真实按键都出现在 CDP Input 通道
        const pressed = inputCalls.find(
            (c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed'
        );
        expect(pressed?.params).toMatchObject({ x: 40, y: 60, button: 'left' });
        const keyDowns = inputCalls.filter((c) => c.method === 'Input.dispatchKeyEvent' && c.params.type === 'keyDown');
        expect(keyDowns.some((c) => c.params.key === 'X')).toBe(true);
        // 清空 + 回读仍在内容 frame 内执行（合成 clear 与原生按键配合）
        expect(frames.innerFrame.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining("'no-element'"));
        // 受控编辑器问题根源的合成逐字符脚本（KeyboardEvent 派发）不再出现在 frame 中
        const frameScripts = frames.innerFrame.executeJavaScript.mock.calls.map((c: any[]) => c[0] as string);
        expect(frameScripts.some((s) => s.includes('KeyboardEvent'))).toBe(false);
    });

    test('clearFirst 在原生路径补发 Ctrl+A 真实全选（受控编辑器模型同步替换）', async () => {
        const { session, inputCalls } = makeNativeSession();
        const frames = makeNestedFrameMocks();
        session.webContents.mainFrame = frames.mainFrame;
        const ctrl = makeNativeCtrl(session);

        await ctrl.type('e1-e2', 'N', { slowly: true, clearFirst: true });

        const selectAll = inputCalls.find(
            (c) => c.method === 'Input.dispatchKeyEvent' && c.params.type === 'keyDown' && c.params.key === 'a'
        );
        expect(selectAll).toBeDefined();
        expect(selectAll!.params.modifiers).toBe(process.platform === 'darwin' ? 4 : 2);
        // 全选发生在逐字符输入之前
        const selectAllIdx = inputCalls.findIndex((c) => c === selectAll);
        const firstCharIdx = inputCalls.findIndex((c) => c.method === 'Input.dispatchKeyEvent' && c.params.key === 'N');
        expect(selectAllIdx).toBeLessThan(firstCharIdx);
    });

    test('嵌套 ref 的修饰键点击走原生鼠标事件（Ctrl+点击可触发默认行为，BUG-31）', async () => {
        const { session, inputCalls } = makeNativeSession();
        const frames = makeNestedFrameMocks();
        session.webContents.mainFrame = frames.mainFrame;
        const ctrl = makeNativeCtrl(session);

        await ctrl.click('e1-e2', { modifiers: ['Control'] });

        const pressed = inputCalls.find(
            (c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed'
        );
        expect(pressed?.params).toMatchObject({ x: 40, y: 60, button: 'left', modifiers: 2 });
        // 合成点击脚本（isTrusted=false，无法触发默认行为）不应再出现在 frame 中
        const frameScripts = frames.innerFrame.executeJavaScript.mock.calls.map((c: any[]) => c[0] as string);
        expect(frameScripts.some((s) => s.includes('dispatchEvent(new MouseEvent'))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// BUG-32 补充：坐标被遮挡时跳过原生全选
// （此刻焦点可能落在遮挡元素/其它控件上，全选 + 替换会清掉无辜元素的既有内容）
// ---------------------------------------------------------------------------

describe('BUG-32 补充: 坐标被遮挡时跳过原生全选', () => {
    function makeNonNestedNativeSession(obscured: boolean) {
        const inputCalls: Array<{ method: string; params: any }> = [];
        const session: any = {
            webContentsId: 5,
            webContents: { focus: jest.fn(), isDestroyed: () => false, isLoading: () => false },
            isHealthy: jest.fn(async () => true),
            waitForPageReady: jest.fn(async () => {}),
            waitForDOMStable: jest.fn(async () => {}),
            ensureDialogHandling: jest.fn(async () => {}),
            takeLastDialog: jest.fn(() => null),
            send: jest.fn(async (method: string, params: any) => {
                if (method.startsWith('Input.')) {
                    inputCalls.push({ method, params });
                    return {};
                }
                const expr = params?.expression || '';
                if (expr.trim() === 'location.href') return { result: { value: 'https://host.example/' } };
                if (expr.includes('scrollY')) {
                    return {
                        result: {
                            value: JSON.stringify({
                                url: 'https://host.example/',
                                title: 'T',
                                scrollY: 0,
                                scrollHeight: 1000,
                                viewportHeight: 800
                            })
                        }
                    };
                }
                // resolveRefCoords：目标坐标 + 遮挡探测结果
                if (expr.includes('__odFindRef') && expr.includes('elementFromPoint')) {
                    return {
                        result: {
                            value: JSON.stringify({ x: 10, y: 20, tag: 'input', text: '', obscured })
                        }
                    };
                }
                // type 预检 / 清空 / 回读等合成脚本：无需真实返回值
                return { result: { value: undefined } };
            })
        };
        return { session, inputCalls };
    }

    test('obscured=true：不派发 Ctrl+A 全选，逐字符输入照常', async () => {
        const { session, inputCalls } = makeNonNestedNativeSession(true);
        const ctrl = makeNativeCtrl(session);

        await ctrl.type('e1', 'N', { slowly: true, clearFirst: true });

        const selectAll = inputCalls.find(
            (c) => c.method === 'Input.dispatchKeyEvent' && c.params.type === 'keyDown' && c.params.key === 'a'
        );
        expect(selectAll).toBeUndefined();
        expect(inputCalls.some((c) => c.method === 'Input.dispatchKeyEvent' && c.params.key === 'N')).toBe(true);
    });

    test('无遮挡：Ctrl+A 全选照常补发', async () => {
        const { session, inputCalls } = makeNonNestedNativeSession(false);
        const ctrl = makeNativeCtrl(session);

        await ctrl.type('e1', 'N', { slowly: true, clearFirst: true });

        const selectAll = inputCalls.find(
            (c) => c.method === 'Input.dispatchKeyEvent' && c.params.type === 'keyDown' && c.params.key === 'a'
        );
        expect(selectAll).toBeDefined();
        expect(selectAll!.params.modifiers).toBe(process.platform === 'darwin' ? 4 : 2);
    });
});

// ---------------------------------------------------------------------------
// 遮挡校验的组合树祖先判定（elementFromPoint 对 shadow 内元素 retarget 成宿主）
// ---------------------------------------------------------------------------

describe('遮挡校验的组合树祖先判定（shadow retarget 免责）', () => {
    const OBSCURED_EXPR = 'hit && hit !== el && !isComposedAncestor(el, hit) && !isComposedAncestor(hit, el)';

    function evalSnippet(expr: string, sandbox: Record<string, unknown>): unknown {
        return vm.runInNewContext(`${OD_COMPOSED_ANCESTOR_HELPER}\n${expr}`, sandbox);
    }

    const makeNode = (name: string): any => ({ name, parentNode: null, nodeType: 1 });

    test('shadow 内元素被 elementFromPoint retarget 成宿主：宿主不算遮挡', () => {
        const host = makeNode('host');
        const inner = makeNode('inner');
        inner.parentNode = { nodeType: 11, host }; // ShadowRoot
        host.parentNode = makeNode('body');

        expect(evalSnippet(OBSCURED_EXPR, { hit: host, el: inner })).toBeFalsy();
    });

    test('真正无关的遮挡元素仍判为遮挡', () => {
        const overlay = makeNode('overlay');
        const el = makeNode('el');
        el.parentNode = makeNode('body');

        expect(evalSnippet(OBSCURED_EXPR, { hit: overlay, el })).toBeTruthy();
    });

    test('同一 light DOM 树的 contains 语义保持，嵌套 shadow 跨层可判', () => {
        const container = makeNode('container');
        const child = makeNode('child');
        child.parentNode = container;
        expect(evalSnippet('isComposedAncestor(el, hit)', { el: container, hit: child })).toBe(true);

        // 嵌套 shadow：内层 shadow 元素的祖先链跨越两层 shadow 边界
        const outerHost = makeNode('outerHost');
        const innerHost = makeNode('innerHost');
        innerHost.parentNode = { nodeType: 11, host: outerHost };
        const deepEl = makeNode('deep');
        deepEl.parentNode = { nodeType: 11, host: innerHost };
        expect(evalSnippet('isComposedAncestor(outerHost, deepEl)', { outerHost, deepEl })).toBe(true);
    });
});
