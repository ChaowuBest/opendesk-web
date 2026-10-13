/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the software at http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { getLogDirectory, getOpendeskDirectory } from '../../../utils/setting.js';
import type { TaskState } from '../../../aikernel/states/tasks.js';
import { t } from '../locale/index.js';
import { createSandboxDecideEndpoint } from './sandbox-decide.js';
import { policyTextLinux } from './dynabox-policy.js';
import type { DynamicSandboxLaunch } from './linux-sandbox.js';

export type { DynamicSandboxLaunch };

/**
 * 解析 darwin 动态沙箱 dylib：
 * - 开发运行：native/darwin/sandbox/runtime/dynobox-darwin.dylib
 * - 安装包：resources/sandbox/dynobox-darwin.dylib（由 forge stageDarwinSandboxResource 落盘）
 */
export function resolveDarwinSandboxDylib(): string | null {
    const electronProcess = process as NodeJS.Process & {
        defaultApp?: boolean;
        resourcesPath?: string;
    };
    const dev = path.join(
        process.env.INIT_CWD || process.cwd(),
        'native',
        'darwin',
        'sandbox',
        'runtime',
        'dynobox-darwin.dylib'
    );
    if (electronProcess.defaultApp === true) {
        return fs.existsSync(dev) ? dev : null;
    }
    // resourcesPath 缺失时 path.join 会产出相对路径，可能误中工作目录同名文件
    const packaged = electronProcess.resourcesPath
        ? path.join(electronProcess.resourcesPath, 'sandbox', 'dynobox-darwin.dylib')
        : null;
    if (packaged && fs.existsSync(packaged)) return packaged;
    return fs.existsSync(dev) ? dev : null;
}

/** Mach-O 代码签名 CodeDirectory flags（_dyld_interpose 判定所需的子集） */
const CS_ADHOC = 0x00000002;
const CS_RUNTIME = 0x10000;
const CS_LINKER_SIGNED = 0x20000;

interface MachOCodeFlags {
    flags: number;
}

function readU32(buffer: Buffer, offset: number, bigEndian = false): number {
    return bigEndian ? buffer.readUInt32BE(offset) : buffer.readUInt32LE(offset);
}

/** 读 u64 偏移（fat_arch_64）：Number 安全上限内（Mach-O 文件 < 2^53）直接转 */
function readU64BEAsNumber(buffer: Buffer, offset: number): number {
    const big = buffer.readBigUInt64BE(offset);
    return Number(big);
}

/** 打开文件并读取指定偏移的 Buffer；文件尾允许短读，读取失败返回 null */
function readChunk(fd: number, offset: number, length: number): Buffer | null {
    const buffer = Buffer.alloc(length);
    const bytes = fs.readSync(fd, buffer, 0, length, offset);
    return bytes > 0 ? buffer.subarray(0, bytes) : null;
}

/**
 * 读取 Mach-O（含 fat）目标架构 slice 的 CodeDirectory flags。
 * 解析规则与原生侧 boxdylib.c 的 read_code_flags 一致；失败返回 null
 * （非 Mach-O 如脚本，由调用方按"无需重签"处理）。
 *
 * 按需分块读取（header ≤ 4KB、签名区 ≤ 64KB），不限文件大小——整读大文件
 * 会把内存峰值拉到数 MB 且签名区可能落在窗口外。
 */
