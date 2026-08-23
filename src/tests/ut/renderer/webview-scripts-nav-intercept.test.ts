import { describe, it, expect } from '@jest/globals';
import { NAV_INTERCEPT_SCRIPT, NAV_INTERCEPT_CONSOLE_PREFIX } from '../../../renderer/webviewScripts';

describe('NAV_INTERCEPT_SCRIPT', () => {
    it('compiles as a script function body without errors', () => {
        expect(() => new Function(NAV_INTERCEPT_SCRIPT)).not.toThrow();
    });

    it('is idempotent via an install marker', () => {
        expect(NAV_INTERCEPT_SCRIPT).toContain('__odNavInterceptInstalled');
        expect(NAV_INTERCEPT_SCRIPT).toMatch(/if \(window\.__odNavInterceptInstalled\) return;/);
    });

    it('emits the canonical console prefix expected by the renderer bridge', () => {
        // renderer 侧以该前缀识别导航信令，两侧必须一致
        expect(NAV_INTERCEPT_SCRIPT).toContain("var PREFIX = '" + NAV_INTERCEPT_CONSOLE_PREFIX + "';");
        expect(NAV_INTERCEPT_CONSOLE_PREFIX).toBe('__od_nav__:');
    });

    it('intercepts left clicks and GET form submits in capture phase', () => {
        expect(NAV_INTERCEPT_SCRIPT).toContain("addEventListener('click'");
        expect(NAV_INTERCEPT_SCRIPT).toContain("addEventListener('submit'");
        expect(NAV_INTERCEPT_SCRIPT).toContain('true);'); // capture = true
        expect(NAV_INTERCEPT_SCRIPT).toContain('preventDefault()');
    });

    it('lets modified clicks, non-http schemes and popup targets through untouched', () => {
        expect(NAV_INTERCEPT_SCRIPT).toContain('ctrlKey');
        expect(NAV_INTERCEPT_SCRIPT).toContain('metaKey');
        expect(NAV_INTERCEPT_SCRIPT).toContain("!== '_self'");
        expect(NAV_INTERCEPT_SCRIPT).toContain("'https:'");
    });

    it('patches HTMLFormElement.prototype.submit to route GET form.submit() into the bridge', () => {
        // form.submit() 不触发 submit 事件，submit 拦截捕获不到；其原生导航在
        // webview 中被静默挂起（Bing 搜索框回车即走此路径），故包装原型方法。
        expect(NAV_INTERCEPT_SCRIPT).toContain('HTMLFormElement.prototype.submit');
        expect(NAV_INTERCEPT_SCRIPT).toContain('var _origSubmit = HTMLFormElement.prototype.submit;');
        expect(NAV_INTERCEPT_SCRIPT).toContain('_origSubmit.apply(this, arguments)');
        // 仅 GET http(s) 表单序列化后走信令，POST / 非 http(s) 放行原生
        expect(NAV_INTERCEPT_SCRIPT).toContain("(form.getAttribute('method') || 'get').toLowerCase() !== 'get'");
        expect(NAV_INTERCEPT_SCRIPT).toContain('console.log(PREFIX + action.toString())');
    });

    it('does not fall back to the per-input search-box whitelist hack', () => {
        // 四引擎搜索经真实任务验证本就正常，不再依赖按 name/id 劫持搜索框回车的兜底
        expect(NAV_INTERCEPT_SCRIPT).not.toContain('DEFAULT_SEARCH_PATH');
        expect(NAV_INTERCEPT_SCRIPT).not.toContain("['q', 'wd', 'query', 'kw', 'word']");
    });

    it('patches Location.prototype assign/replace to route same-main-domain JS navigation into the bridge', () => {
        // JS 直接导航（location.assign / replace）同样会被 webview 框架层静默
        // 中止，需把这些入口转成与表单/链接一致的 console 信令。location.href
        // 赋值因平台限制无法覆写（见脚本内注释），不在此列。
        expect(NAV_INTERCEPT_SCRIPT).toContain('Location.prototype.assign');
        expect(NAV_INTERCEPT_SCRIPT).toContain('Location.prototype.replace');
        expect(NAV_INTERCEPT_SCRIPT).toContain('routeJsNav');
        // 只拦截 http(s) 完整 URL，同页锚点 / about / data / javascript 放行
        expect(NAV_INTERCEPT_SCRIPT).toContain("new RegExp('^https?://', 'i')");
        // 仅在用户明确导航意图（回车 / 左键点击）后的 1s 窗口内、且目标与当前
        // 页面同主域时拦截，避免误伤输入过程中的 URL 更新与登录回调等跨域重定向。
        expect(NAV_INTERCEPT_SCRIPT).toContain('_lastNavIntent');
        expect(NAV_INTERCEPT_SCRIPT).toContain('sameMainDomain');
        expect(NAV_INTERCEPT_SCRIPT).toContain('new URL(url).hostname, location.hostname');
        expect(NAV_INTERCEPT_SCRIPT).toContain('Date.now() - _lastNavIntent > 1000');
        // 拦截后仍通过同一 console 前缀进入 loadURL 通道
        expect(NAV_INTERCEPT_SCRIPT).toContain('console.log(PREFIX + url)');
    });
});
