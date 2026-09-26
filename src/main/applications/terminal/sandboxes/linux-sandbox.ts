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
import { createSandboxDecideEndpoint } from './sandbox-decide.js';
import { policyTextLinux } from './dynabox-policy.js';

export interface DynamicSandboxLaunch {
    file: string;
    args: string[];
    cwd?: string;
    /** 附加环境变量（spawn 时与继承环境合并，如工具链缓存重定向到沙箱内 /tmp） */
    env?: Record<string, string>;
    attach: (process: ChildProcess) => void;
    cleanup: () => Promise<void>;
}

/**
 * 解析 Linux 动态沙箱二进制：
 * - 开发运行：native/linux/sandbox/target/release/dynobox-linux
 * - 安装包：resources/sandbox/dynobox-linux（由 forge stageLinuxSandboxResource 落盘）
 */
export function resolveLinuxSandboxExecutable(): string | null {
    const electronProcess = process as NodeJS.Process & {
        defaultApp?: boolean;
        resourcesPath?: string;
    };
    const dev = path.join(
        process.env.INIT_CWD || process.cwd(),
        'native',
        'linux',
        'sandbox',
        'target',
        'release',
        'dynobox-linux'
    );
    if (electronProcess.defaultApp === true) {
        return fs.existsSync(dev) ? dev : null;
    }
    // 打包路径优先；开发路径兜底（CLI/测试等非 Electron 环境也可用）
    const packaged = path.join(electronProcess.resourcesPath || '', 'sandbox', 'dynobox-linux');
    if (fs.existsSync(packaged)) return packaged;
    return fs.existsSync(dev) ? dev : null;
}

/**
 * 探测沙箱内需要可见的工具链目录（二进制所在目录，只读挂载）：
 * - 从 PATH 解析常见工具（node/npm/npx/cargo/rustc/go/python3 等）的所在目录；
 * - 补充常见布局候选（nvm/cargo/rustup/go），存在才加入。
 * 缓存/配置目录（~/.npm、~/.cargo/registry 等）刻意不挂：通过环境变量重定向到
 * 沙箱内 /tmp（见 prepareLinuxSandbox 的 env），避免把宿主可写路径暴露进沙箱。
 */
export function detectToolchainReadOnlyDirs(env: NodeJS.ProcessEnv = process.env): string[] {
    const candidates: string[] = [];
    const add = (dir: string) => {
        if (dir && fs.existsSync(dir) && !candidates.includes(dir)) candidates.push(dir);
    };
    const tools = ['node', 'npm', 'npx', 'pnpm', 'yarn', 'cargo', 'rustc', 'go', 'python3', 'python'];
    // PATH 分隔符平台自适应：Windows 用 ';'；POSIX 用 ':'。测试可能显式传
    // Linux 风格（':' 分隔）字符串，因此在 Windows 上需额外识别盘符（C:）
    // 以免把 "C:\bin:D:\bin" 切成碎片。实现：先按 ';' 拆；若无 ';' 再按
    // ':' 拆，单字母段（盘符）与下一段合并。
    const rawPath = env.PATH || '';
    let pathValue: string[];
    if (rawPath.includes(';')) {
        pathValue = rawPath.split(';').filter(Boolean);
    } else {
        const segs = rawPath.split(':').filter(Boolean);
        pathValue = [];
        for (let i = 0; i < segs.length; i++) {
            // 单字母盘符段（C / D）与后续段合并成 "C:\..."
            if (i + 1 < segs.length && /^[A-Za-z]$/.test(segs[i])) {
                pathValue.push(`${segs[i]}:${segs[i + 1]}`);
                i++;
            } else {
                pathValue.push(segs[i]);
            }
        }
    }
    for (const tool of tools) {
        for (const base of pathValue) {
            const bin = path.join(base, tool);
            if (fs.existsSync(bin)) {
                add(path.resolve(base));
                break; // 取第一个命中即可
            }
        }
    }
    const home = env.HOME || '';
    if (home) {
        for (const candidate of [
            'nvm',
            'nvm/versions',
            'cargo/bin',
            'rustup/toolchains',
            'rustup',
            '.local/go/bin',
            '.local/bin',
            '.local/share/pnpm'
        ]) {
            add(path.join(home, candidate));
        }
    }
    return candidates;
}