export function readCodeDirectoryFlags(
    filePath: string,
    arch: NodeJS.Architecture = process.arch
): MachOCodeFlags | null {
    let fd: number;
    try {
        fd = fs.openSync(filePath, 'r');
    } catch {
        return null;
    }
    try {
        const head = readChunk(fd, 0, 4096);
        if (!head || head.length < 32) return null;
        const magic = readU32(head, 0);
        let sliceOffset = 0;
        const wantCpuType = arch === 'arm64' ? 0x0100000c : 0x01000007;
        const isFat32 = magic === 0xcafebabe || magic === 0xbebafeca;
        const isFat64 = magic === 0xcafebabf || magic === 0xbfbafecb;
        if (isFat32 || isFat64) {
            // fat：header 8 字节（大端）+ fat_arch 20 / fat_arch_64 32 字节每项
            const nfat = head.readUInt32BE(4);
            const entrySize = isFat64 ? 32 : 20;
            if (nfat > 16 || 8 + nfat * entrySize > head.length) return null;
            let found = false;
            for (let i = 0; i < nfat; i++) {
                const entry = 8 + i * entrySize;
                const cputype = readU32(head, entry, true);
                if (cputype === wantCpuType) {
                    // offset 在 entry + 8（fat_arch）/+ 8（fat_arch_64 同位）
                    sliceOffset = isFat64 ? readU64BEAsNumber(head, entry + 8) : readU32(head, entry + 8, true);
                    found = true;
                    break;
                }
            }
            if (!found) return null;
        }
        const sliceHead = readChunk(fd, sliceOffset, 32);
        if (!sliceHead) return null;
        const sliceMagic = readU32(sliceHead, 0);
        if (
            sliceMagic !== 0xfeedfacf &&
            sliceMagic !== 0xcffaedfe &&
            sliceMagic !== 0xfeedface &&
            sliceMagic !== 0xcefaedfe
        ) {
            return null;
        }
        const swap = sliceMagic === 0xcffaedfe || sliceMagic === 0xcefaedfe;
        const ncmds = readU32(sliceHead, 16, swap);
        if (ncmds > 4096) return null;
        const headerSize = sliceMagic === 0xfeedfacf || sliceMagic === 0xcffaedfe ? 32 : 28;
        // sizeofcmds 在 mach_header 偏移 20：精确按其大小读 LC 表（超大 dylib 的
        // LC 表可超 64KB，固定窗口会把"命令越界"误判为解析失败 → 漏重签）
        const sizeofcmds = readU32(sliceHead, 20, swap);
        if (sizeofcmds === 0 || sizeofcmds > 32 * 1024 * 1024) return null;
        const lcBuffer = readChunk(fd, sliceOffset + headerSize, sizeofcmds);
        if (!lcBuffer || lcBuffer.length < sizeofcmds) return null;
        let pos = 0;
        for (let i = 0; i < ncmds; i++) {
            if (pos + 8 > lcBuffer.length) return null;
            const cmd = readU32(lcBuffer, pos, swap);
            const cmdsize = readU32(lcBuffer, pos + 4, swap);
            if (cmdsize < 8 || pos + cmdsize > lcBuffer.length) return null;
            if (cmd === 0x1d) {
                // LC_CODE_SIGNATURE：linkedit_data_command = {cmd, cmdsize, dataoff, datasize}
                const dataoff = readU32(lcBuffer, pos + 8, swap);
                // 签名 blob 统一大端；CS_SuperBlob = {magic, length, count, index[]}
                const superBlob = readChunk(fd, sliceOffset + dataoff, 12);
                if (!superBlob) return null;
                const superMagic = readU32(superBlob, 0, true);
                if (superMagic !== 0xfade0cc0) return null;
                const count = readU32(superBlob, 8, true);
                const indexBuffer = readChunk(fd, sliceOffset + dataoff + 12, Math.min(count, 16) * 8);
                if (!indexBuffer) return null;
                for (let s = 0; s < count && s < 16; s++) {
                    const type = readU32(indexBuffer, s * 8, true);
                    if (type !== 0) continue; // 0 = CSSLOT_CODEDIRECTORY
                    const cdOffset = readU32(indexBuffer, s * 8 + 4, true);
                    const cd = readChunk(fd, sliceOffset + dataoff + cdOffset, 16);
                    if (!cd) return null;
                    // CodeDirectory = {magic, length, version, flags}
                    return { flags: readU32(cd, 12, true) };
                }
                return null;
            }
            pos += cmdsize;
        }
        return null;
    } catch {
        return null;
    } finally {
        try {
            fs.closeSync(fd);
        } catch {
            // 关闭失败不影响结果
        }
    }
}

/**
 * 二进制是否需要 复制+adhoc 重签 后才能被 DYLD 注入：
 * - 平台二进制（无 CS_ADHOC）或 hardened runtime（CS_RUNTIME）：需要；
 * - linker-signed / 普通签名：直接注入。
 * 读不到签名（脚本等）返回 false——脚本由解释器执行，走沙箱内 shebang 改写。
 */
export function needsExecResign(filePath: string, arch: NodeJS.Architecture = process.arch): boolean {
    const parsed = readCodeDirectoryFlags(filePath, arch);
    if (!parsed) return false;
    if (parsed.flags & CS_LINKER_SIGNED) return false;
    if (!(parsed.flags & CS_ADHOC) || parsed.flags & CS_RUNTIME) return true;
    return false;
}

function sha256Hex(filePath: string): string | null {
    try {
        // 流式哈希：平台二进制（/bin/zsh 约 3MB）整读入内存无必要
        const hash = crypto.createHash('sha256');
        const fd = fs.openSync(filePath, 'r');
        try {
            const buffer = Buffer.alloc(1024 * 1024);
            for (;;) {
                const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
                if (bytes <= 0) break;
                hash.update(buffer.subarray(0, bytes));
            }
        } finally {
            fs.closeSync(fd);
        }
        return hash.digest('hex');
    } catch {
        return null;
    }
}

