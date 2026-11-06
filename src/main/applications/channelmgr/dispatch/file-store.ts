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
 * 激活任务绑定的文件存储：channelmgr 的私有运行态，落在应用数据目录
 * （apps/channelmgr/active_tasks.json），不进 settings.json。
 *
 * 绑定关系是机器产生的运行态而非用户配置：放进配置树会让导出/同步/整体替换配置
 * 这些动作顺手带上或抹掉它，而且每次落盘都要过一遍整份配置的校验与广播。
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../../utils/logger.js';
import type { ActiveTaskEntry, ActiveTaskStore } from './registry.js';

/** 磁盘文件布局；channels 按渠道分节，与 registry 的「渠道维度持久化」对齐 */
interface ActiveTaskFileData {
    version: 1;
    channels: Record<string, Record<string, ActiveTaskEntry>>;
}

/** 合并短时间内的连续写入，避免同一 tick 的多条变更各写一次文件 */
const WRITE_DEBOUNCE_MS = 300;

/** 待 flush 的 store：进程退出时统一同步落盘，避免丢掉防抖窗口内的变更 */
const pendingStores = new Set<{ flush: () => void }>();
let exitHookInstalled = false;

function scheduleExitFlush(store: { flush: () => void }): void {
    pendingStores.add(store);
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    // 只注册一次；退出阶段仅允许同步 IO，因此走 flushSync 路径
    process.once('exit', () => {
        for (const pending of pendingStores) {
            try {
                pending.flush();
            } catch {
                /* 退出阶段尽力而为 */
            }
        }
    });
}

export class ActiveTaskFileStore implements ActiveTaskStore {
    private data: ActiveTaskFileData | undefined;
    private timer: NodeJS.Timeout | undefined;
    /** 读取失败（非「文件不存在」）时置位：宁可这次的绑定不落盘，也不要拿空快照覆盖整份文件 */
    private writeBlocked = false;

    constructor(
        private readonly filePath: string,
        private readonly debounceMs: number = WRITE_DEBOUNCE_MS
    ) {
        scheduleExitFlush({
            flush: () => {
                this.cancelScheduledWrite();
                this.writeNow();
            }
        });
    }

    load(channelId: string): Record<string, ActiveTaskEntry> | undefined {
        return this.ensureLoaded().channels[channelId];
    }

    save(channelId: string, entries: Record<string, ActiveTaskEntry>): void {
        this.ensureLoaded().channels[channelId] = entries;
        this.scheduleWrite();
    }

    /** 立即落盘并取消防抖（测试与退出路径用）。 */
    flush(): void {
        this.cancelScheduledWrite();
        this.writeNow();
    }

    /** 首次访问时读取整份文件；文件缺失或损坏都退化为空数据（绑定可自愈，不阻断消息路由）。 */
    private ensureLoaded(): ActiveTaskFileData {
        if (this.data) return this.data;
        this.data = { version: 1, channels: {} };
        let raw: string;
        try {
            raw = fs.readFileSync(this.filePath, 'utf8');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                logger.warn(`[channelmgr] 读取激活任务绑定失败: ${(err as Error).message}`);
                // 读不到（占用/权限等瞬态问题）时禁止覆盖写：拿空快照落盘会抹掉其他渠道的绑定
                this.writeBlocked = true;
            }
            return this.data;
        }
        try {
            const parsed = JSON.parse(raw) as Partial<ActiveTaskFileData>;
            if (parsed && typeof parsed === 'object' && parsed.channels && typeof parsed.channels === 'object') {
                this.data.channels = parsed.channels;
            }
        } catch (err) {
            logger.warn(`[channelmgr] 激活任务绑定文件损坏，按空绑定处理: ${(err as Error).message}`);
        }
        return this.data;
    }

    private scheduleWrite(): void {
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.writeNow();
        }, this.debounceMs);
        // pending 写入不应阻止进程退出（退出时由 exit 钩子同步落盘）
        if (typeof this.timer.unref === 'function') this.timer.unref();
    }

    private cancelScheduledWrite(): void {
        if (!this.timer) return;
        clearTimeout(this.timer);
        this.timer = undefined;
    }

    /** 原子替换写：先写同目录临时文件再 rename，避免进程中途退出留下半截 json */
    private writeNow(): void {
        if (!this.data || this.writeBlocked) return;
        const tempPath = `${this.filePath}.tmp`;
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(tempPath, JSON.stringify(this.data), 'utf8');
            fs.renameSync(tempPath, this.filePath);
        } catch (err) {
            logger.warn(`[channelmgr] 保存激活任务绑定失败: ${(err as Error).message}`);
            try {
                fs.rmSync(tempPath, { force: true });
            } catch {
                /* 临时文件清理失败不影响主流程 */
            }
        }
    }
}
