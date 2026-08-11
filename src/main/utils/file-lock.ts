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
 * 通用文件锁：按解析后的绝对路径共享互斥访问。
 *
 * 相同路径（包括通过 `.` / `..` 等不同写法指向同一文件的情况）返回同一把锁，
 * 不同路径互不干扰。适用于需要对同一文件进行原子读-改-写操作的场景。
 */

import path from 'path';
import { Mutex } from 'async-mutex';

export class FileLock {
    /** 模块级共享：resolved path → Mutex */
    private static readonly locks = new Map<string, Mutex>();

    private readonly mutex: Mutex;
    private readonly resolvedPath: string;

    constructor(filePath: string) {
        this.resolvedPath = path.resolve(filePath);
        let mutex = FileLock.locks.get(this.resolvedPath);
        if (!mutex) {
            mutex = new Mutex();
            FileLock.locks.set(this.resolvedPath, mutex);
        }
        this.mutex = mutex;
    }

    /** 返回此锁对应的已解析绝对路径。 */
    get resolved(): string {
        return this.resolvedPath;
    }

    /** 当前锁是否被持有。 */
    isLocked(): boolean {
        return this.mutex.isLocked();
    }

    /**
     * 在独占锁内执行回调，确保同一文件的并发操作串行化。
     *
     * 回调正常返回或抛出异常时都会自动释放锁。
     */
    async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
        return this.mutex.runExclusive(fn);
    }
}
