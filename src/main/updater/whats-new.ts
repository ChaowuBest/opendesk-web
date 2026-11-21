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

import fs from 'node:fs';
import path from 'node:path';
import { isValidVersion } from '../utils/version.js';

// 用户已预览过「版本更新内容」弹窗的版本号历史：只增不删。
// 启动流程据此判定当前版本的更新内容是否需要展示，与自动更新升级流程解耦。
const WHATS_NEW_SEEN_FILE_NAME = 'whats-new-seen.json';

function seenFilePath(stateDirectory: string): string {
    return path.join(stateDirectory, WHATS_NEW_SEEN_FILE_NAME);
}

export async function readWhatsNewSeen(stateDirectory: string): Promise<string[]> {
    const target = seenFilePath(stateDirectory);
    try {
        const raw = JSON.parse(await fs.promises.readFile(target, 'utf8')) as { seen?: unknown };
        if (!Array.isArray(raw.seen)) {
            // 形状不对视同损坏：清掉坏文件，当作从未预览过
            await fs.promises.rm(target, { force: true });
            return [];
        }
        // 只保留合法 SemVer 条目：坏条目既不能污染判定，也不能挤掉合法历史
        return raw.seen.filter((entry): entry is string => typeof entry === 'string' && isValidVersion(entry));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            // 坏文件自愈：删掉后当作从未预览过
            await fs.promises.rm(target, { force: true });
        }
        return [];
    }
}

// 启动判定：严格"当前版本 ∈ seen"才跳过弹窗。
// 用户手动装回老版本时，该版本可能已在历史里，属预期行为。
export async function hasPreviewedReleaseNotes(stateDirectory: string, currentVersion: string): Promise<boolean> {
    return (await readWhatsNewSeen(stateDirectory)).includes(currentVersion);
}

// 弹窗 dismiss 后落账：把当前版本追加进 seen 历史
export async function markReleaseNotesSeen(stateDirectory: string, version: string): Promise<void> {
    const seen = await readWhatsNewSeen(stateDirectory);
    if (seen.includes(version)) return;
    seen.push(version);
    const target = seenFilePath(stateDirectory);
    // 与更新流程解耦后不能假设缓存目录已存在：从未进入更新流程的安装也要能落账
    await fs.promises.mkdir(stateDirectory, { recursive: true });
    // 与 ready.json 相同的原子写法：tmp + rename，进程中途崩溃不会留下半截记录
    await fs.promises.writeFile(`${target}.tmp`, JSON.stringify({ seen }, null, 4), 'utf8');
    await fs.promises.rm(target, { force: true });
    await fs.promises.rename(`${target}.tmp`, target);
}
