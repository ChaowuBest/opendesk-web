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

import { prepareHostResource } from '../../platforms/runtime.js';

/**
 * 大体积依赖的懒加载句柄。
 *
 * 把「请求宿主准备资源 → 动态 import → 并发单飞 → 失败后复位重试」收敛在这一处，
 * 调用方只关心：同步路径用 `peek()` 拿已就绪对象或降级，异步路径用 `ensure()` 等待。
 * 资源标识与宿主 `prepareResource` 契约保持一致。
 */
export interface ResourceLoader<T> {
    /** 已加载完成的对象；尚未就绪或上次加载失败后复位时返回 null。 */
    peek(): T | null;
    /** 后台触发加载且不等待结果；已有进行中的加载时不会重复触发。 */
    prefetch(): void;
    /** 加载并返回资源；并发调用共享同一次加载，失败后复位以便下次调用重试。 */
    ensure(): Promise<T>;
}

/**
 * 创建懒加载句柄。
 *
 * @param resource 传给宿主 `prepareResource` 的资源标识
 * @param load 真正加载模块的函数，仅在宿主准备成功后调用
 */
export function createResourceLoader<T>(resource: string, load: () => Promise<T>): ResourceLoader<T> {
    let value: T | null = null;
    let pending: Promise<T> | null = null;

    const ensure = (): Promise<T> => {
        if (value !== null) return Promise.resolve(value);
        if (!pending) {
            // 失败时清空 pending：下一次调用会重新请求宿主准备并重新加载，
            // 覆盖宿主资源暂时不可用的场景。
            pending = prepareHostResource(resource)
                .then(load)
                .then(
                    (loaded) => {
                        value = loaded;
                        pending = null;
                        return loaded;
                    },
                    (error: unknown) => {
                        pending = null;
                        throw error;
                    }
                );
        }
        return pending;
    };

    return {
        peek: () => value,
        prefetch: () => {
            void ensure().catch(() => {
                /* 后台预取失败由调用方按需降级，真正的错误在 ensure() 处上报 */
            });
        },
        ensure
    };
}
