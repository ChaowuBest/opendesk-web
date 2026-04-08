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

import fs from 'fs';
import path from 'path';

/**
 * 单次操作的计时记录
 */
interface ProfileEntry {
    /** 操作类别: "llm_completion" | "tool_call" */
    category: 'llm_completion' | 'tool_call';
    /** 具体名称, 对于 tool_call 为工具名, 对于 llm_completion 为 "streamComplete" */
    name: string;
    /** 所属的 turn 索引 (从 0 开始) */
    turn: number;
    /** 开始时间 (Unix ms) */
    start_ms: number;
    /** 结束时间 (Unix ms) */
    end_ms: number;
    /** 耗时 (ms) */
    duration_ms: number;
    /** 额外元数据 */
    meta?: Record<string, unknown>;
}

/**
 * 汇总后按工具名的统计
 */
interface ToolAggregate {
    tool_name: string;
    call_count: number;
    total_ms: number;
    avg_ms: number;
    min_ms: number;
    max_ms: number;
}

/**
 * 单个 turn (一轮对话) 的汇总
 */
interface TurnSummary {
    turn: number;
    llm_ms: number;
    tool_ms: number;
    total_ms: number;
    tool_calls: { name: string; duration_ms: number }[];
}

/**
 * 最终输出的 profile JSON 结构
 */
export interface ProfileReport {
    version: 1;
    task_id: string;
    /** 总耗时 (ms), 从 profiler 开始到结束 */
    total_ms: number;
    /** LLM 推理累计耗时 (ms) */
    llm_total_ms: number;
    /** 工具执行累计耗时 (ms) */
    tool_total_ms: number;
    /** 其他时间 (框架开销、等待等) = total_ms - llm_total_ms - tool_total_ms */
    overhead_ms: number;
    /** 各 turn 的汇总 */
    turns: TurnSummary[];
    /** 按工具名汇总的统计 */
    tool_aggregates: ToolAggregate[];
    /** 完整的时间线事件列表 */
    timeline: ProfileEntry[];
}

/**
 * TaskProfiler: 轻量级性能分析器, 跟随 TaskState 生命周期。
 *
 * 使用方式:
 * 1. 创建 profiler: `const profiler = new TaskProfiler(task_id)`
 * 2. LLM 推理前后: `profiler.beginLLM(turn)` / `profiler.endLLM(meta?)`
 * 3. 工具执行前后: `profiler.beginTool(name, turn)` / `profiler.endTool(meta?)`
 * 4. 结束时: `profiler.finish()` → 生成 ProfileReport
 */
export class TaskProfiler {
    private taskId: string;
    private startTime: number;
    private endTime: number = 0;
    private entries: ProfileEntry[] = [];

    private currentEntry: Partial<ProfileEntry> | null = null;

    constructor(taskId: string) {
        this.taskId = taskId;
        this.startTime = Date.now();
    }

    beginLLM(turn: number): void {
        this.currentEntry = {
            category: 'llm_completion',
            name: 'streamComplete',
            turn,
            start_ms: Date.now()
        };
    }

    endLLM(meta?: Record<string, unknown>): void {
        if (!this.currentEntry || this.currentEntry.category !== 'llm_completion') return;
        const now = Date.now();
        const entry: ProfileEntry = {
            category: 'llm_completion',
            name: this.currentEntry.name!,
            turn: this.currentEntry.turn!,
            start_ms: this.currentEntry.start_ms!,
            end_ms: now,
            duration_ms: now - this.currentEntry.start_ms!,
            meta
        };
        this.entries.push(entry);
        this.currentEntry = null;
    }

    /**
     * 开始一次工具调用计时。返回一个 token，用于 endTool 时匹配。
     * 支持并发工具调用，不再依赖单一 currentEntry。
     */
    beginTool(toolName: string, turn: number): number {
        const token = this.entries.length + this._pendingTools.length;
        this._pendingTools.set(token, {
            category: 'tool_call',
            name: toolName,
            turn,
            start_ms: Date.now()
        });
        return token;
    }

    private _pendingTools: Map<number, Partial<ProfileEntry>> = new Map();

    endTool(token: number, meta?: Record<string, unknown>): void {
        const pending = this._pendingTools.get(token);
        if (!pending) return;
        this._pendingTools.delete(token);

        const now = Date.now();
        const entry: ProfileEntry = {
            category: 'tool_call',
            name: pending.name!,
            turn: pending.turn!,
            start_ms: pending.start_ms!,
            end_ms: now,
            duration_ms: now - pending.start_ms!,
            meta
        };
        this.entries.push(entry);
    }

    /**
     * 结束 profiling，生成最终报告。
     */
    finish(): ProfileReport {
        this.endTime = Date.now();
        const totalMs = this.endTime - this.startTime;

        let llmTotalMs = 0;
        let toolTotalMs = 0;

        const toolMap = new Map<string, { count: number; total: number; min: number; max: number }>();
        const turnMap = new Map<number, TurnSummary>();

        for (const entry of this.entries) {
            if (entry.category === 'llm_completion') {
                llmTotalMs += entry.duration_ms;
            } else {
                toolTotalMs += entry.duration_ms;
            }

            // turn 汇总
            if (!turnMap.has(entry.turn)) {
                turnMap.set(entry.turn, {
                    turn: entry.turn,
                    llm_ms: 0,
                    tool_ms: 0,
                    total_ms: 0,
                    tool_calls: []
                });
            }
            const turnSummary = turnMap.get(entry.turn)!;
            if (entry.category === 'llm_completion') {
                turnSummary.llm_ms += entry.duration_ms;
            } else {
                turnSummary.tool_ms += entry.duration_ms;
                turnSummary.tool_calls.push({
                    name: entry.name,
                    duration_ms: entry.duration_ms
                });
            }

            // 工具聚合
            if (entry.category === 'tool_call') {
                const existing = toolMap.get(entry.name);
                if (existing) {
                    existing.count++;
                    existing.total += entry.duration_ms;
                    existing.min = Math.min(existing.min, entry.duration_ms);
                    existing.max = Math.max(existing.max, entry.duration_ms);
                } else {
                    toolMap.set(entry.name, {
                        count: 1,
                        total: entry.duration_ms,
                        min: entry.duration_ms,
                        max: entry.duration_ms
                    });
                }
            }
        }

        // 计算每个 turn 的总时间
        for (const ts of turnMap.values()) {
            ts.total_ms = ts.llm_ms + ts.tool_ms;
        }

        const turns = Array.from(turnMap.values()).sort((a, b) => a.turn - b.turn);

        const toolAggregates: ToolAggregate[] = Array.from(toolMap.entries())
            .map(([name, stats]) => ({
                tool_name: name,
                call_count: stats.count,
                total_ms: stats.total,
                avg_ms: Math.round(stats.total / stats.count),
                min_ms: stats.min,
                max_ms: stats.max
            }))
            .sort((a, b) => b.total_ms - a.total_ms);

        return {
            version: 1,
            task_id: this.taskId,
            total_ms: totalMs,
            llm_total_ms: llmTotalMs,
            tool_total_ms: toolTotalMs,
            overhead_ms: totalMs - llmTotalMs - toolTotalMs,
            turns,
            tool_aggregates: toolAggregates,
            timeline: this.entries
        };
    }

    /**
     * 将 profile 报告写入到指定路径。
     */
    static writeReport(report: ProfileReport, filePath: string): void {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(report, null, 2), { encoding: 'utf8' });
    }
}
