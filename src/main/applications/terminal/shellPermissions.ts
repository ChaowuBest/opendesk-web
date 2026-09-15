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

/**
 * Shell 命令的静态文件权限分析。
 *
 * 通过解析命令字符串，识别命令中明确引用的文件路径及其访问方式（读/写），
 * 生成 PermissionRequest[] 供权限引擎检查。
 *
 * 设计约束：
 * - **安全优先**：对于确定的路径精确声明，对于不确定的动态元素保守声明 execute /
 * - 不会执行命令、不会展开变量、不会展开 glob 通配符
 * - 包含变量引用、命令替换、.NET 调用等动态元素的命令会触发保守权限声明
 */

import path from 'path';
import os from 'os';
import { cleanPathInput } from '../../../utils/path.js';
import type { PermissionRequest, PermissionAction } from '../../aikernel/security/permission';

// ─── 公共工具函数 ───────────────────────────────────────────────────

/**
 * 将 MSYS2/Git Bash 风格的路径（如 /c/Projects/...）转换为 Windows 原生路径（如 C:/Projects/...）。
 *
 * 在 Git Bash (MSYS2) 环境下，process.cwd() 返回 /c/Projects/... 形式的路径。
 * Node.js 的 path.resolve() 在 Windows 上会将 /c/Projects/... 解释为相对于当前驱动器
 * 根目录的路径，产生 C:\c\Projects\...（双重前缀），因此需要先转换。
 */
function fromMsysPath(p: string): string {
    if (process.platform !== 'win32') return p;
    return p.replace(/^\/([a-zA-Z])\//, (_, letter) => `${letter.toUpperCase()}:/`);
}

/**
 * 规范化路径：展开 ~、清理不可见字符、解析为绝对路径、统一使用正斜杠
 */
function normalizePath(rawPath: string, cwd: string): string {
    let p = cleanPathInput(rawPath);

    // 展开 ~
    if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
        p = os.homedir() + p.slice(1);
    }

    // 将 MSYS2/Git Bash 风格路径转换为 Windows 原生路径，避免 path.resolve 产生双重前缀
    p = fromMsysPath(p);
    const normalizedCwd = fromMsysPath(cwd);
    const preserveTrailingSeparator = path.isAbsolute(p) && p.length > 1 && /[\\/]$/.test(p);

    // 始终通过 path.resolve 解析路径。绝对路径也可能包含 . 或 ..；仅用
    // path.isAbsolute 判断会保留这些片段，导致权限规则匹配到错误的路径。
    p = path.resolve(normalizedCwd, p);

    // 统一使用正斜杠
    p = p.replace(/\\/g, '/');

    if (preserveTrailingSeparator && p !== '/') {
        p += '/';
    }

    // 清理连续多个斜杠（保留 UNC 路径 // 和协议前缀 ://）
    p = p.replace(/(?<!:)\/{2,}/g, '/');

    return p;
}

/**
 * 判断一个路径参数是否为"确定的"（不含变量展开、命令替换、通配符等）
 */
