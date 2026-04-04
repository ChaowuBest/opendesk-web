/**
 * 集成测试: chat.send 通过 gateway 创建任务并流式收到回复。
 *
 * Mock LLM.streamComplete 使其返回固定文本，避免依赖真实 API。
 * 验证：
 *   1. chat.send 立即返回 { runId, status: 'started' }
 *   2. 服务端通过 WebSocket event 推送 chat delta/final 帧
 *   3. final 帧包含预期的 assistant 回复文本
 *
 * 运行: npx tsx src/tests/gateway-chat-send.test.ts
 */

import WebSocket from 'ws';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TEST_PORT = 19998;
const GATEWAY_URL = `ws://127.0.0.1:${TEST_PORT}`;
const MOCK_REPLY = '你好，这是来自 OpenDesk Agent 的回复。';

// ── Mock LLM ──────────────────────────────────────────────────────────────────

async function setupLLMMock() {
    const { LLM } = await import('../main/aikernel/llm.js');
    const { AssistantResponse, AssistantMessage, TextMessagePart } = await import('../main/aikernel/messages.js');

    const original = LLM.streamComplete;

    (LLM as any).streamComplete = async function* () {
        const msg = new AssistantMessage();
        msg.content.push(new TextMessagePart(MOCK_REPLY));
        yield new AssistantResponse(msg, 'stop');
    };

    // 同时 mock ask，因为 generateTaskName 会调用它
    const originalAsk = LLM.ask;
    (LLM as any).ask = async () => '测试任务';

    return () => {
        (LLM as any).streamComplete = original;
        (LLM as any).ask = originalAsk;
    };
}

// ── WebSocket helpers ─────────────────────────────────────────────────────────

function sendReq(ws: WebSocket, method: string, params?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const frame = { type: 'req', id, method, params };
        const timeout = setTimeout(() => {
            reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
        }, 15_000);

        const handler = (data: WebSocket.RawData) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'res' && msg.id === id) {
                    clearTimeout(timeout);
                    ws.off('message', handler);
                    resolve(msg);
                }
            } catch {
                /* ignore */
            }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify(frame));
    });
}

