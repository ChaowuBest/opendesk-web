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
 * 特性禁用状态的运行时持有者。
 *
 * 状态是动态的、跟随插件生命周期：插件在 setup() 中通过 `ctx.features` 写入，
 * 其 PluginRegistration dispose（插件停用/卸载/宿主重载）时回退，不落盘。
 * 同一目标可被多个插件同时禁用（按 owner 计数），全部回退后才视为恢复。
 *
 * 本模块不依赖 electron（只用了主进程的 logger），主进程消费方（ApplicationRegistry、
 * aikernel、filemgr、IPC 推送）与 worker 线程内被实例化的应用类都会加载它。
 *
 * 应用侧有两种独立的门控：禁用（disableApplication）停掉图标、工具集、事件与 worker 调用；
 * 隐藏（hideApplication）只让入口图标不显示，应用本身照常在后台运行。
 */

import { logger } from '../../main/utils/logger.js';

export interface FeatureStateSnapshot {
    disabledFeatures: string[];
    disabledApplications: string[];
    /** 被插件隐藏入口的应用：图标不显示，但应用仍按原样运行 */
    hiddenApplications: string[];
}

type FeatureChangeListener = () => void;
/** 目标 -> 持有者 -> 持有次数 */
type DisableRecords = Map<string, Map<string, number>>;

export class FeatureManager {
    private readonly disabledFeatures: DisableRecords = new Map();
    private readonly disabledApplications: DisableRecords = new Map();
    /** 仅隐藏入口的应用：图标不显示，但应用照常运行（Skill / Agent / 工具集 / 事件全部保留） */
    private readonly hiddenApplications: DisableRecords = new Map();
    private readonly featureChangeListeners = new Set<FeatureChangeListener>();
    private readonly applicationChangeListeners = new Set<FeatureChangeListener>();

    isFeatureDisabled(featureId: string): boolean {
        return FeatureManager.hasOwner(this.disabledFeatures, featureId);
    }

    isApplicationDisabled(bundleName: string): boolean {
        return FeatureManager.hasOwner(this.disabledApplications, bundleName);
    }

    isApplicationHidden(bundleName: string): boolean {
        return FeatureManager.hasOwner(this.hiddenApplications, bundleName);
    }

    getDisabledFeatures(): string[] {
        return Array.from(this.disabledFeatures.keys()).filter((id) => this.isFeatureDisabled(id));
    }

    getDisabledApplications(): string[] {
        return Array.from(this.disabledApplications.keys()).filter((name) => this.isApplicationDisabled(name));
    }

    getHiddenApplications(): string[] {
        return Array.from(this.hiddenApplications.keys()).filter((name) => this.isApplicationHidden(name));
    }

    getSnapshot(): FeatureStateSnapshot {
        return {
            disabledFeatures: this.getDisabledFeatures(),
            disabledApplications: this.getDisabledApplications(),
            hiddenApplications: this.getHiddenApplications()
        };
    }

    /** 禁用中的特性清单（含持有禁用的 owner id，宿主侧即插件 id） */
    listDisabledFeatures(): Array<{ id: string; pluginIds: string[] }> {
        return Array.from(this.disabledFeatures.entries()).map(([id, owners]) => ({
            id,
            pluginIds: [...owners.keys()]
        }));
    }

    /** 禁用中的应用清单（含持有禁用的 owner id，宿主侧即插件 id） */
    listDisabledApplications(): Array<{ bundleName: string; pluginIds: string[] }> {
        return Array.from(this.disabledApplications.entries()).map(([bundleName, owners]) => ({
            bundleName,
            pluginIds: [...owners.keys()]
        }));
    }

    /** 被隐藏入口的应用清单（含 owner id） */
    listHiddenApplications(): Array<{ bundleName: string; pluginIds: string[] }> {
        return Array.from(this.hiddenApplications.entries()).map(([bundleName, owners]) => ({
            bundleName,
            pluginIds: [...owners.keys()]
        }));
    }

    /**
     * 设置某 owner 对特性的禁用开关；幂等，仅在禁用状态实际变化时通知监听器。
     * 传 false 会清除该 owner 持有的全部禁用次数（用于状态镜像/测试复位）。
     */
    setFeatureDisabled(featureId: string, ownerId: string, disabled: boolean): void {
        if (FeatureManager.setOwner(this.disabledFeatures, featureId, ownerId, disabled)) {
            this.notify(this.featureChangeListeners);
        }
    }

    /** 设置某 owner 对应用的禁用开关；语义同 setFeatureDisabled */
    setApplicationDisabled(bundleName: string, ownerId: string, disabled: boolean): void {
        if (FeatureManager.setOwner(this.disabledApplications, bundleName, ownerId, disabled)) {
            this.notify(this.applicationChangeListeners);
        }
    }