function isDeterministicPath(token: string): boolean {
    if (!token || token.length === 0) return false;

    // 包含换行符或其他控制字符（不是合法文件路径，可能是多行内容被误识别）
    // 包括 \r\n、C0 控制字符 \x00-\x1f、Unicode 行/段分隔符 U+2028/U+2029
    if (/[\r\n\x00-\x1f\u2028\u2029]/.test(token)) return false;

    // 包含 shell 变量引用
    if (/\$/.test(token)) return false;

    // 包含反引号命令替换
    if (/`/.test(token)) return false;

    // 包含 glob 通配符
    if (/[*?]/.test(token)) return false;

    // 包含花括号展开（如 {a,b} 或 {1..3}）
    if (/\{.*[,.].*\}/.test(token)) return false;

    // 包含括号（子表达式、命令替换残留等）
    if (/[()]/.test(token)) return false;

    return true;
}

/**
 * 判断 token 是否"看起来像文件路径"
 * 排除纯粹的 flags（如 -r, --force）和非路径类参数
 */
function looksLikePath(token: string): boolean {
    if (!token || token.length === 0) return false;
    // 以 - 开头的是 flag
    if (token.startsWith('-')) return false;
    // 纯数字不是路径
    if (/^\d+$/.test(token)) return false;
    return true;
}

/**
 * 从去引号后的 token 中提取路径
 */
function unquote(token: string): string {
    // 去除外层单引号或双引号
    if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'))) {
        return token.slice(1, -1);
    }
    return token;
}

function makePermission(action: PermissionAction, filePath: string, cwd: string): PermissionRequest | null {
    const raw = unquote(filePath);
    if (!isDeterministicPath(raw)) return null;
    if (!looksLikePath(raw)) return null;
    return {
        resourceType: 'file',
        action,
        resourcePath: normalizePath(raw, cwd)
    };
}

function addIfValid(results: PermissionRequest[], action: PermissionAction, token: string, cwd: string): void {
    const perm = makePermission(action, token, cwd);
    if (perm) {
        results.push(perm);
    }
}

// ─── Bash/Zsh 命令分析 ──────────────────────────────────────────────

/**
 * 将 bash/zsh 命令字符串拆分为简单命令列表（按 ;、&&、||、| 拆分）
 * 忽略引号和括号内的分隔符
 */
export function splitBashCommands(command: string): string[] {
    const commands: string[] = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let escaped = false;
    let parenDepth = 0;

    for (let i = 0; i < command.length; i++) {
        const ch = command[i];

        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }

        if (ch === '\\' && !inSingleQuote) {
            escaped = true;
            current += ch;
            continue;
        }

        if (ch === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
            current += ch;
            continue;
        }

        if (ch === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
            current += ch;
            continue;
        }

        if (inSingleQuote || inDoubleQuote) {
            current += ch;
            continue;
        }

        if (ch === '(') {
            parenDepth++;
            current += ch;
            continue;
        }
        if (ch === ')') {
            parenDepth--;
            current += ch;
            continue;
        }

        if (parenDepth > 0) {
            current += ch;
            continue;
        }

        // 命令分隔符：;  &&  ||  |
        if (ch === ';') {
            commands.push(current);
            current = '';
            continue;
        }

        if (ch === '&' && i + 1 < command.length && command[i + 1] === '&') {
            commands.push(current);
            current = '';
            i++; // skip second &
            continue;
        }

        if (ch === '|' && i + 1 < command.length && command[i + 1] === '|') {
            commands.push(current);
            current = '';
            i++; // skip second |
            continue;
        }

        if (ch === '|') {
            commands.push(current);
            current = '';
            continue;
        }

        current += ch;
    }

    if (current.trim()) {
        commands.push(current);
    }

    return commands.map((c) => c.trim()).filter(Boolean);
}

/**
 * 解析单个 bash/zsh 简单命令的 token（简易分词，处理引号）
 */
function tokenizeBashCommand(cmd: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let escaped = false;

    for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i];

        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }

        if (ch === '\\' && !inSingleQuote) {
            escaped = true;
            current += ch;
            continue;
        }

        if (ch === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
            current += ch;
            continue;
        }

        if (ch === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
            current += ch;
            continue;
        }

        if (!inSingleQuote && !inDoubleQuote && (ch === ' ' || ch === '\t')) {
            if (current) {
                tokens.push(current);
                current = '';
            }
            continue;
        }

        current += ch;
    }

    if (current) {
        tokens.push(current);
    }

    return tokens;
}

/** 从 token 列表中提取重定向目标 */
function extractBashRedirects(tokens: string[]): {
    redirects: { target: string; action: PermissionAction }[];
    rest: string[];
} {
    const redirects: { target: string; action: PermissionAction }[] = [];
    const rest: string[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];

        // >>file  或 >> file
        if (/^>>(.+)$/.test(t)) {
            redirects.push({ target: t.slice(2), action: 'write' });
            continue;
        }
        if (t === '>>') {
            if (i + 1 < tokens.length) {
                redirects.push({ target: tokens[++i], action: 'write' });
            }
            continue;
        }

        // >file  或 > file  （也匹配 1> 2> 等 fd 重定向）
        if (/^\d*>(.+)$/.test(t)) {
            const match = t.match(/^\d*>(.+)$/);
            if (match) redirects.push({ target: match[1], action: 'write' });
            continue;
        }
        if (/^\d*>$/.test(t)) {
            if (i + 1 < tokens.length) {
                redirects.push({ target: tokens[++i], action: 'write' });
            }
            continue;
        }

        // here-doc (<<) 和 here-string (<<<) → 不产生文件访问
        if (t.startsWith('<<<') || t.startsWith('<<')) {
            // 跳过 here-doc 标记后面的 token（delimiter）
            if (t === '<<' || t === '<<<' || t === '<<-') {
                i++; // skip delimiter token
            }
            continue;
        }

        // <(process substitution) → 跳过
        if (t.startsWith('<(')) {
            continue;
        }

        // <file  或 < file  （输入重定向 → 读取）
        if (/^<(.+)$/.test(t)) {
            redirects.push({ target: t.slice(1), action: 'read' });
            continue;
        }
        if (t === '<') {
            if (i + 1 < tokens.length) {
                redirects.push({ target: tokens[++i], action: 'read' });
            }
            continue;
        }

        rest.push(t);
    }

    return { redirects, rest };
}

/**
 * 已知读取类命令：命令的路径参数全部视为读取
 */
const BASH_READ_COMMANDS = new Set([
    'cat',
    'head',
    'tail',
    'less',
    'more',
    'wc',
    'file',
    'stat',
    'md5sum',
    'sha256sum',
    'sha1sum',
    'shasum',
    'diff',
    'source',
    '.',
    'realpath',
    'readlink',
    'basename',
    'dirname',
    'xxd',
    'hexdump',
    'od',
    'strings',
    'rev',
    'nl',
    'sort',
    'uniq',
    'cut',
    'paste',
    'fold',
    'fmt',
    'pr',
    'column',
    'tac',
    'shuf',
    'jq',
    'yq'
]);

/**
 * 目录浏览/读取类命令：无路径参数时隐含读取 cwd
 */
const BASH_DIR_READ_COMMANDS = new Set(['ls', 'du', 'tree']);

/**
 * 目录切换命令：目标路径视为读取（防止通过 cd+命令 绕过工作区限制）
 */
const BASH_CD_COMMANDS = new Set(['cd', 'pushd']);

/**
 * 解析命令链中的目录切换，供后续命令使用更新后的 cwd。
 * 返回 undefined 表示命令没有可静态确定的目录变化。
 */
function resolveBashDirectoryChange(tokens: string[], cwd: string, directoryStack: string[]): string | undefined {
    const { rest } = extractBashRedirects(tokens);
    if (rest.length === 0) return undefined;

    let cmdStartIdx = 0;
    while (cmdStartIdx < rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[cmdStartIdx])) {
        cmdStartIdx++;
    }
    if (cmdStartIdx >= rest.length) return undefined;

    const cmdName = path.basename(unquote(rest[cmdStartIdx]));
    if (cmdName === 'popd') {
        return directoryStack.pop();
    }
    if (!BASH_CD_COMMANDS.has(cmdName)) return undefined;

    const target = rest.slice(cmdStartIdx + 1).find((arg) => looksLikePath(unquote(arg)));
    if (!target) return undefined;

    const nextCwd = normalizePath(target, cwd);
    if (cmdName === 'pushd') {
        directoryStack.push(cwd);
    }
    return nextCwd;
}

/**
 * 已知写入类命令：命令的路径参数全部视为写入
 * 注意：cp/mv 的最后一个参数是写入目标，其他是读取源，需要特殊处理
 */
const BASH_WRITE_COMMANDS = new Set(['touch', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'truncate']);

/**
 * 复合命令（读源 + 写目标）：除最后一个路径参数是写入外，其余为读取
 */
const BASH_COPY_COMMANDS = new Set(['cp', 'mv', 'install']);

/**
 * sed -i 的写入目标
 */
function isSedInPlace(tokens: string[]): boolean {
    return tokens.some((t) => t === '-i' || t.startsWith('-i') || t === '--in-place');
}

/**
 * chmod/chown/chgrp：对路径参数执行写入操作
 */
const BASH_CHMOD_COMMANDS = new Set(['chmod', 'chown', 'chgrp']);

function analyzeSingleBashCommand(tokens: string[], cwd: string): PermissionRequest[] {
    const results: PermissionRequest[] = [];

    // 1. 提取重定向
    const { redirects, rest } = extractBashRedirects(tokens);
    for (const redir of redirects) {
        addIfValid(results, redir.action, redir.target, cwd);
    }

    if (rest.length === 0) return results;

    // 跳过可能的环境变量赋值前缀（如 VAR=value cmd args）
    let cmdStartIdx = 0;
    while (cmdStartIdx < rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[cmdStartIdx])) {
        cmdStartIdx++;
    }

    if (cmdStartIdx >= rest.length) return results;

    const cmdToken = rest[cmdStartIdx];
    const cmdName = path.basename(unquote(cmdToken));
    const args = rest.slice(cmdStartIdx + 1);

    // 过滤掉 flags，得到非 flag 参数
    const nonFlagArgs = args.filter((a) => looksLikePath(unquote(a)));

    // 1.5 目录切换命令 (cd, pushd)：目标路径视为读取
    if (BASH_CD_COMMANDS.has(cmdName)) {
        if (nonFlagArgs.length > 0) {
            addIfValid(results, 'read', nonFlagArgs[0], cwd);
        }
        return results;
    }

    // 2. 读取类命令
    if (BASH_READ_COMMANDS.has(cmdName)) {
        for (const arg of nonFlagArgs) {
            addIfValid(results, 'read', arg, cwd);
        }
        return results;
    }

    // 2.5 目录浏览类命令：有路径参数则读取该路径，无路径参数则隐含读取 cwd
    if (BASH_DIR_READ_COMMANDS.has(cmdName)) {
        if (nonFlagArgs.length > 0) {
            for (const arg of nonFlagArgs) {
                addIfValid(results, 'read', arg, cwd);
            }
        } else {
            results.push({
                resourceType: 'file',
                action: 'read',
                resourcePath: normalizePath('.', cwd)
            });
        }
        return results;
    }

    // 2.6 find 命令：路径参数出现在第一个 expression（以 - 开头或括号开头）之前
    if (cmdName === 'find') {
        const pathArgs: string[] = [];
        for (const arg of args) {
            const raw = unquote(arg);
            if (raw.startsWith('-') || raw.startsWith('(') || raw.startsWith('!')) break;
            if (looksLikePath(raw)) pathArgs.push(arg);
        }
        if (pathArgs.length > 0) {
            for (const arg of pathArgs) {
                addIfValid(results, 'read', arg, cwd);
            }
        } else {
            results.push({
                resourceType: 'file',
                action: 'read',
                resourcePath: normalizePath('.', cwd)
            });
        }
        return results;
    }

    // 3. 写入类命令
    if (BASH_WRITE_COMMANDS.has(cmdName)) {
        for (const arg of nonFlagArgs) {
            addIfValid(results, 'write', arg, cwd);
        }
        return results;
    }

    // 4. 复合命令 (cp, mv, install): 最后一个参数是写入目标，其余为读取源
    if (BASH_COPY_COMMANDS.has(cmdName)) {
        if (nonFlagArgs.length >= 2) {
            const sources = nonFlagArgs.slice(0, -1);
            const dest = nonFlagArgs[nonFlagArgs.length - 1];
            for (const src of sources) {
                addIfValid(results, 'read', src, cwd);
            }
            addIfValid(results, 'write', dest, cwd);
        } else if (nonFlagArgs.length === 1) {
            // 只有一个参数时不确定是源还是目标，保守跳过
        }
        return results;
    }

    // 5. sed -i: 最后的非 flag 参数是文件，视为读写
    if (cmdName === 'sed') {
        if (isSedInPlace(args)) {
            // sed -i 's/foo/bar/' file1 file2
            // 策略：跳过 sed 表达式（以 s/ s| y/ 开头或被引号包裹的表达式），
            // 剩余的看起来像文件路径的参数视为文件
            for (const arg of nonFlagArgs) {
                const raw = unquote(arg);
                // 跳过 sed 表达式：以 s/ s| y/ 开头，或匹配 /pattern/ 形式，
                // 或以 数字/逗号+命令字符 开头
                if (/^[sy][/|]/.test(raw)) continue;
                if (/^\/.*\//.test(raw)) continue;
                if (/^[0-9,~]*[sydaicpqg]/.test(raw) && !raw.includes('.') && !raw.includes('/')) continue;
                // 只把有扩展名、包含路径分隔符、或以 ~ 开头的参数当文件
                if (raw.includes('.') || raw.includes('/') || raw.includes('~')) {
                    addIfValid(results, 'read', arg, cwd);
                    addIfValid(results, 'write', arg, cwd);
                }
            }
        }
        return results;
    }

    // 6. tee 命令：参数文件是写入目标，stdin 来自管道不分析
    if (cmdName === 'tee') {
        for (const arg of nonFlagArgs) {
            addIfValid(results, 'write', arg, cwd);
        }
        return results;
    }

    // 7. chmod/chown/chgrp：第一个非 flag 参数是权限/所有者说明，后续为路径
    if (BASH_CHMOD_COMMANDS.has(cmdName)) {
        // 收集所有非 flag 参数（包含数字参数如 "644"）
        const allNonFlag = args.filter((a) => !unquote(a).startsWith('-'));
        // 跳过第一个（权限模式/所有者），其余视为文件路径
        const pathArgs = allNonFlag.slice(1);
        for (const arg of pathArgs) {
            addIfValid(results, 'write', arg, cwd);
        }
        return results;
    }

    // 8. ln 命令
    if (cmdName === 'ln') {
        if (nonFlagArgs.length >= 2) {
            addIfValid(results, 'read', nonFlagArgs[0], cwd);
            addIfValid(results, 'write', nonFlagArgs[nonFlagArgs.length - 1], cwd);
        }
        return results;
    }

    // 9. tar 命令
    if (cmdName === 'tar') {
        const flagStr = args.filter((a) => a.startsWith('-')).join(' ');
        const isExtract = /x/.test(flagStr) || args.includes('-x') || args.includes('--extract');
        const isCreate = /c/.test(flagStr) || args.includes('-c') || args.includes('--create');

        // 查找 -f 参数后的文件名
        for (let i = 0; i < args.length; i++) {
            if (args[i] === '-f' || args[i] === '--file') {
                if (i + 1 < args.length) {
                    const tarFile = args[i + 1];
                    if (isExtract) {
                        addIfValid(results, 'read', tarFile, cwd);
                    } else if (isCreate) {
                        addIfValid(results, 'write', tarFile, cwd);
                    }
                }
                break;
            }
            // 合并短选项如 -xzf file.tar.gz
            if (/^-[a-zA-Z]*f$/.test(args[i]) && i + 1 < args.length) {
                const tarFile = args[i + 1];
                if (isExtract || /x/.test(args[i])) {
                    addIfValid(results, 'read', tarFile, cwd);
                } else if (isCreate || /c/.test(args[i])) {
                    addIfValid(results, 'write', tarFile, cwd);
                }
                break;
            }
        }
        return results;
    }

    // 10. grep/rg/ag —— 搜索工具，文件参数为读取
    if (cmdName === 'grep' || cmdName === 'rg' || cmdName === 'ag' || cmdName === 'egrep' || cmdName === 'fgrep') {
        // grep 的第一个非 flag 参数是 pattern，后面的才是文件
        // 但由于 -e pattern 等复杂情况，保守只处理最简单的 `grep pattern file` 形式
        if (nonFlagArgs.length >= 2) {
            for (const arg of nonFlagArgs.slice(1)) {
                addIfValid(results, 'read', arg, cwd);
            }
        }
        return results;
    }

    // 11. python/node/ruby 等脚本执行器
    if (
        cmdName === 'python' ||
        cmdName === 'python3' ||
        cmdName === 'node' ||
        cmdName === 'ruby' ||
        cmdName === 'perl' ||
        cmdName === 'php' ||
        cmdName === 'bash' ||
        cmdName === 'sh' ||
        cmdName === 'zsh'
    ) {
        const cIdx = args.indexOf('-c');
        const eIdx = args.indexOf('-e');
        const inlineIdx = cIdx !== -1 ? cIdx : eIdx;

        if (inlineIdx !== -1 && inlineIdx + 1 < args.length) {
            const inlineCode = unquote(args[inlineIdx + 1]);
            if (cmdName === 'bash' || cmdName === 'sh' || cmdName === 'zsh') {
                // 对 shell 内联代码递归分析
                results.push(...analyzeSingleBashCommandChain(inlineCode, cwd));
            } else {
                // 非 shell 内联代码无法静态分析，声明对根路径的 execute 权限以触发确认
                results.push({
                    resourceType: 'file',
                    action: 'execute',
                    resourcePath: '/'
                });
            }
        } else if (nonFlagArgs.length >= 1) {
            const scriptFile = nonFlagArgs[0];
            const raw = unquote(scriptFile);
            if (raw.includes('.') || raw.includes('/')) {
                addIfValid(results, 'read', scriptFile, cwd);
            }
        }
        return results;
    }

    return results;
}

/**
 * 分析一段 bash 命令链（可含 ;, &&, ||, |）并返回权限请求。
 * 供内部递归分析 `bash -c "..."` / `sh -c "..."` 使用。
 */
function analyzeSingleBashCommandChain(command: string, cwd: string): PermissionRequest[] {
    const results: PermissionRequest[] = [];
    let currentCwd = cwd;
    const directoryStack: string[] = [];
    const simpleCommands = splitBashCommands(command);
    for (const cmd of simpleCommands) {
        const tokens = tokenizeBashCommand(cmd);
        if (tokens.length === 0) continue;
        results.push(...analyzeSingleBashCommand(tokens, currentCwd));
        const nextCwd = resolveBashDirectoryChange(tokens, currentCwd, directoryStack);
        if (nextCwd) currentCwd = nextCwd;
    }
    return results;
}

/**
 * 分析 bash/zsh 命令字符串所需的文件访问权限。
 *
 * @param command 待执行的完整 bash/zsh 命令
 * @param cwd 命令的工作目录（用于解析相对路径）
 * @returns 识别出的文件权限请求列表
 */
export function analyzeBashPermissions(command: string, cwd: string): PermissionRequest[] {
    const results: PermissionRequest[] = [];
    results.push(...analyzeSingleBashCommandChain(command, cwd));

    if (bashCommandContainsDynamicElements(command)) {
        results.push({ resourceType: 'file', action: 'execute', resourcePath: '/' });
    }

    return deduplicatePermissions(results);
}

/**
 * 检测 bash 命令是否包含无法静态分析的动态元素。
 * 任何 shell 变量、命令替换、动态执行都应触发保守权限声明，
 * 因为它们可以被用于构造任意路径来绕过静态分析。
 */
function bashCommandContainsDynamicElements(command: string): boolean {
    // shell 变量引用 $VAR, ${VAR}, $() — 可被用于构造任意路径
    if (/\$/.test(command)) return true;
    // 反引号命令替换
    if (/`[^`]+`/.test(command)) return true;
    // eval 命令
    if (/\beval\b/.test(command)) return true;
    // awk/gawk（支持 system() 执行任意命令）
    if (/\b[gm]?awk\b/.test(command)) return true;
    // xargs（从管道接收路径后执行命令，路径不可预知）
    if (/\bxargs\b/.test(command)) return true;
    return false;
}

// ─── PowerShell 命令分析 ─────────────────────────────────────────────

/**
 * 将 PowerShell 命令字符串拆分为简单命令列表（按 ;、|）
 */
function splitPowerShellCommands(command: string): string[] {
    const commands: string[] = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let parenDepth = 0;

    for (let i = 0; i < command.length; i++) {
        const ch = command[i];

        if (ch === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
            current += ch;
            continue;
        }

        if (ch === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
            current += ch;
            continue;
        }

        if (inSingleQuote || inDoubleQuote) {
            current += ch;
            continue;
        }

        if (ch === '(') {
            parenDepth++;
            current += ch;
            continue;
        }
        if (ch === ')') {
            parenDepth--;
            current += ch;
            continue;
        }

        if (parenDepth > 0) {
            current += ch;
            continue;
        }

        if (ch === ';' || ch === '|') {
            commands.push(current);
            current = '';
            continue;
        }

        current += ch;
    }

    if (current.trim()) {
        commands.push(current);
    }

    return commands.map((c) => c.trim()).filter(Boolean);
}

/**
 * PowerShell 的简易分词
 */
function tokenizePowerShell(cmd: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;

    for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i];

        if (ch === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
            current += ch;
            continue;
        }

        if (ch === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
            current += ch;
            continue;
        }

        if (!inSingleQuote && !inDoubleQuote && (ch === ' ' || ch === '\t')) {
            if (current) {
                tokens.push(current);
                current = '';
            }
            continue;
        }

        current += ch;
    }

    if (current) {
        tokens.push(current);
    }

    return tokens;
}

