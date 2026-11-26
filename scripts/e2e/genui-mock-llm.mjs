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
 * 生成式 UI 端到端测试用的 OpenAI 兼容模型桩。
 *
 * 用户消息里带 [genui:<场景>] 标记时，按场景返回 showUI/askUI 工具调用（参数分块流式下发）；
 * 收到工具结果后回一句 "MOCK_FINAL <场景>: <工具结果>"，测试据此确认结果回到了模型。
 * 其它请求（标题生成、记忆整理等辅助调用）一律回短文本。
 *
 *   node scripts/e2e/genui-mock-llm.mjs --port 18790
 */

import http from 'node:http';

const SCENARIOS = {
    table: [
        {
            name: 'showUI',
            arguments: {
                component: 'data-table',
                title: '季度销售',
                props: {
                    columns: [
                        { key: 'region', label: '区域', priority: 'primary' },
                        { key: 'revenue', label: '收入', align: 'end', format: { kind: 'currency', currency: 'CNY' } },
                        { key: 'growth', label: '增长', align: 'end', format: { kind: 'percent', basis: 'fraction' } },
                        {
                            key: 'status',
                            label: '状态',
                            format: { kind: 'badge', tones: { 达标: 'success', 预警: 'warning' } }
                        }
                    ],
                    rows: [
                        { region: '华东', revenue: 1280000, growth: 0.12, status: '达标' },
                        { region: '华南', revenue: 860000, growth: -0.03, status: '预警' },
                        { region: '华北', revenue: 990000, growth: 0.05, status: '达标' }
                    ],
                    defaultSort: { key: 'revenue', direction: 'desc' }
                }
            }
        }
    ],
    showcase: [
        {
            name: 'showUI',
            arguments: {
                component: 'chart',
                props: {
                    label: '日活用户',
                    value: '12,840',
                    delta: '+8.2%',
                    trend: 'up',
                    points: [9800, 10200, 11050, 10900, 11800, 12840]
                }
            }
        },
        {
            name: 'showUI',
            arguments: {
                component: 'comparison-card',
                props: {
                    traitLabels: ['价格', '离线可用', '团队协作'],
                    options: [
                        { id: 'a', name: '基础版', headline: '个人使用', traits: ['¥99/月', false, false] },
                        { id: 'b', name: '专业版', headline: '小团队', traits: ['¥199/月', '支持', '5 人'] }
                    ],
                    recommendedId: 'b',
                    reason: '需要离线和协作'
                }
            }
        },
        {
            name: 'showUI',
            arguments: {
                component: 'spec-sheet',
                props: {
                    title: '推荐服务器配置',
                    subtitle: '按 50 并发估算',
                    rows: [
                        { label: 'CPU', value: '8 核', emphasis: true },
                        { label: '内存', value: '32 GB' },
                        { label: '磁盘', value: '500 GB SSD' }
                    ]
                }
            }
        },
        {
            name: 'showUI',
            arguments: {
                component: 'link-preview',
                props: {
                    href: 'https://example.com/opendesk-genui',
                    title: 'OpenDesk 生成式 UI',
                    description: '在对话里直接展示表格、卡片和表单',
                    siteName: 'example.com'
                }
            }
        }
    ],
    ask: [
        {
            name: 'askUI',
            arguments: {
                component: 'option-list',
                title: '发布到哪个环境？',
                props: {
                    options: [
                        { id: 'staging', label: '预发环境', description: '先在预发验证' },
                        { id: 'prod', label: '生产环境', description: '直接上线' }
                    ]
                }
            }
        }
    ],
    approve: [
        {
            name: 'askUI',
            arguments: {
                component: 'approval-card',
                props: {
                    title: '清理构建产物',
                    subtitle: '工作区 build/ 目录',
                    description: '删除后需要重新构建',
                    command: 'rm -rf build/',
                    variant: 'destructive'
                }
            }
        }
    ],
    form: [
        {
            name: 'askUI',
            arguments: {
                component: 'form',
                props: {
                    message: '请确认发布信息',
                    fields: [
                        { name: 'version', label: '版本号', kind: 'text', required: true, default: '1.2.0' },
                        {
                            name: 'channel',
                            label: '渠道',
                            kind: 'choice',
                            options: ['stable', 'beta'],
                            default: 'stable'
                        },
                        { name: 'notify', label: '通知用户', kind: 'toggle', default: true }
                    ]
                }
            }
        }
    ],
    flow: [
        {
            name: 'askUI',
            arguments: {
                component: 'question-flow',
                props: {
                    steps: [
                        {
                            id: 'size',
                            question: '团队规模？',
                            options: [
                                { id: 'small', label: '10 人以内' },
                                { id: 'large', label: '10 人以上' }
                            ]
                        },
                        {
                            id: 'budget',
                            question: '预算？',
                            options: [
                                { id: 'low', label: '低' },
                                { id: 'high', label: '高' }
                            ]
                        }
                    ]
                }
            }
        }
    ],
    // 参数不合法：工具报错，错误信息应原样回到模型
    // 内置 askUser（非 genui）：确认 web 模式下的提问投递与回答
    askuser: [
        {
            name: 'askUser',
            arguments: {
                questions: [
                    {
                        question: '报告导出成什么格式？',
                        header: '格式',
                        options: [
                            { label: 'PDF', description: '适合打印' },
                            { label: 'Markdown', description: '方便继续编辑' }
                        ],
                        multiple: false
                    }
                ]
            }
        }
    ],
    invalid: [
        { name: 'showUI', arguments: { component: 'chart', props: { label: '坏数据', value: '1', points: [1] } } }
    ]
};

