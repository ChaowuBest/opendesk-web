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

/** Chromium error description → 用户友好的中文提示 */
const ERROR_MESSAGES: Record<string, string> = {
    ERR_CONNECTION_REFUSED: '连接被拒绝，服务器可能未运行',
    ERR_CONNECTION_CLOSED: '连接意外关闭',
    ERR_CONNECTION_RESET: '连接被重置',
    ERR_CONNECTION_TIMED_OUT: '连接超时，请检查网络',
    ERR_NAME_NOT_RESOLVED: '无法解析域名，请检查网址是否正确',
    ERR_TIMED_OUT: '请求超时，请稍后重试',
    ERR_ADDRESS_UNREACHABLE: '无法访问目标地址',
    ERR_NETWORK_CHANGED: '网络连接已变化，请重试',
    ERR_INTERNET_DISCONNECTED: '网络已断开连接',
    ERR_SSL_PROTOCOL_ERROR: 'SSL协议错误，无法建立安全连接',
    ERR_CERT_COMMON_NAME_INVALID: '证书域名不匹配',
    ERR_CERT_DATE_INVALID: '证书已过期或尚未生效',
    ERR_CERT_AUTHORITY_INVALID: '证书不受信任',
    ERR_CERT_REVOKED: '证书已被吊销',
    ERR_CERT_WEAK_SIGNATURE_ALGORITHM: '证书使用了不安全的签名算法',
    ERR_CERT_WEAK_KEY: '证书密钥强度不足',
    ERR_CERT_INVALID: '证书无效',
    ERR_CERT_DATABASE_CHANGED: '证书数据库已变更',
    ERR_PROXY_CONNECTION_FAILED: '代理服务器连接失败',
    ERR_PROXY_AUTH_UNSUPPORTED: '代理服务器需要不支持的认证方式',
    ERR_TOO_MANY_REDIRECTS: '重定向次数过多',
    ERR_EMPTY_RESPONSE: '服务器返回了空响应',
    ERR_SSL_VERSION_OR_CIPHER_MISMATCH: 'SSL版本或加密套件不匹配',
    ERR_BLOCKED_BY_CLIENT: '请求被浏览器扩展阻止',
    ERR_ACCESS_DENIED: '访问被拒绝',
    ERR_FILE_NOT_FOUND: '文件未找到',
    ERR_CACHE_MISS: '缓存未命中',
    ERR_ABORTED: '请求已中止',
    ERR_SOCKET_NOT_CONNECTED: '套接字未连接',
    ERR_INSUFFICIENT_RESOURCES: '系统资源不足'
};

/**
 * 根据 Chromium 错误描述返回中文友好提示。
 * 未知错误码返回 "页面加载失败（{errorDescription}）"。
 */
export function getErrorMessage(errorDescription: string): string {
    return ERROR_MESSAGES[errorDescription] || `页面加载失败（${errorDescription}）`;
}

/**
 * 根据错误类型返回 Font Awesome 图标类名。
 * 需要在页面中引入 Font Awesome CSS。
 */
export function getErrorIconClass(errorDescription: string): string {
    if (errorDescription.startsWith('ERR_CERT') || errorDescription.startsWith('ERR_SSL')) {
        return 'fa-solid fa-lock';
    }
    if (errorDescription === 'ERR_INTERNET_DISCONNECTED' || errorDescription === 'ERR_NETWORK_CHANGED') {
        return 'fa-solid fa-wifi';
    }
    if (errorDescription === 'ERR_NAME_NOT_RESOLVED') {
        return 'fa-solid fa-globe';
    }
    // warning triangle icon (default)
    return 'fa-solid fa-triangle-exclamation';
}

export interface ErrorInfo {
    code: number;
    description: string;
    url: string;
    userMessage: string;
}

/**
 * 生成用于通过 executeJavaScript 注入 webview 的错误页面脚本。
 * 替换 chrome-error:// 页面的 DOM 内容为自定义中文错误页面。
 *
 * 页面包含：
 * - 标题 "无法访问此页面"
 * - 中文错误描述（放在 id="main-message" 的元素中，与 embedBrowserUse 的 readPageInfo 兼容）
 * - 失败的 URL
 * - 错误码（放在 class="error-code" 的元素中，与 embedBrowserUse 的 readPageInfo 兼容）
 * - 重新加载按钮（导航回原始 URL）
 *
 * 关键：使用 Chromium 错误页面的标准 DOM id/class，使得 embedBrowserUse 的
 * readPageInfo() 无需任何修改即可读取到中文错误信息。
 */
export function buildErrorPageScript(errorInfo: ErrorInfo): string {
    const iconClass = getErrorIconClass(errorInfo.description);
    // 转义 HTML 特殊字符，防止 XSS；同时转义反引号和 $ 防止模板字符串注入
    const esc = (s: string) =>
        s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/`/g, '\\`')
            .replace(/\$/g, '\\$');
    const escUrl = esc(errorInfo.url);
    const escMsg = esc(errorInfo.userMessage);
    const escCode = esc(errorInfo.description);
    // 将原始 URL 编码后嵌入 data 属性，供重新加载时使用
    const encodedUrl = encodeURIComponent(errorInfo.url);
    return `document.open(); document.write(\`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<title>无法访问此页面</title>
<style>
body { margin:0; padding:0; background:#fafafa; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
.error-container { display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; padding:20px 16px; box-sizing:border-box; overflow:hidden; }
.error-icon { flex-shrink:0; font-size:48px; color:#d1d5db; }
.error-title { font-size:18px; font-weight:600; color:#1f2937; margin:12px 0 6px; }
.error-message { font-size:13px; color:#6b7280; max-width:90vw; text-align:center; margin:0 0 4px; line-height:1.5; }
.error-url { font-size:11px; color:#9ca3af; max-width:90vw; text-align:center; margin:0 0 4px; word-break:break-all; }
.error-code { font-size:10px; color:#d1d5db; margin:0 0 16px; }
.retry-btn { padding:8px 24px; border:1px solid #e5e7eb; border-radius:6px; background:white; color:#374151; font-size:13px; cursor:pointer; display:flex; align-items:center; gap:6px; transition:all 0.15s; }
.retry-btn:hover { background:#f9fafb; border-color:#d1d5db; }
</style>
</head>
<body>
<div class="error-container" data-original-url="${esc(encodedUrl)}">
    <div class="error-icon"><i class="${iconClass}"></i></div>
    <h1 class="error-title">无法访问此页面</h1>
    <p id="main-message" class="error-message">${escMsg}</p>
    <p class="error-url">${escUrl}</p>
    <p class="error-code">${escCode}</p>
    <button class="retry-btn" onclick="location.href=decodeURIComponent(this.parentElement.getAttribute('data-original-url'))"><i class="fa-solid fa-rotate-right"></i> 重新加载</button>
</div>
</body>
</html>\`); document.close();`;
}