/**
 * 判断 PowerShell token 是否是确定性路径
 */
function isPSDeterministicPath(token: string): boolean {
    if (!token || token.length === 0) return false;
    const raw = unquote(token);
    // 包含 PowerShell 变量
    if (/\$/.test(raw)) return false;
    // 包含通配符
    if (/[*?]/.test(raw)) return false;
    // 包含子表达式
    if (/\(/.test(raw)) return false;
    return true;
}

/** PowerShell 读取类 cmdlet（不区分大小写） */
const PS_READ_CMDLETS = new Map<string, true>([
    ['get-content', true],
    ['gc', true],
    ['cat', true],
    ['type', true],
    ['get-item', true],
    ['gi', true],
    ['get-childitem', true],
    ['gci', true],
    ['dir', true],
    ['ls', true],
    ['test-path', true],
    ['resolve-path', true],
    ['get-filehash', true],
    ['select-string', true],
    ['sls', true]
]);

/** PowerShell 写入类 cmdlet */
const PS_WRITE_CMDLETS = new Map<string, true>([
    ['set-content', true],
    ['sc', true],
    ['add-content', true],
    ['ac', true],
    ['out-file', true],
    ['new-item', true],
    ['ni', true],
    ['remove-item', true],
    ['ri', true],
    ['del', true],
    ['rd', true],
    ['rmdir', true],
    ['erase', true],
    ['clear-content', true],
    ['clc', true],
    ['rename-item', true],
    ['ren', true],
    ['rni', true]
]);

/** PowerShell 复合类 cmdlet（读源+写目标） */
const PS_COPY_CMDLETS = new Map<string, true>([
    ['copy-item', true],
    ['cp', true],
    ['cpi', true],
    ['copy', true],
    ['move-item', true],
    ['mv', true],
    ['mi', true],
    ['move', true]
]);

/**
 * 从 PowerShell token 列表中找到 -Path / -LiteralPath / -Destination 等参数的值
 */
function findPSNamedParam(tokens: string[], paramNames: string[]): string | null {
    for (let i = 0; i < tokens.length; i++) {
        const lower = tokens[i].toLowerCase();
        for (const name of paramNames) {
            if (lower === name && i + 1 < tokens.length) {
                return tokens[i + 1];
            }
        }
    }
    return null;
}

/**
 * 获取 PowerShell cmdlet 的路径参数（位置参数或命名参数）
 */
function getPSPathParam(tokens: string[], cmdIdx: number): string | null {
    // 先检查命名参数
    const named = findPSNamedParam(tokens, ['-path', '-literalpath', '-filepath']);
    if (named) return named;

    // 取第一个非 flag 的位置参数
    for (let i = cmdIdx + 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.startsWith('-') && i + 1 < tokens.length) {
            // 是命名参数，跳过参数值
            i++;
            continue;
        }
        if (!t.startsWith('-')) {
            return t;
        }
    }
    return null;
}