/**
 * Linux 动态沙箱：dynobox-linux run。透明路径——沙箱内路径与宿主一致，受控路径
 * 为任务工作区（roots virtual=real=workspace），ask 请求 path 即宿主真实路径。
 */
export async function prepareLinuxSandbox(options: {
    shellPath: string;
    shellArgs: string[];
    command: string;
    cwd?: string;
    taskState?: TaskState;
    /** 删除送回收站（XDG Trash） */
    deleteToTrash?: boolean;
    onPermissionWaitChange?: (waiting: boolean) => void;
}): Promise<DynamicSandboxLaunch | null> {
    if (process.platform !== 'linux') return null;
    const executable = resolveLinuxSandboxExecutable();
    if (!executable) throw new Error(t('sandbox.executableMissing.linux'));

    const workspace = options.cwd || options.taskState?.getWorkspace();
    if (!workspace) throw new Error(t('sandbox.cwdMissing.linux'));
    if (!fs.existsSync(workspace)) {
        throw new Error(t('sandbox.cwdUnsupported.linux', { path: workspace }));
    }

    const configDirectory = getOpendeskDirectory();
    fs.mkdirSync(configDirectory, { recursive: true });
    // crypto.randomUUID：并发任务下进程唯一（避免 Date.now+Math.random 碰撞）
    const runId = `dynamic-sandbox-linux-${crypto.randomUUID()}`;
    const policyPath = path.join(configDirectory, `${runId}.toml`);
    const logDirectory = path.join(getLogDirectory(), 'sandbox');
    fs.mkdirSync(logDirectory, { recursive: true });
    const logPath = path.join(logDirectory, `${runId}.log`);

    const decide = await createSandboxDecideEndpoint({
        taskState: options.taskState,
        onPermissionWaitChange: options.onPermissionWaitChange,
        // 透明路径：沙箱内路径即宿主路径，恒等映射
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
            policyTextLinux(
                decide.endpoint,
                decide.token,
                workspace,
                options.taskState?.harnessContext.permission?.getRules?.(),
                process.env.HOME
            ),
            'utf8'
        );
        // 策略文件含 ask token：收紧权限，防其他本地用户读取后伪造授权请求。
        // writeFileSync 的 mode 仅对新建文件生效，chmod 兜底（防 umask 影响/预存在）
        fs.chmodSync(policyPath, 0o600);
    } catch (error) {
        await cleanup();
        throw error;
    }

    const roDirs = detectToolchainReadOnlyDirs();
    const childArgs = [options.shellPath, ...options.shellArgs];
    return {
        file: executable,
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
            ...(options.deleteToTrash ? ['--del-to-trash'] : []),
            ...(roDirs.length > 0 ? ['--ro-dirs', roDirs.join(',')] : []),
            '--',
            ...childArgs
        ],
        cwd: undefined,
        // 工具链缓存重定向到宿主持久缓存目录（~/.cache/opendesk-sandbox/...）：
        // 避免写宿主家目录不可见路径或把宿主可写缓存暴露进沙箱；持久目录让
        // CARGO_HOME/npm 缓存跨沙箱实例复用（首次构建才需网络下载依赖）。
        // 注意：RUSTUP_HOME 不在此列——工具链目录已由 --ro-dirs 从宿主 ~/.rustup
        // 只读挂载，重定向会导致 rustc 找不到 toolchain。
        env: {
            CARGO_HOME: `${process.env.HOME || ''}/.cache/opendesk-sandbox/cargo`,
            npm_config_cache: `${process.env.HOME || ''}/.cache/opendesk-sandbox/npm`,
            GOCACHE: `${process.env.HOME || ''}/.cache/opendesk-sandbox/go`,
            GOPATH: `${process.env.HOME || ''}/.cache/opendesk-sandbox/gopath`,
            XDG_CACHE_HOME: `${process.env.HOME || ''}/.cache/opendesk-sandbox/xdg`
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
