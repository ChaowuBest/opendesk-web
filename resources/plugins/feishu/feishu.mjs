/**
 * 飞书消息渠道实现（原生 OpenDesk Channel）。
 *
 * 协议要点：
 * - 参数登录：appId / appSecret → tenant_access_token
 * - 收消息：飞书「长连接」模式（WebSocket）
 *   1) POST {domain}/callback/ws/endpoint  body {AppID, AppSecret} → {URL, ClientConfig}
 *   2) 连接 wss URL；帧为 protobuf 编码（Frame: method/headers/payload）
 *   3) 定期发送 ping（control 帧），事件以 data 帧下发，需回 ack
 * - 发消息：POST /open-apis/im/v1/messages（text / image，先上传图片）
 *
 * 凭证自管：appId/appSecret 持久化到 ctx.dataDir/accounts.json。
 */

import fs from 'node:fs';
import path from 'node:path';
// 不使用 Node 全局 WebSocket：它由 undici 提供，而 OpenHarmony 版 Electron 主进程无法加载
// undici（见 src/platforms/electron.ts 的说明）。ws 是纯 JS 握手 + node:http，与 devicemgr
// 网关保持同一套跨平台实现；bundle 时会被内联进插件产物，运行时无需 node_modules。
import WebSocket from 'ws';
// protobufjs 无 exports 字段，ESM 下需显式 .js 扩展名；UMD 产物用 default import 解构
import protobuf from 'protobufjs/minimal.js';
const { Reader, Writer } = protobuf;

const FEISHU_DOMAIN = 'https://open.feishu.cn';
const LARK_DOMAIN = 'https://open.larksuite.com';

// ── protobuf 编解码（Frame/Header，基于官方 protobufjs Reader/Writer）───────

function readUint64(reader) {
    const value = reader.uint64();
    if (value && typeof value.toNumber === 'function') return value.toNumber();
    if (value && typeof value.toString === 'function') return Number(value.toString());
    return Number(value);
}

/** 解码 Frame（method/headers/payload，protobuf 字段号见 SDK Frame.proto） */
function decodeFrame(bytes) {
    const reader = Reader.create(bytes);
    const frame = { method: 0, service: 0, SeqID: 0, LogID: 0, headers: [], payload: new Uint8Array(0) };
    while (reader.pos < reader.len) {
        const tag = reader.uint32();
        const field = tag >>> 3;
        const wireType = tag & 7;
        if (field === 4 && wireType === 0) frame.method = reader.int32();
        else if (field === 3 && wireType === 0) frame.service = reader.int32();
        else if (field === 1 && wireType === 0) frame.SeqID = readUint64(reader);
        else if (field === 2 && wireType === 0) frame.LogID = readUint64(reader);
        else if (field === 5 && wireType === 2) frame.headers.push(decodeHeader(reader.bytes()));
        else if (field === 8 && wireType === 2) frame.payload = reader.bytes();
        else reader.skipType(wireType);
    }
    return frame;
}

function decodeHeader(bytes) {
    const reader = Reader.create(bytes);
    const header = { key: '', value: '' };
    while (reader.pos < reader.len) {
        const tag = reader.uint32();
        const field = tag >>> 3;
        const wireType = tag & 7;
        if (field === 1 && wireType === 2) header.key = reader.string();
        else if (field === 2 && wireType === 2) header.value = reader.string();
        else reader.skipType(wireType);
    }
    return header;
}

/** 编码 Frame 为 protobuf bytes（ping / ack 等出站帧） */
function encodeFrame(frame) {
    const writer = Writer.create();
    if (frame.method !== undefined && frame.method !== null) writer.uint32((4 << 3) | 0).int32(frame.method);
    if (frame.service) writer.uint32((3 << 3) | 0).int32(frame.service);
    if (frame.SeqID) writer.uint32((1 << 3) | 0).uint64(frame.SeqID);
    if (frame.LogID) writer.uint32((2 << 3) | 0).uint64(frame.LogID);
    for (const header of frame.headers || []) {
        const headerWriter = Writer.create();
        if (header.key) headerWriter.uint32((1 << 3) | 2).string(header.key);
        if (header.value) headerWriter.uint32((2 << 3) | 2).string(header.value);
        writer.uint32((5 << 3) | 2).bytes(headerWriter.finish());
    }
    if (frame.payload && frame.payload.length > 0) {
        writer.uint32((8 << 3) | 2).bytes(frame.payload);
    }
    return writer.finish();
}

// ── Channel 实现 ─────────────────────────────────────────────────────────────

export class FeishuChannel {
    meta = {
        id: 'feishu',
        label: { en: 'Feishu', zh: '飞书' },
        description: 'Feishu/Lark channel (WebSocket long connection)',
        aliases: ['lark']
    };
    capabilities = { chatTypes: ['direct', 'group'], media: true, interactive: true };
    supportLoginWithQr = true;