/**
 * 平台二进制重签：复制到缓存（<hash>/<原basename> 目录布局，与原生侧 dylib
 * 共用同一命名规则，保证宿主启动的 shell 与沙箱内 exec 的重签副本一致），
 * codesign adhoc 重签。已有缓存直接复用。失败返回 null（调用方回退原路径）。
 *
 * 目录化原因：xcode-select 的 tool-shim（/usr/bin/python3 等系统工具）运行时
 * 按自身 basename 到 CLT 的 usr/bin/ 下查找真实工具——平铺 <hash>.bin 名字
 * 对不上，shim 报 "Failed to locate ... requesting installation of command
 * line developer tools"（exit 72）。目录化后 basename 保持原名，shim 正常。
 */
export function resignCopyForExec(filePath: string, cacheDir: string): string | null {
    const hex = sha256Hex(filePath);
    if (!hex) return null;
    const base = path.basename(filePath);
    if (!base) return null;
    const hashDir = path.join(cacheDir, hex);
    const cached = path.join(hashDir, base);
    fs.mkdirSync(hashDir, { recursive: true });
    // 同一平台二进制的哈希全局唯一：并发沙箱实例同时冷启动时，用独占锁文件
    // 串行化 重签→rename，避免 codesign 交叉覆盖。锁退化（无法创建）时直接
    // 尝试复用既有缓存。持锁者崩溃后锁残留：锁文件含 pid 与时间戳，超时视为
    // 死锁残留并抢占（重签幂等，最坏情况是重复一次 copy+codesign）。
    const LOCK_STALE_MS = 30000;
    const lockPath = `${cached}.lock`;
    let locked = false;
    try {
        fs.writeFileSync(lockPath, `${process.pid} ${Date.now()}`, { flag: 'wx' });
        locked = true;
    } catch {
        // EEXIST：锁被占用。残留锁（超过 LOCK_STALE_MS）抢占；无时间戳的旧格式
        // 锁（Number(undefined)=NaN）按残留处理（重签幂等，抢占最坏重复一次）
        try {
            const stamp = Number(fs.readFileSync(lockPath, 'utf8').trim().split(' ')[1]);
            if (!Number.isFinite(stamp) || Date.now() - stamp > LOCK_STALE_MS) {
                fs.rmSync(lockPath, { force: true });
                fs.writeFileSync(lockPath, `${process.pid} ${Date.now()}`, { flag: 'wx' });
                locked = true;
            }
        } catch {
            locked = false;
        }
    }
    if (locked) {
        try {
            try {
                if (fs.statSync(cached).size > 0) return cached;
            } catch {
                // 缓存不存在，执行复制重签
            }
            const tmpPath = `${cached}.tmp.${process.pid}`;
            try {
                fs.copyFileSync(filePath, tmpPath);
                fs.chmodSync(tmpPath, 0o755);
                // 只保留 entitlements；剥离 hardened/平台身份正是重签目的
                execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', tmpPath], { stdio: 'ignore' });
                // rename 原子落位（macOS 允许覆盖执行中的二进制；先删除会制造
                // 并发 spawn 的 ENOENT 空窗，绝不能 rm+rename）
                fs.renameSync(tmpPath, cached);
                return cached;
            } catch {
                try {
                    fs.rmSync(tmpPath, { force: true });
                } catch {
                    // 清理失败可忽略：临时目录由系统清理
                }
                return null;
            }
        } finally {
            try {
                fs.rmSync(lockPath, { force: true });
            } catch {
                // 锁清理失败可忽略：下一次冷启动覆盖
            }
        }
    }
    // 未抢到锁：另一实例正在重签，等待其完成后复用。
    // 用 Atomics.wait 同步休眠（不阻塞事件循环之外的方式会引入异步复杂度；
    // Atomics.wait 在 Electron 主进程与 worker_threads 均可用，渲染进程不可达此代码）。
    const sab = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 50; i++) {
        try {
            if (fs.statSync(cached).size > 0) return cached;
        } catch {
            // 尚未就绪，继续等待
        }
        try {
            Atomics.wait(sab, 0, 0, 100);
        } catch {
            // 环境禁止阻塞等待：退化为忙等切片
            const deadline = Date.now() + 100;
            while (Date.now() < deadline) {
                // 自旋等待
            }
        }
    }
    return null;
}

