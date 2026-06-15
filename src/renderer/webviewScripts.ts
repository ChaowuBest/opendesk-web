/**
 * Webview 注入脚本 — 共享常量
 *
 * 这些脚本字符串分别通过 preload（webviewPreload.js）和
 * executeJavaScript（browser.ts / entry.ts）两种方式注入到
 * webview guest 页面中，用于 patch window.open / window.opener。
 *
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

/**
 * window.open Proxy 注入脚本
 *
 * 在 webview guest 中覆盖 window.open，使 Electron deny 弹窗时
 * 仍返回一个模拟 window 对象（而非 null），让页面逻辑正常运行。
 */
export const WINDOW_OPEN_PROXY_SCRIPT = `(function() {
    if (window.__openDeskWindowOpenPatched) return;
    window.__openDeskWindowOpenPatched = true;

    console.log('[OpenDesk::webviewPreload] window.open proxy injected at', Date.now());

    if (!window.__openDeskPopupProxies) window.__openDeskPopupProxies = [];
    var _proxyCounter = 0;

    const _origOpen = window.open.bind(window);

    window.open = function(url, target, features) {
        console.log('[OpenDesk::webviewPreload] window.open called:', url, 'target:', target);

        const result = _origOpen(url, target, features);
        if (result) {
            console.log('[OpenDesk::webviewPreload] native window.open succeeded, returning real window');
            return result;
        }

        console.log('[OpenDesk::webviewPreload] native window.open returned null, returning proxy');

        var proxyId = ++_proxyCounter;
        var proxy = {
            closed: false,
            close: function() {
                proxy.closed = true;
                console.log('__openDesk_popup_close__:' + proxyId);
            },
            focus: function() {
                console.log('__openDesk_popup_focus__:' + proxyId);
            },
            blur: function() {},
            print: function() {},
            stop: function() {},
            postMessage: function(msg, origin) {
                window.dispatchEvent(new MessageEvent('message', {
                    data: msg,
                    origin: origin || '',
                    source: null
                }));
            },
            location: {
                href: url || 'about:blank',
                reload: function() {},
                replace: function(u) { proxy.location.href = u; },
                assign: function(u) { proxy.location.href = u; },
                toString: function() { return proxy.location.href; }
            },
            document: {
                hasFocus: function() { return !proxy.closed; },
                write: function() {},
                writeln: function() {},
                close: function() {},
                open: function() {},
                readyState: 'complete',
                title: '',
                URL: url || 'about:blank'
            },
            navigator: window.navigator,
            opener: window,
            innerWidth: 800,
            innerHeight: 600,
            outerWidth: 800,
            outerHeight: 600,
            screenX: 0,
            screenY: 0,
            moveTo: function() {},
            moveBy: function() {},
            resizeTo: function() {},
            resizeBy: function() {},
            scrollTo: function() {},
            scrollBy: function() {},
            getComputedStyle: function() { return {}; },
            addEventListener: function() {},
            removeEventListener: function() {},
            dispatchEvent: function() { return true; }
        };

        window.__openDeskPopupProxies.push({ id: proxyId, proxy: proxy });
        return proxy;
    };
})()`;

/**
 * 焦点边界隔离脚本
 *
 * 保留 Chromium 在页面内部的原生 Tab 行为，只在焦点会从首尾边界逃出
 * webview 时进行首尾循环，避免焦点进入 OpenDesk 宿主界面。
 */