    constructor() {
        this._ctx = null;
        this._ws = new Map(); // accountId -> WebSocket
        this._pingTimers = new Map(); // accountId -> timer
        this._tokens = new Map(); // accountId -> { token, expiresAt }
        this._fragments = new Map(); // message_id -> { buffer[], sum }
        this._seenEventIds = new Set();
        this._runningAccounts = new Set(); // 主动启动（含待重连）的账号
        this._reconnectTimers = new Map(); // accountId -> timer
        this._reconnectAttempts = new Map(); // accountId -> 已重连次数（指数退避）
        // 结构化交互（权限审批 / askUser）pending 状态：interactionId -> { kind, accountId, ... }
        this._interactions = new Map();
        this._seenCardActionTokens = new Set(); // card action token 去重
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
            return JSON.parse(fs.readFileSync(this.accountsFile(), 'utf-8')) || {};
        } catch {
            return {};
        }
    }

    saveAccounts(accounts) {
        fs.mkdirSync(this._ctx.dataDir, { recursive: true });
        fs.writeFileSync(this.accountsFile(), JSON.stringify(accounts, null, 2));
    }

    listAccounts() {
        return Object.entries(this.loadAccounts()).map(([accountId, data]) => ({
            accountId,
            accountName: data.accountName || accountId
        }));
    }

    checkAccountStatus(accountId) {
        const accounts = this.loadAccounts();
        const data = accounts[accountId];
        if (!data?.appId || !data?.appSecret) return { ok: false, message: 'not configured' };
        const connected = this._ws.has(accountId) && this._ws.get(accountId)?.readyState === 1;
        return {
            ok: connected,
            message: connected ? 'connected' : `configured (appId: ${data.appId})`
        };
    }

    logoutAccount(accountId) {
        const accounts = this.loadAccounts();
        if (accounts[accountId]) {
            delete accounts[accountId];
            this.saveAccounts(accounts);
        }
    }

    // ── 登录（参数：appId/appSecret） ────────────────────────────────────────

    getAccountLoginParams() {
        return [
            { name: 'appId', displayName: 'App ID', required: true, type: 'text' },
            { name: 'appSecret', displayName: 'App Secret', required: true, type: 'password' }
        ];
    }

    async loginAccountWithParams(values) {
        const appId = (values.appId || '').trim();
        const appSecret = (values.appSecret || '').trim();
        if (!appId || !appSecret) throw new Error('feishu: appId and appSecret are required');
        // 校验凭证：尝试获取 tenant_access_token
        await this._getTenantToken(appId, appSecret);
        const accountId = appId;
        // 尝试获取应用名称（bot/v3/info），失败回退 appId
        const appName = (await this._getBotInfo(appId, appSecret)) || appId;
        const accounts = this.loadAccounts();
        accounts[accountId] = { appId, appSecret, accountName: appName };
        this.saveAccounts(accounts);
        this._ctx?.logger.info(`feishu: login success with appId ${appId}`);
        return { accountId, accountName: appName };
    }

    // ── 扫码登录（设备授权一键创建机器人） ──────────────────────────────────

    async getAccountLoginQr() {
        const ctx = this._ctx;
        // init：校验当前环境支持 client_secret 设备授权
        const initRes = await this._feishuAuthInit();
        if (!initRes.supported_auth_methods?.includes('client_secret')) {
            throw new Error('feishu: 当前环境不支持扫码创建机器人');
        }
        // begin：获取 device_code 与验证 URL
        const beginRes = await this._feishuAuthBegin();
        if (!beginRes.device_code || !beginRes.verification_uri_complete) {
            throw new Error('feishu: begin 返回异常');
        }
        // 记录会话，loginAccountWithQrWait 用 sessionKey（=device_code）轮询
        this._qrSessions = { ...(this._qrSessions || {}), [beginRes.device_code]: beginRes };
        return {
            qrUrl: beginRes.verification_uri_complete,
            sessionKey: beginRes.device_code,
            expiresAt: Date.now() + (beginRes.expire_in || beginRes.expires_in || 180) * 1000
        };
    }

    async loginAccountWithQrWait(session, onProgress) {
        const ctx = this._ctx;
        const beginRes = this._qrSessions?.[session.sessionKey];
        if (!beginRes) {
            throw new Error('feishu: 二维码会话已过期，请重新发起登录');
        }
        const deviceCode = beginRes.device_code;
        const interval = beginRes.interval || 5;
        const timeoutSec = Math.min(beginRes.expire_in || beginRes.expires_in || 180, 180);
        const deadline = Date.now() + timeoutSec * 1000;

        while (Date.now() < deadline) {
            await sleep(interval * 1000);
            let pollRes;
            try {
                pollRes = await this._feishuAuthPoll(deviceCode);
            } catch (err) {
                ctx.logger.warn('feishu: poll 网络错误: ' + (err?.message || err));
                continue;
            }
            if (pollRes.client_id && pollRes.client_secret) {
                // 创建机器人成功，保存凭证（账号 id 用 appId，不同应用互不覆盖）
                const appId = pollRes.client_id;
                const appSecret = pollRes.client_secret;
                const openId = pollRes.user_info?.open_id || '';
                const accountId = appId;
                const appName = (await this._getBotInfo(appId, appSecret)) || appId;
                const accounts = this.loadAccounts();
                accounts[accountId] = { appId, appSecret, accountName: appName };
                this.saveAccounts(accounts);
                this._tokens.delete(appId + ':' + appSecret);
                ctx.logger.info('feishu: 扫码创建机器人成功 appId=' + appId + ' openId=' + openId);
                onProgress?.('机器人创建成功');
                return { accountId, accountName: appName };
            }
            if (pollRes.error) {
                if (pollRes.error === 'authorization_pending' || pollRes.error === 'slow_down') {
                    onProgress?.('等待扫码确认...');
                    continue;
                }
                if (pollRes.error === 'access_denied') throw new Error('feishu: 用户拒绝了授权');
                if (pollRes.error === 'expired_token') throw new Error('feishu: 二维码已过期，请重新发起');
                throw new Error(
                    'feishu: ' +
                        (pollRes.error || 'unknown') +
                        (pollRes.error_description ? ': ' + pollRes.error_description : '')
                );
            }
        }
        throw new Error('feishu: 等待扫码超时，二维码已过期');
    }

    // ── 设备授权 REST 辅助（POST https://accounts.feishu.cn/oauth/v1/app/registration） ──

    async _feishuAuthPost(params) {
        const ctx = this._ctx;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
            const resp = await ctx.fetch('https://accounts.feishu.cn/oauth/v1/app/registration', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(params).toString(),
                signal: controller.signal
            });
            return await resp.json();
        } finally {
            clearTimeout(timer);
        }
    }

    async _feishuAuthInit() {
        return this._feishuAuthPost({ action: 'init' });
    }

    async _feishuAuthBegin() {
        return this._feishuAuthPost({
            action: 'begin',
            archetype: 'PersonalAgent',
            auth_method: 'client_secret',
            request_user_info: 'open_id'
        });
    }

    async _feishuAuthPoll(deviceCode) {
        return this._feishuAuthPost({ action: 'poll', device_code: deviceCode });
    }

    // ── 运行生命周期 ───────────────────────────────────────────────────────

    async start(account) {
        const accountId = account.accountId;
        const accounts = this.loadAccounts();
        const data = accounts[accountId];
        if (!data?.appId || !data?.appSecret) {
            throw new Error(`feishu: account ${accountId} not configured`);
        }
        if (this._ws.has(accountId) || this._runningAccounts.has(accountId)) return;

        this._runningAccounts.add(accountId);
        const ctx = this._ctx;
        ctx.setStatus({ online: true, statusText: '连接中' }, accountId);
        ctx.logger.info(`feishu: start ws (accountId=${accountId})`);

        try {
            await this._runWebSocket(accountId, data);
        } catch (err) {
            ctx.logger.error(`feishu: ws start failed: ${err?.message || err}`);
            ctx.setStatus({ online: false, statusText: '连接失败', error: err?.message || String(err) }, accountId);
            this._ws.delete(accountId);
            // 启动失败（如服务端暂时不可用）也进入自动重连
            this._scheduleReconnect(accountId);
        }
    }

    async stop(accountId) {
        this._runningAccounts.delete(accountId);
        this._clearReconnect(accountId);
        const ws = this._ws.get(accountId);
        if (ws) {
            try {
                ws.close();
            } catch {
                /* ignore */
            }
        }
        const timer = this._pingTimers.get(accountId);
        if (timer) clearTimeout(timer);
        this._pingTimers.delete(accountId);
        this._ws.delete(accountId);
    }

    // ── 断线自动重连 ─────────────────────────────────────────────────────────
    // 仅在账号仍处于「运行中」集合时重连（主动 stop 不会触发）。
    // 指数退避：5s → 10s → 20s → 40s → 封顶 80s。

    _scheduleReconnect(accountId) {
        if (!this._runningAccounts.has(accountId)) return;
        if (this._reconnectTimers.has(accountId)) return;
        const attempt = this._reconnectAttempts.get(accountId) || 0;
        const delay = Math.min(5000 * 2 ** Math.min(attempt, 4), 80_000);
        this._reconnectAttempts.set(accountId, attempt + 1);
        this._ctx?.setStatus({ online: false, statusText: `连接断开，${Math.round(delay / 1000)}s 后重连` }, accountId);
        this._reconnectTimers.set(
            accountId,
            setTimeout(() => {
                this._reconnectTimers.delete(accountId);
                void this._reconnect(accountId);
            }, delay)
        );
    }

    _clearReconnect(accountId) {
        const timer = this._reconnectTimers.get(accountId);
        if (timer) clearTimeout(timer);
        this._reconnectTimers.delete(accountId);
        this._reconnectAttempts.delete(accountId);
    }

    async _reconnect(accountId) {
        if (!this._runningAccounts.has(accountId)) return;
        const accounts = this.loadAccounts();
        const data = accounts[accountId];
        if (!data?.appId || !data?.appSecret) {
            this._runningAccounts.delete(accountId);
            return;
        }
        const ctx = this._ctx;
        ctx.logger.info(`feishu: reconnecting (accountId=${accountId})`);
        try {
            await this._runWebSocket(accountId, data);
            this._reconnectAttempts.delete(accountId);
        } catch (err) {
            ctx.logger.error(`feishu: reconnect failed: ${err?.message || err}`);
            ctx.setStatus({ online: false, statusText: '重连失败', error: err?.message || String(err) }, accountId);
            this._ws.delete(accountId);
            this._scheduleReconnect(accountId);
        }
    }

    async _runWebSocket(accountId, data) {
        const ctx = this._ctx;
        const domain = data.domain === 'lark' ? LARK_DOMAIN : FEISHU_DOMAIN;
        ctx.logger.info(`feishu: connecting (accountId=${accountId}, appId=${data.appId})`);

        // 1. 获取连接配置
        let endpointJson;
        try {
            const endpointResp = await ctx.fetch(`${domain}/callback/ws/endpoint`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', locale: 'zh' },
                body: JSON.stringify({ AppID: data.appId, AppSecret: data.appSecret })
            });
            endpointJson = await endpointResp.json();
        } catch (err) {
            throw new Error(`feishu: get ws endpoint network error: ${err?.message || err}`);
        }
        if (endpointJson.code !== 0 || !endpointJson.data?.URL) {
            throw new Error(
                `feishu: get ws endpoint failed code=${endpointJson.code} msg=${endpointJson.msg || ''} ` +
                    `(提示：需要飞书开放平台应用且已启用「长连接」事件订阅)`
            );
        }
        const connectUrl = endpointJson.data.URL;
        ctx.logger.info(`feishu: ws endpoint ok: ${connectUrl.slice(0, 80)}...`);
        const serviceId = Number(new URL(connectUrl).searchParams.get('service_id') || 0);
        let pingInterval = (endpointJson.data.ClientConfig?.PingInterval || 30) * 1000;

        // 2. 建立 WebSocket
        // stop 与重连竞态防护：endpoint 请求期间账号已被 stop，此时不再建连。
        // 必须在 new WebSocket 之前判断：ws 在握手阶段被 close 会异步 emit 'error'，
        // 而此刻还没挂上 onerror，EventEmitter 会把它抛成未捕获异常。
        if (!this._runningAccounts.has(accountId)) {
            throw new Error('feishu: connection cancelled (account stopped)');
        }
        const ws = new WebSocket(connectUrl);
        ws.binaryType = 'arraybuffer';
        this._ws.set(accountId, ws);

        const sendFrame = (frame) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            ws.send(encodeFrame(frame));
        };

        const pingLoop = () => {
            sendFrame({
                headers: [{ key: 'type', value: 'ping' }],
                service: serviceId,
                method: 0,
                SeqID: 0,
                LogID: 0
            });
            this._pingTimers.set(
                accountId,
                setTimeout(pingLoop, pingInterval).unref?.() || setTimeout(pingLoop, pingInterval)
            );
        };

        ws.onmessage = (event) => {
            const raw = event.data;
            const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw);
            ctx.logger.debug(`feishu: ws frame ${bytes.length}B (${accountId})`);
            this._handleFrame(accountId, bytes, sendFrame, (interval) => {
                if (interval > 0) {
                    pingInterval = interval;
                    const timer = this._pingTimers.get(accountId);
                    if (timer) clearTimeout(timer);
                    this._pingTimers.set(accountId, setTimeout(pingLoop, pingInterval));
                }
            });
        };

        ws.onclose = () => {
            const timer = this._pingTimers.get(accountId);
            if (timer) clearTimeout(timer);
            this._pingTimers.delete(accountId);
            const current = this._ws.get(accountId);
            if (current === ws) this._ws.delete(accountId);
            ctx.logger.info(`feishu: ws closed (${accountId})`);
            ctx.setStatus({ online: false, statusText: '连接断开' }, accountId);
            // 非主动 stop 的断开进入自动重连
            this._scheduleReconnect(accountId);
        };

        // 等待连接打开或快速失败
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                ctx.logger.error(`feishu: ws connect timeout (${accountId})`);
                try {
                    ws.close();
                } catch {
                    /* ignore */
                }
                reject(new Error('feishu: ws connect timeout'));
            }, 15_000);
            ws.onopen = () => {
                clearTimeout(timer);
                // 连接期间账号被 stop：立即关闭，不建立正式连接
                if (!this._runningAccounts.has(accountId)) {
                    try {
                        ws.close();
                    } catch {
                        /* ignore */
                    }
                    reject(new Error('feishu: connection cancelled (account stopped)'));
                    return;
                }
                ctx.setStatus({ online: true, statusText: '已连接' }, accountId);
                ctx.logger.info(`feishu: ws connected (${accountId})`);
                pingLoop();
                resolve();
            };
            ws.onerror = (e) => {
                clearTimeout(timer);
                ctx.logger.error(`feishu: ws connect error (${accountId}): ${e?.message || e?.type || 'unknown'}`);
                reject(new Error('feishu: ws connect failed'));
            };
        });
    }

    _handleFrame(accountId, bytes, sendFrame, updatePingInterval) {
        let frame;
        try {
            frame = decodeFrame(bytes);
        } catch (err) {
            this._ctx?.logger.warn(`feishu: decode frame failed: ${err?.message}`);
            return;
        }
        const headers = {};
        for (const h of frame.headers || []) headers[h.key] = h.value;

        if (frame.method === 0) {
            // control frame: ping / pong
            const type = headers.type;
            if (type === 'pong' && frame.payload?.length) {
                try {
                    const payloadJson = JSON.parse(new TextDecoder().decode(frame.payload));
                    const interval = Number(payloadJson.PingInterval || 0);
                    if (interval > 0) updatePingInterval(interval * 1000);
                } catch {
                    /* ignore */
                }
            }
            return;
        }

        // data frame: event / card
        const type = headers.type;
        if (type !== 'event' && type !== 'card') {
            this._ctx?.logger.debug(`feishu: ignore data frame type=${type}`);
            return;
        }

        const messageId = headers.message_id;
        const sum = Number(headers.sum || 1);
        const seq = Number(headers.seq || 0);
        this._ctx?.logger.info(`feishu: data frame type=${type} messageId=${messageId} seq=${seq}/${sum}`);

        // 分片重组
        const key = messageId || `${type}:${Date.now()}`;
        let fragment = this._fragments.get(key);
        if (!fragment) {
            fragment = { buffer: new Array(sum).fill(null), sum };
            this._fragments.set(key, fragment);
        }
        fragment.buffer[seq] = frame.payload;
        if (!fragment.buffer.every((part) => part)) return;

        this._fragments.delete(key);
        const merged = new Uint8Array(fragment.buffer.reduce((acc, cur) => acc + cur.byteLength, 0));
        let offset = 0;
        for (const part of fragment.buffer) {
            merged.set(part, offset);
            offset += part.byteLength;
        }

        // 解析事件
        let event;
        try {
            event = JSON.parse(new TextDecoder().decode(merged));
        } catch (err) {
            this._ctx?.logger.warn(`feishu: event parse failed: ${err?.message}`);
            this._ackFrame(sendFrame, frame, { code: 200 });
            return;
        }
        const eventType = event?.header?.event_type || event?.type;
        const eventId = event?.header?.event_id || messageId;
        if (eventId && this._seenEventIds.has(eventId)) return;
        if (eventId) {
            this._seenEventIds.add(eventId);
            if (this._seenEventIds.size > 5000) this._seenEventIds.clear();
        }

        this._ctx?.logger.info(`feishu: event ${eventType}`);

        if (eventType === 'im.message.receive_v1') {
            this._ackFrame(sendFrame, frame, { code: 200 });
            void this._handleMessageEvent(accountId, event).catch((err) => {
                this._ctx?.logger.error(`feishu: handle message event failed: ${err?.message || err}`);
            });
        } else if (eventType === 'card.action.trigger') {
            // 卡片回调：先处理再 ack。长连接模式下 ack 需按 HTTP 响应结构返回
            // （StatusCode/Header/Body），否则 toast 提示与卡片更新不会生效。
            void (async () => {
                let resp;
                try {
                    resp = await this._handleCardAction(accountId, event);
                } catch (err) {
                    this._ctx?.logger.error(`feishu: handle card action failed: ${err?.message || err}`);
                    resp = {};
                }
                this._ackFrame(sendFrame, frame, this._buildCardActionAckPayload(resp || {}));
            })();
        } else {
            this._ackFrame(sendFrame, frame, { code: 200 });
            this._ctx?.logger.debug(`feishu: unhandled event type=${eventType}`);
        }
    }

    /** 构造长连接模式下卡片回调的 ack payload（模拟 HTTP 响应结构）。 */
    _buildCardActionAckPayload(resp) {
        return {
            StatusCode: 200,
            Header: { 'Content-Type': 'application/json; charset=utf-8' },
            Body: JSON.stringify({ code: 0, ...(resp || {}) })
        };
    }

    /** 发送长连接 ack 帧（事件处理完成后调用）。 */
    _ackFrame(sendFrame, frame, body) {
        try {
            sendFrame({
                ...frame,
                headers: [...(frame.headers || []), { key: 'biz_rt', value: '0' }],
                payload: new TextEncoder().encode(JSON.stringify(body))
            });
        } catch (err) {
            this._ctx?.logger.warn(`feishu: ack frame failed: ${err?.message}`);
        }
    }

    async _handleMessageEvent(accountId, event) {
        const message = event?.event?.message;
        if (!message) {
            this._ctx?.logger.warn('feishu: receive event without message');
            return;
        }
        const ctx = this._ctx;
        const chatType = message.chat_type === 'group' ? 'group' : 'direct';
        // 飞书事件结构中 sender 位于 event.event.sender，而非 message.sender
        const eventSender = event?.event?.sender || {};
        const sender = eventSender.sender_id || {};
        const senderId = sender.open_id || sender.union_id || sender.user_id || 'unknown';
        if (senderId === 'unknown') {
            ctx.logger.warn(
                'feishu: cannot resolve sender id from event: ' + JSON.stringify(eventSender).slice(0, 200)
            );
        }

        // 解析 content
        let contentText = '';
        const media = [];
        try {
            const content = JSON.parse(message.content || '{}');
            const msgType = message.message_type;
            if (msgType === 'text') {
                contentText = content.text || '';
            } else if (msgType === 'post') {
                contentText = extractPostText(content);
            } else if (msgType === 'image' && content.image_key) {
                // 图片下载成功后仅以媒体形式投递，避免占位文本与图片被渲染成两条消息
                try {
                    const filePath = await this._downloadImage(accountId, message.message_id, content.image_key);
                    if (filePath) {
                        media.push({ path: filePath, contentType: 'image/*' });
                    } else {
                        contentText = '[图片]';
                    }
                } catch (err) {
                    contentText = '[图片]';
                    ctx.logger.warn(`feishu: download image failed: ${err?.message}`);
                }
            } else if (msgType === 'file' && content.file_key) {
                contentText = `[文件: ${content.file_name || 'file'}]`;
            } else if (msgType === 'location' && content.latitude != null && content.longitude != null) {
                const locationName = typeof content.name === 'string' && content.name.trim() ? content.name.trim() : '';
                contentText = locationName
                    ? `[位置] ${locationName}（纬度: ${content.latitude}, 经度: ${content.longitude}）`
                    : `[位置] 纬度: ${content.latitude}, 经度: ${content.longitude}`;
            } else {
                contentText = '[不支持的消息类型]';
            }
        } catch {
            contentText = message.content || '';
        }

        if (!contentText.trim() && media.length === 0) {
            ctx.logger.warn(`feishu: empty message dropped (type=${message.message_type}, id=${message.message_id})`);
            return;
        }

        const inbound = {
            messageId: message.message_id || undefined,
            accountId,
            chatType,
            sender: { id: senderId },
            text: contentText,
            timestamp: Date.now(),
            raw: event
        };
        if (chatType === 'group' && message.chat_id) inbound.group = { id: message.chat_id };
        if (media.length > 0) inbound.media = media;

        ctx.logger.info(`feishu: dispatch from ${senderId} chat=${chatType} type=${message.message_type}`);
        await ctx.dispatch(inbound);
    }

    // ── 出站 ───────────────────────────────────────────────────────────────

    async sendOutboundMessage(message) {
        const accountId = message.accountId;
        const accounts = this.loadAccounts();
        const data = accounts[accountId];
        if (!data?.appId || !data?.appSecret) {
            throw new Error(`feishu: account ${accountId} not configured`);
        }
        const token = await this._getTenantToken(data.appId, data.appSecret);
        const domain = data.domain === 'lark' ? LARK_DOMAIN : FEISHU_DOMAIN;
        const ctx = this._ctx;
        const target = message.to;
        const isGroup = target.chatType === 'group';
        const receiveIdType = isGroup ? 'chat_id' : 'open_id';

        const text = message.message?.text || '';
        const media = message.message?.media || [];

        let msgType = 'text';
        let content = JSON.stringify({ text });

        // 媒体：仅支持图片（本地文件上传为 image）
        if (media.length > 0) {
            const attachment = media[0];
            const filePath = attachment.path || attachment.url;
            if (filePath) {
                const imageKey = await this._uploadImage(domain, token, filePath);
                if (imageKey) {
                    msgType = 'image';
                    content = JSON.stringify({ image_key: imageKey });
                } else if (!text) {
                    return {};
                }
            }
        } else if (text) {
            // 富文本 post：渲染 markdown（soft break 转硬换行，代码块内保留）
            msgType = 'post';
            content = buildFeishuPostContent(materializeSoftBreaks(text));
        }

        const resp = await ctx.fetch(`${domain}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({
                receive_id: isGroup ? target.recipientId : target.recipientId,
                msg_type: msgType,
                content
            })
        });
        const respJson = await resp.json();
        if (respJson.code !== 0) {
            throw new Error(`feishu: send message failed code=${respJson.code} msg=${respJson.msg || ''}`);
        }
        return { messageId: respJson.data?.message_id };
    }

    // ── 结构化交互（权限审批 / askUser 卡片） ────────────────────────────────
    // OpenDesk 在渠道支持交互（capabilities.interactive）时，将权限审批与
    // askUser 提问作为 ChannelInteractionRequest 下发，本方法渲染为飞书交互卡片；
    // 用户在卡片上点击后经 card.action.trigger 事件 → _handleCardAction → ctx.dispatchInteraction 回传。

    /** 交互卡片默认 TTL：5 分钟（与 OpenClaw 飞书插件一致）。 */
    async sendInteraction(request) {
        if (!request || typeof request !== 'object') {
            throw new Error('feishu: invalid interaction request');
        }
        const accountId = request.accountId;
        const kind = request.kind === 'askUser' ? 'askUser' : 'approval';
        const payload = request.payload || {};
        const card = kind === 'askUser' ? this._buildAskUserCard(payload, {}) : this._buildApprovalCard(payload);
        this._injectInteractionId(card, request.interactionId);

        // 注册 pending 交互状态（用于卡片回调关联与超时结算）
        this._registerInteraction({
            interactionId: request.interactionId,
            kind,
            accountId,
            expiresAt: request.expiresAt,
            questions: kind === 'askUser' ? payload.questions || [] : undefined,
            prompt: kind === 'approval' ? payload.prompt || '' : undefined
        });

        const messageId = await this._sendCard(accountId, request.to, card);
        const pending = this._interactions.get(request.interactionId);
        if (pending && messageId) {
            pending.cardMessageId = messageId;
        }
        return { messageId };
    }

    /** 发送一张 interactive 卡片消息到目标会话，返回平台消息 id。 */
    async _sendCard(accountId, to, card) {
        const accounts = this.loadAccounts();
        const data = accounts[accountId];
        if (!data?.appId || !data?.appSecret) {
            throw new Error(`feishu: account ${accountId} not configured`);
        }
        const token = await this._getTenantToken(data.appId, data.appSecret);
        const domain = data.domain === 'lark' ? LARK_DOMAIN : FEISHU_DOMAIN;
        const isGroup = to.chatType === 'group';
        const receiveIdType = isGroup ? 'chat_id' : 'open_id';
        const resp = await this._ctx.fetch(`${domain}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({
                receive_id: to.recipientId,
                msg_type: 'interactive',
                content: JSON.stringify(card)
            })
        });
        const respJson = await resp.json();
        if (respJson.code !== 0) {
            throw new Error(`feishu: send card failed code=${respJson.code} msg=${respJson.msg || ''}`);
        }
        return respJson.data?.message_id;
    }
    /**
     * 交互卡片的全局配置。JSON 2.0 仅支持共享卡片，且「更新已发送的消息卡片」接口
     * 要求更新前后的卡片都显式声明 update_multi=true，否则无法就地刷新。
     */
    _cardConfig() {
        return { width_mode: 'fill', update_multi: true };
    }

    /** 构建审批卡片（确认 / 取消）。注意：卡片 schema V2 已不支持 tag:action 容器，按钮直接作为 block 元素。 */
    _buildApprovalCard(payload) {
        const confirmLabel = (payload.confirmLabel || 'Confirm').slice(0, 20);
        const cancelLabel = (payload.cancelLabel || 'Cancel').slice(0, 20);
        return {
            schema: '2.0',
            config: this._cardConfig(),
            header: {
                title: { tag: 'plain_text', content: '权限确认' },
                template: 'orange'
            },
            body: {
                elements: [
                    { tag: 'markdown', content: this._escapeCardText(payload.prompt || '是否允许该操作？') },
                    this._buildCardButton(confirmLabel, 'primary', {
                        oc: 'opendesk-interaction-v1',
                        kind: 'approval',
                        decision: 'allow'
                    }),
                    this._buildCardButton(cancelLabel, 'default', {
                        oc: 'opendesk-interaction-v1',
                        kind: 'approval',
                        decision: 'deny'
                    })
                ]
            }
        };
    }
    _buildAskUserCard(payload, state = {}) {
        const questions = Array.isArray(payload.questions) ? payload.questions : [];
        const selections = state.selections || {};
        const done = state.done || {};
        const elements = [];
        const doneCount = Object.keys(done).length;

        if (doneCount > 0) {
            const lines = Object.entries(done).map(([idx, labels]) => {
                const q = questions[Number(idx)];
                const labelText = Array.isArray(labels) ? labels.join('、') : String(labels ?? '');
                return `- ${q?.header || `问题${Number(idx) + 1}`}: **${labelText}**`;
            });
            elements.push({ tag: 'markdown', content: '**已回答：**\n' + lines.join('\n') });
        }

        const remaining = questions.map((q, idx) => ({ q, idx })).filter(({ idx }) => done[idx] === undefined);
        if (remaining.length === 0) {
            elements.push({ tag: 'markdown', content: '所有问题已回答，感谢确认。' });
        }
        for (const { q, idx } of remaining) {
            const multiple = q.multiple === true;
            elements.push({
                tag: 'markdown',
                content: `**${q.header || `问题${idx + 1}`}**${multiple ? '（多选，勾选后点确认）' : ''}\n${this._escapeCardText(q.question || '')}`
            });
            const options = Array.isArray(q.options) ? q.options : [];
            const current = selections[idx] || [];
            options.forEach((opt, optIdx) => {
                const selected = current.includes(opt.label);
                // 多选用勾选器（复选框）就地勾选，单选沿用按钮点击即答
                elements.push(
                    multiple
                        ? this._buildAskUserChecker(idx, optIdx, opt, selected)
                        : this._buildCardButton((opt.label || '').slice(0, 20), 'default', {
                              oc: 'opendesk-interaction-v1',
                              kind: 'askUser',
                              q: idx,
                              o: opt.label
                          })
                );
            });
        }
        // 所有问题选项渲染完成后，再统一放置各多选问题的「确认选择」按钮，
        // 保证按钮位于卡片末尾（取消按钮之前），避免夹在多选题与后续问题之间。
        const multiRemaining = remaining.filter(({ q }) => q.multiple === true);
        if (multiRemaining.length === 1) {
            const { idx } = multiRemaining[0];
            const current = selections[idx] || [];
            elements.push(
                this._buildCardButton(
                    current.length > 0 ? `确认选择（已选 ${current.length}）` : '确认选择',
                    'primary',
                    {
                        oc: 'opendesk-interaction-v1',
                        kind: 'askUser',
                        q: idx,
                        confirm: true
                    }
                )
            );
        } else if (multiRemaining.length > 1) {
            // 多个多选问题并存时，用问题标题区分各自的确认按钮
            for (const { q, idx } of multiRemaining) {
                const current = selections[idx] || [];
                const qLabel = q.header || `问题${idx + 1}`;
                elements.push(
                    this._buildCardButton(
                        current.length > 0 ? `确认选择 ${qLabel}（已选 ${current.length}）` : `确认选择 ${qLabel}`,
                        'primary',
                        {
                            oc: 'opendesk-interaction-v1',
                            kind: 'askUser',
                            q: idx,
                            confirm: true
                        }
                    )
                );
            }
        }
        elements.push(
            this._buildCardButton('取消提问', 'default', {
                oc: 'opendesk-interaction-v1',
                kind: 'askUser',
                cancel: true
            })
        );

        return {
            schema: '2.0',
            config: this._cardConfig(),
            header: {
                title: { tag: 'plain_text', content: '向你提问' },
                template: 'blue'
            },
            body: { elements }
        };
    }
    _buildCardButton(label, type, value) {
        return {
            tag: 'button',
            text: { tag: 'plain_text', content: label },
            type,
            value
        };
    }

    /**
     * 多选选项的勾选器（复选框）元素。用户勾选后客户端本地立即变更勾选态，
     * 同时经 behaviors.callback 把 checked 状态回传服务端累积选择。
     */
    _buildAskUserChecker(questionIndex, optionIndex, option, selected) {
        return {
            tag: 'checker',
            name: `odk_chk_${questionIndex}_${optionIndex}`,
            checked: selected === true,
            text: { tag: 'plain_text', content: (option.label || '').slice(0, 60) },
            behaviors: [
                {
                    type: 'callback',
                    value: {
                        oc: 'opendesk-interaction-v1',
                        kind: 'askUser',
                        q: questionIndex,
                        o: option.label
                    }
                }
            ]
        };
    }

    /** 递归为卡片中所有交互组件的回传 value 注入 interactionId。 */
    _injectInteractionId(card, interactionId) {
        const visit = (node) => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) {
                for (const item of node) visit(item);
                return;
            }
            if (node.tag === 'button' && node.value && typeof node.value === 'object') {
                node.value.id = interactionId;
            }
            if (node.tag === 'checker' && Array.isArray(node.behaviors)) {
                for (const behavior of node.behaviors) {
                    if (behavior?.value && typeof behavior.value === 'object') {
                        behavior.value.id = interactionId;
                    }
                }
            }
            for (const [key, child] of Object.entries(node)) {
                if (node.tag === 'button' && key === 'value') continue;
                visit(child);
            }
        };
        visit(card);
    }

    /** 转义卡片 markdown 文本中的特殊字符。 */
    _escapeCardText(text) {
        return String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /**
     * 卡片回调的 ack 响应体：toast 提示 + 就地刷新同一张卡片
     * （card.type=raw 表示直接传入卡片 JSON），无需撤回重发。
     * 回调需在 3 秒内响应，因此中间态刷新只走 ack，不额外发更新请求。
     */
    _cardActionResponse(toast, card) {
        const response = {};
        if (toast) response.toast = toast;
        if (card) response.card = { type: 'raw', data: card };
        return response;
    }

    /**
     * 卡片交互后的刷新：ack 回传新卡片就地刷新，同时 PATCH 原消息兜底
     * （长连接下 ack 的卡片更新并非总是生效）。两条路径都作用于同一条消息，
     * 不会撤回原卡片也不会产生新卡片。
     * 飞书长连接回调需在 3 秒内 ack：此处先立即返回 toast + 新卡片，
     * PATCH 作为异步兜底执行，避免阻塞 ack 窗口导致客户端无任何反馈。
     */
    _respondWithCardRefresh(accountId, pending, card, toast) {
        const patchPromise = this._updateCardMessage(accountId, pending.cardMessageId, card);
        if (patchPromise && typeof patchPromise.catch === 'function') {
            patchPromise.catch((err) => {
                this._ctx?.logger.warn(`feishu: patch card message error: ${err?.message || err}`);
            });
        }
        return this._cardActionResponse(toast, card);
    }

    /** 注册 pending 交互并设置超时结算。 */
    _registerInteraction({ interactionId, kind, accountId, expiresAt, questions, prompt }) {
        const expiresAtMs = expiresAt || Date.now() + 5 * 60_000;
        const ttl = Math.max(1, expiresAtMs - Date.now());
        const pending = {
            interactionId,
            kind,
            accountId,
            expiresAt: expiresAtMs,
            cardMessageId: undefined,
            // askUser 中间态：selections=当前每题已选（多选可累积），done=已确认完成的问题；approval 无此字段
            selections: kind === 'askUser' ? {} : undefined,
            done: kind === 'askUser' ? {} : undefined,
            questions,
            // approval 的审批说明（用于点击后渲染状态卡片）
            prompt,
            timer: null
        };
        this._interactions.delete(interactionId);
        this._interactions.set(interactionId, pending);
        const timer = setTimeout(() => {
            // 超时：按取消结算，避免 pending 悬挂
            if (this._interactions.get(interactionId) !== pending) return;
            this._interactions.delete(interactionId);
            this._ctx?.logger.info(`feishu: interaction ${interactionId} expired`);
            void this._ctx?.dispatchInteraction?.({
                kind,
                interactionId,
                accountId,
                operator: { id: '', name: 'timeout' },
                cancelled: true,
                raw: { reason: 'expired' }
            });
            // 超时无卡片回调可依附，主动把原卡片刷新为已超时状态
            void this._updateCardMessage(
                accountId,
                pending.cardMessageId,
                this._buildDoneCard('已超时', 'grey', '等待超时，本次交互已自动取消。')
            );
        }, ttl);
        // unref：pending 交互不应阻止进程退出
        if (typeof timer.unref === 'function') timer.unref();
        pending.timer = timer;
    }
    /** 处理卡片回调（card.action.trigger），返回 ack 响应体（含 toast 与刷新后的卡片）。 */
    async _handleCardAction(accountId, event) {
        const ctx = this._ctx;
        const actionEvent = event?.event || {};
        const operator = actionEvent.operator || {};
        const action = actionEvent.action || {};
        const value = action.value || {};
        const token = String(actionEvent.token || '');
        const operatorId = operator.open_id || operator.user_id || operator.union_id || 'unknown';

        // token 去重：同一次点击只处理一次
        if (token) {
            if (this._seenCardActionTokens.has(token)) return {};
            this._seenCardActionTokens.add(token);
            if (this._seenCardActionTokens.size > 5000) this._seenCardActionTokens.clear();
        }

        if (value.oc !== 'opendesk-interaction-v1') {
            ctx?.logger.debug(`feishu: ignore non-opendesk card action from ${operatorId}`);
            return {};
        }
        const interactionId = value.id || value.interactionId;
        const pending = interactionId ? this._interactions.get(interactionId) : undefined;
        if (!pending) {
            ctx?.logger.warn(`feishu: card action for unknown interaction ${interactionId} from ${operatorId}`);
            return { toast: { type: 'warning', content: '该操作已过期，请重新发起' } };
        }
        if (pending.accountId !== accountId) {
            ctx?.logger.warn(
                `feishu: interaction ${interactionId} belongs to account ${pending.accountId}, got ${accountId}`
            );
            return { toast: { type: 'warning', content: '该操作不属于当前账号' } };
        }

        if (pending.kind === 'approval') {
            this._interactions.delete(interactionId);
            clearTimeout(pending.timer);
            const decision = value.decision === 'allow' ? 'allow' : 'deny';
            ctx?.logger.info(`feishu: approval ${interactionId} -> ${decision} by ${operatorId}`);
            await ctx?.dispatchInteraction?.({
                kind: 'approval',
                interactionId,
                accountId,
                operator: { id: operatorId },
                decision,
                raw: event
            });
            const doneCard = this._buildApprovalDoneCard(decision, pending.prompt);
            return await this._respondWithCardRefresh(accountId, pending, doneCard, {
                type: decision === 'allow' ? 'success' : 'info',
                content: decision === 'allow' ? '已确认' : '已取消'
            });
        }

        // askUser
        if (value.cancel) {
            this._interactions.delete(interactionId);
            clearTimeout(pending.timer);
            ctx?.logger.info(`feishu: askUser ${interactionId} cancelled by ${operatorId}`);
            await ctx?.dispatchInteraction?.({
                kind: 'askUser',
                interactionId,
                accountId,
                operator: { id: operatorId },
                cancelled: true,
                raw: event
            });
            const cancelCard = this._buildDoneCard('已取消', 'grey', '提问已取消');
            return await this._respondWithCardRefresh(accountId, pending, cancelCard, {
                type: 'info',
                content: '已取消'
            });
        }

        // 多选问题：点击「确认选择」提交该题
        if (value.confirm === true) {
            const qIdx = Number(value.q);
            if (!Number.isInteger(qIdx) || !pending.questions?.[qIdx]) {
                return { toast: { type: 'warning', content: '无效的问题' } };
            }
            pending.done[qIdx] = [...(pending.selections[qIdx] || [])];
            const total = pending.questions.length;
            const doneCount = Object.keys(pending.done).length;
            ctx?.logger.info(
                `feishu: askUser ${interactionId} confirmed Q${qIdx} (${doneCount}/${total}) by ${operatorId}`
            );
            if (doneCount >= total) {
                return await this._settleAskUser(accountId, pending, interactionId, operatorId, event, ctx);
            }
            return await this._respondWithCardRefresh(
                accountId,
                pending,
                this._refreshAskUserCard(pending, interactionId),
                { type: 'info', content: `问题 ${pending.questions[qIdx].header || Number(qIdx) + 1} 已确认` }
            );
        }

        const questionIndex = Number(value.q);
        const optionLabel = String(value.o ?? '');
        if (!Number.isInteger(questionIndex) || !optionLabel || !pending.questions?.[questionIndex]) {
            ctx?.logger.warn(`feishu: malformed askUser option from ${operatorId}: q=${value.q} o=${value.o}`);
            return { toast: { type: 'warning', content: '无效的选项' } };
        }
        const multiple = pending.questions[questionIndex].multiple === true;
        const total = pending.questions.length;

        if (multiple) {
            // 多选：勾选器（或按钮）只累积/取消选择，不提交该题
            const current = pending.selections[questionIndex] || [];
            const pos = current.indexOf(optionLabel);
            // 勾选器回调携带客户端最终勾选态，以它为准；按钮回调按 toggle 处理
            const shouldSelect = action.tag === 'checker' ? action.checked === true : pos < 0;
            if (shouldSelect && pos < 0) current.push(optionLabel);
            else if (!shouldSelect && pos >= 0) current.splice(pos, 1);
            pending.selections[questionIndex] = current;
            delete pending.done[questionIndex]; // 重新选择时回到未完成
            return await this._respondWithCardRefresh(
                accountId,
                pending,
                this._refreshAskUserCard(pending, interactionId),
                {
                    type: 'info',
                    content: shouldSelect ? `已选择：${optionLabel}（继续勾选或确认）` : `已取消：${optionLabel}`
                }
            );
        }

        // 单选：点击即完成该题
        pending.selections[questionIndex] = [optionLabel];
        pending.done[questionIndex] = [optionLabel];
        const doneCount = Object.keys(pending.done).length;
        ctx?.logger.info(`feishu: askUser ${interactionId} answered ${doneCount}/${total} by ${operatorId}`);
        if (doneCount < total) {
            return await this._respondWithCardRefresh(
                accountId,
                pending,
                this._refreshAskUserCard(pending, interactionId),
                { type: 'info', content: `已选择：${optionLabel}` }
            );
        }

        // 全部完成：结算
        return await this._settleAskUser(accountId, pending, interactionId, operatorId, event, ctx);
    }

    /** 按当前 pending 状态重建 askUser 卡片（已注入 interactionId）。 */
    _refreshAskUserCard(pending, interactionId) {
        const card = this._buildAskUserCard(
            { questions: pending.questions },
            { selections: pending.selections, done: pending.done }
        );
        this._injectInteractionId(card, interactionId);
        return card;
    }

    /** askUser 全部回答完成：结算并把同一张卡片刷新为完成状态。 */
    async _settleAskUser(accountId, pending, interactionId, operatorId, event, ctx) {
        this._interactions.delete(interactionId);
        clearTimeout(pending.timer);
        await ctx?.dispatchInteraction?.({
            kind: 'askUser',
            interactionId,
            accountId,
            operator: { id: operatorId },
            answers: pending.done,
            raw: event
        });
        const doneCard = this._buildAskUserDoneCard(pending.questions, pending.done);
        return await this._respondWithCardRefresh(accountId, pending, doneCard, {
            type: 'success',
            content: '已全部回答'
        });
    }

    /**
     * askUser 全部回答完成后的结算卡片：逐题回显用户实际选择的选项，
     * 与 Electron 端 askUser 完成后对话中可见的答案保持一致。
     */
    _buildAskUserDoneCard(questions, done) {
        const lines = Object.keys(done)
            .sort((a, b) => Number(a) - Number(b))
            .map((idx) => {
                const q = questions[Number(idx)];
                const labels = done[idx];
                const labelText = Array.isArray(labels) ? labels.join('、') : String(labels ?? '');
                return `- ${this._escapeCardText(q?.header || `问题${Number(idx) + 1}`)}: **${this._escapeCardText(labelText)}**`;
            });
        return {
            schema: '2.0',
            config: this._cardConfig(),
            header: { title: { tag: 'plain_text', content: '已全部回答' }, template: 'green' },
            body: {
                elements: [
                    { tag: 'markdown', content: '**已回答：**\n' + lines.join('\n') },
                    { tag: 'markdown', content: '所有问题已回答，感谢确认。' }
                ]
            }
        };
    }

    /** 通用状态卡片：替换原交互卡片，展示最终结果（按钮移除，不可再点）。 */
    _buildDoneCard(title, template, text) {
        return {
            schema: '2.0',
            config: this._cardConfig(),
            header: { title: { tag: 'plain_text', content: title }, template },
            body: { elements: [{ tag: 'markdown', content: this._escapeCardText(text) }] }
        };
    }

    /** 审批后的状态卡片：替换原卡片，展示已允许/已拒绝，按钮不可再点。 */
    _buildApprovalDoneCard(decision, prompt) {
        const allowed = decision === 'allow';
        return {
            schema: '2.0',
            config: this._cardConfig(),
            header: {
                title: { tag: 'plain_text', content: allowed ? '已允许' : '已拒绝' },
                template: allowed ? 'green' : 'red'
            },
            body: {
                elements: [
                    {
                        tag: 'markdown',
                        content: `**${allowed ? '已允许该操作' : '已拒绝该操作'}**\n\n${this._escapeCardText(prompt || '')}`
                    }
                ]
            }
        };
    }

    /**
     * 就地刷新原交互卡片：调用「更新已发送的消息卡片」（PATCH）接口，
     * 始终作用于同一条消息，不撤回、不重发。卡片回调场景下与 ack 响应中的
     * card 互为兜底；超时等无回调场景下是唯一的刷新途径。
     */
    async _updateCardMessage(accountId, messageId, card) {
        if (!messageId || !card) return;
        const accounts = this.loadAccounts();
        const data = accounts[accountId];
        if (!data?.appId || !data?.appSecret) return;
        try {
            const token = await this._getTenantToken(data.appId, data.appSecret);
            const domain = data.domain === 'lark' ? LARK_DOMAIN : FEISHU_DOMAIN;
            const resp = await this._ctx.fetch(`${domain}/open-apis/im/v1/messages/${messageId}`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ content: JSON.stringify(card) })
            });
            const json = await resp.json();
            if (json.code !== 0) {
                this._ctx?.logger.warn(
                    `feishu: patch card message ${messageId} failed code=${json.code} msg=${json.msg || ''}`
                );
            }
        } catch (err) {
            this._ctx?.logger.warn(`feishu: patch card message ${messageId} error: ${err?.message || err}`);
        }
    }

    // ── 飞书 REST 辅助 ──────────────────────────────────────────────────────

    /** 获取应用名称（GET /open-apis/bot/v3/info），失败返回空串。 */
    async _getBotInfo(appId, appSecret) {
        try {
            const token = await this._getTenantToken(appId, appSecret);
            const resp = await this._ctx.fetch(FEISHU_DOMAIN + '/open-apis/bot/v3/info', {
                headers: { Authorization: 'Bearer ' + token }
            });
            const json = await resp.json();
            // 兼容两种响应结构：{ bot } 与 { data: { bot } }
            const botInfo = json?.bot ?? json?.data?.bot;
            const name = botInfo?.app_name;
            if (typeof name === 'string' && name.trim()) {
                return name.trim();
            }
            if (json && json.code !== 0) {
                this._ctx?.logger.warn(
                    'feishu: get bot info failed code=' + (json.code ?? '?') + ' msg=' + (json.msg || '')
                );
            }
            return '';
        } catch (err) {
            this._ctx?.logger.warn('feishu: get bot info failed: ' + (err?.message || err));
            return '';
        }
    }

    async _getTenantToken(appId, appSecret) {
        const key = `${appId}:${appSecret}`;
        const cached = this._tokens.get(key);
        if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

        const resp = await this._ctx.fetch(`${FEISHU_DOMAIN}/open-apis/auth/v3/tenant_access_token/internal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ app_id: appId, app_secret: appSecret })
        });
        const json = await resp.json();
        if (json.code !== 0) {
            throw new Error(`feishu: get tenant_access_token failed code=${json.code} msg=${json.msg || ''}`);
        }
        const token = json.tenant_access_token;
        this._tokens.set(key, { token, expiresAt: Date.now() + (json.expire || 7200) * 1000 });
        return token;
    }

    async _downloadImage(accountId, messageId, fileKey) {
        const accounts = this.loadAccounts();
        const data = accounts[accountId];
        if (!data) return null;
        const token = await this._getTenantToken(data.appId, data.appSecret);
        const domain = data.domain === 'lark' ? LARK_DOMAIN : FEISHU_DOMAIN;
        const resp = await this._ctx.fetch(
            `${domain}/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=image`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!resp.ok) return null;
        const buffer = Buffer.from(await resp.arrayBuffer());
        // 加随机后缀避免同一毫秒多条图片互相覆盖
        const suffix = Math.random().toString(36).slice(2, 8);
        const filePath = path.join(this._ctx.dataDir, 'media', `img-${Date.now()}-${suffix}.png`);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, buffer);
        return filePath;
    }

    async _uploadImage(domain, token, filePath) {
        const fs = await import('node:fs');
        const fileBuf = fs.readFileSync(filePath);
        const form = new FormData();
        form.append('image_type', 'message');
        form.append('image', new Blob([fileBuf]), path.basename(filePath));
        const resp = await this._ctx.fetch(`${domain}/open-apis/im/v1/images`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: form
        });
        const json = await resp.json();
        if (json.code !== 0) {
            this._ctx?.logger.warn(`feishu: upload image failed code=${json.code} msg=${json.msg || ''}`);
            return null;
        }
        return json.data?.image_key;
    }
}

/** 从飞书富文本 post 消息中提取纯文本。 */
function extractPostText(content) {
    const parts = [];
    const zh = content.zh?.elements || [];
    const en = content.en?.elements || [];
    for (const elements of [zh, en]) {
        for (const element of elements) {
            if (element.tag === 'text' && element.text) parts.push(element.text);
            else if (element.tag === 'a' && element.text) parts.push(element.text);
            else if (element.tag === 'at' && element.user_id) parts.push(`@${element.user_id}`);
            else if (element.tag === 'img') parts.push('[图片]');
        }
    }
    return parts.join('');
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 构建飞书富文本 post 消息内容（md 元素渲染 markdown）。 */
function buildFeishuPostContent(messageText) {
    return JSON.stringify({
        zh_cn: {
            content: [[{ tag: 'md', text: messageText }]]
        }
    });
}

/**
 * CommonMark soft break 转硬换行（行尾两个空格 + 换行），供飞书 md 渲染保留换行。
 * 代码围栏（```）内的换行保留原样，避免破坏代码块。
 */
function materializeSoftBreaks(text) {
    if (!text.includes('\n')) return text;
    const lines = text.split('\n');
    let inFence = false;
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*```(?:[a-zA-Z0-9_-]*)?\s*$/.test(line)) {
            inFence = !inFence;
            out.push(line);
            continue;
        }
        if (!inFence && i < lines.length - 1) {
            out.push(line + '  ');
        } else {
            out.push(line);
        }
    }
    return out.join('\n');
}
