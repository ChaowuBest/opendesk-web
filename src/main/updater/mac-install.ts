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

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// 备份与目标 .app 同目录，保证 mv 在同一卷上是原子操作
const BACKUP_SUFFIX = '.opendesk-update-backup';

export interface MacInstallRunner {
    run(command: string, args: string[]): Promise<void>;
    listDir(directory: string): Promise<string[]>;
    pathExists(target: string): boolean;
}

export function createMacInstallRunner(): MacInstallRunner {
    return {
        run: async (command, args) => {
            await execFileAsync(command, args);
        },
        listDir: (directory) => fs.promises.readdir(directory),
        pathExists: (target) => fs.existsSync(target)
    };
}

// macOS 允许替换正在运行的应用 bundle（可执行文件已加载进内存），
// 但 execPath 必须确实来自一个 .app bundle，否则没有可替换的安装位置
export function resolveAppBundlePath(execPath: string): string | undefined {
    if (path.basename(path.dirname(execPath)) !== 'MacOS') return undefined;
    const contents = path.dirname(path.dirname(execPath));
    if (path.basename(contents) !== 'Contents') return undefined;
    const bundle = path.dirname(contents);
    return bundle.toLowerCase().endsWith('.app') ? bundle : undefined;
}

export async function findAppBundleOnVolume(volumePath: string, runner: MacInstallRunner): Promise<string> {
    const entries = await runner.listDir(volumePath);
    const apps = entries.filter((entry) => entry.toLowerCase().endsWith('.app')).sort();
    if (apps.length === 0) {
        throw new Error(`No application bundle found on the mounted image ${volumePath}`);
    }
    return path.join(volumePath, apps[0]);
}

export interface InstallFromDmgOptions {
    dmgPath: string;
    appBundlePath: string;
    // 挂载点由调用方生成（保证唯一），避免与用户已挂载的同名卷冲突
    mountPoint: string;
    runner: MacInstallRunner;
}

export async function installFromDmg(options: InstallFromDmgOptions): Promise<void> {
    const { dmgPath, appBundlePath, mountPoint, runner } = options;
    await runner.run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath]);
    try {
        const sourceApp = await findAppBundleOnVolume(mountPoint, runner);
        const backupPath = appBundlePath + BACKUP_SUFFIX;
        const hadPreviousBundle = runner.pathExists(appBundlePath);
        if (hadPreviousBundle) await runner.run('mv', [appBundlePath, backupPath]);
        try {
            // ditto 会保留 bundle 的元数据与权限，是替换 .app 的标准做法
            await runner.run('ditto', [sourceApp, appBundlePath]);
        } catch (error) {
            // 替换失败必须回滚：清掉半安装目录，把旧包移回原位
            if (hadPreviousBundle) {
                await runner.run('rm', ['-rf', appBundlePath]);
                await runner.run('mv', [backupPath, appBundlePath]);
            }
            throw error;
        }
        if (hadPreviousBundle) await runner.run('rm', ['-rf', backupPath]);
    } finally {
        // 安装成败都要尝试卸载；卸载失败不遮蔽安装结果（卷会在弹出/重启时释放）
        await runner.run('hdiutil', ['detach', mountPoint]).catch(() => undefined);
    }
}
