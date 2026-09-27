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
import type { ChildProcess } from 'node:child_process';
import { getLogDirectory, getOpendeskDirectory } from '../../../utils/setting.js';
import type { TaskState } from '../../../aikernel/states/tasks.js';
import { t } from '../locale/index.js';
import { ensureSandboxLoopback } from './loopback.js';
import { ensureSandboxPipes } from './pipes.js';
import { virtualPathToHostPath } from './ask-path.js';
import { createSandboxDecideEndpoint } from './sandbox-decide.js';
import { policyText } from './dynabox-policy.js';

export interface DynamicSandboxLaunch {
    file: string;
    args: string[];
    cwd?: string;
    attach: (process: ChildProcess) => void;
    cleanup: () => Promise<void>;
}

function resolveSandboxExecutable(): string | null {
    if (process.platform !== 'win32') return null;
    const electronProcess = process as NodeJS.Process & {
        defaultApp?: boolean;
        resourcesPath?: string;
    };
    const executable =
        electronProcess.defaultApp === true
            ? path.join(process.env.INIT_CWD || process.cwd(), 'native', 'windows', 'sandbox', 'runtime', 'sandbox.exe')
            : path.join(electronProcess.resourcesPath || '', 'sandbox', 'sandbox.exe');
    return fs.existsSync(executable) ? executable : null;
}