    /** 设置某 owner 对应用的入口隐藏开关；语义同 setFeatureDisabled */
    setApplicationHidden(bundleName: string, ownerId: string, hidden: boolean): void {
        if (FeatureManager.setOwner(this.hiddenApplications, bundleName, ownerId, hidden)) {
            this.notify(this.applicationChangeListeners);
        }
    }

    /**
     * 追加一次特性禁用持有，返回释放函数（可重复调用，只生效一次）。
     *
     * 与 setFeatureDisabled 的区别：按次数计数，同一 owner 持有多次时必须释放同样次数
     * 才恢复。插件通过 SDK 每次调用 ctx.features.disableFeature 都会得到一个独立 registration，
     * 用这个接口才不会因为释放其中一个 registration 就整体解锁。
     */
    acquireFeatureDisable(featureId: string, ownerId: string): () => void {
        return FeatureManager.acquire(this.disabledFeatures, featureId, ownerId, () =>
            this.notify(this.featureChangeListeners)
        );
    }

    /** 追加一次应用禁用持有，语义同 acquireFeatureDisable */
    acquireApplicationDisable(bundleName: string, ownerId: string): () => void {
        return FeatureManager.acquire(this.disabledApplications, bundleName, ownerId, () =>
            this.notify(this.applicationChangeListeners)
        );
    }

    /** 追加一次应用入口隐藏持有，语义同 acquireFeatureDisable */
    acquireApplicationHide(bundleName: string, ownerId: string): () => void {
        // 只记录「入口隐藏」，不写任何禁用通道：Skill、Agent、工具集、事件与 worker 调用都不受影响。
        // 需要彻底停用应用请走 acquireApplicationDisable。
        return FeatureManager.acquire(this.hiddenApplications, bundleName, ownerId, () =>
            this.notify(this.applicationChangeListeners)
        );
    }

    onFeaturesChanged(listener: FeatureChangeListener): () => void {
        this.featureChangeListeners.add(listener);
        return () => this.featureChangeListeners.delete(listener);
    }

    onApplicationsChanged(listener: FeatureChangeListener): () => void {
        this.applicationChangeListeners.add(listener);
        return () => this.applicationChangeListeners.delete(listener);
    }

    /** 仅供单元测试重置单例状态 */
    resetForTests(): void {
        this.disabledFeatures.clear();
        this.disabledApplications.clear();
        this.hiddenApplications.clear();
        this.featureChangeListeners.clear();
        this.applicationChangeListeners.clear();
    }

    private static hasOwner(records: DisableRecords, key: string): boolean {
        const owners = records.get(key);
        if (!owners) return false;
        for (const count of owners.values()) {
            if (count > 0) return true;
        }
        return false;
    }

    /** 返回禁用状态是否发生变化 */
    private static setOwner(records: DisableRecords, key: string, ownerId: string, disabled: boolean): boolean {
        let owners = records.get(key);
        if (disabled) {
            if (owners?.has(ownerId)) return false;
            if (!owners) {
                owners = new Map();
                records.set(key, owners);
            }
            owners.set(ownerId, 1);
            return true;
        }
        if (!owners?.delete(ownerId)) return false;
        if (owners.size === 0) records.delete(key);
        return true;
    }

    private static acquire(records: DisableRecords, key: string, ownerId: string, notify: () => void): () => void {
        let owners = records.get(key);
        if (!owners) {
            owners = new Map();
            records.set(key, owners);
        }
        const wasDisabled = FeatureManager.hasOwner(records, key);
        owners.set(ownerId, (owners.get(ownerId) ?? 0) + 1);
        if (!wasDisabled) notify();

        let released = false;
        return () => {
            if (released) return;
            released = true;
            const current = records.get(key);
            const count = current?.get(ownerId) ?? 0;
            if (!current || count === 0) return;
            const wasActive = FeatureManager.hasOwner(records, key);
            if (count <= 1) current.delete(ownerId);
            else current.set(ownerId, count - 1);
            if (current.size === 0) records.delete(key);
            if (wasActive && !FeatureManager.hasOwner(records, key)) notify();
        };
    }

    private notify(listeners: Set<FeatureChangeListener>): void {
        for (const listener of [...listeners]) {
            try {
                listener();
            } catch (error) {
                logger.error('Feature change listener failed', error);
            }
        }
    }
}

let globalFeatureManager: FeatureManager | undefined;

export function getFeatureManager(): FeatureManager {
    globalFeatureManager ??= new FeatureManager();
    return globalFeatureManager;
}

/** 仅供单元测试重置全局单例 */
export function resetFeatureManagerForTests(): void {
    if (globalFeatureManager) {
        globalFeatureManager.resetForTests();
    }
}
