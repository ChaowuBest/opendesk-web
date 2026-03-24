/**
 * 复现 gateway METHOD_NOT_FOUND 问题。
 *
 * 直接启动一个 DeviceGateway 实例，模拟 openclaw 客户端连接后
 * 发送 chat.send 等方法请求，验证是否返回 METHOD_NOT_FOUND。
 *
 * 运行: npx tsx src/tests/gateway-method-not-found.test.ts
 */

import WebSocket from 'ws';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TEST_PORT = 19999;
const GATEWAY_URL = `ws://127.0.0.1:${TEST_PORT}`;

function sendReq(ws: WebSocket, method: string, params?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const frame = { type: 'req', id, method, params };

        const timeout = setTimeout(() => {
            reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
        }, 10_000);

        const handler = (data: WebSocket.RawData) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'res' && msg.id === id) {
                    clearTimeout(timeout);
                    ws.off('message', handler);
                    resolve(msg);
                }
            } catch { /* ignore parse errors */ }
        };

        ws.on('message', handler);
        ws.send(JSON.stringify(frame));
    });
}

function waitForEvent(ws: WebSocket, eventName: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Timeout waiting for event: ${eventName}`));
        }, 10_000);

        const handler = (data: WebSocket.RawData) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'event' && msg.event === eventName) {
                    clearTimeout(timeout);
                    ws.off('message', handler);
                    resolve(msg);
                }
            } catch { /* ignore parse errors */ }
        };

        ws.on('message', handler);
    });
}

async function main() {
    console.log(`\n=== Gateway METHOD_NOT_FOUND 复现测试 ===\n`);

    // 创建临时数据目录
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-gw-test-'));
    console.log(`临时数据目录: ${tmpDir}`);

    // 动态导入 DeviceGateway 和方法注册
    const { DeviceGateway } = await import('../main/applications/devicemgr/gateway.js');
    const { registerOpenClawMethods } = await import('../main/applications/devicemgr/gateway-methods.js');

    const gateway = new DeviceGateway(tmpDir, {
        enabled: true,
        port: TEST_PORT,
        autoApproveLocal: true,
    });

    registerOpenClawMethods(gateway);

    try {
        await gateway.start();
        console.log(`[OK] Gateway 已启动在端口 ${TEST_PORT}\n`);

        const ws = new WebSocket(GATEWAY_URL);

        // 注册 challenge 监听器，在 open 之前，以免错过立即发送的事件
        const challengePromise = waitForEvent(ws, 'connect.challenge');

        await new Promise<void>((resolve, reject) => {
            ws.on('open', resolve);
            ws.on('error', (err) => reject(new Error(`连接失败: ${err.message}`)));
        });

        console.log('[OK] WebSocket 连接已建立');

        const challenge = await challengePromise;
        console.log(`[OK] 收到 connect.challenge: nonce=${challenge.payload.nonce}`);

        // 发送 connect 请求（模拟 openclaw operator 客户端）
        const connectRes = await sendReq(ws, 'connect', {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
                id: 'test-client',
                version: '1.0.0',
                platform: 'test',
                mode: 'operator',
            },
            role: 'operator',
            scopes: ['operator.read', 'operator.write'],
            caps: [],
            commands: [],
            permissions: {},
        });

        if (!connectRes.ok) {
            console.log(`[FAIL] connect 失败: ${JSON.stringify(connectRes.error)}`);
            ws.close();
            await gateway.stop();
            process.exit(1);
        }

        console.log('[OK] connect 握手成功\n');

        // 测试 openclaw 客户端常用方法
        const methodsToTest = [
            { method: 'chat.send', params: { sessionKey: 'main', message: 'hello', idempotencyKey: crypto.randomUUID() } },
            { method: 'chat.history', params: { sessionKey: 'main' } },
            { method: 'chat.abort', params: { sessionKey: 'main' } },
            { method: 'sessions.list', params: {} },
            { method: 'sessions.create', params: {} },
            { method: 'health', params: {} },
            { method: 'status', params: {} },
            { method: 'models.list', params: {} },
            { method: 'tools.catalog', params: {} },
            { method: 'agents.list', params: {} },
            { method: 'config.get', params: {} },
            { method: 'send', params: { to: 'test', message: 'hello', idempotencyKey: crypto.randomUUID() } },
        ];

        let passed = 0;
        let failed = 0;

        for (const { method, params } of methodsToTest) {
            const res = await sendReq(ws, method, params);
            const isMethodNotFound = !res.ok && res.error?.code === 'METHOD_NOT_FOUND';

            if (isMethodNotFound) {
                console.log(`[FAIL] ${method}: METHOD_NOT_FOUND - ${res.error.message}`);
                failed++;
            } else if (!res.ok) {
                console.log(`[OK]   ${method}: 方法已注册 (业务错误: ${res.error?.code || 'unknown'} - ${res.error?.message || ''})`);
                passed++;
            } else {
                console.log(`[OK]   ${method}: 成功 ${res.payload ? '(有响应)' : ''}`);
                passed++;
            }
        }

        console.log(`\n=== 测试结果: ${passed} 通过, ${failed} 失败 ===\n`);

        ws.close();
        await gateway.stop();

        // 清理临时目录
        fs.rmSync(tmpDir, { recursive: true, force: true });

        process.exit(failed > 0 ? 1 : 0);
    } catch (err: any) {
        console.error(`测试异常: ${err.message}`);
        try { await gateway.stop(); } catch { /* ignore */ }
        fs.rmSync(tmpDir, { recursive: true, force: true });
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(`启动失败: ${err.message}`);
    process.exit(1);
});