function getPSDestinationParam(tokens: string[]): string | null {
    return findPSNamedParam(tokens, ['-destination']);
}

/** 从 PowerShell 命令中提取重定向目标 */
function extractPSRedirects(tokens: string[]): {
    redirects: { target: string; action: PermissionAction }[];
    rest: string[];
} {
    const redirects: { target: string; action: PermissionAction }[] = [];
    const rest: string[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];

        // >>file  或 >> file
        if (/^>>(.+)$/.test(t)) {
            redirects.push({ target: t.slice(2), action: 'write' });
            continue;
        }
        if (t === '>>') {
            if (i + 1 < tokens.length) {
                redirects.push({ target: tokens[++i], action: 'write' });
            }
            continue;
        }

        // >file  或 > file
        if (/^>(.+)$/.test(t)) {
            redirects.push({ target: t.slice(1), action: 'write' });
            continue;
        }
        if (t === '>') {
            if (i + 1 < tokens.length) {
                redirects.push({ target: tokens[++i], action: 'write' });
            }
            continue;
        }

        rest.push(t);
    }

    return { redirects, rest };
}

/** PowerShell 目录切换 cmdlet */
const PS_CD_CMDLETS = new Map<string, true>([
    ['cd', true],
    ['set-location', true],
    ['sl', true],
    ['push-location', true],
    ['pushd', true]
]);

