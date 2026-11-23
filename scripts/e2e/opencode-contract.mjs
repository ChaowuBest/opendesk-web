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
 * opencode 协议契约测试：启动 `opendesk serve`（模型用脚本内置的 OpenAI 兼容桩），
 * 逐个调用已实现的端点并订阅 /event，用 opencode 官方 OpenAPI 规范校验响应与事件。
 * 规范版本取 package.json 中固定的 @opencode-ai/sdk 版本（devDependencies）。
 *
 *   npm run build-cli && node scripts/e2e/opencode-contract.mjs \
 *       [--cli dist/cli/opendesk] [--spec openapi.json] [--port 4196] [--mock-port 18794]
 *
 * 不传 --spec 时从 opencode 仓库对应版本的 tag 下载 packages/sdk/openapi.json 并缓存到临时目录。
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function option(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index > 0 ? process.argv[index + 1] : fallback;
}

const cliPath = path.resolve(option('cli', path.join(repoRoot, 'dist', 'cli', 'opendesk')));
const port = Number(option('port', '4196'));
const mockPort = Number(option('mock-port', '18794'));
const base = `http://127.0.0.1:${port}`;

/** 规范中没有、服务端仍会发出的事件（已知差异）；出现时只提示，不算失败 */
const KNOWN_NON_SPEC_EVENTS = new Set(['session.aborted', 'server.heartbeat']);

/** 用户消息带这个标记时，模型桩先调用 TodoWrite 与 writeFile，拿到工具结果后再回复文本 */
const TOOLS_MARKER = '[contract:tools]';
const CONTRACT_FILE = 'contract-output.txt';
const MOCK_REPLY = 'contract reply from the mock model';

function textOf(content) {
    if (typeof content === 'string') return content;
    return Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : '';
}

/**
 * 以最近一条带标记的用户消息为本轮起点（宿主可能在其后插入提醒类 user 消息），之后已有工具结果就收尾。
 * 待办直接标记为 completed：未完成的待办会让 OpenDesk 每隔几秒追加提醒、继续推进任务。
 */
function planReply(body) {
    const messages = body.messages ?? [];
    const turnStart = messages.findLastIndex(
        (message) => message.role === 'user' && textOf(message.content).includes(TOOLS_MARKER)
    );
    if (turnStart === -1 || messages.slice(turnStart + 1).some((message) => message.role === 'tool')) {
        return { text: MOCK_REPLY };
    }
    // 宿主给工具名加了工具集前缀（如 filemgr-writeFile），按后缀找到实际名称
    const names = (body.tools ?? []).map((tool) => tool?.function?.name).filter(Boolean);
    const resolve = (name) => names.find((candidate) => candidate === name || candidate.endsWith(`-${name}`));
    const toolCalls = [
        { name: resolve('TodoWrite'), arguments: { todos: [{ content: 'contract todo', status: 'completed' }] } },
        { name: resolve('writeFile'), arguments: { path: CONTRACT_FILE, content: 'written by the contract test\n' } }
    ].filter((call) => call.name);
    return toolCalls.length > 0 ? { toolCalls } : { text: MOCK_REPLY };
}