/**
 * 沙箱 exec 缓存目录（与原生侧默认一致；OPENDESK_SANDBOX_EXEC_CACHE 可覆盖，
 * 原生侧同名环境变量优先级一致，测试用独立目录避免并行 worker 竞争）。
 */
export function sandboxExecCacheDir(): string {
    const override = process.env.OPENDESK_SANDBOX_EXEC_CACHE;
    if (override) return override;
    return path.join(process.env.HOME || '', 'Library', 'Caches', 'com.opendesk.sandbox', 'exec');
}

/**
 * 为 DYLD 注入准备 shell 可执行文件：
 * 平台二进制/hardened 二进制复制+重签；其余原样返回。
 * 这是宿主侧启动沙箱 shell 的必经步骤——/bin/zsh 等 Apple 平台二进制会
 * 静默忽略 DYLD_INSERT_LIBRARIES，必须以重签副本启动。
 */
export function prepareShellForSandbox(shellPath: string): string {
    if (process.platform !== 'darwin') return shellPath;
    // PATH 扫描可能产出相对路径（PATH 含相对段时）：哈希/缓存/exec 都需要绝对路径，
    // 且 exec 后续 cwd 变化会使相对路径错位
    let absoluteShellPath = shellPath;
    try {
        absoluteShellPath = path.resolve(shellPath);
    } catch {
        return shellPath;
    }
    if (!needsExecResign(absoluteShellPath)) return absoluteShellPath;
    return resignCopyForExec(absoluteShellPath, sandboxExecCacheDir()) ?? absoluteShellPath;
}

/**
 * darwin 动态沙箱：DYLD_INSERT_LIBRARIES interposing。透明路径——沙箱内路径与
 * 宿主一致，ask 请求 path 即宿主真实路径（与 Linux 同语义，复用 policyTextLinux）。
 */