function textOf(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content))
        return content.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('');
    return '';
}

const MARKER = /\[genui:([a-z-]+)\]/;

/**
 * 根据对话决定回复：以最近一条带场景标记的用户消息为本轮起点（宿主可能在其后插入提醒类
 * user 消息），之后已有工具结果就收尾，否则发该场景的工具调用。
 */
export function planReply(body) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const toolNames = new Set((body?.tools ?? []).map((tool) => tool?.function?.name).filter(Boolean));
    let turnStart = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === 'user' && MARKER.test(textOf(messages[index].content))) {
            turnStart = index;
            break;
        }
    }
    const scenario = turnStart >= 0 ? textOf(messages[turnStart].content).match(MARKER)?.[1] : undefined;
    if (!scenario || !SCENARIOS[scenario]) return { text: '好的' };

    const results = messages
        .slice(turnStart + 1)
        .filter((message) => message.role === 'tool')
        .map((message) => textOf(message.content));
    if (results.length > 0) {
        return { text: `MOCK_FINAL ${scenario}: ${results.join(' | ')}` };
    }
    // 宿主给工具名加了工具集前缀（如 interaction-showUI），按后缀找到实际名称
    const resolve = (name) => [...toolNames].find((tool) => tool === name || tool.endsWith(`-${name}`));
    const calls = SCENARIOS[scenario].map((call) => ({ ...call, name: resolve(call.name) }));
    if (calls.some((call) => !call.name)) {
        return { text: `MOCK_NO_TOOLS ${scenario}: ${[...toolNames].join(',')}` };
    }
    return { toolCalls: calls };
}

let callSeq = 0;

function chunk(model, delta, finishReason = null) {
    return {
        id: 'chatcmpl-genui',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }]
    };
}

function splitText(text, size) {
    const pieces = [];
    for (let index = 0; index < text.length; index += size) pieces.push(text.slice(index, index + size));
    return pieces;
}

async function streamReply(res, model, reply) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const pause = () => new Promise((resolve) => setTimeout(resolve, 15));
    if (reply.toolCalls) {
        for (const [index, call] of reply.toolCalls.entries()) {
            callSeq += 1;
            send(
                chunk(model, {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                        {
                            index,
                            id: `call_genui_${callSeq}`,
                            type: 'function',
                            function: { name: call.name, arguments: '' }
                        }
                    ]
                })
            );
            // 参数分块下发，覆盖工具调用参数流式生成中的渲染
            for (const piece of splitText(JSON.stringify(call.arguments), 48)) {
                send(chunk(model, { tool_calls: [{ index, function: { arguments: piece } }] }));
                await pause();
            }
        }
        send(chunk(model, {}, 'tool_calls'));
    } else {
        send(chunk(model, { role: 'assistant', content: '' }));
        for (const piece of splitText(reply.text, 24)) {
            send(chunk(model, { content: piece }));
            await pause();
        }
        send(chunk(model, {}, 'stop'));
    }
    res.write('data: [DONE]\n\n');
    res.end();
}

function jsonReply(res, model, reply) {
    const message = reply.toolCalls
        ? {
              role: 'assistant',
              content: null,
              tool_calls: reply.toolCalls.map((call) => {
                  callSeq += 1;
                  return {
                      id: `call_genui_${callSeq}`,
                      type: 'function',
                      function: { name: call.name, arguments: JSON.stringify(call.arguments) }
                  };
              })
          }
        : { role: 'assistant', content: reply.text };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
        JSON.stringify({
            id: 'chatcmpl-genui',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, message, finish_reason: reply.toolCalls ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
        })
    );
}

export function startMockLlm({ port = 18790, host = '0.0.0.0', log = () => {} } = {}) {
    const requests = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (data) => (raw += data));
        req.on('end', () => {
            const url = new URL(req.url ?? '/', 'http://mock');
            if (req.method === 'GET' && url.pathname.endsWith('/models')) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({ object: 'list', data: [{ id: 'genui-mock', object: 'model', owned_by: 'mock' }] })
                );
                return;
            }
            if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
                let body = {};
                try {
                    body = JSON.parse(raw || '{}');
                } catch {
                    // 非法请求体按辅助调用处理
                }
                const reply = planReply(body);
                requests.push({ body, reply });
                log(
                    `mock-llm: ${reply.toolCalls ? reply.toolCalls.map((call) => call.name).join(',') : reply.text.slice(0, 80)}`
                );
                const model = body.model ?? 'genui-mock';
                if (body.stream) void streamReply(res, model, reply);
                else jsonReply(res, model, reply);
                return;
            }
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `not found: ${req.method} ${url.pathname}` } }));
        });
    });
    return new Promise((resolve) => {
        server.listen(port, host, () =>
            resolve({ server, requests, close: () => new Promise((done) => server.close(done)) })
        );
    });
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const portIndex = process.argv.indexOf('--port');
    const port = portIndex > 0 ? Number(process.argv[portIndex + 1]) : 18790;
    const { server } = await startMockLlm({ port, log: (line) => console.log(line) });
    console.log(`genui mock LLM listening on ${JSON.stringify(server.address())}`);
}
