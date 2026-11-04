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
 * 目录占用统计。
 *
 * 引擎在每个用例收尾时量一次它自己的目录并记账，界面读记录即可，
 * 不需要在渲染路径上遍历磁盘。
 */

import fs from 'fs';
import path from 'path';

/** 手动重扫历史轮次时的并发上限：再高对机械盘没有收益，反而拖慢单次 readdir/stat */
export const DEFAULT_MEASURE_CONCURRENCY = 32;

/**
 * 用例收尾记账用的并发上限。
 *
 * 比手动重扫低得多：记账发生在别的用例还在跑的间隙，目标是别跟被测任务抢 IO，
 * 而不是尽快量完。单个用例目录也就几千个文件，8 并发足够。
 */
export const CASE_MEASURE_CONCURRENCY = 8;

/**
 * 递归量一个目录的占用字节数。
 *
 * 目录不存在按 0 算；单个文件/子目录在统计途中被删掉（用例清理工作空间时会这样）就跳过，
 * 统计本身不该因为这种竞态失败。
 *
 * 并发是有意的：一轮的 cases 目录常有十几万文件，串行 stat 实测要一分多钟，
 * 限并发下能压到十分之一。并发数不拉太高，否则机械盘上的寻道反而更慢。
 */
export async function measureDirectoryBytes(root: string, concurrency = DEFAULT_MEASURE_CONCURRENCY): Promise<number> {
    let total = 0;
    let active = 0;
    const waiting: Array<() => void> = [];
    /** 同一时刻最多 concurrency 个 FS 操作在跑 */
    const withSlot = async <T>(task: () => Promise<T>): Promise<T> => {
        if (active < concurrency) active += 1;
        else await new Promise<void>((resolve) => waiting.push(resolve));
        try {
            return await task();
        } finally {
            const next = waiting.shift();
            // 名额直接转交给排队的调用方，active 不变
            if (next) next();
            else active -= 1;
        }
    };
    const walk = async (dir: string): Promise<void> => {
        const entries = await withSlot(async () => {
            try {
                return await fs.promises.readdir(dir, { withFileTypes: true });
            } catch {
                return [] as fs.Dirent[];
            }
        });
        // 大目录一次铺开会堆出几十万个 Promise，分批推进入即可，并发由 withSlot 兜住
        for (let i = 0; i < entries.length; i += concurrency) {
            await Promise.all(
                entries.slice(i, i + concurrency).map(async (entry) => {
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await walk(full);
                        return;
                    }
                    if (!entry.isFile()) return;
                    const size = await withSlot(async () => {
                        try {
                            return (await fs.promises.stat(full)).size;
                        } catch {
                            // 竞态：文件刚被清理掉，跳过即可
                            return 0;
                        }
                    });
                    total += size;
                })
            );
        }
    };
    await walk(root);
    return total;
}