/** PowerShell 动态执行 cmdlet（无法静态分析内容） */
const PS_DYNAMIC_EXEC_CMDLETS = new Map<string, true>([
    ['invoke-expression', true],
    ['iex', true]
]);

/** PowerShell 子进程执行命令 */
const PS_SUBPROCESS_CMDLETS = new Map<string, true>([
    ['powershell', true],
    ['pwsh', true],
    ['powershell.exe', true],
    ['pwsh.exe', true]
]);

function analyzeSinglePowerShellCommand(tokens: string[], cwd: string): PermissionRequest[] {
    const results: PermissionRequest[] = [];

    // 提取重定向
    const { redirects, rest } = extractPSRedirects(tokens);
    for (const redir of redirects) {
        const raw = unquote(redir.target);
        if (isPSDeterministicPath(redir.target) && looksLikePath(raw)) {
            results.push({
                resourceType: 'file',
                action: redir.action,
                resourcePath: normalizePath(raw, cwd)
            });
        }
    }

    if (rest.length === 0) return results;

    const cmdToken = rest[0];
    const cmdName = unquote(cmdToken).toLowerCase();

    // 目录切换 cmdlet: 目标路径视为读取
    if (PS_CD_CMDLETS.has(cmdName)) {
        const pathParam = getPSPathParam(rest, 0);
        if (pathParam) {
            const raw = unquote(pathParam);
            if (isPSDeterministicPath(pathParam) && looksLikePath(raw)) {
                results.push({
                    resourceType: 'file',
                    action: 'read',
                    resourcePath: normalizePath(raw, cwd)
                });
            }
        }
        return results;
    }

    // 动态执行 cmdlet (Invoke-Expression): 无法静态分析，声明对根路径的 execute 以触发确认
    if (PS_DYNAMIC_EXEC_CMDLETS.has(cmdName)) {
        results.push({
            resourceType: 'file',
            action: 'execute',
            resourcePath: '/'
        });
        return results;
    }

    // 子进程执行 (powershell -Command): 递归分析或声明 execute
    if (PS_SUBPROCESS_CMDLETS.has(cmdName)) {
        const commandIdx = rest.findIndex((t) => t.toLowerCase() === '-command');
        if (commandIdx !== -1 && commandIdx + 1 < rest.length) {
            const inlineCode = unquote(rest[commandIdx + 1]);
            results.push(...analyzePowerShellCommandChain(inlineCode, cwd));
        } else {
            results.push({
                resourceType: 'file',
                action: 'execute',
                resourcePath: '/'
            });
        }
        return results;
    }

    // 读取类 cmdlet
    if (PS_READ_CMDLETS.has(cmdName)) {
        const pathParam = getPSPathParam(rest, 0);
        if (pathParam) {
            const raw = unquote(pathParam);
            if (isPSDeterministicPath(pathParam) && looksLikePath(raw)) {
                results.push({
                    resourceType: 'file',
                    action: 'read',
                    resourcePath: normalizePath(raw, cwd)
                });
            }
        }
        return results;
    }

    // 写入类 cmdlet
    if (PS_WRITE_CMDLETS.has(cmdName)) {
        const pathParam = getPSPathParam(rest, 0);
        if (pathParam) {
            const raw = unquote(pathParam);
            if (isPSDeterministicPath(pathParam) && looksLikePath(raw)) {
                results.push({
                    resourceType: 'file',
                    action: 'write',
                    resourcePath: normalizePath(raw, cwd)
                });
            }
        }
        return results;
    }

    // 复合类 cmdlet（Copy-Item, Move-Item）
    if (PS_COPY_CMDLETS.has(cmdName)) {
        const srcParam = getPSPathParam(rest, 0);
        const destParam = getPSDestinationParam(rest);

        if (srcParam) {
            const raw = unquote(srcParam);
            if (isPSDeterministicPath(srcParam) && looksLikePath(raw)) {
                results.push({
                    resourceType: 'file',
                    action: 'read',
                    resourcePath: normalizePath(raw, cwd)
                });
            }
        }
        if (destParam) {
            const raw = unquote(destParam);
            if (isPSDeterministicPath(destParam) && looksLikePath(raw)) {
                results.push({
                    resourceType: 'file',
                    action: 'write',
                    resourcePath: normalizePath(raw, cwd)
                });
            }
        } else if (srcParam) {
            // Copy-Item src dest (位置参数形式)
            // 找到 src 之后的下一个非 flag 参数作为 dest
            const srcIdx = rest.indexOf(srcParam);
            if (srcIdx >= 0) {
                for (let i = srcIdx + 1; i < rest.length; i++) {
                    const t = rest[i];
                    if (t.startsWith('-') && i + 1 < rest.length) {
                        i++;
                        continue;
                    }
                    if (!t.startsWith('-')) {
                        const raw = unquote(t);
                        if (isPSDeterministicPath(t) && looksLikePath(raw)) {
                            results.push({
                                resourceType: 'file',
                                action: 'write',
                                resourcePath: normalizePath(raw, cwd)
                            });
                        }
                        break;
                    }
                }
            }
        }
        return results;
    }

    return results;
}

