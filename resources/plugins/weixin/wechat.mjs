/**
 * 微信消息渠道实现（原生 OpenDesk Channel）。
 *
 * 协议要点（ilink 机器人 API，JSON over HTTP）：
 * - 扫码登录：POST ilink/bot/get_bot_qrcode?bot_type=3 → { qrcode, qrcode_img_content }
 *   长轮询 GET ilink/bot/get_qrcode_status?qrcode=... → confirmed 后返回 bot_token + baseurl
 * - 收消息：POST ilink/bot/getupdates（长轮询），body { get_updates_buf, base_info }
 * - 发消息：POST ilink/bot/sendmessage，body { msg: WeixinMessage }
 *
 * 凭证自管：登录后 token 持久化到 ctx.dataDir/accounts/<accountId>.json。
 * 支持文本与图片接收（CDN 下载 + AES-128-ECB 解密）；出站发送媒体暂不支持。
 */

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
// 微信 CDN 下载基址：图片等媒体经 download?encrypted_query_param=... 获取后 AES-128-ECB 解密
const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const ILINK_APP_ID = 'bot';
const CHANNEL_VERSION = '2.4.6';
const CLIENT_VERSION = ((2 & 0xff) << 16) | ((4 & 0xff) << 8) | (6 & 0xff);
const DEFAULT_BOT_AGENT = 'OpenDesk';

import fs from 'node:fs';
import path from 'node:path';
import { createDecipheriv } from 'node:crypto';

const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const QR_POLL_TIMEOUT_MS = 30_000;
const QR_LOGIN_TIMEOUT_MS = 8 * 60 * 1000;

