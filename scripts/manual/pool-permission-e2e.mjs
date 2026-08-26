#!/usr/bin/env node

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

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_DEVTOOLS_URL = 'http://127.0.0.1:9283/json/list';
const PROMPT_TIMEOUT_MS = 90_000;
const POLL_MS = 500;

const args = parseArgs(process.argv.slice(2));
const devtoolsUrl = args.devtools || process.env.OPENDESK_DEVTOOLS_URL || DEFAULT_DEVTOOLS_URL;
const includeTimeout = args['include-timeout'] === true;

const results = [];
const createdTaskIds = new Set();
let tempRoot;
let page;

main().catch(async (error) => {
    console.error(error.stack || error.message || String(error));
    await cleanup();
    process.exit(1);
});

async function main() {
    page = await connectToElectron(devtoolsUrl);
    await ensureNoExistingPrompt();

    tempRoot = path.join(
        os.homedir(),
        `.opendesk-pool-permission-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    await fs.mkdir(tempRoot, { recursive: true });
    console.log(`Manual pool permission E2E temp root: ${tempRoot}`);

    await runScenario('one-time allow keeps duplicate queued request visible', scenarioOneTimeAllowDuplicate);
    await runScenario('one-time deny only denies the current duplicate request', scenarioOneTimeDenyDuplicate);
    await runScenario(
        'always allow exact file auto-resolves duplicate queued requests',
        scenarioAlwaysAllowExactDuplicate
    );
    await runScenario(
        'always allow exact file does not cover a different file',
        scenarioAlwaysAllowExactDoesNotCoverOther
    );
    await runScenario('always allow directory covers queued descendants', scenarioAlwaysAllowDirectory);
    await runScenario(
        'always allow parent directory covers sibling queued requests',
        scenarioAlwaysAllowParentDirectory
    );
    await runScenario(
        'always allow all reads still yields explicit sensitive ask',
        scenarioAllowTypeSensitiveAskPriority
    );
    await runScenario('stopping one child clears its prompt and advances queue', scenarioStopChild);
    await runScenario('stopping parent clears queued prompts', scenarioStopParent);

    if (includeTimeout) {
        await runScenario('current prompt timeout advances queue', scenarioTimeout);
    } else {
        record(
            'current prompt timeout advances queue',
            'SKIP',
            'Use --include-timeout to run the real 300s timeout path.'
        );
    }

    await cleanup();
    printSummary();

    const failed = results.some((result) => result.status === 'FAIL');
    process.exit(failed ? 1 : 0);
}

async function runScenario(name, fn) {
    console.log(`\n[RUN] ${name}`);
    const beforeTasks = new Set(createdTaskIds);
    try {
        await fn();
    } catch (error) {
        record(name, 'FAIL', error.message || String(error));
    } finally {
        for (const taskId of createdTaskIds) {
            if (!beforeTasks.has(taskId)) {
                await stopTaskQuietly(taskId);
            }
        }
        await delay(1_000);
    }
}

async function scenarioOneTimeAllowDuplicate() {
    const same = await fixtureFile('allow-duplicate/same.txt', 'same');
    const taskId = await createPoolReadTask([same, same], 'one-time allow duplicate');
    const first = await waitForPrompt(taskId, (prompt) => prompt.path === same);

    assertPromptHasSource(first);
    await clickPrompt(taskId, 'allow');

    const second = await waitForPrompt(
        taskId,
        (prompt) => prompt.path === same && prompt.requestId !== first.requestId,
        10_000
    );
    await delay(350);
    const stillVisible = await getPrompt(taskId);

    if (!stillVisible || stillVisible.requestId !== second.requestId) {
        throw new Error('The second duplicate prompt disappeared during the renderer hide delay window.');
    }

    await clickPrompt(taskId, 'deny');
    record(
        'one-time allow keeps duplicate queued request visible',
        'PASS',
        'Second duplicate prompt stayed visible after one-time allow.'
    );
}

async function scenarioOneTimeDenyDuplicate() {
    const same = await fixtureFile('deny-duplicate/same.txt', 'same');
    const taskId = await createPoolReadTask([same, same], 'one-time deny duplicate');
    const first = await waitForPrompt(taskId, (prompt) => prompt.path === same);

    await clickPrompt(taskId, 'deny');
    const second = await waitForPrompt(
        taskId,
        (prompt) => prompt.path === same && prompt.requestId !== first.requestId,
        10_000
    );
    assertPromptHasSource(second);

    await clickPrompt(taskId, 'deny');
    record(
        'one-time deny only denies the current duplicate request',
        'PASS',
        'Duplicate request reappeared after one-time deny.'
    );
}

async function scenarioAlwaysAllowExactDuplicate() {
    const same = await fixtureFile('exact-duplicate/same.txt', 'same');
    const taskId = await createPoolReadTask([same, same], 'exact duplicate');
    const prompt = await waitForPrompt(taskId, (current) => current.path === same);

    await clickPrefix(taskId, prompt.path);
    const duplicatePrompted = await waitForOptionalPrompt(
        taskId,
        (current) => current.requestId !== prompt.requestId && current.path === same,
        6_000
    );

    if (duplicatePrompted) {
        await clickPrompt(taskId, 'deny');
        throw new Error('A queued identical file request prompted again after exact persistent allow.');
    }

    record(
        'always allow exact file auto-resolves duplicate queued requests',
        'PASS',
        'Queued duplicate was resolved without a second prompt.'
    );
}

async function scenarioAlwaysAllowExactDoesNotCoverOther() {
    const firstPath = await fixtureFile('exact-other/first.txt', 'first');
    const secondPath = await fixtureFile('exact-other/second.txt', 'second');
    const taskId = await createPoolReadTask([firstPath, secondPath], 'exact does not cover other');
    const firstPrompt = await waitForPrompt(taskId, (current) => [firstPath, secondPath].includes(current.path));
    const otherPath = firstPrompt.path === firstPath ? secondPath : firstPath;

    await clickPrefix(taskId, firstPrompt.path);
    const otherPrompt = await waitForPrompt(
        taskId,
        (current) => current.requestId !== firstPrompt.requestId && current.path === otherPath,
        12_000
    );

    await clickPrompt(taskId, 'deny');
    record(
        'always allow exact file does not cover a different file',
        'PASS',
        `Different file still prompted: ${otherPrompt.path}`
    );
}

async function scenarioAlwaysAllowDirectory() {
    const dir = path.join(tempRoot, 'directory-cover');
    const a = await fixtureFile('directory-cover/a.txt', 'a');
    const b = await fixtureFile('directory-cover/b.txt', 'b');
    const c = await fixtureFile('directory-cover/sub/c.txt', 'c');
    const taskId = await createPoolReadTask([a, b, c], 'directory cover');
    const first = await waitForPrompt(taskId, (current) => [a, b, c].includes(current.path));

    await clickPrefix(taskId, `${dir}/**`);
    const coveredPrompt = await waitForOptionalPrompt(
        taskId,
        (current) => current.requestId !== first.requestId && current.path.startsWith(`${dir}/`),
        8_000
    );

    if (coveredPrompt) {
        await clickPrompt(taskId, 'deny');
        throw new Error(`Directory persistent allow did not cover queued descendant: ${coveredPrompt.path}`);
    }

    record(
        'always allow directory covers queued descendants',
        'PASS',
        'Queued descendant requests were auto-resolved.'
    );
}

async function scenarioAlwaysAllowParentDirectory() {
    const left = await fixtureFile('parent-cover/left/a.txt', 'left');
    const right = await fixtureFile('parent-cover/right/b.txt', 'right');
    const parent = path.join(tempRoot, 'parent-cover');
    const taskId = await createPoolReadTask([left, right], 'parent directory cover');
    const first = await waitForPrompt(taskId, (current) => [left, right].includes(current.path));

    await clickPrefix(taskId, `${parent}/**`);
    const coveredPrompt = await waitForOptionalPrompt(
        taskId,
        (current) => current.requestId !== first.requestId && current.path.startsWith(`${parent}/`),
        8_000
    );

    if (coveredPrompt) {
        await clickPrompt(taskId, 'deny');
        throw new Error(`Parent directory persistent allow did not cover queued sibling: ${coveredPrompt.path}`);
    }

    record(
        'always allow parent directory covers sibling queued requests',
        'PASS',
        'Queued sibling request was auto-resolved by parent directory allow.'
    );
}

async function scenarioAllowTypeSensitiveAskPriority() {
    const normal = await fixtureFile('allow-type/normal.txt', 'normal');
    const sensitive = await fixtureFile('allow-type/.env', 'OPENDESK_E2E_FAKE_SECRET=1');
    const taskId = await createSequentialReadPoolTask(normal, sensitive, 'allow type ask priority');
    await waitForPrompt(taskId, (current) => current.path === normal);

    await clickPrompt(taskId, 'allow_type');
    const sensitivePrompt = await waitForPrompt(taskId, (current) => current.path === sensitive, 45_000);
    assertPromptHasSource(sensitivePrompt);

    await clickPrompt(taskId, 'deny');
    record(
        'always allow all reads still yields explicit sensitive ask',
        'PASS',
        'Sensitive .env path still prompted after allow-all-read in the same child.'
    );
}

async function scenarioStopChild() {
    const firstPath = await fixtureFile('stop-child/first.txt', 'first');
    const secondPath = await fixtureFile('stop-child/second.txt', 'second');
    const taskId = await createPoolReadTask([firstPath, secondPath], 'stop child');
    const firstPrompt = await waitForPrompt(taskId, (current) => [firstPath, secondPath].includes(current.path));

    if (!firstPrompt.sourceTaskId) {
        throw new Error('Prompt did not include sourceTaskId, so child stop cleanup cannot be verified.');
    }

    await stopTask(firstPrompt.sourceTaskId);
    const nextPrompt = await waitForPrompt(
        taskId,
        (current) => current.sourceTaskId && current.sourceTaskId !== firstPrompt.sourceTaskId,
        15_000
    );

    await clickPrompt(taskId, 'deny');
    record(
        'stopping one child clears its prompt and advances queue',
        'PASS',
        `Queue advanced from ${firstPrompt.sourceTaskId} to ${nextPrompt.sourceTaskId}.`
    );
}

async function scenarioStopParent() {
    const firstPath = await fixtureFile('stop-parent/first.txt', 'first');
    const secondPath = await fixtureFile('stop-parent/second.txt', 'second');
    const taskId = await createPoolReadTask([firstPath, secondPath], 'stop parent');

    await waitForPrompt(taskId, (current) => [firstPath, secondPath].includes(current.path));
    await stopTask(taskId);
    await delay(1_500);

    const prompt = await getPrompt(taskId);
    if (prompt) {
        throw new Error(`Prompt remained visible after parent stop: ${prompt.path}`);
    }

    record('stopping parent clears queued prompts', 'PASS', 'Parent stop cleared visible permission prompt.');
}

async function scenarioTimeout() {
    const firstPath = await fixtureFile('timeout/first.txt', 'first');
    const secondPath = await fixtureFile('timeout/second.txt', 'second');
    const taskId = await createPoolReadTask([firstPath, secondPath], 'timeout');
    const first = await waitForPrompt(taskId, (current) => [firstPath, secondPath].includes(current.path));

    const next = await waitForPrompt(taskId, (current) => current.requestId !== first.requestId, 330_000);

    await clickPrompt(taskId, 'deny');
    record('current prompt timeout advances queue', 'PASS', `Prompt advanced after timeout to ${next.path}.`);
}

async function createPoolReadTask(paths, label) {
    const instructions = paths
        .map((filePath, index) => `- 子任务${index + 1}只调用 readFile 读取这个绝对路径：${filePath}`)
        .join('\n');
    const message = [
        `/pool 创建${paths.length}个子任务并行执行。\n`,
        '公共要求：每个子任务只做自己的 readFile 调用，然后用一句话报告成功或失败；不要调用其它工具；不要重试。\n',
        instructions,
        `\n配置：concurrency=${paths.length}，maxRetries=0。\n测试标签：${label}。`
    ].join('');

    return createTaskAndSubmit(message);
}

async function createSequentialReadPoolTask(firstPath, secondPath, label) {
    const message = [
        '/pool 创建1个子任务执行。\n',
        `这个子任务先调用 readFile 读取绝对路径：${firstPath}\n`,
        `第一步结束后继续调用 readFile 读取绝对路径：${secondPath}\n`,
        '只做这两个 readFile 调用，然后报告结果；不要调用其它工具；不要重试。\n',
        `配置：concurrency=1，maxRetries=0。\n测试标签：${label}。`
    ].join('');

    return createTaskAndSubmit(message);
}

async function createTaskAndSubmit(message) {
    const taskId = await page.evaluate(
        `(async () => {
      const taskId = await window.taskManagerAPI.createTask();
      window.globalControlAPI.openTask(taskId);
      await window.taskManagerAPI.submitMessage(taskId, {
        message: ${JSON.stringify(message)},
        attachedFilePaths: [],
        attachedImages: [],
      });
      return taskId;
    })()`
    );
    createdTaskIds.add(taskId);
    return taskId;
}

async function waitForPrompt(taskId, predicate, timeoutMs = PROMPT_TIMEOUT_MS) {
    const started = Date.now();
    let lastPrompt = null;

    while (Date.now() - started < timeoutMs) {
        const prompt = await getPrompt(taskId);
        if (prompt) {
            lastPrompt = prompt;
            if (!predicate || predicate(prompt)) {
                return prompt;
            }
        }
        await delay(POLL_MS);
    }

    const last = lastPrompt ? JSON.stringify(lastPrompt) : 'none';
    throw new Error(`Timed out waiting for permission prompt on ${taskId}; last prompt: ${last}`);
}

async function waitForOptionalPrompt(taskId, predicate, timeoutMs) {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
        const prompt = await getPrompt(taskId);
        if (prompt && (!predicate || predicate(prompt))) {
            return prompt;
        }
        await delay(POLL_MS);
    }

    return null;
}

async function getPrompt(taskId) {
    return page.evaluate(
        `(() => {
      const prompts = Array.from(document.querySelectorAll('permission-prompt'));
      const visible = prompts.find((prompt) => {
        const data = prompt._data;
        if (!data || !prompt._requestId || prompt.style.display === 'none') return false;
        const rect = prompt.getBoundingClientRect();
        return data.taskId === ${JSON.stringify(taskId)} && rect.width > 0 && rect.height > 0;
      });
      if (!visible) return null;
      const data = visible._data;
      const firstRequest = Array.isArray(data.requests) ? data.requests[0] : null;
      return {
        requestId: visible._requestId || null,
        taskId: data.taskId,
        path: firstRequest?.resourcePath || data.path || null,
        operation: firstRequest?.action || data.operation || null,
        toolName: data.toolName,
        sourceTaskId: data.sourceTaskId || null,
        sourceTaskTitle: data.sourceTaskName || data.sourceTaskTitle || null,
        sourceParentTaskId: data.parentTaskId || data.sourceParentTaskId || null,
        prefixOptions: data.prefixOptions || [],
        text: visible.textContent || '',
      };
    })()`
    );
}

async function clickPrompt(taskId, action) {
    return page.evaluate(
        `(() => {
      const prompts = Array.from(document.querySelectorAll('permission-prompt'));
      const prompt = prompts.find((candidate) => candidate._data?.taskId === ${JSON.stringify(taskId)} && candidate._requestId && candidate.style.display !== 'none');
      if (!prompt) throw new Error('No visible permission prompt for task ${taskId}');
      const button = Array.from(prompt.querySelectorAll('button.permission-btn'))
        .find((candidate) => candidate.dataset.action === ${JSON.stringify(action)});
      if (!button) {
        const actions = Array.from(prompt.querySelectorAll('button.permission-btn')).map((candidate) => candidate.dataset.action).join(', ');
        throw new Error('Missing permission button ${action}; available actions: ' + actions);
      }
      const data = prompt._data;
      button.click();
      return { requestId: data.requestId, path: data.path, action: button.dataset.action };
    })()`
    );
}

async function clickPrefix(taskId, pattern) {
    return page.evaluate(
        `(() => {
      const prompts = Array.from(document.querySelectorAll('permission-prompt'));
      const prompt = prompts.find((candidate) => candidate._data?.taskId === ${JSON.stringify(taskId)} && candidate._requestId && candidate.style.display !== 'none');
      if (!prompt) throw new Error('No visible permission prompt for task ${taskId}');
      const buttons = Array.from(prompt.querySelectorAll('button.permission-btn[data-action="prefix"]'));
      const button = buttons.find((candidate) => candidate.dataset.pattern === ${JSON.stringify(pattern)});
      if (!button) {
        const patterns = buttons.map((candidate) => candidate.dataset.pattern).join(', ');
        throw new Error('Missing prefix option ${pattern}; available patterns: ' + patterns);
      }
      const data = prompt._data;
      button.click();
      return { requestId: data.requestId, path: data.path, pattern: button.dataset.pattern };
    })()`
    );
}

function assertPromptHasSource(prompt) {
    if (!prompt.sourceTaskId) {
        throw new Error(`Prompt for ${prompt.path} is missing sourceTaskId.`);
    }

    if (!prompt.text.includes('来自')) {
        throw new Error(`Prompt for ${prompt.path} does not display a child-task source label.`);
    }
}

async function ensureNoExistingPrompt() {
    const prompt = await page.evaluate(
        `(() => {
      const prompts = Array.from(document.querySelectorAll('permission-prompt'));
      const visible = prompts.find((candidate) => candidate._data && candidate._requestId && candidate.style.display !== 'none');
      return visible ? {
        taskId: visible._data.taskId,
        path: visible._data.path,
        sourceTaskId: visible._data.sourceTaskId || null,
      } : null;
    })()`
    );

    if (prompt) {
        throw new Error(`Refusing to start while an existing permission prompt is visible: ${JSON.stringify(prompt)}`);
    }
}

async function fixtureFile(relativePath, contents) {
    const filePath = path.join(tempRoot, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents, 'utf8');
    return filePath;
}

async function stopTask(taskId) {
    await page.evaluate(
        `(async () => {
      await window.taskManagerAPI.stopTask(${JSON.stringify(taskId)});
      return true;
    })()`
    );
}

async function stopTaskQuietly(taskId) {
    try {
        await stopTask(taskId);
    } catch {
        // Best-effort cleanup for manual validation tasks.
    }
}

async function cleanup() {
    if (page) {
        for (const taskId of createdTaskIds) {
            await stopTaskQuietly(taskId);
        }
    }

    if (tempRoot) {
        await fs.rm(tempRoot, { recursive: true, force: true });
        console.log(`Cleaned temp root: ${tempRoot}`);
    }
}

function record(name, status, details) {
    results.push({ name, status, details });
    console.log(`[${status}] ${name}${details ? ` - ${details}` : ''}`);
}

function printSummary() {
    console.log('\nManual pool permission E2E summary');
    for (const result of results) {
        console.log(`${result.status.padEnd(4)} ${result.name}${result.details ? ` :: ${result.details}` : ''}`);
    }
}

async function connectToElectron(url) {
    const targets = await fetch(url).then((response) => {
        if (!response.ok) {
            throw new Error(`DevTools target list failed: ${response.status} ${response.statusText}`);
        }
        return response.json();
    });

    const target = targets.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl);
    if (!target) {
        throw new Error(`No Electron page target found at ${url}`);
    }

    return new DevToolsPage(target.webSocketDebuggerUrl);
}

class DevToolsPage {
    constructor(webSocketUrl) {
        if (typeof WebSocket === 'undefined') {
            throw new Error('This manual E2E script requires a Node.js runtime with global WebSocket support.');
        }

        this.nextId = 1;
        this.pending = new Map();
        this.socket = new WebSocket(webSocketUrl);
        this.ready = new Promise((resolve, reject) => {
            this.socket.addEventListener('open', resolve, { once: true });
            this.socket.addEventListener('error', () => reject(new Error('DevTools WebSocket connection failed')), {
                once: true
            });
        });
        this.socket.addEventListener('message', (message) => {
            const payload = JSON.parse(String(message.data));
            const pending = this.pending.get(payload.id);
            if (!pending) return;
            this.pending.delete(payload.id);
            if (payload.error) {
                pending.reject(new Error(payload.error.message));
            } else {
                pending.resolve(payload.result);
            }
        });
    }

    async evaluate(expression) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true
        });

        if (result.exceptionDetails) {
            const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
            throw new Error(text);
        }

        return result.result.value;
    }

    async send(method, params = {}) {
        await this.ready;
        const id = this.nextId++;
        const payload = { id, method, params };
        const promise = new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });
        this.socket.send(JSON.stringify(payload));
        return promise;
    }
}

function parseArgs(argv) {
    const parsed = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg.startsWith('--')) {
            const name = arg.slice(2);
            const next = argv[index + 1];
            if (!next || next.startsWith('--')) {
                parsed[name] = true;
            } else {
                parsed[name] = next;
                index += 1;
            }
        }
    }
    return parsed;
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