/**
 * 分析一段 PowerShell 命令链（可含 ; |）并返回权限请求。
 * 供内部递归分析 `powershell -Command "..."` 使用。
 */
function analyzePowerShellCommandChain(command: string, cwd: string): PermissionRequest[] {
    const results: PermissionRequest[] = [];
    const simpleCommands = splitPowerShellCommands(command);
    for (const cmd of simpleCommands) {
        const tokens = tokenizePowerShell(cmd);
        if (tokens.length === 0) continue;
        results.push(...analyzeSinglePowerShellCommand(tokens, cwd));
    }
    return results;
}

/**
 * 分析 PowerShell 命令字符串所需的文件访问权限。
 *
 * @param command 待执行的完整 PowerShell 命令
 * @param cwd 命令的工作目录（用于解析相对路径）
 * @returns 识别出的文件权限请求列表
 */
export function analyzePowerShellPermissions(command: string, cwd: string): PermissionRequest[] {
    const results: PermissionRequest[] = [];
    const simpleCommands = splitPowerShellCommands(command);

    for (const cmd of simpleCommands) {
        const tokens = tokenizePowerShell(cmd);
        if (tokens.length === 0) continue;
        results.push(...analyzeSinglePowerShellCommand(tokens, cwd));
    }

    if (psCommandContainsDynamicElements(command)) {
        results.push({ resourceType: 'file', action: 'execute', resourcePath: '/' });
    }

    return deduplicatePermissions(results);
}