export const BROWSER_FOCUS_TRAP_SCRIPT = `(function() {
    if (window.__openDeskBrowserFocusTrapInstalled) return;
    window.__openDeskBrowserFocusTrapInstalled = true;

    var focusableSelector = [
        'a[href]',
        'area[href]',
        'button',
        'input',
        'select',
        'textarea',
        'iframe',
        'object',
        'embed',
        'summary',
        '[contenteditable="true"]',
        '[tabindex]'
    ].join(',');

    function isElement(el) {
        return !!el && el.nodeType === Node.ELEMENT_NODE;
    }

    function isVisible(el) {
        if (!isElement(el)) return false;
        if (el.closest('[hidden],[inert]')) return false;
        var style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return el.getClientRects().length > 0 || el === document.body || el === document.documentElement;
    }

    function isFocusable(el) {
        if (!isElement(el) || !isVisible(el)) return false;
        var tag = String(el.tagName || '').toLowerCase();
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        if (tag === 'input' && String(el.type || '').toLowerCase() === 'hidden') return false;
        if (el.tabIndex < 0) return false;
        return true;
    }

    function collectFocusable(root, out) {
        if (!root) return;
        var nodes = root.querySelectorAll ? root.querySelectorAll(focusableSelector) : [];
        for (var i = 0; i < nodes.length; i += 1) {
            var node = nodes[i];
            if (isFocusable(node)) out.push(node);
            if (node.shadowRoot) collectFocusable(node.shadowRoot, out);
        }
    }

    function orderedFocusableElements() {
        var out = [];
        collectFocusable(document.body || document.documentElement, out);
        return out
            .map(function(el, index) {
                return { el: el, index: index, tabIndex: el.tabIndex || 0 };
            })
            .sort(function(a, b) {
                var aPositive = a.tabIndex > 0;
                var bPositive = b.tabIndex > 0;
                if (aPositive && bPositive && a.tabIndex !== b.tabIndex) return a.tabIndex - b.tabIndex;
                if (aPositive !== bPositive) return aPositive ? -1 : 1;
                return a.index - b.index;
            })
            .map(function(item) { return item.el; });
    }

    function deepestActive(root) {
        var active = root.activeElement || document.activeElement;
        while (active && active.shadowRoot && active.shadowRoot.activeElement) {
            active = active.shadowRoot.activeElement;
        }
        return active;
    }

    function focusElement(el) {
        try {
            el.focus({ preventScroll: true });
        } catch {
            el.focus();
        }
    }

    window.addEventListener('keydown', function(event) {
        if (event.defaultPrevented || event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;

        var focusables = orderedFocusableElements();
        if (focusables.length === 0) {
            event.preventDefault();
            return;
        }

        var active = deepestActive(document);
        var index = focusables.indexOf(active);
        if (index < 0) {
            index = focusables.findIndex(function(el) {
                return active && (el === active || el.contains(active));
            });
        }
        if (index < 0) return;

        var next = null;
        if (focusables.length === 1) {
            next = focusables[0];
        } else if (event.shiftKey && index <= 0) {
            next = focusables[focusables.length - 1];
        } else if (!event.shiftKey && index >= focusables.length - 1) {
            next = focusables[0];
        }

        if (!next) return;
        event.preventDefault();
        event.stopPropagation();
        focusElement(next);
    }, false);
})()`;

/**
 * window.opener 桥接脚本
 *
 * 在弹窗 tab 中注入 window.opener 桥接和 window.close() 覆盖，
 * 使得 SSO 页面可以通过 window.opener.postMessage() 向父 tab 发送消息，
 * 并且 window.close() 能正常关闭 tab（绕过 Chromium 对非 script-opened 窗口的限制）。
 */
export const OPENER_BRIDGE_SCRIPT = `(function() {
    if (window.__openDeskOpenerPatched) return;
    window.__openDeskOpenerPatched = true;
    if (!window.opener) {
        window.opener = {
            postMessage: function(msg, targetOrigin) {
                window.__openDeskOpenerMessage = { data: msg, origin: targetOrigin };
                console.log('__openDesk_opener_postMessage__:' + JSON.stringify({ data: msg, origin: targetOrigin }));
            },
            closed: false,
            focus: function() {},
            blur: function() {},
            location: {
                href: '',
                reload: function() {
                    console.log('__openDesk_opener_reload__');
                },
                replace: function(url) {
                    console.log('__openDesk_opener_navigate__:' + url);
                },
                assign: function(url) {
                    console.log('__openDesk_opener_navigate__:' + url);
                },
                toString: function() { return ''; }
            }
        };
    }
    var _origClose = window.close.bind(window);
    window.close = function() {
        console.log('__openDesk_window_close__');
        try { _origClose(); } catch(e) {}
    };
})()`;

/**
 * 弹窗关闭通知脚本
 *
 * 当弹窗 tab 关闭时，通知 opener tab 更新所有 proxy.closed 状态。
 */
export const NOTIFY_POPUP_CLOSED_SCRIPT = `(function() {
    if (window.__openDeskPopupProxies) {
        window.__openDeskPopupProxies.forEach(function(item) {
            if (item && item.proxy) item.proxy.closed = true;
        });
    }
})()`;
