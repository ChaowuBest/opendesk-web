/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

'use strict';

// Jest 的 node 环境会把 process 深拷贝进 vm（见 jest-util createProcessObject），
// 测试内对 process.env 的修改对 child_process 的 PATH 查找不可见，导致依赖
// "改 PATH 劫持外部命令" 的测试跑到真实命令上。该环境把 vm 内 process.env
// 换成宿主真实 env 的读写代理，使测试写入能被 spawn 的子进程看到；
// teardown 时按构造时快照还原真实 env，避免污染同 worker 的后续测试文件。
//
// Windows 补丁：Node 在 Windows 上无法执行 PATH 中无扩展名的 shebang 脚本
// （libuv 只按 .exe/.cmd 等可执行扩展名解析），会跳过 mock 脚本继续命中真实
// 命令（如 DevEco 自带的 hdc.exe）。该补丁拦截 execFile：目标命令按 PATH 顺序
// 解析到首个以 "#!" 开头的无扩展名文件时，改用 Git Bash 执行同一脚本，保证
// 与 POSIX 行为一致；未找到 Git Bash 或目标不是 shebang 脚本时保持原行为。

const StableTimerGlobalsEnvironment = require('./stable-timer-environment.js');
const { execFile: originalExecFile } = require('node:child_process');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const IS_WINDOWS = process.platform === 'win32';
let cachedBashExecutable;

function findBashExecutable() {
    if (cachedBashExecutable !== undefined) {
        return cachedBashExecutable;
    }
    const candidates = [];
    if (process.env.ProgramFiles) {
        candidates.push(path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'));
        candidates.push(path.join(process.env.ProgramFiles, 'Git', 'usr', 'bin', 'bash.exe'));
    }
    if (process.env['ProgramFiles(x86)']) {
        candidates.push(path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'));
    }
    if (process.env.LOCALAPPDATA) {
        candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
    }
    for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
        if (dir) {
            candidates.push(path.join(dir, 'bash.exe'));
        }
    }
    cachedBashExecutable =
        candidates.find((candidate) => {
            try {
                return fs.statSync(candidate).isFile();
            } catch {
                return false;
            }
        }) ?? null;
    return cachedBashExecutable;
}

function resolveShebangScriptTarget(command, env) {
    if (!command || /[\\/]/.test(command) || path.extname(command)) {
        return null;
    }
    const searchPaths = String(env?.PATH ?? env?.Path ?? process.env.PATH ?? '')
        .split(path.delimiter)
        .filter(Boolean);
    for (const dir of searchPaths) {
        const candidate = path.join(dir, command);
        let stat;
        try {
            stat = fs.statSync(candidate);
        } catch {
            continue;
        }
        // 目录等非文件项不参与命令解析：继续沿 PATH 往下找，不要直接放弃
        if (!stat.isFile()) continue;
        let magic;
        try {
            const fd = fs.openSync(candidate, 'r');
            const buffer = Buffer.alloc(2);
            fs.readSync(fd, buffer, 0, 2, 0);
            fs.closeSync(fd);
            magic = buffer.toString('latin1');
        } catch {
            return null;
        }
        return magic === '#!' ? candidate : null;
    }
    return null;
}

function installWindowsShebangExecFilePatch() {
    if (childProcess.execFile !== originalExecFile) {
        return;
    }
    const bashExecutable = findBashExecutable();
    if (!bashExecutable) {
        return;
    }
    const patchedExecFile = function execFile(file, args, options, callback) {
        let normalizedArgs = args;
        let normalizedOptions = options;
        let normalizedCallback = callback;
        if (typeof normalizedArgs === 'function') {
            normalizedCallback = normalizedArgs;
            normalizedArgs = undefined;
        } else if (normalizedArgs !== undefined && !Array.isArray(normalizedArgs)) {
            normalizedOptions = normalizedArgs;
            normalizedArgs = undefined;
        }
        if (typeof normalizedOptions === 'function') {
            normalizedCallback = normalizedOptions;
            normalizedOptions = undefined;
        }
        const shebangTarget = resolveShebangScriptTarget(file, normalizedOptions?.env);
        if (!shebangTarget) {
            return originalExecFile(file, args, options, callback);
        }
        return originalExecFile(
            bashExecutable,
            [shebangTarget, ...(normalizedArgs ?? [])],
            normalizedOptions,
            normalizedCallback
        );
    };
    Object.assign(patchedExecFile, originalExecFile);
    // 原生 execFile 挂有不可枚举的 util.promisify.custom（promisify(execFile) 时优先走它），
    // 该属性无法被 Object.assign 复制；缺失时 promisify 退回默认包装，会把
    // (err, stdout, stderr) 回调解析成数组，导致调用方解构出 undefined 的 stdout。
    // 这里重挂一个语义一致的版本，并把重定向逻辑同样应用到 promisify 链路。
    const promisifyCustom = require('node:util').promisify.custom;
    Object.defineProperty(patchedExecFile, promisifyCustom, {
        enumerable: false,
        value: function (...args) {
            const { promise, resolve, reject } = Promise.withResolvers();
            promise.child = patchedExecFile(...args, (err, stdout, stderr) => {
                if (err !== null) {
                    err.stdout = stdout;
                    err.stderr = stderr;
                    reject(err);
                } else {
                    resolve({ stdout, stderr });
                }
            });
            return promise;
        }
    });
    childProcess.execFile = patchedExecFile;
}

class RealProcessEnvEnvironment extends StableTimerGlobalsEnvironment {
    constructor(config, context) {
        super(config, context);
        const realEnv = globalThis.process.env;
        this.envSnapshot = { ...realEnv };
        this.global.process.env = new Proxy(realEnv, {
            get: (target, key) => Reflect.get(target, key),
            set: (target, key, value) => {
                Reflect.set(target, key, value);
                return true;
            },
            deleteProperty: (target, key) => {
                Reflect.deleteProperty(target, key);
                return true;
            }
        });
        if (IS_WINDOWS) {
            installWindowsShebangExecFilePatch();
        }
    }

    async teardown() {
        const realEnv = globalThis.process.env;
        for (const key of Object.keys(realEnv)) {
            if (!(key in this.envSnapshot)) {
                Reflect.deleteProperty(realEnv, key);
            } else if (realEnv[key] !== this.envSnapshot[key]) {
                realEnv[key] = this.envSnapshot[key];
            }
        }
        if (IS_WINDOWS && childProcess.execFile !== originalExecFile) {
            childProcess.execFile = originalExecFile;
        }
        await super.teardown();
    }
}

module.exports = RealProcessEnvEnvironment;
