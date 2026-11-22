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
 * opencode 协议契约测试：启动 `opendesk serve`（模型用 genui-mock-llm.mjs 的桩），
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
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockLlm } from './genui-mock-llm.mjs';

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

const mock = await startMockLlm({ port: mockPort, host: '127.0.0.1' });
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
                if (data) events.push(JSON.parse(data));
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
        '/path',
        '/permission',
        '/question',
        '/skill',
        '/session',
        '/session/status',
        '/experimental/session',
        '/experimental/console'
    ]) {
        await step(`GET ${specPath}`, () => call('GET', specPath, specPath));
    }

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
        assert(types.includes('message.updated'), `no message.updated among ${types.join(', ')}`);
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
