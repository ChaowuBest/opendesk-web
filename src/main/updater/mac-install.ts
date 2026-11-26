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
// staging 同样与目标同目录：rename 才能瞬时完成
const STAGING_SUFFIX = '.opendesk-update-staging';
// hdiutil 在 DMG 损坏/卷冲突/许可协议场景可能永久挂起，超时兜底防止状态卡死 installing
const HDIUTIL_TIMEOUT_MS = 120_000;

export interface MacInstallRunner {
    run(command: string, args: string[]): Promise<void>;
    listDir(directory: string): Promise<string[]>;
    pathExists(target: string): boolean;
}

export function createMacInstallRunner(): MacInstallRunner {
    return {
        run: async (command, args) => {
            if (command === 'hdiutil') {
                await execFileAsync(command, args, { timeout: HDIUTIL_TIMEOUT_MS, killSignal: 'SIGKILL' });
                return;
            }
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
        const stagingPath = appBundlePath + STAGING_SUFFIX;
        // 残留预清理：上次安装中断或备份删除失败会让 backup/staging 残留。
        // BSD mv 对已存在目录会把源移入其内部，不清掉会破坏本次替换与回滚
        if (runner.pathExists(appBundlePath) && runner.pathExists(backupPath)) {
            await runner.run('rm', ['-rf', backupPath]);
        }
        if (runner.pathExists(stagingPath)) {
            await runner.run('rm', ['-rf', stagingPath]);
        }
        // ditto 先复制到同卷临时目录：复制阶段（秒级）失败或进程中断时旧包原封不动，无需回滚
        try {
            await runner.run('ditto', [sourceApp, stagingPath]);
        } catch (error) {
            await runner.run('rm', ['-rf', stagingPath]).catch(() => undefined);
            throw error;
        }
        const hadPreviousBundle = runner.pathExists(appBundlePath) || runner.pathExists(backupPath);
        try {
            if (runner.pathExists(appBundlePath)) await runner.run('mv', [appBundlePath, backupPath]);
            // 两次同卷 rename 瞬时完成：运行中的 app 只暴露在毫秒级窗口内
            await runner.run('mv', [stagingPath, appBundlePath]);
        } catch (error) {
            // 替换失败必须回滚：把旧包从备份移回原位
            if (hadPreviousBundle && runner.pathExists(backupPath)) {
                await runner.run('mv', [backupPath, appBundlePath]);
            }
            throw error;
        }
        // 备份清理失败不遮蔽安装结果（新包已就位）；残留由下次安装的预清理兜底
        if (hadPreviousBundle) await runner.run('rm', ['-rf', backupPath]).catch(() => undefined);
    } finally {
        // 安装成败都要尝试卸载；卸载失败不遮蔽安装结果（卷会在弹出/重启时释放）
        await runner.run('hdiutil', ['detach', mountPoint]).catch(() => undefined);
    }
}
