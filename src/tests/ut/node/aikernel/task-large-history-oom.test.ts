import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import {
    AssistantMessage,
    ChatContext,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../../main/aikernel/states/tasks.js';
import { getTaskDirectory, setCustomOpendeskDirectory } from '../../../../main/utils/setting.js';

/**
 * Issue #341 复现：恢复超大任务历史（issue 中约 384MB、888 次工具调用、363 个图片条目）
 * 后，任务对象把全部消息内容（含 base64 图片、已压缩工具结果的原始 result）常驻内存，
 * 且落盘走 JSON.stringify(task.toJSON(), null, 4) 全量序列化，内存峰值远超文件体积。
 *
 * 本测试用真实类构建与 issue 同构的 fixture（888 次工具调用、363 个图片条目、
 * 212 条已压缩但仍保留原始 result 的工具结果），按等比缩小到 ~130MB，在子进程中
 * 用受限 old-space 实测三条路径（阈值按 fixture 实际体积推导，余量见各断言）：
 *
 * - 恢复路径净驻留 ≈ 0.9× 文件体积（实测 93~96MB / 104.8MB）→ 上界断言 1.15×；
 * - 恢复 + 一次 saveSync 在 2.7× 堆下完成，保存阶段 heap 净增 ≈ 2.4× 文件体积
 *   （实测 254MB / 104.8MB）→ 下界断言 1.5×，钉死全量序列化的放大系数；
 * - 恢复 + 保存管线在 1.25× 堆下必然 V8 OOM（崩溃堆必须高于 tsx 子进程自身的模块
 *   编译地板 ~128MB，同时低于实测需求下界 1.335×，因此 fixture 不能小于 ~100MB；
 *   并用 modules=1 里程碑确保 OOM 发生在任务管线而非模块加载阶段），
 *   崩溃签名与 issue 一致（"...heap out of memory"，实机为 SIGABRT / node::OOMErrorHandler）。
 *
 * 注意：实测两条路径的最小可完成堆几乎重合（~1.35~1.41× 文件体积），且 V8 GC 调度
 * 带随机性（临界点复跑会漂移），因此不做「同堆下恢复存活、保存必崩」的 razor-thin
 * 对照；保存路径的放大系数由第二条断言单独钉死。
 *
 * 修复后本文件的翻转方式：放大系数断言改为显著低于 1.5× 的上界断言，并可在远小于
 * 1.20× 的堆限制下要求整条管线完成。
 */

const TARGET_TOOL_CALLS = 888;
const TARGET_IMAGES = 363; // ≈ 67MB base64，与 issue 观测一致
const REPLACED_RESULTS = 212; // 已有压缩替代文本但原始 result 仍保留在 chat_context 中
const TARGET_FILE_MB = 140; // issue 384MB 的等比缩小版（内存峰值与体积线性相关）
const MIN_FIXTURE_MB = 100; // 低于该值时崩溃堆会撞上 tsx 子进程自身的模块编译地板（~128MB）

const CHILD_SCRIPT_TIMEOUT_MS = 150_000;
const TEST_TIMEOUT_MS = 300_000;

let fixtureDir: string | undefined;
let fixtureFileBytes = 0;

// 子进程回放脚本：与实机一致的恢复（TaskManagerState.load + getTask -> ensureLoaded）
// 与保存（persistLater + saveSync -> JSON.stringify(task.toJSON(), null, 4)）路径。
// heap 上限通过 NODE_OPTIONS 传入（tsx 会把脚本转发到子进程，命令行 flag 不生效）。
const CHILD_REPLAY_SOURCE = `
import { TaskManagerState } from './src/main/aikernel/states/tasks.ts';
import { setCustomOpendeskDirectory } from './src/main/utils/setting.ts';

// fixture 目录由环境变量传入（纯路径，setCustomOpendeskDirectory 内部自行 resolve）
console.error('MILESTONE modules=1');
setCustomOpendeskDirectory(process.env.REPLAY_FIXTURE_DIR);

function heapMB() {
    return Math.round(process.memoryUsage().heapUsed / 1048576);
}
const before = heapMB();
const manager = TaskManagerState.load();
if (!manager) throw new Error('no task manager state');
const task = manager.getTask('issue341-large');
if (!task) throw new Error('task missing after restore');
console.error('MILESTONE restore_growth_mb=' + (heapMB() - before));

if (process.env.REPLAY_PHASE === 'save') {
    task.task_name = (task.task_name ?? '') + ' r';
    task.persistLater();
    const t0 = Date.now();
    manager.saveSync();
    console.error('MILESTONE save_heap_mb=' + heapMB() + ' save_ms=' + (Date.now() - t0));
}
console.error('MILESTONE done=1');
`;

interface ChildRunResult {
    status: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    stdout: string;
    milestones: Record<string, number>;
}

function runReplayChild(phase: 'restore' | 'save', heapMB: number): ChildRunResult {
    const repositoryRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
    const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--import', './src/tests/test-env.ts', '--input-type=module', '-'],
        {
            cwd: repositoryRoot,
            input: CHILD_REPLAY_SOURCE,
            encoding: 'utf8',
            timeout: CHILD_SCRIPT_TIMEOUT_MS,
            env: {
                ...process.env,
                NODE_OPTIONS: `--max-old-space-size=${heapMB}`,
                REPLAY_FIXTURE_DIR: fixtureDir!,
                REPLAY_PHASE: phase
            }
        }
    );
    const milestones: Record<string, number> = {};
    for (const match of `${child.stdout}\n${child.stderr}`.matchAll(/MILESTONE (\w+)=(-?\d+)/g)) {
        milestones[match[1]] = Number(match[2]);
    }
    return {
        status: child.status,
        signal: child.signal ?? null,
        stderr: child.stderr ?? '',
        stdout: child.stdout ?? '',
        milestones
    };
}

