/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

export function hasCardContent(card: { prompt: string; html: string }): boolean {
    return !!(card.prompt.trim() || card.html.trim());
}

/**
 * 组装卡片 iframe 的 srcdoc：
 * 1. 注入基础样式 —— 无论 agent 生成的内容是否规范，都保证无默认边距、
 *    不可滚动、使用系统字体栈，并按桌面主题声明 color-scheme；
 * 2. 注入链接拦截脚本 —— 卡片内点击链接不允许就地导航（会毁掉卡片），
 *    拦截后 postMessage 给桌面，由桌面以浏览器浮窗打开。
 */
export function composeCardSrcDoc(html: string, theme: 'light' | 'dark'): string {
    const baseStyle = [
        '<style>',
        'html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;}',
        "body{font-family:-apple-system,'SF Pro SC','PingFang SC','Microsoft YaHei UI','Segoe UI',sans-serif;}",
        `:root{color-scheme:${theme};}`,
        '</style>'
    ].join('');
    const themeBridge = ['<script>', `document.documentElement.dataset.theme='${theme}';`, '</script>'].join('');
    const linkInterceptor = [
        '<script>',
        "document.addEventListener('click',function(e){",
        'var t=e.target;var a=t&&t.closest?t.closest("a[href]"):null;',
        'if(!a)return;e.preventDefault();',
        'try{parent.postMessage({type:"od-open-link",url:a.href},"*");}catch(err){}',
        '},true);',
        '</script>'
    ].join('');
    const initialReflow = [
        '<script>',
        "window.addEventListener('load',function(){",
        "requestAnimationFrame(function(){requestAnimationFrame(function(){window.dispatchEvent(new Event('resize'));});});",
        '});',
        '</script>'
    ].join('');
    const injection = baseStyle + themeBridge + linkInterceptor + initialReflow;
    if (/<head[^>]*>/i.test(html)) {
        return html.replace(/<head[^>]*>/i, (match) => `${match}${injection}`);
    }
    if (/<html[^>]*>/i.test(html)) {
        return html.replace(/<html[^>]*>/i, (match) => `${match}${injection}`);
    }
    return injection + html;
}