export async function prepareDarwinSandbox(options: {
    shellPath: string;
    shellArgs: string[];
    command: string;
    cwd?: string;
    taskState?: TaskState;
    /** 删除送废纸篓（OpenDesk 统一回收站，目录见 trashDir） */
    deleteToTrash?: boolean;
    /** 任务级统一回收站目录（<opendesk>/trash/<taskId>），每次拉起都传入 */
    trashDir?: string;
    /** 删除分流排除清单：命中目录前缀真删不入站（':' 分隔注入环境变量） */
    trashExcludeDirs?: string[];
    onPermissionWaitChange?: (waiting: boolean) => void;
}): Promise<DynamicSandboxLaunch | null> {
    if (process.platform !== 'darwin') return null;
    const dylib = resolveDarwinSandboxDylib();
    if (!dylib) throw new Error(t('sandbox.executableMissing.darwin'));

    if (!options.cwd && !options.taskState?.getWorkspace()) {
        throw new Error(t('sandbox.cwdMissing.darwin'));
    }
    const requestedWorkspace = options.cwd || options.taskState!.getWorkspace()!;
    // 策略按路径前缀匹配，而 macOS 上 getcwd 返回 /private/var/...（/var 是
    // symlink），TS 传入的 cwd 可能是 /var/...：策略里统一 realpath 保证前后缀
    // 一致；spawn cwd 保留用户传入的原始路径（用户可见 pwd 不应变成长别名）
    let policyWorkspace: string;
    try {
        policyWorkspace = fs.realpathSync(requestedWorkspace);
    } catch {
        throw new Error(t('sandbox.cwdUnsupported.darwin', { path: requestedWorkspace }));
    }

    const configDirectory = getOpendeskDirectory();
    fs.mkdirSync(configDirectory, { recursive: true });
    // crypto.randomUUID：并发任务下进程唯一（避免 Date.now+Math.random 碰撞）
    const runId = `dynamic-sandbox-darwin-${crypto.randomUUID()}`;
    const policyPath = path.join(configDirectory, `${runId}.toml`);
    const logDirectory = path.join(getLogDirectory(), 'sandbox');
    fs.mkdirSync(logDirectory, { recursive: true });
    const logPath = path.join(logDirectory, `${runId}.log`);

    const decide = await createSandboxDecideEndpoint({
        taskState: options.taskState,
        onPermissionWaitChange: options.onPermissionWaitChange,
        // 透明路径：沙箱内路径即宿主路径，恒等映射（与 Linux 一致）
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
                policyWorkspace,
                options.taskState?.harnessContext.permission?.getRules?.(),
                process.env.HOME,
                // 回收站写保护 deny 需要真实数据目录（debug/自定义目录布局）
                getOpendeskDirectory()
            ),
            'utf8'
        );
        // 策略文件含 ask token：收紧权限，防其他本地用户读取后伪造授权请求
        fs.chmodSync(policyPath, 0o600);
    } catch (error) {
        await cleanup();
        throw error;
    }

    // shell 必须以重签副本启动，否则 dyld 静默忽略插入（平台二进制）——
    // 重签失败时静默回退会让命令在无沙箱下运行（用户以为有管控），fail closed：
    // 直接报错让上层按"沙箱不可用"处理
    const sandboxShellPath = prepareShellForSandbox(options.shellPath);
    if (needsExecResign(options.shellPath) && sandboxShellPath === options.shellPath) {
        throw new Error(t('sandbox.executableMissing.darwin'));
    }

    // node spawn(file, args) 自动以 file 充当 argv[0]，args 只含后续参数；
    // 误把 shellPath 放进 args 会让 zsh 把 argv[1]（shell 路径）当脚本执行
    const childArgs = [...options.shellArgs];
    // 回收站目录：OpenDesk 统一回收站（<opendesk>/trash/<taskId>/），与其他平台
    // 的 --trash-dir 语义一致；宿主未传时退回按任务 ID 推导。不用 ~/.Trash（系统
    // 废纸篓无任务归属、放回信息缺失，且用户在访达看到一大堆重命名文件难以辨认）。
    // darwin 沙箱无 wrapper 进程、配置全走环境变量：目录路径每次拉起都注入
    // （原生层仅在 OPENDESK_SANDBOX_TRASH=1 时启用删除拦截）。
    const taskId = options.taskState?.task_id || 'unknown-task';
    const trashDir = options.trashDir || path.join(getOpendeskDirectory(), 'trash', taskId);
    if (options.deleteToTrash || options.trashDir) fs.mkdirSync(trashDir, { recursive: true });

    return {
        file: sandboxShellPath,
        args: childArgs,
        cwd: requestedWorkspace,
        // macOS watchdog（宿主死 → 整树陪葬）依赖独立进程组：shell 必须 setpgid
        //（POSIX detached），watchdog 才能对 -pg 发信号覆盖沙箱树。
        detached: true,
        env: {
            DYLD_INSERT_LIBRARIES: dylib,
            OPENDESK_SANDBOX_POLICY: policyPath,
            OPENDESK_SANDBOX_LOG: logPath,
            OPENDESK_SANDBOX_TRASH_DIR: trashDir,
            // 工具链缓存写入沙箱专用目录，避免开放宿主 ~/Library/Caches 整树。
            npm_config_cache: `${process.env.HOME || ''}/.cache/opendesk-sandbox/npm`,
            npm_config_devdir: `${process.env.HOME || ''}/.cache/opendesk-sandbox/node-gyp`,
            npm_package_config_node_gyp_devdir: `${process.env.HOME || ''}/.cache/opendesk-sandbox/node-gyp`,
            PIP_CACHE_DIR: `${process.env.HOME || ''}/.cache/opendesk-sandbox/pip`,
            ELECTRON_CACHE: `${process.env.HOME || ''}/.cache/opendesk-sandbox/electron`,
            ELECTRON_BUILDER_CACHE: `${process.env.HOME || ''}/.cache/opendesk-sandbox/electron-builder`,
            XDG_CACHE_HOME: `${process.env.HOME || ''}/.cache/opendesk-sandbox/xdg`,
            // Python 字节码缓存重定向（与 Linux/OHOS 同语义）：3.8+ 的 import
            // 写 __pycache__ 到镜像树，落点在 ~/.cache/opendesk-sandbox/pycache
            //（读已由 node app 策略 {home}/.cache/opendesk-sandbox/** read allow
            // 覆盖；写入由 dynabox-policy 的 ~/.cache/opendesk-sandbox/** write
            // allow 覆盖）。旧版 Python（<3.8）不落盘字节码，避免开放任意目录写权限。
            PYTHONPYCACHEPREFIX: `${process.env.HOME || ''}/.cache/opendesk-sandbox/pycache`,
            // 排除清单：命中目录前缀的删除真删不入站（构建零时产物零噪音）
            ...(options.trashExcludeDirs && options.trashExcludeDirs.length > 0
                ? { OPENDESK_SANDBOX_TRASH_EXCLUDE: options.trashExcludeDirs.join(':') }
                : {}),
            ...(options.deleteToTrash ? { OPENDESK_SANDBOX_TRASH: '1' } : {})
        },
        attach: (proc: ChildProcess) => {
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