function fixtureMB(): number {
    return fixtureFileBytes / 1048576;
}

/** 大堆探针：远高于两条路径的最小可完成堆（实测 ≈1.41×），保证必然完成 */
function surviveHeapMB(): number {
    return Math.max(300, Math.round(fixtureMB() * 2.7));
}

/**
 * 崩溃探针：必须高于 tsx 子进程模块编译地板（~128MB，低于它会复现不出任务管线的 OOM），
 * 同时低于恢复/保存需求实测下界 1.335×。fixture ≥ ~105MB 时两者才能同时满足。
 */
function oomHeapMB(): number {
    return Math.max(132, Math.round(fixtureMB() * 1.25));
}

function buildLargeHistoryFixture(): void {
    const base64Chunk = 'T25kZXNrRGVza0ZpeHR1cmVJbWFnZURhdGFVdGY4RW5jb2RlZEJhc2U2NFNlZ01l'.repeat(28);
    const imageBytes = TARGET_IMAGES * 2 * base64Chunk.length * 1.34;
    const textCount = TARGET_TOOL_CALLS - TARGET_IMAGES;
    const textResultBytes = Math.max(1024, Math.floor(((TARGET_FILE_MB * 1048576 - imageBytes) / textCount) * 0.92));
    const textUnit = 'The quick brown fox jumps over the lazy dog. ';
    const textRepeat = Math.max(1, Math.floor(textResultBytes / 45));

    const buildToolCall = (seq: number): ToolCall => {
        const replaced = seq % Math.max(1, Math.floor(TARGET_TOOL_CALLS / REPLACED_RESULTS)) === 0 && seq !== 0;
        const call = new ToolCall(seq, `call-${seq}`, 'browser-screenshot', `{"seq":${seq}}`);
        call.status = 'success';
        if (seq < TARGET_IMAGES) {
            call.result = `screenshot ${seq} captured`;
            call.result_object = {
                type: 'image',
                images: [
                    {
                        image_url: `data:image/png;base64,${base64Chunk}${base64Chunk}${String(seq).padStart(6, '0')}`,
                        media_type: 'image/png',
                        source: 'fixture'
                    }
                ]
            };
        } else {
            const result = textUnit.repeat(textRepeat);
            call.result = result;
            call.rendered = `<div class="tool-output">${result.slice(0, 2048)}</div>`;
            if (replaced) {
                // Level-1 压缩语义：替代文本 + 原始 result 仍保留（issue 中的 212 条画像）
                call.result_storage = {
                    result_id: `result-${seq}`,
                    storage_version: 1,
                    relative_path: path.join('artifacts', 'fixture', `result-${seq}.txt`),
                    original_chars: result.length,
                    original_lines: result.split('\n').length,
                    persisted_at: new Date().toISOString(),
                    replacement_text: `${result.slice(0, 1200)}\n\n... [中间省略] ...`
                };
            }
        }
        return call;
    };

    const manager = new TaskManagerState();
    const task = new TaskState(manager);
    task.task_id = 'issue341-large';
    task.task_name = 'issue341 large history';
    // 终态 failed：与崩溃日志一致（running 会被恢复路径改写）
    task.task_status = 'failed';
    task.model = 'fixture-model';
    task.created_at = new Date('2026-11-09T09:00:00.000Z');
    task.started_at = new Date('2026-11-09T09:00:10.000Z');
    task.finished_at = new Date('2026-11-09T10:00:00.000Z');

    task.chat_context = new ChatContext();
    task.chat_context.appendMessage(new UserMessage('please audit the whole page with screenshots'));
    const batchSize = 40;
    for (let batch = 0; batch * batchSize < TARGET_TOOL_CALLS; batch++) {
        const assistant = new AssistantMessage();
        const part = new ToolCallMessagePart();
        for (let i = 0; i < batchSize && batch * batchSize + i < TARGET_TOOL_CALLS; i++) {
            part.toolcalls.push(buildToolCall(batch * batchSize + i));
        }
        assistant.content.push(part);
        task.chat_context.appendMessage(assistant);
        task.chat_context.appendMessage(new UserMessage('continue'));
    }

    manager.tasks.push(task);
    manager.saveSync();

    const taskFile = path.join(getTaskDirectory(), `${task.task_id}.json`);
    fixtureFileBytes = fs.statSync(taskFile).size;
    assert.ok(fixtureMB() >= MIN_FIXTURE_MB, `fixture file unexpectedly small: ${fixtureMB().toFixed(1)}MB`);
}