function randomWechatUin() {
    const buf = new Uint8Array(4);
    crypto.getRandomValues(buf);
    const uint32 = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
    return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function buildBaseInfo() {
    return { channel_version: CHANNEL_VERSION, bot_agent: DEFAULT_BOT_AGENT };
}

function buildHeaders(token) {
    const headers = {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': randomWechatUin(),
        'iLink-App-Id': ILINK_APP_ID,
        'iLink-App-ClientVersion': String(CLIENT_VERSION)
    };
    if (token && token.trim()) {
        headers.Authorization = `Bearer ${token.trim()}`;
    }
    return headers;
}

export class WechatChannel {
    meta = {
        id: 'weixin',
        label: { en: 'WeChat', zh: '微信' },
        description: 'WeChat channel (getUpdates long-poll + sendMessage)',
        aliases: ['wechat']
    };
    capabilities = { chatTypes: ['direct', 'group'], media: false };
    supportLoginWithQr = true;

    constructor() {
        this._ctx = null;
        this._controllers = new Map(); // accountId -> AbortController
        this._updatesBuf = new Map(); // accountId -> get_updates_buf
        this._seenMessageIds = new Set();
        this._contextTokens = new Map(); // accountId:recipientId -> context_token
        this._qrSessions = new Map(); // sessionKey -> { qrcode, baseUrl, token }
    }

    setChannelRuntimeContext(ctx) {
        this._ctx = ctx;
    }

    // ── 账号管理 ───────────────────────────────────────────────────────────

    accountsFile() {
        return this._ctx.resolvePath('accounts.json');
    }

    loadAccounts() {
        try {
            const raw = fs.readFileSync(this.accountsFile(), 'utf-8');
            return JSON.parse(raw) || {};
        } catch {
            return {};
        }
    }

    saveAccounts(accounts) {
        fs.mkdirSync(this._ctx.dataDir, { recursive: true });
        fs.writeFileSync(this.accountsFile(), JSON.stringify(accounts, null, 2));
    }

    listAccounts() {
        const accounts = this.loadAccounts();
        return Object.entries(accounts).map(([accountId, data]) => ({
            accountId,
            accountName: data.accountName || accountId
        }));
    }

    checkAccountStatus(accountId) {
        const accounts = this.loadAccounts();
        const data = accounts[accountId];
        if (!data?.token) return { ok: false, message: 'not logged in' };
        return { ok: true, message: `logged in (${data.baseUrl || DEFAULT_BASE_URL})` };
    }

    logoutAccount(accountId) {
        const accounts = this.loadAccounts();
        if (accounts[accountId]) {
            delete accounts[accountId];
            this.saveAccounts(accounts);
        }
    }

    // ── 扫码登录 ───────────────────────────────────────────────────────────

    async getAccountLoginQr() {
        const ctx = this._ctx;
        const localTokens = Object.values(this.loadAccounts())
            .map((a) => a.token)
            .filter(Boolean);
        const resp = await this._post(
            DEFAULT_BASE_URL,
            `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent('3')}`,
            { local_token_list: localTokens },
            undefined,
            API_TIMEOUT_MS
        );
        if (!resp.qrcode) throw new Error('weixin: no qrcode in response');
        const sessionKey = String(resp.qrcode);
        this._qrSessions.set(sessionKey, { qrcode: resp.qrcode, baseUrl: DEFAULT_BASE_URL });
        // 定时清理过期的二维码会话
        setTimeout(() => this._qrSessions.delete(sessionKey), QR_LOGIN_TIMEOUT_MS + 30_000).unref?.();
        return {
            // qrcode_img_content 是二维码内容字符串，UI 端据此渲染二维码图片
            qrUrl: resp.qrcode_img_content || resp.qrcode,
            sessionKey
        };
    }

    async loginAccountWithQrWait(session, onProgress) {
        const ctx = this._ctx;
        const qr = this._qrSessions.get(session.sessionKey);
        if (!qr) throw new Error('weixin: QR session expired, please retry');

        const deadline = Date.now() + QR_LOGIN_TIMEOUT_MS;
        while (Date.now() < deadline) {
            let statusResp;
            try {
                statusResp = await this._get(
                    qr.baseUrl,
                    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`,
                    undefined,
                    QR_POLL_TIMEOUT_MS
                );
            } catch {
                statusResp = { status: 'wait' };
            }

            const status = statusResp.status;
            if (status === 'confirmed') {
                const token = statusResp.bot_token;
                const baseUrl = statusResp.baseurl || DEFAULT_BASE_URL;
                const accountId = statusResp.ilink_bot_id || 'default';
                const accounts = this.loadAccounts();
                accounts[accountId] = {
                    token,
                    baseUrl,
                    accountName: statusResp.ilink_user_id ? `wx:${statusResp.ilink_user_id}` : accountId
                };
                this.saveAccounts(accounts);
                onProgress?.('登录成功');
                return { accountId, accountName: accounts[accountId].accountName };
            }
            if (status === 'expired' || status === 'verify_code_blocked') {
                throw new Error(`weixin: QR expired (${status})`);
            }
            if (status === 'scaned') onProgress?.('已扫码，请在手机上确认');
            else if (status === 'wait') onProgress?.('等待扫码...');
            // 其余状态（scaned_but_redirect / need_verifycode 等）继续轮询
        }
        throw new Error('weixin: QR login timeout');
    }

    getAccountLoginParams() {
        return [];
    }

    async loginAccountWithParams() {
        throw new Error('weixin: params login not supported, use QR login');
    }

    // ── 运行生命周期 ───────────────────────────────────────────────────────

    async start(account) {
        const accountId = account.accountId;
        const ctx = this._ctx;
        const accounts = this.loadAccounts();
        const data = accounts[accountId];
        if (!data?.token) {
            throw new Error(`weixin: account ${accountId} not configured`);
        }
        if (this._controllers.has(accountId)) return; // 已在运行

        const controller = new AbortController();
        this._controllers.set(accountId, controller);
        ctx.setStatus({ online: true, statusText: '连接中' }, accountId);

        const runLoop = async () => {
            let getUpdatesBuf = this._updatesBuf.get(accountId) || '';
            while (!controller.signal.aborted) {
                try {
                    const resp = await this._post(
                        data.baseUrl || DEFAULT_BASE_URL,
                        'ilink/bot/getupdates',
                        { get_updates_buf: getUpdatesBuf, base_info: buildBaseInfo() },
                        data.token,
                        LONG_POLL_TIMEOUT_MS,
                        controller.signal
                    );
                    if (controller.signal.aborted) break;
                    if (resp.get_updates_buf !== undefined) {
                        getUpdatesBuf = resp.get_updates_buf;
                        this._updatesBuf.set(accountId, getUpdatesBuf);
                    }
                    if (resp.ret && resp.ret !== 0 && resp.errcode === -14) {
                        // session timeout: 重置轮询缓冲后重试
                        getUpdatesBuf = '';
                        continue;
                    }
                    if (Array.isArray(resp.msgs) && resp.msgs.length > 0) {
                        for (const msg of resp.msgs) {
                            await this._handleIncoming(accountId, data, msg);
                        }
                    }
                    ctx.setStatus({ online: true, statusText: '已连接' }, accountId);
                } catch (err) {
                    if (controller.signal.aborted) break;
                    if (err?.name === 'AbortError') break;
                    const message = err?.message || String(err);
                    if (/401|unauthorized|token/i.test(message)) {
                        ctx.setStatus({ online: false, statusText: '认证失败', error: message }, accountId);
                        this._controllers.delete(accountId);
                        return;
                    }
                    ctx.setStatus({ online: false, statusText: '重连中', error: message }, accountId);
                    await sleep(2000);
                }
            }
            this._controllers.delete(accountId);
        };
        runLoop().catch((err) => {
            ctx.setStatus({ online: false, statusText: '连接异常', error: err?.message || String(err) }, accountId);
            this._controllers.delete(accountId);
        });
    }

    async _handleIncoming(accountId, accountData, msg) {
        if (msg.message_type === 2) return; // BOT 消息忽略
        if (msg.message_state === 1) return; // GENERATING 忽略
        const ctx = this._ctx;
        const items = Array.isArray(msg.item_list) ? msg.item_list : [];
        // item.type: 1=文本(MessageItemType.TEXT)，2=图片(MessageItemType.IMAGE)
        const textItems = items.filter((item) => item?.type === 1 && item?.text_item?.text);
        const imageItems = items.filter((item) => item?.type === 2 && item?.image_item?.media);

        const messageId = msg.message_id !== undefined ? String(msg.message_id) : '';
        if (messageId && this._seenMessageIds.has(messageId)) return;
        if (messageId) {
            this._seenMessageIds.add(messageId);
            if (this._seenMessageIds.size > 5000) {
                this._seenMessageIds.clear();
            }
        }

        // 下载图片媒体；下载失败时记下占位文本，避免纯媒体消息被静默丢弃
        const media = [];
        let mediaFallbackText = '';
        for (const item of imageItems) {
            try {
                const downloaded = await downloadWeixinImage(ctx, item.image_item);
                if (downloaded) {
                    media.push(downloaded);
                } else {
                    mediaFallbackText = '[图片]';
                }
            } catch (err) {
                mediaFallbackText = '[图片]';
                ctx.logger.warn(`weixin: download image failed: ${err?.message}`);
            }
        }

        const text = textItems.length > 0 ? textItems.map((item) => item.text_item.text).join('\n') : mediaFallbackText;
        if (!text.trim() && media.length === 0) return;

        const senderId = msg.from_user_id !== undefined ? String(msg.from_user_id) : 'unknown';
        const groupId = msg.group_id !== undefined ? String(msg.group_id) : undefined;

        // 记录会话关联：出站回复时带上 context_token 保持上下文
        if (msg.context_token) {
            const recipientKey = groupId || senderId;
            this._contextTokens.set(accountId + ':' + recipientKey, msg.context_token);
            if (this._contextTokens.size > 2000) this._contextTokens.clear();
        }

        const inbound = {
            messageId: messageId || undefined,
            accountId,
            chatType: groupId ? 'group' : 'direct',
            sender: { id: senderId },
            text,
            timestamp: msg.create_time_ms || Date.now(),
            raw: msg
        };
        if (groupId) inbound.group = { id: groupId };
        if (media.length > 0) inbound.media = media;

        ctx.logger.debug(`incoming from=${senderId} group=${groupId || '-'} len=${text.length} media=${media.length}`);
        await ctx.dispatch(inbound);
    }

    async stop(accountId) {
        const controller = this._controllers.get(accountId);
        if (controller) {
            controller.abort();
            this._controllers.delete(accountId);
        }
    }

    // ── 出站 ───────────────────────────────────────────────────────────────

    async sendOutboundMessage(message) {
        const accountId = message.accountId;
        const accounts = this.loadAccounts();
        const data = accounts[accountId];
        if (!data?.token) {
            throw new Error(`weixin: account ${accountId} not configured`);
        }
        const text = message.message?.text || '';
        const media = message.message?.media || [];
        if (media.length > 0) {
            throw new Error('weixin: media sending not supported yet');
        }
        if (!text) return {};

        const contextToken = this._contextTokens.get(accountId + ':' + message.to.recipientId);
        const outboundMsg = {
            from_user_id: '',
            to_user_id: message.to.recipientId,
            client_id: 'weixin-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
            message_type: 2,
            message_state: 2,
            item_list: text ? [{ type: 1, text_item: { text } }] : undefined,
            context_token: contextToken || undefined
        };
        const resp = await this._post(
            data.baseUrl || DEFAULT_BASE_URL,
            'ilink/bot/sendmessage',
            { msg: outboundMsg },
            data.token,
            API_TIMEOUT_MS
        );
        if (resp.ret && resp.ret !== 0) {
            throw new Error(`weixin: sendMessage ret=${resp.ret} errmsg=${resp.errmsg || '(none)'}`);
        }
        return {};
    }

    // ── HTTP 辅助 ──────────────────────────────────────────────────────────

    async _post(baseUrl, endpoint, body, token, timeoutMs, signal) {
        const ctx = this._ctx;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs || API_TIMEOUT_MS);
        const merged = signal ? linkAbort(signal, controller) : controller.signal;
        try {
            const resp = await ctx.fetch(`${ensureTrailingSlash(baseUrl)}${endpoint}`, {
                method: 'POST',
                headers: buildHeaders(token),
                body: JSON.stringify(body),
                signal: merged
            });
            if (!resp.ok) throw new Error(`weixin: HTTP ${resp.status} ${endpoint}`);
            return await resp.json();
        } finally {
            clearTimeout(timer);
        }
    }

    async _get(baseUrl, endpoint, token, timeoutMs) {
        const ctx = this._ctx;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs || API_TIMEOUT_MS);
        try {
            const resp = await ctx.fetch(`${ensureTrailingSlash(baseUrl)}${endpoint}`, {
                method: 'GET',
                headers: buildHeaders(token),
                signal: controller.signal
            });
            if (!resp.ok) throw new Error(`weixin: HTTP ${resp.status} ${endpoint}`);
            return await resp.json();
        } catch (err) {
            if (err?.name === 'AbortError') return { status: 'wait' };
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }
}

function ensureTrailingSlash(url) {
    return url.endsWith('/') ? url : `${url}/`;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function linkAbort(source, target) {
    const onAbort = () => target.abort();
    if (source.aborted) target.abort();
    else source.addEventListener('abort', onAbort, { once: true });
    const merged = target.signal;
    merged.addEventListener('abort', () => source.removeEventListener('abort', onAbort), { once: true });
    return merged;
}

// ── 入站图片：CDN 下载 + AES-128-ECB 解密 ──────────────────────────────────

/**
 * 解析 CDN 图片的 AES-128 key。
 * 两种编码均可能出现：base64(原始16字节) 或 base64(hex字符串，32字符 ASCII 再按 hex 解析)。
 */
function parseWeixinAesKey(aesKeyBase64) {
    const decoded = Buffer.from(aesKeyBase64, 'base64');
    if (decoded.length === 16) return decoded;
    if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
        return Buffer.from(decoded.toString('ascii'), 'hex');
    }
    throw new Error(`weixin: aes_key must decode to 16 raw bytes or 32-char hex, got ${decoded.length} bytes`);
}

function decryptAesEcb(ciphertext, key) {
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** 从 CDN encrypt_query_param 构造下载 URL。 */
function buildWeixinCdnDownloadUrl(encryptedQueryParam) {
    return `${WEIXIN_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

/** 探测图片 MIME/扩展名（JPEG/PNG/GIF/WebP/BMP），未知回退 JPEG。 */
function detectImageMime(buf) {
    if (!buf || buf.length < 4) return { ext: 'jpg', mime: 'image/jpeg' };
    if (buf[0] === 0xff && buf[1] === 0xd8) return { ext: 'jpg', mime: 'image/jpeg' };
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
        return { ext: 'png', mime: 'image/png' };
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { ext: 'gif', mime: 'image/gif' };
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46)
        return { ext: 'webp', mime: 'image/webp' };
    if (buf[0] === 0x42 && buf[1] === 0x4d) return { ext: 'bmp', mime: 'image/bmp' };
    return { ext: 'jpg', mime: 'image/jpeg' };
}

/**
 * 下载并解密微信 CDN 图片，保存到本地 media 目录。
 * @returns {{ path: string, contentType: string } | null} 成功返回本地文件信息，失败返回 null。
 */
async function downloadWeixinImage(ctx, imageItem) {
    const media = imageItem?.media;
    if (!media) return null;
    const fullUrl = media.full_url || imageItem?.url;
    const encryptedQueryParam = media.encrypt_query_param;
    if (!fullUrl && !encryptedQueryParam) return null;

    const url = fullUrl || buildWeixinCdnDownloadUrl(encryptedQueryParam);
    let resp;
    try {
        resp = await ctx.fetch(url);
    } catch (err) {
        ctx.logger.warn(`weixin: image fetch network error: ${err?.message}`);
        return null;
    }
    if (!resp.ok) {
        ctx.logger.warn(`weixin: image fetch ${resp.status} ${String(url).slice(0, 80)}`);
        return null;
    }
    const encrypted = Buffer.from(await resp.arrayBuffer());

    // 解密：image_item.aeskey(hex) 优先，其次 media.aes_key(base64)；两者皆无按明文处理
    let buf = encrypted;
    const aesKeyBase64 = imageItem.aeskey ? Buffer.from(imageItem.aeskey, 'hex').toString('base64') : media.aes_key;
    if (aesKeyBase64) {
        try {
            buf = decryptAesEcb(encrypted, parseWeixinAesKey(aesKeyBase64));
        } catch (err) {
            ctx.logger.warn(`weixin: image decrypt failed: ${err?.message}`);
            return null;
        }
    }

    const { ext, mime } = detectImageMime(buf);
    // 随机后缀避免同一毫秒多条图片互相覆盖
    const suffix = Math.random().toString(36).slice(2, 8);
    const filePath = path.join(ctx.dataDir, 'media', `wx-img-${Date.now()}-${suffix}.${ext}`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buf);
    return { path: filePath, contentType: mime };
}