/**
 * 检测 PowerShell 命令是否包含无法静态分析的动态元素。
 * 任何变量、.NET 调用、外部程序等都应触发保守权限声明。
 */
function psCommandContainsDynamicElements(command: string): boolean {
    const lower = command.toLowerCase();
    // PowerShell 变量引用（$var, $env:, $PWD 等）— 可用于构造任意路径
    if (/\$/.test(command)) return true;
    // .NET 类型调用 [System.IO.*] 或 [IO.*]
    if (/\[\s*(?:System\.)?IO\./i.test(command)) return true;
    // scriptblock 创建 [scriptblock]::Create
    if (/\[scriptblock\]/i.test(command)) return true;
    // & 调用运算符配合字符串（& 'cmd.exe' 等）
    if (/&\s*['"]/.test(command)) return true;
    // cmd.exe / cmd /c 外部程序调用
    if (/\bcmd(?:\.exe)?\b/i.test(lower)) return true;
    // Start-Process
    if (/\bstart-process\b/i.test(lower)) return true;
    // foreach 循环（可绕过参数分析）
    if (/\bforeach\b/i.test(lower)) return true;
    // WMI 查询
    if (/\[wmi\]/i.test(command)) return true;
    // 方括号类型加速器 + 双冒号方法调用（.NET 静态方法）
    if (/\[[A-Za-z][\w.]*\]\s*::/.test(command)) return true;
    return false;
}

// ─── 去重 ─────────────────────────────────────────────────────────

function deduplicatePermissions(permissions: PermissionRequest[]): PermissionRequest[] {
    const seen = new Set<string>();
    const result: PermissionRequest[] = [];
    for (const p of permissions) {
        const key = `${p.resourceType}:${p.action}:${p.resourcePath}`;
        if (!seen.has(key)) {
            seen.add(key);
            result.push(p);
        }
    }
    return result;
}