/** OpenAI 兼容的模型桩：文本分几段流式下发（覆盖 message.part.delta），工具调用的参数同样流式下发 */
function startMockModel(listenPort) {
    let callSeq = 0;
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
            if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
                res.writeHead(404).end();
                return;
            }
            const body = JSON.parse(raw || '{}');
            const reply = planReply(body);
            const model = body.model ?? 'contract-mock';
            const base = { id: 'chatcmpl-contract', created: Math.floor(Date.now() / 1000), model };
            const usage = { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 };
            const toolCalls = (reply.toolCalls ?? []).map((call) => ({
                id: `call_contract_${++callSeq}`,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) }
            }));
            const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
            if (!body.stream) {
                const message = toolCalls.length
                    ? { role: 'assistant', content: null, tool_calls: toolCalls }
                    : { role: 'assistant', content: reply.text };
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        ...base,
                        object: 'chat.completion',
                        choices: [{ index: 0, message, finish_reason: finishReason }],
                        usage
                    })
                );
                return;
            }
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            const send = (delta, finish = null, extra = {}) =>
                res.write(
                    `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`
                );
            if (toolCalls.length > 0) {
                toolCalls.forEach((call, index) => {
                    send({
                        role: 'assistant',
                        content: null,
                        tool_calls: [
                            {
                                index,
                                id: call.id,
                                type: 'function',
                                function: { name: call.function.name, arguments: '' }
                            }
                        ]
                    });
                    send({ tool_calls: [{ index, function: { arguments: call.function.arguments } }] });
                });
            } else {
                send({ role: 'assistant', content: '' });
                for (const word of reply.text.split(' ')) send({ content: `${word} ` });
            }
            send({}, finishReason, { usage });
            res.end('data: [DONE]\n\n');
        });
    });
    return new Promise((resolve) =>
        server.listen(listenPort, '127.0.0.1', () =>
            resolve({ close: () => new Promise((done) => server.close(() => done())) })
        )
    );
}

async function loadSpec() {
    const explicit = option('spec');
    if (explicit) return JSON.parse(fs.readFileSync(explicit, 'utf8'));
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const version = packageJson.devDependencies['@opencode-ai/sdk'];
    const cached = path.join(os.tmpdir(), `opendesk-opencode-openapi-${version}.json`);
    if (!fs.existsSync(cached)) {
        const url = `https://raw.githubusercontent.com/anomalyco/opencode/v${version}/packages/sdk/openapi.json`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`download ${url}: HTTP ${response.status}`);
        fs.writeFileSync(cached, await response.text());
    }
    return JSON.parse(fs.readFileSync(cached, 'utf8'));
}

const spec = await loadSpec();
const ajv = new Ajv2020({ strict: false, validateSchema: false, validateFormats: false });
ajv.addSchema({ ...spec, $id: 'opencode' });
const pointer = (segment) => segment.replace(/~/g, '~0').replace(/\//g, '~1');

function responseValidator(method, specPath) {
    const content = spec.paths[specPath]?.[method.toLowerCase()]?.responses?.['200']?.content?.['application/json'];
    if (!content?.schema) throw new Error(`${method} ${specPath} has no JSON 200 response in the spec`);
    return ajv.compile({
        $ref: `opencode#/paths/${pointer(specPath)}/${method.toLowerCase()}/responses/200/content/application~1json/schema`
    });
}

function describeErrors(errors) {
    return (errors ?? [])
        .slice(0, 3)
        .map((error) => {
            const detail = error.params?.missingProperty ?? error.params?.additionalProperty ?? '';
            return `${error.instancePath || '/'} ${error.message}${detail ? ` (${detail})` : ''}`;
        })
        .join('; ');
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

// 工作空间是一个在 feature 分支上的 git 仓库，隔离全局 git 配置，/vcs 与 /project/current 的结果可预期
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-opencode-contract-')));
const workspace = path.join(scratch, 'workspace');
const configDir = path.join(scratch, 'config');
const gitConfig = path.join(scratch, 'gitconfig');
fs.mkdirSync(workspace);
fs.mkdirSync(configDir);
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig };
const git = (...args) => execFileSync('git', args, { cwd: workspace, env: gitEnv, stdio: 'ignore' });
git('-c', 'init.defaultBranch=main', 'init');
git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'init');
git('checkout', '-b', 'feature');
fs.writeFileSync(path.join(workspace, 'notes.md'), '# Notes\nthe contract needle lives here\n');
fs.writeFileSync(
    path.join(configDir, 'setting.json'),
    JSON.stringify({
        providers: [
            {
                name: 'contract-mock',
                provider_type: 'openai',
                base_url: `http://127.0.0.1:${mockPort}/v1`,
                api_key: 'mock',
                no_proxy: true,
                no_ssl: false
            }
        ],
        models: [
            {
                alias: 'contract-mock',
                provider_name: 'contract-mock',
                model_name: 'contract-mock',
                model_type: 'chat',
                reasoning_effort: ''
            }
        ],
        default_model: 'contract-mock',
        locale: 'zh-CN'
    })
);

