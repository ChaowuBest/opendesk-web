/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

// OpenHarmony 沙箱二进制定位（无副作用模块，scan.ts 与 openharmony-sandbox.ts 共用）。
// 优先级：
//   1. OPENDESK_DYNOBOX_BIN 环境变量（真机联调：覆盖为实际可执行路径）
//   2. /data/app/bin/dynobox（OpenDesk-ohos 壳工程打包落盘的真机部署路径，
//      同目录需有 libdynobox.so 供 launcher 查找）
//   3. 打包路径 <resourcesPath>/sandbox/dynobox-ohos
//   4. 开发路径 <repo>/native/openharmony/sandbox/runtime/aarch64-linux-ohos/dynobox
import fs from 'node:fs';
import path from 'node:path';

/** OpenDesk-ohos 壳工程打包后真机上的固定部署路径 */
export const OPENDESK_OHOS_DEPLOYED_BIN = '/data/app/bin/dynobox';

export function resolveOpenHarmonySandboxExecutable(): string | null {
    const electronProcess = process as NodeJS.Process & {
        defaultApp?: boolean;
        resourcesPath?: string;
    };
    // 真机联调钩子：最高优先（HNP 部署等实际可执行位置）
    const override = process.env.OPENDESK_DYNOBOX_BIN;
    if (override && fs.existsSync(override)) return override;
    // 真机 OpenDesk-ohos 部署路径（/data/app/bin/，随壳工程打包）
    if (fs.existsSync(OPENDESK_OHOS_DEPLOYED_BIN)) return OPENDESK_OHOS_DEPLOYED_BIN;
    const dev = path.join(
        process.env.INIT_CWD || process.cwd(),
        'native',
        'openharmony',
        'sandbox',
        'runtime',
        'aarch64-linux-ohos',
        'dynobox'
    );
    if (electronProcess.defaultApp === true) {
        return fs.existsSync(dev) ? dev : null;
    }
    // 打包路径优先；开发路径兜底（CLI/测试等非 Electron 环境也可用）
    const packaged = path.join(electronProcess.resourcesPath || '', 'sandbox', 'dynobox-ohos');
    if (fs.existsSync(packaged)) return packaged;
    return fs.existsSync(dev) ? dev : null;
}

/** 与可执行同目录的 preload 库（launcher 在自身目录查找 libdynobox.so）。 */
export function resolveOpenHarmonySandboxLibrary(): string | null {
    const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
    const executable = resolveOpenHarmonySandboxExecutable();
    if (!executable) return null;
    const candidates: string[] = [];
    // 同目录（launcher 的 find_preload_lib 语义；含真机 /data/app/bin/libdynobox.so）
    candidates.push(path.join(path.dirname(executable), 'libdynobox.so'));
    // 真机固定部署路径兜底
    candidates.push('/data/app/bin/libdynobox.so');
    // 打包布局兜底：resources/sandbox/libdynobox.so
    if (electronProcess.resourcesPath) {
        candidates.push(path.join(electronProcess.resourcesPath, 'sandbox', 'libdynobox.so'));
    }
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}
