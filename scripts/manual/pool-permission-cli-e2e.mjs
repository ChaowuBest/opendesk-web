#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { TUIPermissionPromptProvider } from '../../src/main/tui/components/permission.ts';

const PROMPT_TIMEOUT_MS = 2_000;
const POLL_MS = 25;

const results = [];
let tempRoot;

main().catch(async (error) => {
    console.error(error.stack || error.message || String(error));
    await cleanup();
    process.exit(1);
});

async function main() {
    tempRoot = path.join(
        os.homedir(),
        `.opendesk-pool-permission-cli-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    await fs.mkdir(tempRoot, { recursive: true });
    console.log(`Manual CLI pool permission E2E temp root: ${tempRoot}`);

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
    await runScenario('stopping queued child keeps current prompt focused', scenarioStopQueuedChildKeepsFocus);
    await runScenario('stopping one child clears its prompt and advances queue', scenarioStopChild);
    await runScenario('stopping parent clears queued prompts', scenarioStopParent);

    await cleanup();
    printSummary();

    const failed = results.some((result) => result.status === 'FAIL');
    process.exit(failed ? 1 : 0);
}

async function runScenario(name, fn) {
    console.log(`\n[RUN] ${name}`);
    try {
        await fn();
    } catch (error) {
        record(name, 'FAIL', error.message || String(error));
    }
}

async function scenarioOneTimeAllowDuplicate() {
    const same = await fixtureFile('allow-duplicate/same.txt', 'same');
    const harness = createHarness();
    const first = harness.prompt(same, 'child-1', 'Child 1');
    const second = harness.prompt(same, 'child-2', 'Child 2');

    await harness.waitForPrompt((prompt) => prompt.path === same);

    harness.respond({ decision: 'allow', rememberScope: 'none' });
    await expectResolved(first, (response) => response.decision === 'allow');

    const secondPrompt = await harness.waitForPrompt((prompt) => prompt.path === same);
    if (secondPrompt.path !== same) {
        throw new Error(`Expected second duplicate prompt for ${same}, got ${secondPrompt.path || 'none'}.`);
    }

    harness.respond({ decision: 'deny', rememberScope: 'none', denyReason: 'user_denied' });
    await expectResolved(second, (response) => response.decision === 'deny');
    record(
        'one-time allow keeps duplicate queued request visible',
        'PASS',
        'Second duplicate prompt stayed visible after one-time allow.'
    );
}

async function scenarioOneTimeDenyDuplicate() {
    const same = await fixtureFile('deny-duplicate/same.txt', 'same');
    const harness = createHarness();
    const first = harness.prompt(same, 'child-1', 'Child 1');
    const second = harness.prompt(same, 'child-2', 'Child 2');

    await harness.waitForPrompt((prompt) => prompt.path === same);
    harness.respond({ decision: 'deny', rememberScope: 'none', denyReason: 'user_denied' });
    await expectResolved(first, (response) => response.decision === 'deny');

    const secondPrompt = await harness.waitForPrompt((prompt) => prompt.path === same);
    if (secondPrompt.path !== same) {
        throw new Error(`Expected duplicate prompt after deny, got ${secondPrompt.path || 'none'}.`);
    }

    harness.respond({ decision: 'deny', rememberScope: 'none', denyReason: 'user_denied' });
    await expectResolved(second, (response) => response.decision === 'deny');
    record(
        'one-time deny only denies the current duplicate request',
        'PASS',
        'Duplicate request reappeared after one-time deny.'
    );
}

async function scenarioAlwaysAllowExactDuplicate() {
    const same = await fixtureFile('exact-duplicate/same.txt', 'same');
    const harness = createHarness();
    const first = harness.prompt(same, 'child-1', 'Child 1');
    const second = harness.prompt(same, 'child-2', 'Child 2');

    await harness.waitForPrompt((prompt) => prompt.path === same);
    harness.respond({ decision: 'allow', rememberScope: 'prefix', selectedPrefixPattern: same });
    await expectResolved(first, (response) => response.decision === 'allow');
    await expectResolved(second, (response) => response.decision === 'allow');

    const duplicatePrompted = await harness.optionalPrompt((prompt) => prompt.path === same, 250);
    if (duplicatePrompted) {
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
    const harness = createHarness();
    const first = harness.prompt(firstPath, 'child-1', 'Child 1');
    const second = harness.prompt(secondPath, 'child-2', 'Child 2');

    await harness.waitForPrompt((prompt) => prompt.path === firstPath);
    harness.respond({ decision: 'allow', rememberScope: 'prefix', selectedPrefixPattern: firstPath });
    await expectResolved(first, (response) => response.decision === 'allow');

    const otherPrompt = await harness.waitForPrompt((prompt) => prompt.path === secondPath);
    harness.respond({ decision: 'deny', rememberScope: 'none', denyReason: 'user_denied' });
    await expectResolved(second, (response) => response.decision === 'deny');

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
    const harness = createHarness();
    const first = harness.prompt(a, 'child-1', 'Child 1');
    const second = harness.prompt(b, 'child-2', 'Child 2');
    const third = harness.prompt(c, 'child-3', 'Child 3');

    await harness.waitForPrompt((prompt) => prompt.path === a);
    harness.respond({ decision: 'allow', rememberScope: 'prefix', selectedPrefixPattern: `${dir}/**` });
    await expectResolved(first, (response) => response.decision === 'allow');
    await expectResolved(second, (response) => response.decision === 'allow');
    await expectResolved(third, (response) => response.decision === 'allow');

    const coveredPrompt = await harness.optionalPrompt((prompt) => prompt.path.startsWith(`${dir}/`), 250);
    if (coveredPrompt) {
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
    const harness = createHarness();
    const first = harness.prompt(left, 'child-1', 'Child 1');
    const second = harness.prompt(right, 'child-2', 'Child 2');

    await harness.waitForPrompt((prompt) => prompt.path === left);
    harness.respond({ decision: 'allow', rememberScope: 'prefix', selectedPrefixPattern: `${parent}/**` });
    await expectResolved(first, (response) => response.decision === 'allow');
    await expectResolved(second, (response) => response.decision === 'allow');

    const coveredPrompt = await harness.optionalPrompt((prompt) => prompt.path.startsWith(`${parent}/`), 250);
    if (coveredPrompt) {
        throw new Error(`Parent directory persistent allow did not cover queued sibling: ${coveredPrompt.path}`);
    }

    record(
        'always allow parent directory covers sibling queued requests',
        'PASS',
        'Queued sibling request was auto-resolved by parent directory allow.'
    );
}

async function scenarioStopChild() {
    const firstPath = await fixtureFile('stop-child/first.txt', 'first');
    const secondPath = await fixtureFile('stop-child/second.txt', 'second');
    const harness = createHarness();
    const first = harness.prompt(firstPath, 'child-1', 'Child 1');
    const second = harness.prompt(secondPath, 'child-2', 'Child 2');

    await harness.waitForPrompt((prompt) => prompt.path === firstPath);
    harness.provider.cancelTaskPrompts(['child-1']);
    await expectResolved(first, (response) => response.decision === 'deny' && response.denyReason === 'task_stopped');

    await harness.waitForPrompt((prompt) => prompt.path === secondPath);
    harness.respond({ decision: 'deny', rememberScope: 'none', denyReason: 'user_denied' });
    await expectResolved(second, (response) => response.decision === 'deny');
    record(
        'stopping one child clears its prompt and advances queue',
        'PASS',
        'Queue advanced from the stopped child to the next queued child.'
    );
}

async function scenarioStopQueuedChildKeepsFocus() {
    const firstPath = await fixtureFile('stop-queued-child/first.txt', 'first');
    const secondPath = await fixtureFile('stop-queued-child/second.txt', 'second');
    const harness = createHarness();
    const first = harness.prompt(firstPath, 'child-1', 'Child 1');
    const second = harness.prompt(secondPath, 'child-2', 'Child 2');

    const currentPrompt = await harness.waitForPrompt((prompt) => prompt.path === firstPath);
    harness.provider.cancelTaskPrompts(['child-2']);
    await expectResolved(second, (response) => response.decision === 'deny' && response.denyReason === 'task_stopped');

    const stillVisible = harness.currentPrompt();
    if (!stillVisible || stillVisible.path !== firstPath) {
        throw new Error('Current prompt was hidden when only a queued child was stopped.');
    }
    if (harness.focusTarget() !== currentPrompt.widget.getSelectList()) {
        throw new Error('Current prompt lost focus when only a queued child was stopped.');
    }

    harness.respond({ decision: 'allow', rememberScope: 'none' });
    await expectResolved(first, (response) => response.decision === 'allow');
    record(
        'stopping queued child keeps current prompt focused',
        'PASS',
        'Queued child stop did not steal focus from the visible prompt.'
    );
}

async function scenarioStopParent() {
    const firstPath = await fixtureFile('stop-parent/first.txt', 'first');
    const secondPath = await fixtureFile('stop-parent/second.txt', 'second');
    const harness = createHarness();
    const first = harness.prompt(firstPath, 'child-1', 'Child 1');
    const second = harness.prompt(secondPath, 'child-2', 'Child 2');

    await harness.waitForPrompt((prompt) => [firstPath, secondPath].includes(prompt.path));
    harness.provider.cancelTaskPrompts(['parent']);
    await expectResolved(first, (response) => response.decision === 'deny' && response.denyReason === 'task_stopped');
    await expectResolved(second, (response) => response.decision === 'deny' && response.denyReason === 'task_stopped');

    const prompt = await harness.optionalPrompt(() => true, 250);
    if (prompt) {
        throw new Error(`Prompt remained visible after parent stop: ${prompt.path}`);
    }

    record('stopping parent clears queued prompts', 'PASS', 'Parent stop cleared visible permission prompt.');
}

function createHarness() {
    const inputArea = {
        input: {},
        widget: null,
        showPermissionPrompt(widget) {
            this.widget = widget;
        },
        hidePermissionPrompt() {
            this.widget = null;
        }
    };
    let focusTarget = null;
    const fakeTui = {
        activeTaskId: 'parent',
        inputArea,
        tui: {
            setFocus(target) {
                focusTarget = target;
            },
            requestRender() {}
        },
        isInputBlocked() {
            return false;
        }
    };
    const provider = new TUIPermissionPromptProvider(fakeTui);

    return {
        provider,
        prompt(resourcePath, sourceTaskId, sourceTaskName) {
            return provider.prompt([readRequest(resourcePath)], 'readFile', prefixOptions(resourcePath), {
                taskId: 'parent',
                taskName: 'Parent',
                sourceTaskId,
                sourceTaskName,
                parentTaskId: 'parent'
            });
        },
        currentPrompt() {
            if (!inputArea.widget) return null;
            const widget = inputArea.widget;
            const renderedText = widget.render(100).join('\n');
            return {
                path: widget.rawPaths?.[0] ?? null,
                text: renderedText,
                widget
            };
        },
        respond(response) {
            if (!inputArea.widget?.onDone) {
                throw new Error('No visible CLI permission prompt to respond to.');
            }
            inputArea.widget.onDone(response);
        },
        focusTarget() {
            return focusTarget;
        },
        waitForPrompt(predicate, timeoutMs = PROMPT_TIMEOUT_MS) {
            return waitForPrompt(this, predicate, timeoutMs);
        },
        optionalPrompt(predicate, timeoutMs) {
            return optionalPrompt(this, predicate, timeoutMs);
        }
    };
}

function readRequest(resourcePath) {
    return { resourceType: 'file', action: 'read', resourcePath };
}

function prefixOptions(resourcePath) {
    const dir = path.dirname(resourcePath);
    const parent = path.dirname(dir);
    return [
        { label: resourcePath, pattern: resourcePath },
        { label: dir, pattern: `${dir}/**` },
        { label: parent, pattern: `${parent}/**` }
    ];
}

async function waitForPrompt(harness, predicate, timeoutMs) {
    const started = Date.now();
    let lastPrompt = null;
    while (Date.now() - started < timeoutMs) {
        const prompt = harness.currentPrompt();
        if (prompt) {
            lastPrompt = prompt;
            if (!predicate || predicate(prompt)) {
                return prompt;
            }
        }
        await delay(POLL_MS);
    }
    const last = lastPrompt ? JSON.stringify({ path: lastPrompt.path, text: lastPrompt.text }) : 'none';
    throw new Error(`Timed out waiting for CLI permission prompt; last prompt: ${last}`);
}

async function optionalPrompt(harness, predicate, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const prompt = harness.currentPrompt();
        if (prompt && (!predicate || predicate(prompt))) {
            return prompt;
        }
        await delay(POLL_MS);
    }
    return null;
}

async function expectResolved(promise, predicate) {
    const response = await promise;
    if (!predicate(response)) {
        throw new Error(`Unexpected permission response: ${JSON.stringify(response)}`);
    }
    return response;
}

async function fixtureFile(relativePath, contents) {
    const filePath = path.join(tempRoot, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents, 'utf8');
    return filePath;
}

async function cleanup() {
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
    console.log('\nManual CLI pool permission E2E summary');
    for (const result of results) {
        console.log(`${result.status.padEnd(4)} ${result.name}${result.details ? ` :: ${result.details}` : ''}`);
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
