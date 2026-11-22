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
 * 渲染进程的插件特性禁用状态助手。
 *
 * 主进程的插件通过 ctx.features.disableFeature(featureId) / disableApplication(bundleName) /
 * hideApplication(bundleName) 操作 OpenDesk 内置特性与应用入口，状态经 features:getState 拉取、
 * features:changed 推送。组件用 isFeatureDisabled / isApplicationDisabledByFeature 决定图标/按钮显隐，
 * 并可通过 onFeaturesChanged 在状态变化时刷新自身。
 */

const EMPTY_STATE = { disabledFeatures: [], disabledApplications: [], hiddenApplications: [], features: [] };

/** 拉取失败的重试退避：主进程 IPC handler 可能比窗口加载稍晚就绪 */
const RETRY_DELAYS_MS = [50, 200, 500];

let state = EMPTY_STATE;
let initialized = false;
let initialStatePromise = null;
const changeListeners = new Set();

/** 拉取一次特性状态并订阅后续变更；幂等，重复调用不会重复订阅 */
export function initFeatureState() {
    if (initialized || !window.featuresAPI) return;
    initialized = true;
    initialStatePromise = fetchState(0);
    window.featuresAPI.onChanged((snapshot) => applyState(snapshot));
}

/**
 * 状态首次就绪（或重试耗尽）后 resolve，供需要在首帧就取正确显隐的组件使用。
 * 未调用 initFeatureState（例如没有 featuresAPI 的窗口）时立即 resolve。
 */
export function whenFeatureStateReady() {
    return initialStatePromise ?? Promise.resolve();
}

export function isFeatureDisabled(featureId) {
    return state.disabledFeatures.includes(featureId);
}

export function isApplicationDisabledByFeature(bundleName) {
    return state.disabledApplications.includes(bundleName);
}

export function onFeaturesChanged(listener) {
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
}

async function fetchState(attempt) {
    try {
        applyState(await window.featuresAPI.getState());
    } catch (error) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
            // 保持默认（无禁用）而不是阻塞组件渲染；下次 features:changed 推送仍会纠正状态
            console.warn('loading feature state failed', error);
            return;
        }
        // 重试要串进同一个 promise 链：whenFeatureStateReady 才会等到重试结束，
        // 依赖首帧显隐的组件（如设置页遥测块）不会在首次失败后按默认状态渲染
        await new Promise((resolve) => setTimeout(resolve, delay));
        await fetchState(attempt + 1);
    }
}

function applyState(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    state = {
        disabledFeatures: Array.isArray(snapshot.disabledFeatures) ? snapshot.disabledFeatures : [],
        disabledApplications: Array.isArray(snapshot.disabledApplications) ? snapshot.disabledApplications : [],
        hiddenApplications: Array.isArray(snapshot.hiddenApplications) ? snapshot.hiddenApplications : [],
        features: Array.isArray(snapshot.features) ? snapshot.features : []
    };
    notifyChangeListeners();
}

function notifyChangeListeners() {
    for (const listener of [...changeListeners]) {
        try {
            listener(state);
        } catch (error) {
            console.error('feature state change listener failed', error);
        }
    }
}

// 组件挂载通常晚于模块加载：在模块加载时就发起拉取，缩短首帧按默认状态渲染的窗口
if (typeof window !== 'undefined' && window.featuresAPI) {
    initFeatureState();
}