function waitForEvent(ws: WebSocket, eventName: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Timeout waiting for event: ${eventName}`));
        }, 15_000);

        const handler = (data: WebSocket.RawData) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'event' && msg.event === eventName) {
                    clearTimeout(timeout);
                    ws.off('message', handler);
                    resolve(msg);
                }
            } catch {
                /* ignore */
            }
        };
        ws.on('message', handler);
    });
}

function collectChatEvents(ws: WebSocket, timeoutMs: number = 30_000): Promise<any[]> {
    return new Promise((resolve) => {
        const events: any[] = [];
        const timeout = setTimeout(() => {
            ws.off('message', handler);
            resolve(events);
        }, timeoutMs);

        const handler = (data: WebSocket.RawData) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'event' && msg.event === 'chat') {
                    events.push(msg.payload);
                    if (msg.payload.state === 'final' || msg.payload.state === 'error') {
                        clearTimeout(timeout);
                        ws.off('message', handler);
                        resolve(events);
                    }
                }
            } catch {
                /* ignore */
            }
        };
        ws.on('message', handler);
    });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n=== Gateway chat.send 集成测试 ===\n');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-chat-test-'));
    console.log(`临时数据目录: ${tmpDir}`);

    const restoreLLM = await setupLLMMock();

    const { DeviceGateway } = await import('../main/applications/devicemgr/gateway.js');
    const { registerOpenClawMethods } = await import('../main/applications/devicemgr/gateway-methods.js');
    const { TaskManagerState } = await import('../main/aikernel/states/tasks.js');

    const taskManagerState = new TaskManagerState();

    const gateway = new DeviceGateway(tmpDir, {
        enabled: true,
        port: TEST_PORT,
        autoApproveLocal: true
    });

    registerOpenClawMethods(gateway, {
        taskManagerState,
        workspace: tmpDir
    });

    let passed = 0;
    let failed = 0;

    function assert(condition: boolean, label: string, detail?: string) {
        if (condition) {
            console.log(`  [OK]   ${label}`);
            passed++;
        } else {
            console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
            failed++;
        }
    }

    try {
        await gateway.start();
        console.log(`[OK] Gateway 已启动在端口 ${TEST_PORT}\n`);

        // ── 连接并握手 ────────────────────────────────────
        const ws = new WebSocket(GATEWAY_URL);
        const challengePromise = waitForEvent(ws, 'connect.challenge');

        await new Promise<void>((resolve, reject) => {
            ws.on('open', resolve);
            ws.on('error', (err) => reject(new Error(`连接失败: ${err.message}`)));
        });

        const challenge = await challengePromise;
        console.log(`[OK] connect.challenge 已收到\n`);

        const connectRes = await sendReq(ws, 'connect', {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
                id: 'test-chat-client',
                version: '1.0.0',
                platform: 'test',
                mode: 'operator'
            },
            role: 'operator',
            scopes: ['operator.read', 'operator.write'],
            caps: [],
            commands: [],
            permissions: {}
        });
        assert(connectRes.ok, 'connect 握手成功');

        // ── 测试 1: chat.send 应该返回 started ────────────
        console.log('\n--- 测试 1: chat.send 基本响应 ---');

        const chatEventsPromise = collectChatEvents(ws);

        const idempotencyKey = crypto.randomUUID();
        const sendRes = await sendReq(ws, 'chat.send', {
            sessionKey: 'test-session',
            message: '你好',
            idempotencyKey
        });

        assert(sendRes.ok === true, 'chat.send 返回 ok=true');
        assert(sendRes.payload?.runId === idempotencyKey, `chat.send 返回正确的 runId`);
        assert(sendRes.payload?.status === 'started', 'chat.send 返回 status=started');

        // ── 测试 2: 等待 chat 事件流 ───────────────────────
        console.log('\n--- 测试 2: chat 事件流 ---');

        const chatEvents = await chatEventsPromise;
        console.log(`  收到 ${chatEvents.length} 个 chat 事件`);

        assert(chatEvents.length > 0, '收到至少 1 个 chat 事件');

        const finalEvent = chatEvents.find((e) => e.state === 'final');
        assert(!!finalEvent, '收到 final 事件');

        if (finalEvent?.message?.content) {
            const textContent = finalEvent.message.content.find((c: any) => c.type === 'text');
            const hasExpectedText = textContent?.text?.includes(MOCK_REPLY) ?? false;
            assert(hasExpectedText, `final 事件包含预期回复文本`);
            if (textContent) {
                console.log(
                    `  回复文本: "${textContent.text.slice(0, 80)}${textContent.text.length > 80 ? '...' : ''}"`
                );
            }
        } else {
            assert(false, 'final 事件包含 message.content', `payload: ${JSON.stringify(finalEvent)}`);
        }

        // ── 测试 3: 验证任务已创建 ──────────────────────────
        console.log('\n--- 测试 3: 任务系统验证 ---');

        const taskList = taskManagerState.getTaskList();
        assert(taskList.length >= 1, `TaskManagerState 中存在任务 (count=${taskList.length})`);

        const gatewayTask = taskList.find((t: any) => t.task_name?.includes('Gateway'));
        assert(!!gatewayTask, '存在 Gateway 来源的任务');

        // ── 测试 4: chat.history 返回消息 ────────────────────
        console.log('\n--- 测试 4: chat.history ---');

        const historyRes = await sendReq(ws, 'chat.history', { sessionKey: 'test-session' });
        assert(historyRes.ok === true, 'chat.history 返回 ok=true');
        assert(
            Array.isArray(historyRes.payload?.messages) && historyRes.payload.messages.length >= 2,
            `chat.history 返回消息 (count=${historyRes.payload?.messages?.length ?? 0})`
        );

        // ── 测试 5: chat.abort ──────────────────────────────
        console.log('\n--- 测试 5: chat.abort (任务已完成) ---');

        const abortRes = await sendReq(ws, 'chat.abort', { sessionKey: 'test-session' });
        assert(abortRes.ok === true, 'chat.abort 返回 ok=true');
        assert(abortRes.payload?.aborted === false, 'chat.abort: 已完成任务不会被 abort');

        // ── 测试 6: sessions.list 包含任务 ──────────────────
        console.log('\n--- 测试 6: sessions.list ---');

        const sessionsRes = await sendReq(ws, 'sessions.list', {});
        assert(sessionsRes.ok === true, 'sessions.list 返回 ok=true');
        assert(
            Array.isArray(sessionsRes.payload?.sessions) && sessionsRes.payload.sessions.length >= 1,
            `sessions.list 返回 session (count=${sessionsRes.payload?.sessions?.length ?? 0})`
        );

        // ── 清理 ──────────────────────────────────────────────
        ws.close();
        await gateway.stop();
        restoreLLM();
        fs.rmSync(tmpDir, { recursive: true, force: true });

        console.log(`\n=== 测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
        process.exit(failed > 0 ? 1 : 0);
    } catch (err: any) {
        console.error(`\n测试异常: ${err.message}\n${err.stack}`);
        restoreLLM();
        try {
            await gateway.stop();
        } catch {
            /* ignore */
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(`启动失败: ${err.message}`);
    process.exit(1);
});