before(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-issue341-oom-'));
    const previous = process.env.OPENDESK_CONFIG_DIRECTORY;
    setCustomOpendeskDirectory(fixtureDir);
    try {
        buildLargeHistoryFixture();
    } finally {
        setCustomOpendeskDirectory(undefined);
        if (previous !== undefined) {
            process.env.OPENDESK_CONFIG_DIRECTORY = previous;
        }
    }
});

after(() => {
    if (fixtureDir && fs.existsSync(fixtureDir)) {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
    fixtureDir = undefined;
});

test(
    'restore retains ~1x the file size: the parse graph itself is not the amplifier',
    { timeout: TEST_TIMEOUT_MS },
    () => {
        const child = runReplayChild('restore', surviveHeapMB());
        assert.equal(child.status, 0, `restore must complete under ${surviveHeapMB()}MB old space\n${child.stderr}`);
        assert.ok(!/heap out of memory/i.test(child.stderr), 'restore must not OOM');
        assert.ok(
            child.milestones.done === 1,
            `restore milestones missing\nstdout=${child.stdout}\nstderr=${child.stderr}`
        );
        const retainedMB = child.milestones.restore_growth_mb ?? 0;
        // 实测 ≈ 0.9× 文件体积；上界 1.15× 钉死「全量加载常驻全部消息内容」的基线成本
        assert.ok(
            retainedMB <= fixtureMB() * 1.15,
            `restore retained ${retainedMB}MB should be <= 1.15x file size ${fixtureMB().toFixed(1)}MB`
        );
    }
);

test(
    'restore + one saveSync amplifies heap far beyond the file size (root cause of #341)',
    { timeout: TEST_TIMEOUT_MS },
    () => {
        const child = runReplayChild('save', surviveHeapMB());
        assert.equal(
            child.status,
            0,
            `restore+save must complete under ${surviveHeapMB()}MB old space\n${child.stderr}`
        );
        assert.ok(child.milestones.done === 1, `save milestones missing\nstdout=${child.stdout}`);
        const saveGrowthMB = (child.milestones.save_heap_mb ?? 0) - (child.milestones.restore_growth_mb ?? 0);
        // 保存阶段 heap 净增 ≈ 2.4× 文件体积（JSON.stringify(task.toJSON(), null, 4) 的
        // 输出串叠加在常驻图之上）；下界 1.5× 钉死放大系数。
        // 修复（剥离已压缩原始结果 / 分段序列化 / 图片外置）后应改为显著低于 1.5× 的上界断言。
        assert.ok(
            saveGrowthMB >= fixtureMB() * 1.5,
            `save phase heap growth ${saveGrowthMB}MB should be >= 1.5x file size ${fixtureMB().toFixed(1)}MB`
        );
    }
);

test('restore + save hits the issue #341 V8 OOM crash under a constrained heap', { timeout: TEST_TIMEOUT_MS }, () => {
    const child = runReplayChild('save', oomHeapMB());
    const aborted = child.status === 134 || child.signal === 'SIGABRT';
    assert.ok(
        aborted,
        `restore+save must crash with SIGABRT-class exit under ${oomHeapMB()}MB old space, ` +
            `got status=${child.status} signal=${child.signal}\n${child.stderr}`
    );
    assert.match(
        child.stderr,
        /heap out of memory/,
        'crash signature must be the V8 OOM reported in issue #341 (Reached heap limit / ' +
            'Ineffective mark-compacts near heap limit)'
    );
    // OOM 必须发生在任务管线（模块加载完成之后），而不是 tsx 自身的编译阶段
    assert.equal(
        child.milestones.modules,
        1,
        `crash must happen after module loading, not during tsx compilation
${child.stderr}`
    );
});