function quotePowerShell(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function isPowerShell(shellPath: string): boolean {
    return /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(shellPath);
}

/** Map a host drive path to the stable root-relative path exposed by --automount. */
export function mapHostPathToSandboxRoot(value: string): string | null {
    const normalized = path.win32.normalize(value.replace(/\//g, '\\'));
    const drivePath = /^([A-Za-z]):\\(.*)$/.exec(normalized);
    if (!drivePath) return null;
    const suffix = drivePath[2].replace(/\\/g, '/');
    return `/${drivePath[1].toUpperCase()}/${suffix}`;
}

/**
 * Enter the mapped workspace before the user command so descendants inherit the task cwd.
 * 仅支持 PowerShell：动态沙箱（prepareDynamicSandbox）只会启动 powershell/pwsh，
 * 其他 shell 仅做 cwd 可映射性校验，不会注入切换目录前缀。
 */
export function withSandboxWorkingDirectory(shellPath: string, shellArgs: string[], cwd?: string): string[] {
    const childArgs = shellArgs.slice();
    if (!cwd) return childArgs;
    const mappedCwd = mapHostPathToSandboxRoot(cwd);
    if (!mappedCwd) {
        throw new Error(t('sandbox.cwdUnsupported', { path: cwd }));
    }
    if (!isPowerShell(shellPath)) return childArgs;
    const commandIndex = childArgs.findIndex((arg) => arg === '-Command' || arg === '-c');
    if (commandIndex >= 0 && commandIndex + 1 < childArgs.length) {
        childArgs[commandIndex + 1] =
            `Set-Location -LiteralPath ${quotePowerShell(mappedCwd)}; ${childArgs[commandIndex + 1]}`;
    }
    return childArgs;
}

function quoteWindowsArgument(value: string): string {
    if (value && !/[\s"]/.test(value)) return value;
    return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

export function sandboxRunArgs(options: {
    policyPath: string;
    endpoint: string;
    logPath: string;
    deleteToTrash?: boolean;
    childCommand: string;
    envExtra?: Record<string, string>;
}): string[] {
    return [
        'run',
        '--automount',
        // 开启后沙箱内的直接删除送 Windows 回收站；必须位于 -- 分隔符之前。
        // 本沙箱实例运行期间新建的文件由原生侧跟踪，删除时直接清除不进回收站，
        // 无需宿主传参
        ...(options.deleteToTrash ? ['--del-to-trash'] : []),
        '--policy',
        options.policyPath,
        '--upstream',
        options.endpoint,
        '--log-file',
        options.logPath,
        // 工具链缓存重定向（npm_config_cache 等指向宿主持久目录，跨实例复用）；
        // --env 可重复，每个 NAME=VALUE 一个
        ...Object.entries(options.envExtra ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
        '--',
        options.childCommand
    ];
}

export async function prepareDynamicSandbox(options: {
    shellPath: string;
    shellArgs: string[];
    command: string;
    cwd?: string;
    taskState?: TaskState;
    deleteToTrash?: boolean;
    /**
     * 沙箱触发权限管控、弹窗等待用户决策时的回调：
     * waiting=true 表示开始等待（宿主应暂停工具超时计时），
     * waiting=false 表示决策已返回（批准或拒绝，恢复计时）。
     */
    onPermissionWaitChange?: (waiting: boolean) => void;
}): Promise<DynamicSandboxLaunch | null> {
    if (process.platform !== 'win32') return null;
    // Only the selected Windows pwsh tool requests a native sandbox launch.
    if (!isPowerShell(options.shellPath)) return null;

    const executable = resolveSandboxExecutable();
    if (!executable) throw new Error(t('sandbox.executableMissing'));
    // 校验并映射工作目录必须先于任何宿主侧资源（授权端点、策略文件）的分配，
    // 否则不可映射的 cwd（UNC/相对路径）抛错时会泄漏已监听的服务器与临时文件。
    const childArgs = withSandboxWorkingDirectory(options.shellPath, options.shellArgs, options.cwd);
    await ensureSandboxLoopback(executable);
    // 可选增强：放通沙箱内命名管道（需要管理员，失败静默——由失败诊断兜底）
    void ensureSandboxPipes(executable);
    const configDirectory = getOpendeskDirectory();
    fs.mkdirSync(configDirectory, { recursive: true });
    const runId = `dynamic-sandbox-${crypto.randomUUID()}`;
    const policyPath = path.join(configDirectory, `${runId}.toml`);
    const logDirectory = path.join(getLogDirectory(), 'sandbox');
    fs.mkdirSync(logDirectory, { recursive: true });
    const logPath = path.join(logDirectory, `${runId}.log`);
    const decide = await createSandboxDecideEndpoint({
        taskState: options.taskState,
        onPermissionWaitChange: options.onPermissionWaitChange,
        pathMapper: virtualPathToHostPath,
        caseInsensitivePathKey: true
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
            policyText(
                decide.endpoint,
                decide.token,
                options.taskState?.harnessContext.permission?.getRules?.(),
                process.env.USERPROFILE
            ),
            'utf8'
        );
        // 策略文件含 ask token：收紧权限（Windows 上为继承 ACL，chmod 为无害对齐）
        fs.chmodSync(policyPath, 0o600);
    } catch (error) {
        await cleanup();
        throw error;
    }

    // 工具链缓存重定向到宿主持久目录（~/.cache/opendesk-sandbox/...）：npm 缓存
    // 跨沙箱实例复用（首次构建才需下载），且写放行已由 policyText 的 cacheRoot
    // 规则覆盖。与 linux-sandbox.ts 的 CARGO_HOME/GOCACHE 同语义；Windows 侧暂只
    // 重定向 npm（jest 的 transform 缓存经镜像层共享 Temp 别名自动落在宿主
    // %TEMP%\jest，见 dynobox Runner 的 ConfigureSharedTempAlias，无需也无效的
    // JEST_CACHE_DIR 环境变量——jest 只认 os.tmpdir()/jest 与 cacheDirectory 配置）。
    const cacheRoot = process.env.USERPROFILE
        ? `${process.env.USERPROFILE.replace(/\\/g, '/')}/.cache/opendesk-sandbox`
        : null;
    const envExtra: Record<string, string> = {};
    if (cacheRoot) {
        envExtra['npm_config_cache'] = `${cacheRoot}/npm`;
    }
    // --preserve-symlinks：unrs-resolver（jest-resolve 底层）对虚拟卷上 junction
    // 化的共享 Temp 做默认 realpath 时会报 NOT_A_REPARSE_POINT (os error 4390)，
    // 导致 jest 环境内 import 绝对路径报 Cannot find module。该 flag 让
    // jest-resolve 跳过 symlink 解析绕开此问题（对普通命令无影响）。
    // 仅在用户未自行设置 NODE_OPTIONS 时注入，避免覆盖用户配置。
    if (!process.env.NODE_OPTIONS) {
        envExtra['NODE_OPTIONS'] = '--preserve-symlinks';
    }

    const childCommand = [options.shellPath, ...childArgs].map(quoteWindowsArgument).join(' ');
    return {
        file: executable,
        args: sandboxRunArgs({
            policyPath,
            endpoint: decide.endpoint,
            logPath,
            deleteToTrash: options.deleteToTrash,
            childCommand,
            envExtra
        }),
        cwd: undefined,
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

// 兼容导出：策略生成函数迁至 dynabox-policy.ts（保持既有调用方/测试的 import 有效）
export {
    expandPermissionPattern,
    hostPatternToVirtual,
    permissionRulesForSandbox,
    policyText
} from './dynabox-policy.js';
