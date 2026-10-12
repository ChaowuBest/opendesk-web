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

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getLogDirectory, getOpendeskDirectory } from '../../../utils/setting.js';
import type { TaskState } from '../../../aikernel/states/tasks.js';
import { getHomePath } from '../../../../utils/path.js';
import { getTempDir } from '../../../utils/temp.js';
import {
    getHarmonyHomeDirectory,
    getHarmonyRuntimeEnvironment
} from '../../../../platforms/bridges/harmonyos/runtime.js';
import { t } from '../locale/index.js';
import { createSandboxDecideEndpoint } from './sandbox-decide.js';
import { policyTextOpenHarmony } from './dynabox-policy.js';
import { detectToolchainReadOnlyDirs, type DynamicSandboxLaunch } from './linux-sandbox.js';
import { resolveOpenHarmonySandboxExecutable, resolveOpenHarmonySandboxLibrary } from './resolve-ohos.js';

// 复用公共定位逻辑（OPENDESK_DYNOBOX_BIN → /data/app/bin/dynobox → resources → dev）
export { resolveOpenHarmonySandboxExecutable, resolveOpenHarmonySandboxLibrary } from './resolve-ohos.js';

/**
 * OpenHarmony 动态沙箱：dynobox（LD_PRELOAD 身份命名空间）run。路径无映射，
 * 策略规则直接作用于宿主真实路径；受控路径为任务工作区，ask 请求 path 即宿主
 * 真实路径（与 Linux 版同语义：同为 LD_PRELOAD 拦截，无 [[roots]]，工具链目录
 * 走 --ro-dirs 以只读（write-deny）方式暴露）。与 Linux 版的差异：额外用 --tmp
 * 把 /tmp 映射到应用沙箱目录，且应用沙箱 temp/cache 经 writableDirs 在策略放行。
 */
