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
 * 渠道激活任务注册表：维护「渠道会话 → 当前激活任务」绑定。
 *
 * 绑定粒度为 recipient（私聊 = senderId，群聊 = groupId），策略配置的生效
 * 粒度是账号（accountId）——同一个账号下的不同会话各自持有独立的激活任务。
 * 未注入 store 时为纯内存态（重启丢失）；注入 store 后按渠道维度持久化。
 */

/** 单个渠道会话的激活任务绑定 */
export interface ActiveTaskEntry {
    taskId: string;
    /** 绑定最后活动时间（复用判定或消息处理完成时刷新），作为 timeout 策略的时间基准 */
    updatedAt: number;
}

/**
 * 绑定状态持久化接口：由宿主注入（channelmgr 私有数据目录下的 active_tasks.json）。
 * 绑定是运行态，不进 settings.json，避免被导出/同步/整体替换配置牵连。
 */
export interface ActiveTaskStore {
    load(channelId: string): Record<string, ActiveTaskEntry> | undefined;
    save(channelId: string, entries: Record<string, ActiveTaskEntry>): void;
}

/**
 * 活动时间刷新（touch）的落盘节流周期。
 *
 * updatedAt 唯一用途是 timeout 策略的分钟级阈值（最小 15 分钟），没必要每条入站消息都
 * 刷新一次落盘意图（store 侧还会再做写合并）。
 */
const ACTIVITY_PERSIST_INTERVAL_MS = 60_000;

/** 单渠道绑定上限：超出后淘汰最久未活动的绑定，避免持久化条目无上限增长 */
const MAX_ENTRIES_PER_CHANNEL = 200;

/** 校验从持久化层读出的条目形状，避免脏数据污染内存态 */
function isValidEntry(entry: unknown): entry is ActiveTaskEntry {
    return (
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as ActiveTaskEntry).taskId === 'string' &&
        typeof (entry as ActiveTaskEntry).updatedAt === 'number'
    );
}

export class ActiveTaskRegistry {
    /** key = `${channelId}:${accountId}:${recipientId}`，与历史 taskMap 的 key 拼接方式一致 */
    private entries = new Map<string, ActiveTaskEntry>();
    private loadedChannels = new Set<string>();
    /** 渠道 → 上次落盘时间，用于 touch 的节流 */
    private lastPersistAt = new Map<string, number>();

    constructor(private readonly store?: ActiveTaskStore) {}

    getActiveTaskId(channelId: string, accountId: string, recipientId: string): string | undefined {
        this.ensureChannelLoaded(channelId);
        return this.entries.get(this.key(channelId, accountId, recipientId))?.taskId;
    }

    getEntry(channelId: string, accountId: string, recipientId: string): ActiveTaskEntry | undefined {
        this.ensureChannelLoaded(channelId);
        return this.entries.get(this.key(channelId, accountId, recipientId));
    }

    bind(channelId: string, accountId: string, recipientId: string, taskId: string): void {
        this.ensureChannelLoaded(channelId);
        this.entries.set(this.key(channelId, accountId, recipientId), { taskId, updatedAt: Date.now() });
        this.persist(channelId);
    }

    /** 解绑（/new 无参命令将绑定置空）；绑定不存在时静默返回 */
    unbind(channelId: string, accountId: string, recipientId: string): void {
        this.ensureChannelLoaded(channelId);
        if (!this.entries.delete(this.key(channelId, accountId, recipientId))) return;
        this.persist(channelId);
    }

    /**
     * 刷新绑定活动时间；绑定不存在时静默返回。
     *
     * 活动时间走节流落盘：每个渠道最多每 {@link ACTIVITY_PERSIST_INTERVAL_MS} 写一次配置，
     * 节流窗口内的活动只更新内存态（重启最多丢失窗口内的活动时间，不影响分钟级阈值判定）。
     */
    touch(channelId: string, accountId: string, recipientId: string): void {
        this.ensureChannelLoaded(channelId);
        const entry = this.entries.get(this.key(channelId, accountId, recipientId));
        if (!entry) return;
        const now = Date.now();
        entry.updatedAt = now;
        if (now - (this.lastPersistAt.get(channelId) ?? 0) < ACTIVITY_PERSIST_INTERVAL_MS) return;
        this.persist(channelId);
    }