const mock = await startMockModel(mockPort);
const server = spawn(cliPath, ['--config-directory', configDir, 'serve', '--port', String(port)], {
    env: gitEnv,
    stdio: ['ignore', 'ignore', 'pipe']
});
let serverStderr = '';
server.stderr.on('data', (chunk) => (serverStderr = (serverStderr + chunk).slice(-4000)));

const directory = `directory=${encodeURIComponent(workspace)}`;
const withDirectory = (url) => `${url}${url.includes('?') ? '&' : '?'}${directory}`;
const events = [];
const eventStream = new AbortController();
const results = [];

async function step(name, fn) {
    const started = Date.now();
    try {
        await fn();
        results.push({ name, ok: true });
        console.log(`✔ ${name} (${Date.now() - started}ms)`);
    } catch (error) {
        results.push({ name, ok: false, error: String(error?.message ?? error) });
        console.log(`✘ ${name}\n  ${String(error?.message ?? error)}`);
    }
}

/** 调用端点并按规范校验 200 响应，返回解析后的响应体 */
async function call(method, specPath, url, body) {
    const response = await fetch(base + withDirectory(url), {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    assert(response.status === 200, `HTTP ${response.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    const validate = responseValidator(method, specPath);
    assert(validate(json), describeErrors(validate.errors));
    return json;
}

try {
    await step('serve becomes healthy', async () => {
        for (let attempt = 0; attempt < 120; attempt += 1) {
            const healthy = await fetch(`${base}/global/health`)
                .then((response) => response.ok)
                .catch(() => false);
            if (healthy) return;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error(`server did not start:\n${serverStderr}`);
    });

    void (async () => {
        const response = await fetch(`${base}/event?${directory}`, { signal: eventStream.signal });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            for (let index = buffer.indexOf('\n\n'); index >= 0; index = buffer.indexOf('\n\n')) {
                const data = buffer.slice(0, index).match(/^data: (.*)$/m)?.[1];
                buffer = buffer.slice(index + 2);
                if (!data) continue;
                const event = JSON.parse(data);
                events.push(event);
                // 写文件等工具会请求权限，测试里统一批准一次
                if (event.type === 'permission.asked') {
                    void fetch(`${base}/permission/${event.properties.id}/reply?${directory}`, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ reply: 'once' })
                    });
                }
            }
        }
    })().catch(() => undefined);

    for (const specPath of [
        '/config',
        '/config/providers',
        '/global/config',
        '/global/health',
        '/provider',
        '/mcp',
        '/permission',
        '/question',
        '/skill',
        '/session',
        '/session/status',
        '/experimental/session',
        '/experimental/console',
        '/lsp',
        '/formatter',
        '/experimental/resource',
        '/experimental/worktree',
        '/experimental/workspace',
        '/experimental/workspace/status'
    ]) {
        await step(`GET ${specPath}`, () => call('GET', specPath, specPath));
    }

    await step('GET /path', async () => {
        const paths = await call('GET', '/path', '/path');
        assert(paths.config === configDir && paths.state === configDir, JSON.stringify(paths));
        assert(paths.directory === workspace && paths.worktree === workspace, JSON.stringify(paths));
    });
    await step('GET /find', async () => {
        const matches = await call('GET', '/find', '/find?pattern=contract%20needle');
        assert(matches.length === 1 && matches[0].path.text === 'notes.md', JSON.stringify(matches));
        assert(matches[0].line_number === 2 && matches[0].submatches[0].start === 4, JSON.stringify(matches[0]));
    });
    await step('GET /find/file', async () => {
        const files = await call('GET', '/find/file', '/find/file?query=notes');
        assert(files[0] === 'notes.md', JSON.stringify(files));
    });
    await step('GET /find/symbol', () => call('GET', '/find/symbol', '/find/symbol?query=anything'));
    await step('POST /experimental/workspace/sync-list', async () => {
        const response = await fetch(base + withDirectory('/experimental/workspace/sync-list'), { method: 'POST' });
        assert(response.status === 204 && (await response.text()) === '', `HTTP ${response.status}`);
    });
    await step('POST /instance/dispose', () => call('POST', '/instance/dispose', '/instance/dispose'));
    await step('POST /global/dispose', () => call('POST', '/global/dispose', '/global/dispose'));

    await step('GET /agent', async () => {
        const agents = await call('GET', '/agent', '/agent');
        assert(
            agents.some((agent) => agent.name === 'main' && agent.mode === 'primary'),
            'main agent missing'
        );
    });
    await step('GET /command', async () => {
        const commands = await call('GET', '/command', '/command');
        assert(
            commands.every((command) => command.source === 'skill'),
            'commands should come from skills'
        );
    });
    await step('GET /project/current', async () => {
        const project = await call('GET', '/project/current', '/project/current');
        assert(project.worktree === workspace && project.vcs === 'git', JSON.stringify(project));
    });
    await step('GET /vcs', async () => {
        const vcs = await call('GET', '/vcs', '/vcs');
        assert(vcs.branch === 'feature' && vcs.default_branch === 'main', JSON.stringify(vcs));
    });
    await step('GET /provider/auth', async () => {
        const auth = await call('GET', '/provider/auth', '/provider/auth');
        assert(auth['contract-mock']?.[0]?.label === 'API key', JSON.stringify(auth));
    });

    let sessionID;
    let forkID;
    await step('POST /session', async () => {
        sessionID = (await call('POST', '/session', '/session', {})).id;
    });
    const sessionPath = (suffix = '') => `/session/${sessionID}${suffix}`;
    await step('GET /session/{sessionID}', () => call('GET', '/session/{sessionID}', sessionPath()));
    await step('PATCH /session/{sessionID}', () =>
        call('PATCH', '/session/{sessionID}', sessionPath(), { title: 'contract' })
    );
    await step('POST /session/{sessionID}/message', () =>
        call('POST', '/session/{sessionID}/message', sessionPath('/message'), {
            parts: [{ type: 'text', text: 'hello' }]
        })
    );
    await step('GET /session/{sessionID}/message (user and assistant)', async () => {
        const messages = await call('GET', '/session/{sessionID}/message', sessionPath('/message'));
        const roles = messages.map((message) => message.info.role);
        assert(roles.includes('user') && roles.includes('assistant'), `roles: ${roles.join(',')}`);
        for (const message of messages) {
            await call('GET', '/session/{sessionID}/message/{messageID}', sessionPath(`/message/${message.info.id}`));
        }
    });
    await step('GET /session/{sessionID}/children', () =>
        call('GET', '/session/{sessionID}/children', sessionPath('/children'))
    );
    await step('POST /session/{sessionID}/message (todo and file tools)', async () => {
        await call('POST', '/session/{sessionID}/message', sessionPath('/message'), {
            parts: [{ type: 'text', text: `${TOOLS_MARKER} write the contract file` }]
        });
        assert(fs.existsSync(path.join(workspace, CONTRACT_FILE)), 'writeFile did not run');
    });
    await step('GET /session/{sessionID}/todo', async () => {
        const todos = await call('GET', '/session/{sessionID}/todo', sessionPath('/todo'));
        assert(todos.length === 1 && todos[0].content === 'contract todo', JSON.stringify(todos));
    });
    await step('GET /session/{sessionID}/diff (session and per turn)', async () => {
        const diff = await call('GET', '/session/{sessionID}/diff', sessionPath('/diff'));
        const file = diff.find((entry) => entry.file === CONTRACT_FILE);
        assert(
            file?.status === 'added' && file.additions === 1 && file.patch.includes('+written'),
            JSON.stringify(diff)
        );
        const userIDs = (await call('GET', '/session/{sessionID}/message', sessionPath('/message')))
            .filter((message) => message.info.role === 'user')
            .map((message) => message.info.id);
        const firstTurn = await call('GET', '/session/{sessionID}/diff', sessionPath(`/diff?messageID=${userIDs[0]}`));
        const toolsTurn = await call('GET', '/session/{sessionID}/diff', sessionPath(`/diff?messageID=${userIDs[1]}`));
        assert(firstTurn.length === 0, JSON.stringify(firstTurn));
        assert(
            toolsTurn.some((entry) => entry.file === CONTRACT_FILE),
            JSON.stringify(toolsTurn)
        );
    });
    await step('POST /session/{sessionID}/prompt_async', async () => {
        const response = await fetch(base + withDirectory(sessionPath('/prompt_async')), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ parts: [{ type: 'text', text: 'again' }] })
        });
        assert(response.status === 204, `HTTP ${response.status}`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
    });
    await step('POST /session/{sessionID}/abort', () =>
        call('POST', '/session/{sessionID}/abort', sessionPath('/abort'))
    );
    await step('POST /session/{sessionID}/fork', async () => {
        forkID = (await call('POST', '/session/{sessionID}/fork', sessionPath('/fork'), {})).id;
    });
    await step('DELETE /session/{sessionID}/message/{messageID}', async () => {
        const messages = await call('GET', '/session/{sessionID}/message', `/session/${forkID}/message`);
        const messageID = messages.at(-1).info.id;
        await call('DELETE', '/session/{sessionID}/message/{messageID}', `/session/${forkID}/message/${messageID}`);
        const remaining = await call('GET', '/session/{sessionID}/message', `/session/${forkID}/message`);
        assert(!remaining.some((message) => message.info.id === messageID), 'message still listed');
    });
    await step('DELETE /session/{sessionID}', () => call('DELETE', '/session/{sessionID}', `/session/${forkID}`));

    await step('events match the opencode Event schema', async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const validate = ajv.compile({ $ref: 'opencode#/components/schemas/Event' });
        const invalid = new Map();
        const known = new Set();
        for (const event of events) {
            if (KNOWN_NON_SPEC_EVENTS.has(event.type)) {
                known.add(event.type);
                continue;
            }
            if (!validate(event) && !invalid.has(event.type))
                invalid.set(event.type, JSON.stringify(event).slice(0, 300));
        }
        const types = [...new Set(events.map((event) => event.type))];
        for (const type of [
            'message.updated',
            'message.part.delta',
            'todo.updated',
            'session.diff',
            'message.removed'
        ]) {
            assert(types.includes(type), `no ${type} among ${types.join(', ')}`);
        }
        const diffEvent = events.findLast((event) => event.type === 'session.diff');
        assert(
            diffEvent.properties.diff.some((entry) => entry.file === CONTRACT_FILE),
            `session.diff without ${CONTRACT_FILE}`
        );
        if (known.size) console.log(`  known non-spec events: ${[...known].join(', ')}`);
        assert(invalid.size === 0, [...invalid].map(([type, sample]) => `${type}: ${sample}`).join('\n  '));
    });
} finally {
    eventStream.abort();
    // 等服务端退出后再清理，避免它退出前写入数据目录导致删除失败
    const exited =
        server.exitCode !== null ? Promise.resolve() : new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await exited;
    await mock.close();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
    const failed = results.filter((result) => !result.ok).length;
    console.log(`\n${results.length - failed}/${results.length} steps passed`);
    process.exitCode = failed ? 1 : 0;
}