export async function prepareOpenHarmonySandbox(options: {
    shellPath: string;
    shellArgs: string[];
    command: string;
    cwd?: string;
    taskState?: TaskState;
    /** 删除落回收站（OpenDesk 统一回收站，目录见 trashDir） */
    deleteToTrash?: boolean;
    /** 任务级统一回收站目录（<opendesk>/trash/<taskId>），每次拉起都传入 */
    trashDir?: string;
    /** 删除分流排除清单（--trash-exclude）：命中目录前缀真删不入站 */
    trashExcludeDirs?: string[];
    onPermissionWaitChange?: (waiting: boolean) => void;
}): Promise<DynamicSandboxLaunch | null> {
    if ((process.platform as string) !== 'openharmony') return null;
    const executable = resolveOpenHarmonySandboxExecutable();
    if (!executable) throw new Error(t('sandbox.executableMissing.ohos'));

    const workspace = options.cwd || options.taskState?.getWorkspace();
    if (!workspace) throw new Error(t('sandbox.cwdMissing.linux'));
    if (!fs.existsSync(workspace)) {
        throw new Error(t('sandbox.cwdUnsupported.linux', { path: workspace }));
    }

    const configDirectory = getOpendeskDirectory();
    fs.mkdirSync(configDirectory, { recursive: true });
    // crypto.randomUUID：并发任务下进程唯一（避免 Date.now+Math.random 碰撞）
    const runId = `dynamic-sandbox-ohos-${crypto.randomUUID()}`;
    const policyPath = path.join(configDirectory, `${runId}.toml`);
    const logDirectory = path.join(getLogDirectory(), 'sandbox');
    fs.mkdirSync(logDirectory, { recursive: true });
    const logPath = path.join(logDirectory, `${runId}.log`);
    // OpenHarmony 家目录：优先 harmony runtime 的 userHomeDir（/storage/Users/currentUser）；
    // getHomePath() 在 OH 返回 USER_DATA_PATH（应用数据目录）不是家目录，仅兜底
    const harmonyRuntime = getHarmonyRuntimeEnvironment();
    const home = harmonyRuntime ? getHarmonyHomeDirectory(harmonyRuntime) : getHomePath() || process.env.HOME || '';
    // 回收站目录：优先使用宿主统一构建的任务级目录（<opendesk>/trash/<taskId>，
    // 与其他平台一致）；未传入时退回家目录 Trash（系统无回收站；dynobox 会在
    // 缺失时自动创建。用无点目录名，避免鸿蒙文件管理器对隐藏目录的特殊权限处理）
    const trashDir = options.trashDir || (home ? `${home}/Trash` : '');
    // 应用沙箱 temp/cache 总是可读可写（策略放行，无需 ask），另加家目录 .tmp
    // （python 等解释器/工具在家目录的临时文件，见报错“请求编辑 ~/.tmp”）
    const writableDirs = harmonyRuntime
        ? [harmonyRuntime.tempDir, harmonyRuntime.cacheDir, home ? `${home}/.tmp` : ''].filter(Boolean)
        : [];

    const decide = await createSandboxDecideEndpoint({
        taskState: options.taskState,
        onPermissionWaitChange: options.onPermissionWaitChange,
        // 身份命名空间：沙箱内路径即宿主路径，恒等映射（同 Linux）
        pathMapper: (sandboxPath) => sandboxPath
    });
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = (): Promise<void> => {
        if (!cleanupPromise) {
            cleanupPromise = (async () => {
                await decide.cleanup();
                fs.rmSync(policyPath, { force: true });
            })();
        }
        return cleanupPromise;
    };
    try {
        fs.writeFileSync(
            policyPath,
            policyTextOpenHarmony(
                decide.endpoint,
                decide.token,
                workspace,
                options.taskState?.harnessContext.permission?.getRules?.(),
                home,
                writableDirs
            ),
            'utf8'
        );
        // 策略文件含 ask token：收紧权限，防其他本地用户读取后伪造授权请求。
        fs.chmodSync(policyPath, 0o600);
    } catch (error) {
        await cleanup();
        throw error;
    }

    // 回收站目录预创建（dynobox 侧也会建；目录不可写时给出明确错误而非静默直删）。
    // 统一回收站目录随每次拉起创建；家目录 Trash 兜底路径仍按删除开关创建
    if (trashDir && (options.deleteToTrash || options.trashDir)) {
        try {
            fs.mkdirSync(trashDir, { recursive: true });
        } catch {
            throw new Error(t('sandbox.trashDirUnavailable', { path: trashDir }));
        }
    }

    const roDirs = detectToolchainReadOnlyDirs();
    const childArgs = [options.shellPath, ...options.shellArgs];
    return {
        file: executable,
        // 工具链目录经 --ro-dirs 以只读（write-denied）方式暴露，与 Linux 版一致。
        args: [
            'run',
            '--policy',
            policyPath,
            '--upstream',
            decide.endpoint,
            '--cwd',
            workspace,
            '--log-file',
            logPath,
            // /tmp 映射到应用沙箱临时目录（可读可写，无需策略规则；鸿蒙 /tmp 只读）
            '--tmp',
            getTempDir(),
            // 任务级回收站目录无论删除开关与否都传入（值由宿主统一构建，与
            // Windows/Linux 的 --trash-dir 格式一致）；原生层仅在 --del-to-trash
            // 启用时使用（--trash 为 --trash-dir 的兼容别名，二者等价）
            ...(options.trashDir ? ['--trash-dir', options.trashDir] : []),
            ...(options.deleteToTrash ? ['--del-to-trash'] : []),
            // 排除清单：命中目录前缀的删除真删不入站（构建零时产物零噪音）
            ...(options.trashExcludeDirs ?? []).flatMap((dir) => ['--trash-exclude', dir]),
            ...(roDirs.length > 0 ? ['--ro-dirs', roDirs.join(',')] : []),
            '--',
            ...childArgs
        ],
        cwd: undefined,
        // 工具链缓存重定向到宿主持久缓存目录：避免写宿主家目录不可见路径或把
        // 宿主可写缓存暴露进沙箱；持久目录让跨沙箱实例复用（首次才下载依赖）。
        // 与 linux-sandbox 的 CARGO_HOME/GOCACHE 同语义。
        env: {
            CARGO_HOME: `${home}/.cache/opendesk-sandbox/cargo`,
            npm_config_cache: `${home}/.cache/opendesk-sandbox/npm`,
            GOCACHE: `${home}/.cache/opendesk-sandbox/go`,
            GOPATH: `${home}/.cache/opendesk-sandbox/gopath`,
            XDG_CACHE_HOME: `${home}/.cache/opendesk-sandbox/xdg`,
            // Python 字节码缓存重定向：3.8+ 的 import 写 __pycache__ 到镜像树
            //（/data/app/python.org 等安装目录零落盘），落点在
            // ~/.cache/opendesk-sandbox/pycache（读已由 node app 策略
            // {home}/.cache/opendesk-sandbox/** read allow 覆盖）。
            // 旧版 Python（<3.8）不认此变量，回退 /**/__pycache__/** 兜底规则。
            PYTHONPYCACHEPREFIX: `${home}/.cache/opendesk-sandbox/pycache`
        },
        attach: (proc) => {
            const finish = () => {
                void cleanup().catch(() => undefined);
            };
            proc.once('exit', finish);
            proc.once('close', finish);
            proc.once('error', finish);
        },
        cleanup
    };
}
