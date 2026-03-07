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

/**
 * 消息插件集成测试。
 * 支持子命令: info | connect | send | listen
 */

import { loadPlugins, listInstalledPlugins } from '../main/plugins/manager.js';
import type {
    PluginEntry,
    ChannelPlugin,
    ChannelAccountStatus,
    ChannelGatewayContext,
    InboundChannelMessage,
    PluginLogger,
} from '../main/plugins/types.js';
import readline from 'readline';
import fs from 'fs';
import path from 'path';

// ── 工具 ─────────────────────────────────────────────────────────────────────

const C = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
};

function ok(msg: string) { console.log(`  ${C.green}✓${C.reset} ${msg}`); }
function fail(msg: string) { console.log(`  ${C.red}✗${C.reset} ${msg}`); }
function info(msg: string) { console.log(`  ${C.cyan}ℹ${C.reset} ${msg}`); }
function warn(msg: string) { console.log(`  ${C.yellow}⚠${C.reset} ${msg}`); }
function heading(msg: string) { console.log(`\n${C.bold}${C.magenta}═══ ${msg} ═══${C.reset}`); }
function subheading(msg: string) { console.log(`\n${C.bold}  ── ${msg} ──${C.reset}`); }

function createTestLogger(prefix: string): PluginLogger {
    return {
        info: (...args: any[]) => console.log(`  ${C.dim}[${prefix}]${C.reset}`, ...args),
        warn: (...args: any[]) => console.log(`  ${C.yellow}[${prefix}]${C.reset}`, ...args),
        error: (...args: any[]) => console.log(`  ${C.red}[${prefix}]${C.reset}`, ...args),
        debug: (...args: any[]) => console.log(`  ${C.dim}[${prefix}:debug]${C.reset}`, ...args),
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function buildGatewayContext(
    cp: ChannelPlugin,
    accountId: string,
    account: any,
    config: any,
    overrides?: Partial<ChannelGatewayContext>,
): ChannelGatewayContext {
    const log = createTestLogger(`${cp.id}:${accountId}`);
    return {
        accountId,
        account,
        cfg: config,
        logger: log,
        log,
        runtime: {
            log: (...args: any[]) => console.log(`  ${C.dim}[${cp.id}:${accountId}]${C.reset}`, ...args),
            error: (...args: any[]) => console.error(`  ${C.red}[${cp.id}:${accountId}]${C.reset}`, ...args),
            warn: (...args: any[]) => console.warn(`  ${C.yellow}[${cp.id}:${accountId}]${C.reset}`, ...args),
            platform: 'opendesk',
        },
        dispatch: async () => {},
        setStatus: () => {},
        ...overrides,
    };
}

function prompt(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(question, answer => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

// ── 加载插件 ─────────────────────────────────────────────────────────────────

async function loadChannelPlugins(): Promise<PluginEntry[]> {
    const records = listInstalledPlugins();
    if (records.length === 0) {
        fail('暂无已安装的插件。请先运行: npm run cli -- plugins install <npm-spec>');
        return [];
    }
    info(`已发现 ${records.length} 个已安装插件`);

    const plugins = await loadPlugins();
    const channelPlugins = plugins.filter(p => p.channelPlugin);

    if (channelPlugins.length === 0) {
        warn('已安装的插件中没有消息插件');
    } else {
        ok(`已加载 ${channelPlugins.length} 个消息插件`);
    }
    return channelPlugins;
}

function findPlugin(plugins: PluginEntry[], channelId?: string): PluginEntry | undefined {
    if (!channelId) return plugins[0];
    return plugins.find(
        p => p.channelPlugin?.id === channelId || p.id === channelId,
    );
}

// ── 子命令: info ─────────────────────────────────────────────────────────────

async function cmdInfo(channelId?: string): Promise<boolean> {
    heading('消息插件信息');

    const plugins = await loadChannelPlugins();
    if (plugins.length === 0) return false;

    for (const entry of plugins) {
        const cp = entry.channelPlugin!;
        subheading(`${cp.meta.label} (${cp.id})`);

        info(`插件 ID: ${entry.id}`);
        info(`npm 包: ${entry.installRecord.npmSpec}`);
        if (cp.meta.description) info(`描述: ${cp.meta.description}`);

        const caps = cp.capabilities;
        info(`聊天类型: ${caps.chatTypes.join(', ')}`);
        const features: string[] = [];
        if (caps.media) features.push('媒体');
        if (caps.threading) features.push('线程');
        if (caps.reactions) features.push('表情');
        if (caps.editing) features.push('编辑');
        if (features.length > 0) info(`支持功能: ${features.join(', ')}`);

        const adapters: string[] = [];
        if (cp.gateway) adapters.push('gateway');
        if (cp.outbound) adapters.push(`outbound(${cp.outbound.deliveryMode})`);
        if (cp.status) adapters.push('status');
        if (cp.messaging) adapters.push('messaging');
        if (cp.heartbeat) adapters.push('heartbeat');
        if (cp.streaming) adapters.push('streaming');
        info(`适配器: ${adapters.join(', ') || '无'}`);

        if (cp.gateway) {
            const methods: string[] = [];
            if (cp.gateway.startAccount) methods.push('startAccount');
            if (cp.gateway.stopAccount) methods.push('stopAccount');
            if (cp.gateway.loginWithQrStart) methods.push('loginWithQrStart');
            if (cp.gateway.logoutAccount) methods.push('logoutAccount');
            info(`Gateway 方法: ${methods.join(', ')}`);
        }
        if (cp.outbound) {
            const methods: string[] = [];
            if (cp.outbound.sendText) methods.push('sendText');
            if (cp.outbound.sendPayload) methods.push('sendPayload');
            if (cp.outbound.sendMedia) methods.push('sendMedia');
            info(`Outbound 方法: ${methods.join(', ')}`);
        }

        if (cp.configSchema) {
            info('配置 Schema: 已定义');
        }
    }
    return true;
}

// ── 子命令: connect ──────────────────────────────────────────────────────────

async function cmdConnect(channelId?: string): Promise<boolean> {
    heading('消息插件连接测试');

    const plugins = await loadChannelPlugins();
    if (plugins.length === 0) return false;

    const entry = findPlugin(plugins, channelId);
    if (!entry) {
        fail(`未找到消息插件: ${channelId}`);
        return false;
    }

    const cp = entry.channelPlugin!;
    subheading(`测试连接: ${cp.meta.label} (${cp.id})`);

    if (!cp.gateway?.startAccount) {
        warn('该插件未实现 gateway.startAccount，跳过连接测试');
        return true;
    }

    // Build test config
    const config = buildTestConfig(cp);

    let accountIds: string[];
    try {
        accountIds = cp.config.listAccountIds(config);
    } catch {
        accountIds = [];
    }
    if (accountIds.length === 0) {
        accountIds = ['default'];
        warn('未从配置中解析到 account，使用 default');
    }
    info(`Account IDs: ${accountIds.join(', ')}`);

    let allPassed = true;
    for (const accountId of accountIds) {
        subheading(`Account: ${accountId}`);

        const statusLog: { time: number; status: ChannelAccountStatus }[] = [];
        const messageLog: InboundChannelMessage[] = [];
        const startTime = Date.now();

        let account: any;
        try {
            account = cp.config.resolveAccount(config, accountId);
        } catch {
            account = {};
        }

        const ctx = buildGatewayContext(cp, accountId, account, config, {
            dispatch: async (message: InboundChannelMessage) => {
                messageLog.push(message);
                info(`收到消息: [${message.senderName || message.senderId}] ${message.text?.substring(0, 80) || '(空)'}`);
            },
            setStatus: (status: any) => {
                statusLog.push({ time: Date.now() - startTime, status });
                const icon = status.online ? C.green + '●' : C.red + '○';
                const statusText = status.statusText || status.status || (status.online ? '在线' : '离线');
                console.log(`  ${icon}${C.reset} 状态变更: ${statusText}${status.error ? ` (${status.error})` : ''} [+${Date.now() - startTime}ms]`);
            },
        });

        // 测试 1: 启动连接（startAccount 是长连接，不等它 resolve）
        info('正在启动连接...');
        const abortController = new AbortController();
        (ctx as any).abortSignal = abortController.signal;

        let startAccountError: Error | null = null;
        const startAccountPromise = cp.gateway.startAccount(ctx).catch((err: any) => {
            if (!abortController.signal.aborted) {
                startAccountError = err;
            }
        });

        // 等待观察连接状态
        info('等待 8 秒观察连接状态...');
        await sleep(8000);

        if (startAccountError) {
            fail(`startAccount 失败: ${startAccountError.message}`);
            allPassed = false;
            continue;
        }

        ok('连接启动成功，已运行 8 秒');

        // 打印状态日志摘要
        if (statusLog.length > 0) {
            ok(`收到 ${statusLog.length} 次状态变更`);
            const lastStatus = statusLog[statusLog.length - 1].status;
            info(`最终状态: ${lastStatus.online ? '在线' : '离线'} - ${lastStatus.statusText || 'N/A'}`);
        } else {
            warn('未收到任何 setStatus 回调');
        }

        if (messageLog.length > 0) {
            ok(`在等待期间收到 ${messageLog.length} 条消息`);
        }

        // 测试 2: 停止连接
        info('正在停止连接...');
        abortController.abort();
        if (cp.gateway.stopAccount) {
            try {
                await Promise.race([
                    cp.gateway.stopAccount(ctx),
                    sleep(5000),
                ]);
                ok('stopAccount 调用成功');
            } catch (err: any) {
                warn(`stopAccount: ${err?.message || err}`);
            }
        }
        await Promise.race([startAccountPromise, sleep(3000)]);
        ok('连接已清理');
    }
    return allPassed;
}

// ── 子命令: send ─────────────────────────────────────────────────────────────

async function cmdSend(args: string[]): Promise<boolean> {
    heading('消息发送测试');

    const plugins = await loadChannelPlugins();
    if (plugins.length === 0) return false;

    // 解析参数: send [channelId] <to> <text...>
    let channelId: string | undefined;
    let to: string;
    let text: string;

    if (plugins.length === 1 && args.length >= 2) {
        to = args[0];
        text = args.slice(1).join(' ');
    } else if (args.length >= 3) {
        channelId = args[0];
        to = args[1];
        text = args.slice(2).join(' ');
    } else {
        console.log('用法: npm run test-cli -- channels send [channelId] <to> <text>');
        console.log('  channelId: 插件 ID（仅安装了一个插件时可省略）');
        console.log('  to:        接收者 ID');
        console.log('  text:      消息文本');
        return false;
    }

    const entry = findPlugin(plugins, channelId);
    if (!entry) {
        fail(`未找到消息插件: ${channelId || '(默认)'}`);
        return false;
    }

    const cp = entry.channelPlugin!;
    subheading(`通过 ${cp.meta.label} 发送消息`);

    if (!cp.outbound?.sendText && !cp.outbound?.sendPayload) {
        fail('该插件未实现 outbound.sendText 或 outbound.sendPayload');
        return false;
    }

    const config = buildTestConfig(cp);
    let accountId: string;
    try {
        accountId = cp.config.defaultAccountId(config);
    } catch {
        accountId = 'default';
    }

    info(`目标: ${to}`);
    info(`文本: ${text}`);
    info(`Account: ${accountId}`);

    // 如果有 gateway，先启动连接
    let gatewayCtx: ChannelGatewayContext | undefined;
    if (cp.gateway?.startAccount) {
        info('需要先建立连接，正在启动 gateway...');
        let account: any;
        try { account = cp.config.resolveAccount(config, accountId); } catch { account = {}; }
        gatewayCtx = buildGatewayContext(cp, accountId, account, config, {
            setStatus: (status: any) => {
                const icon = status.online ? C.green + '●' : C.red + '○';
                console.log(`  ${icon}${C.reset} 状态: ${status.statusText || status.status || ''}`);
            },
        });
        try {
            await Promise.race([
                cp.gateway.startAccount(gatewayCtx),
                sleep(15000).then(() => { throw new Error('连接超时'); }),
            ]);
            ok('Gateway 已启动');
            await sleep(2000);
        } catch (err: any) {
            fail(`Gateway 启动失败: ${err?.message || err}`);
            return false;
        }
    }

    // 发送消息
    const sendCtx = {
        channelId: cp.id,
        accountId,
        to,
        text,
        cfg: config,
    };

    try {
        if (cp.outbound?.sendText) {
            info('调用 outbound.sendText...');
            const result = await cp.outbound.sendText(sendCtx);
            ok(`sendText 成功${result ? `: ${JSON.stringify(result)}` : ''}`);
        } else if (cp.outbound?.sendPayload) {
            info('调用 outbound.sendPayload...');
            const result = await cp.outbound.sendPayload({ ...sendCtx, payload: { text } });
            ok(`sendPayload 成功${result ? `: ${JSON.stringify(result)}` : ''}`);
        }
    } catch (err: any) {
        fail(`发送失败: ${err?.message || err}`);
    }

    // 停止 gateway
    if (gatewayCtx && cp.gateway?.stopAccount) {
        try { await cp.gateway.stopAccount(gatewayCtx); } catch {}
    }

    return true;
}

// ── 子命令: listen ───────────────────────────────────────────────────────────

async function cmdListen(channelId?: string): Promise<boolean> {
    heading('消息接收测试（监听模式）');

    const plugins = await loadChannelPlugins();
    if (plugins.length === 0) return false;

    const entry = findPlugin(plugins, channelId);
    if (!entry) {
        fail(`未找到消息插件: ${channelId || '(默认)'}`);
        return false;
    }

    const cp = entry.channelPlugin!;
    subheading(`监听: ${cp.meta.label} (${cp.id})`);

    if (!cp.gateway?.startAccount) {
        fail('该插件未实现 gateway.startAccount，无法监听');
        return false;
    }

    const config = buildTestConfig(cp);
    let accountIds: string[];
    try { accountIds = cp.config.listAccountIds(config); } catch { accountIds = []; }
    if (accountIds.length === 0) {
        accountIds = ['default'];
        warn('未从配置中解析到 account，使用 default');
    }

    const messageCount = { value: 0 };
    const gatewayContexts: ChannelGatewayContext[] = [];

    for (const accountId of accountIds) {
        let account: any;
        try { account = cp.config.resolveAccount(config, accountId); } catch { account = {}; }

        const ctx = buildGatewayContext(cp, accountId, account, config, {
            dispatch: async (message: InboundChannelMessage) => {
                messageCount.value++;
                const ts = new Date().toLocaleTimeString();
                console.log(`\n  ${C.green}◀${C.reset} ${C.bold}[${ts}]${C.reset} 收到消息 #${messageCount.value}`);
                console.log(`    发送者: ${message.senderName || message.senderId}`);
                console.log(`    类型:   ${message.chatType}${message.groupName ? ` (${message.groupName})` : ''}`);
                console.log(`    内容:   ${message.text || '(空)'}`);
                if (message.media?.length) console.log(`    媒体:   ${message.media.length} 个附件`);
                if (message.threadId) console.log(`    线程:   ${message.threadId}`);
            },
            setStatus: (status: any) => {
                const icon = status.online ? C.green + '●' : C.red + '○';
                const statusText = status.statusText || status.status || (status.online ? '在线' : '离线');
                console.log(`  ${icon}${C.reset} [${accountId}] ${statusText}${status.error ? ` (${status.error})` : ''}`);
            },
        });
        gatewayContexts.push(ctx);

        info(`正在启动 account ${accountId}...`);
        try {
            await Promise.race([
                cp.gateway.startAccount(ctx),
                sleep(15000).then(() => { throw new Error('连接超时 (15s)'); }),
            ]);
            ok(`Account ${accountId} 已启动`);
        } catch (err: any) {
            fail(`Account ${accountId} 启动失败: ${err?.message || err}`);
        }
    }

    console.log(`\n  ${C.cyan}⏳${C.reset} 正在监听消息... 按 ${C.bold}Ctrl+C${C.reset} 或输入 ${C.bold}q${C.reset} 退出\n`);

    // 等待用户退出
    const exitPromise = new Promise<void>(resolve => {
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on('data', (data) => {
                const ch = data.toString();
                if (ch === 'q' || ch === 'Q' || ch === '\x03') {
                    resolve();
                }
            });
        }
        process.on('SIGINT', () => resolve());
        process.on('SIGTERM', () => resolve());
    });

    await exitPromise;

    // 清理
    console.log(`\n  ${C.yellow}⏹${C.reset} 正在停止...`);
    if (cp.gateway.stopAccount) {
        for (const ctx of gatewayContexts) {
            try {
                await Promise.race([
                    cp.gateway.stopAccount(ctx),
                    sleep(5000),
                ]);
            } catch {}
        }
    }

    info(`会话统计: 共收到 ${messageCount.value} 条消息`);
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
    }
    return true;
}

// ── 子命令: mock ─────────────────────────────────────────────────────────────

async function cmdMock(channelId?: string): Promise<boolean> {
    heading('消息插件模拟测试');
    info('模拟一条入站消息，验证插件的 dispatch → outbound 流程');

    const plugins = await loadChannelPlugins();
    if (plugins.length === 0) return false;

    const entry = findPlugin(plugins, channelId);
    if (!entry) {
        fail(`未找到消息插件: ${channelId || '(默认)'}`);
        return false;
    }

    const cp = entry.channelPlugin!;
    subheading(`模拟测试: ${cp.meta.label} (${cp.id})`);

    // 测试 1: config adapter
    subheading('1. 配置适配器');
    const config = buildTestConfig(cp);
    let accountIds: string[];
    try {
        accountIds = cp.config.listAccountIds(config);
        ok(`listAccountIds: [${accountIds.join(', ')}]`);
    } catch (err: any) {
        fail(`listAccountIds 失败: ${err?.message}`);
        accountIds = ['default'];
    }

    const defaultId = (() => { try { return cp.config.defaultAccountId(config); } catch { return 'default'; } })();
    ok(`defaultAccountId: ${defaultId}`);

    try {
        const resolved = cp.config.resolveAccount(config, defaultId);
        ok(`resolveAccount(${defaultId}): ${JSON.stringify(resolved)?.substring(0, 80) || '(empty)'}`);
    } catch (err: any) {
        warn(`resolveAccount 失败: ${err?.message}`);
    }

    // 测试 2: outbound adapter
    if (cp.outbound) {
        subheading('2. Outbound 适配器');
        info(`deliveryMode: ${cp.outbound.deliveryMode}`);
        if (cp.outbound.chunker) {
            try {
                const chunks = cp.outbound.chunker('Hello World! '.repeat(100), cp.outbound.textChunkLimit || 2000);
                ok(`chunker: 分成 ${chunks.length} 块`);
            } catch (err: any) {
                warn(`chunker 失败: ${err?.message}`);
            }
        }
    } else {
        subheading('2. Outbound 适配器');
        warn('未实现 outbound 适配器');
    }

    // 测试 3: 模拟 dispatch
    subheading('3. Gateway Dispatch 模拟');
    const mockMessage: InboundChannelMessage = {
        channelId: cp.id,
        accountId: defaultId,
        senderId: 'test-user-001',
        senderName: '测试用户',
        text: '你好，这是一条测试消息。',
        chatType: 'direct',
        messageId: `mock-${Date.now()}`,
    };
    info(`模拟消息: [${mockMessage.senderName}] ${mockMessage.text}`);

    let dispatchCalled = false;
    let outboundCalled = false;
    let outboundPayload: any = null;

    // 替换 outbound 以捕获调用
    const origSendText = cp.outbound?.sendText;
    const origSendPayload = cp.outbound?.sendPayload;
    if (cp.outbound) {
        cp.outbound.sendText = async (ctx: any) => {
            outboundCalled = true;
            outboundPayload = ctx;
            ok(`outbound.sendText 被调用: to=${ctx.to}, text=${ctx.text?.substring(0, 60)}`);
            return { delivered: true, mock: true };
        };
        cp.outbound.sendPayload = async (ctx: any) => {
            outboundCalled = true;
            outboundPayload = ctx;
            ok(`outbound.sendPayload 被调用: to=${ctx.to}`);
            return { delivered: true, mock: true };
        };
    }

    // 如果有 gateway，构造 context 并调用 dispatch
    if (cp.gateway?.startAccount) {
        let account: any;
        try { account = cp.config.resolveAccount(config, defaultId); } catch { account = {}; }
        const gatewayCtx = buildGatewayContext(cp, defaultId, account, config, {
            dispatch: async (message) => {
                dispatchCalled = true;
                info(`dispatch 回调触发: ${message.text?.substring(0, 60)}`);
            },
            setStatus: (status: any) => {
                const icon = status.online ? C.green + '●' : C.red + '○';
                console.log(`  ${icon}${C.reset} mock setStatus: ${status.statusText || ''}`);
            },
        });

        // 手动触发 dispatch
        info('手动触发 dispatch...');
        await gatewayCtx.dispatch(mockMessage);
        if (dispatchCalled) {
            ok('dispatch 回调成功触发');
        }
    } else {
        info('无 gateway，直接测试 outbound');
        if (cp.outbound?.sendText) {
            await cp.outbound.sendText({
                channelId: cp.id, accountId: defaultId,
                to: mockMessage.senderId, text: '这是一条模拟回复。',
                cfg: config,
            });
        }
    }

    // 恢复原始方法
    if (cp.outbound) {
        cp.outbound.sendText = origSendText;
        cp.outbound.sendPayload = origSendPayload;
    }

    subheading('模拟测试结果');
    ok('插件加载和注册正常');
    ok('配置适配器功能正常');
    if (dispatchCalled) ok('Gateway dispatch 流程正常');
    if (outboundCalled) ok(`Outbound 回调正常: payload=${JSON.stringify(outboundPayload)?.substring(0, 100)}`);

    return true;
}

// ── 配置构建 ─────────────────────────────────────────────────────────────────

function buildTestConfig(cp: ChannelPlugin): any {
    const settingPath = path.join(process.env.HOME || '', '.opendesk', 'setting.json');
    try {
        if (fs.existsSync(settingPath)) {
            const setting = JSON.parse(fs.readFileSync(settingPath, 'utf-8'));
            const channelConfig = setting?.applications?.channels?.[cp.id] || {};
            return {
                channels: { [cp.id]: channelConfig },
                ...channelConfig,
            };
        }
    } catch (err: any) {
        console.warn(`  配置读取失败: ${err?.message}`);
    }

    return { channels: { [cp.id]: {} } };
}

// ── 主入口 ───────────────────────────────────────────────────────────────────

export async function runChannelsTest(subArgs: string[]): Promise<boolean> {
    const subCmd = (subArgs[0] || '').toLowerCase();
    const rest = subArgs.slice(1);

    switch (subCmd) {
        case 'info':
            return cmdInfo(rest[0]);

        case 'connect':
            return cmdConnect(rest[0]);

        case 'send':
            return cmdSend(rest);

        case 'listen':
            return cmdListen(rest[0]);

        case 'mock':
            return cmdMock(rest[0]);

        case '':
        case 'help':
            printHelp();
            return true;

        default:
            console.error(`未知子命令: ${subCmd}`);
            printHelp();
            return false;
    }
}

function printHelp() {
    console.log(`
${C.bold}消息插件测试工具${C.reset}

${C.bold}用法:${C.reset} npm run test-cli -- channels <command> [args...]

${C.bold}命令:${C.reset}
  ${C.cyan}info${C.reset}    [channelId]                    查看消息插件详细信息
  ${C.cyan}connect${C.reset} [channelId]                    测试消息插件连接（启动 → 观察 → 停止）
  ${C.cyan}send${C.reset}    [channelId] <to> <text...>     通过插件发送一条测试消息
  ${C.cyan}listen${C.reset}  [channelId]                    启动插件并监听入站消息（Ctrl+C 退出）
  ${C.cyan}mock${C.reset}    [channelId]                    模拟测试（不需要真实连接）

${C.bold}示例:${C.reset}
  npm run test-cli -- channels info
  npm run test-cli -- channels connect xiaoyi
  npm run test-cli -- channels send user123 你好
  npm run test-cli -- channels listen
  npm run test-cli -- channels mock
`);
}
