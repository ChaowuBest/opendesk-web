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
 * Issue #341 回归：超大任务历史（issue 中约 384MB、888 次工具调用、363 个图片条目）
 * 的恢复与保存管线不得再放大内存。
 *
 * 修复内容（阶段二）：
 * - 落盘走流式序列化（json-stream-write），不再物化整个 JSON 输出串——保存峰值
 *   从「常驻图 + ~2.4× 文件体积的输出串」降为「常驻图 + 有界写批次」；
 * - 已压缩工具结果的原始 result 按可恢复性从序列化输出中剥离（见
 *   toolcall-compressed-result-strip.test.ts）。
 *
 * 本测试用真实类构建与 issue 同构的 fixture（888 次工具调用、363 个图片条目、
 * 212 条已压缩但仍保留原始 result 的工具结果，无 artifacts 原文文件——即旧文件
 * 被拷贝到没有 artifacts 的机器的最坏画像），按等比缩小到 ~130MB，在子进程中
 * 用受限 old-space 实测（阈值按 fixture 实际体积推导，余量见各断言）：
 *
 * - 恢复路径净驻留（收敛采样）≈ 1.0× 文件体积 → 上界断言 1.15×；
 *   （加载路径未改动，该基线与修复前一致）
 * - 保存阶段存活净增（子进程开启 --expose-gc，采样前强制全量 GC）必须显著低于
 *   修复前的 ~2.4× 文件体积（全量 stringify 的输出串是存活内存）：流式写出后
 *   保存只增加 toJSON 结构图（字符串共享引用）与有界写批次，存活净增退化为
 *   个位数 MB → 上界断言 max(16MB, 0.1×)；
 * - 恢复 + 保存整条管线必须在 1.55× 堆下完成（实测修复前保存管线在同堆下
 *   因全量 stringify 的输出串叠加必然 V8 OOM：常驻 ~0.9× + 输出串 ~1× 的峰值
 *   早已超出；修复后有界批次不再受堆约束）。探针必须高于恢复路径自身的最小
 *   可完成堆（实测 ~1.35~1.41×，JSON.parse 的输入串与解析图瞬时共存所致），
 *   因此 fixture 不能小于 ~100MB。
 *
 * 注意：fixture 构建时已压缩条目的原始 result 因 artifacts 缺失而按契约保持内联，
 * 图片为不可解码的伪 base64（jimp 解码失败，外置为 no-op），确保子进程始终回放「未瘦身
 * 的旧文件」最坏画像，钉死流式写出与剥离对保存峰值的真实效果。
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
// 与保存（persistLater + saveSync）路径。heap 上限通过 NODE_OPTIONS 传入（tsx 会把
// 脚本转发到子进程，命令行 flag 不生效）；--expose-gc + 收敛式采样让各里程碑读数
// 反映存活内存而非 GC 时机漂浮垃圾。注意各里程碑的口径：
// - restore_growth_mb：恢复前后的存活净增（增量）；
// - save_growth_mb：保存操作前后的存活净增（增量，紧邻采样，不受恢复基线影响）；
// - save_ms：saveSync 耗时（诊断用）。
const CHILD_REPLAY_SOURCE = `
import { TaskManagerState } from './src/main/aikernel/states/tasks.ts';
import { setCustomOpendeskDirectory } from './src/main/utils/setting.ts';

// fixture 目录由环境变量传入（纯路径，setCustomOpendeskDirectory 内部自行 resolve）
console.error('MILESTONE modules=1');
setCustomOpendeskDirectory(process.env.REPLAY_FIXTURE_DIR);

// 单次 gc() 在增量标记下可能只推进当前标记周期，恢复大图后需要多轮才收敛；
// 连续两轮 heap 下降小于 1MB 视为已收敛，此后 heapUsed 才反映真实存活内存
function liveHeapMB() {
    const gc = globalThis.gc;
    if (typeof gc === 'function') {
        let previous = -1;
        for (let round = 0; round < 8; round++) {
            gc();
            const current = process.memoryUsage().heapUsed;
            if (previous >= 0 && previous - current < 1048576) {
                break;
            }
            previous = current;
        }
    }
    return Math.round(process.memoryUsage().heapUsed / 1048576);
}
const before = liveHeapMB();
const manager = TaskManagerState.load();
if (!manager) throw new Error('no task manager state');
const task = manager.getTask('issue341-large');
if (!task) throw new Error('task missing after restore');
console.error('MILESTONE restore_growth_mb=' + (liveHeapMB() - before));

if (process.env.REPLAY_PHASE === 'save') {
    const preSave = liveHeapMB();
    task.task_name = (task.task_name ?? '') + ' r';
    task.persistLater();
    const t0 = Date.now();
    manager.saveSync();
    const postSave = liveHeapMB();
    console.error('MILESTONE save_growth_mb=' + (postSave - preSave) + ' save_ms=' + (Date.now() - t0));
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
                NODE_OPTIONS: `--max-old-space-size=${heapMB} --expose-gc`,
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

/** 大堆探针：远高于两条路径的最小可完成堆，保证必然完成 */
function surviveHeapMB(): number {
    return Math.max(300, Math.round(fixtureMB() * 2.7));
}

/**
 * 约束堆探针：必须高于恢复路径自身的最小可完成堆（实测 ~1.35~1.41×，加载路径
 * 未改动），同时远低于修复前保存管线必然 OOM 的水平（常驻 ~0.9× + 全量输出串
 * ~1× 的瞬时峰值 ≥ ~1.9×）。fixture ≥ ~105MB 时模块编译地板（~128MB）不构成约束。
 */
function constrainedHeapMB(): number {
    return Math.max(170, Math.round(fixtureMB() * 1.55));
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
        // 收敛采样实测 ≈ 1.0× 文件体积（解析图字符串为文件内容的新副本 + tsx 模块残量）；
        // 上界 1.15× 钉死「全量加载常驻全部消息内容」的基线成本
        assert.ok(
            retainedMB <= fixtureMB() * 1.15,
            `restore retained ${retainedMB}MB should be <= 1.15x file size ${fixtureMB().toFixed(1)}MB`
        );
    }
);

test(
    'restore + one saveSync no longer amplifies heap beyond a bounded write batch',
    { timeout: TEST_TIMEOUT_MS },
    () => {
        const child = runReplayChild('save', surviveHeapMB());
        assert.equal(
            child.status,
            0,
            `restore+save must complete under ${surviveHeapMB()}MB old space\n${child.stderr}`
        );
        assert.ok(child.milestones.done === 1, `save milestones missing\nstdout=${child.stdout}`);
        // 子进程在保存操作前后各做一次收敛采样，save_growth_mb 即保存阶段的存活净增：
        // 流式写出后只剩 toJSON 结构图（字符串共享引用）+ 有界写批次；修复前全量
        // stringify 的输出串让该值为 ~2.4× 文件体积（约 254MB / 104.8MB 量级）。
        const saveGrowthMB = child.milestones.save_growth_mb ?? 0;
        const growthCeilingMB = Math.max(16, Math.round(fixtureMB() * 0.1));
        assert.ok(
            saveGrowthMB <= growthCeilingMB,
            `save phase live heap growth ${saveGrowthMB}MB should be <= ${growthCeilingMB}MB ` +
                `(file size ${fixtureMB().toFixed(1)}MB)\n${child.stderr}`
        );
    }
);

test(
    'restore + save completes the whole pipeline under a heap that starved the full stringify',
    {
        timeout: TEST_TIMEOUT_MS
    },
    () => {
        const child = runReplayChild('save', constrainedHeapMB());
        assert.equal(
            child.status,
            0,
            `restore+save must complete under ${constrainedHeapMB()}MB old space, ` +
                `got status=${child.status} signal=${child.signal}\n${child.stderr}`
        );
        assert.ok(!/heap out of memory/i.test(child.stderr), 'the fixed pipeline must not OOM');
        assert.ok(child.milestones.done === 1, `save milestones missing\nstdout=${child.stdout}`);
        // 约束堆下保存阶段的存活净增同样必须有界（修复前同堆下全量 stringify 直接 OOM）
        const saveGrowthMB = child.milestones.save_growth_mb ?? 0;
        const growthCeilingMB = Math.max(16, Math.round(fixtureMB() * 0.1));
        assert.ok(
            saveGrowthMB <= growthCeilingMB,
            `constrained save live heap growth ${saveGrowthMB}MB should be <= ${growthCeilingMB}MB\n${child.stderr}`
        );
    }
);
