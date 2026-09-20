/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { buildChildProcessEnv } from '../../../utils/shellExec.js';
import { isHostMappedPackageName } from '../runtime/package-mapping.js';

const execFileAsync = promisify(execFile);

export interface NpmInvocation {
    executable: string;
    args: string[];
}

function environmentValue(environment: NodeJS.ProcessEnv, names: string[]): string | undefined {
    for (const name of names) {
        const value = environment[name];
        if (value) return value;
    }
    return undefined;
}

function executableOnPath(name: string, directories: string[], requireExecutable: boolean): string | undefined {
    for (const directory of directories) {
        const candidate = path.join(directory, name);
        try {
            if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
            if (requireExecutable) fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        } catch {
            continue;
        }
    }
    return undefined;
}

type PluginManagerPlatform = NodeJS.Platform | 'openharmony';

function environmentPathDirectories(platform: PluginManagerPlatform, environment: NodeJS.ProcessEnv): string[] {
    const pathValue = environmentValue(environment, ['Path', 'PATH']) ?? '';
    // PATH 的格式由运行主机决定：Windows 主机上的路径带盘符（如 C:\foo），
    // 其冒号不能作为分隔符。因此只要实际运行在 Windows 上就按 ';' 分隔，
    // 否则模拟 darwin/openharmony 平台时盘符会被误切导致可执行文件路径丢失盘符。
    const separator = platform === 'win32' || process.platform === 'win32' ? ';' : ':';
    const directories = pathValue
        .split(separator)
        .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
        .filter(Boolean);
    if (platform !== 'win32') directories.push('/bin', '/usr/bin', '/usr/local/bin');
    if (platform === 'darwin') directories.push('/opt/homebrew/bin');
    if (platform === 'openharmony') directories.push('/data/service/hnp/bin');
    return [...new Set(directories)];
}

export function resolveNpmInvocation(
    args: string[],
    platform: PluginManagerPlatform = process.platform,
    environment: NodeJS.ProcessEnv = process.env
): NpmInvocation {
    const pathDirectories = environmentPathDirectories(platform, environment);
    if (platform !== 'win32') {
        const executable = executableOnPath('npm', pathDirectories, true);
        if (!executable) throw new Error('plugin.install_npm_cli_not_found');
        return { executable, args };
    }

    const configuredNpmCli = environment.npm_execpath;
    const npmCliCandidates = [
        configuredNpmCli,
        ...pathDirectories.map((directory) => path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    ].filter((candidate): candidate is string => Boolean(candidate));
    const npmCli = npmCliCandidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    const configuredNode = environment.npm_node_execpath;
    const nodeExecutable =
        (configuredNode && fs.existsSync(configuredNode) && fs.statSync(configuredNode).isFile()
            ? configuredNode
            : undefined) ?? executableOnPath('node.exe', pathDirectories, false);
    if (!npmCli || !nodeExecutable) throw new Error('plugin.install_npm_cli_not_found');
    return {
        executable: nodeExecutable,
        args: [npmCli, ...args]
    };
}

/**
 * npm 11.19+（RFC npm/rfcs#868）规定 project 级安装不允许 CLI/env 层携带
 * allow-scripts 策略，否则直接抛 EALLOWSCRIPTS。而 `npm run` 会把用户 .npmrc
 * 里的 allow-scripts 以 npm_config_allow_scripts 环境变量注入子进程，导致本模块
 * 以子进程方式执行的 project 级 npm install 全部失败。这些安装均带
 * --ignore-scripts，策略本身不参与脚本判定，剔除 env 层即可让子 npm 回落到
 * package.json/.npmrc 层（这两层不受限制）。
 */
export function stripNpmScriptPolicyEnv(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(environment)) {
        // npm 解析环境变量时前缀匹配（/^npm_config_/i）不区分大小写，两种拼写都要剔除
        if (/^npm_config_allow_scripts$/i.test(key)) continue;
        result[key] = value;
    }
    return result;
}

export async function defaultNpmRunner(args: string[], cwd: string, cacheDirectory: string): Promise<void> {
    const invocation = resolveNpmInvocation(args);
    const npmrcPath = path.join(cwd, '.npmrc');
    fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
    fs.mkdirSync(cacheDirectory, { recursive: true });
    fs.writeFileSync(npmrcPath, '', 'utf-8');
    try {
        await execFileAsync(invocation.executable, invocation.args, {
            cwd,
            timeout: 180_000,
            maxBuffer: 10 * 1024 * 1024,
            env: stripNpmScriptPolicyEnv(
                buildChildProcessEnv({
                    ...process.env,
                    npm_config_userconfig: npmrcPath,
                    npm_config_cache: cacheDirectory,
                    npm_config_fund: 'false',
                    npm_config_audit: 'false'
                })
            )
        });
    } finally {
        fs.rmSync(npmrcPath, { force: true });
    }
}

const RUNTIME_DEPENDENCY_INSTALL_ARGS = [
    'install',
    '--no-save',
    '--install-links=true',
    '--no-bin-links',
    '--omit=dev',
    '--no-optional',
    '--audit=false',
    '--ignore-scripts',
    '--package-lock=false'
];

/**
 * 收集插件声明且需要从 registry 安装的运行时依赖（name@range）。
 * 被宿主映射的包（@bitclub.ai/opendesk-plugin-sdk、zod）由 package-mapping
 * 在运行时兜底解析，无需（也不应）安装——否则会因声明的版本与 npm 已发布
 * 版本不匹配（如官网示例的 ^0.1.0）导致 npm ETARGET，整个插件安装失败。
 */
function collectRuntimeDependencySpecs(packageJson: Record<string, unknown>): string[] {
    const specs: string[] = [];
    for (const field of ['dependencies', 'peerDependencies']) {
        const value = packageJson[field];
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        for (const [name, range] of Object.entries(value as Record<string, unknown>)) {
            if (isHostMappedPackageName(name)) continue;
            if (typeof range !== 'string' || !range) continue;
            specs.push(`${name}@${range}`);
        }
    }
    return specs;
}

export async function installPluginDependencies(
    pluginDirectory: string,
    runNpm: (args: string[], cwd: string) => Promise<void>
): Promise<void> {
    const packageJsonPath = path.join(pluginDirectory, 'package.json');
    if (!fs.existsSync(packageJsonPath)) return;
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as Record<string, unknown>;
    const dependencySpecs = collectRuntimeDependencySpecs(packageJson);
    if (dependencySpecs.length === 0) return;
    await runNpm([...RUNTIME_DEPENDENCY_INSTALL_ARGS, ...dependencySpecs], pluginDirectory);
}