    /** 清除指向已失效任务的绑定；返回是否发生了清除 */
    evictIfInvalid(
        channelId: string,
        accountId: string,
        recipientId: string,
        isTaskValid: (taskId: string) => boolean
    ): boolean {
        this.ensureChannelLoaded(channelId);
        const key = this.key(channelId, accountId, recipientId);
        const entry = this.entries.get(key);
        if (!entry || isTaskValid(entry.taskId)) return false;
        this.entries.delete(key);
        this.persist(channelId);
        return true;
    }

    /** 枚举指定渠道下的全部绑定，供联系人枚举与重启恢复使用 */
    listChannelEntries(channelId: string): { accountId: string; recipientId: string; entry: ActiveTaskEntry }[] {
        this.ensureChannelLoaded(channelId);
        const prefix = `${channelId}:`;
        const out: { accountId: string; recipientId: string; entry: ActiveTaskEntry }[] = [];
        for (const [key, entry] of this.entries) {
            if (!key.startsWith(prefix)) continue;
            const rest = key.slice(prefix.length);
            const sep = rest.indexOf(':');
            if (sep <= 0 || sep === rest.length - 1) continue;
            out.push({ accountId: rest.slice(0, sep), recipientId: rest.slice(sep + 1), entry });
        }
        return out;
    }

    private key(channelId: string, accountId: string, recipientId: string): string {
        return `${channelId}:${accountId}:${recipientId}`;
    }

    /** 首次访问某渠道时从 store 惰性恢复绑定，之后统一走内存态 */
    private ensureChannelLoaded(channelId: string): void {
        if (this.loadedChannels.has(channelId)) return;
        this.loadedChannels.add(channelId);
        if (!this.store) return;
        try {
            const saved = this.store.load(channelId);
            if (!saved || typeof saved !== 'object') return;
            for (const [key, entry] of Object.entries(saved)) {
                if (!isValidEntry(entry)) continue;
                // 同样用副本：store 读出来的是配置树里的对象，直接持有会在 touch 时改动配置内存态
                if (!this.entries.has(key)) this.entries.set(key, { ...entry });
            }
        } catch {
            // 持久化读取失败时退化为内存态绑定，不阻断消息路由
        }
    }

    private persist(channelId: string): void {
        if (!this.store) return;
        this.lastPersistAt.set(channelId, Date.now());
        this.pruneChannel(channelId);
        const prefix = `${channelId}:`;
        const snapshot: Record<string, ActiveTaskEntry> = {};
        for (const [key, entry] of this.entries) {
            // 落盘用副本：store 会把对象直接挂进配置树，共享引用会让内存态后续改动串到配置里
            if (key.startsWith(prefix)) snapshot[key] = { ...entry };
        }
        try {
            this.store.save(channelId, snapshot);
        } catch {
            // 持久化失败不影响本次消息路由
        }
    }

    /** 单渠道绑定过多时淘汰最久未活动的条目（内存与持久化一起收敛） */
    private pruneChannel(channelId: string): void {
        const prefix = `${channelId}:`;
        const keys = [...this.entries.keys()].filter((key) => key.startsWith(prefix));
        const excess = keys.length - MAX_ENTRIES_PER_CHANNEL;
        if (excess <= 0) return;
        keys.sort((a, b) => (this.entries.get(a)?.updatedAt ?? 0) - (this.entries.get(b)?.updatedAt ?? 0));
        for (const key of keys.slice(0, excess)) {
            this.entries.delete(key);
        }
    }
}
