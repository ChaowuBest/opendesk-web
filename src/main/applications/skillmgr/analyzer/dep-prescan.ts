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
 * 依赖预扫描工具：从源码中提取 Python 模块引用和 Shell 命令引用，
 * 用于 _buildDepsPrompt 中注入预扫描结果，辅助 Agent 完成依赖分析。
 */

/** 从 Python 源码中提取所有顶层 import 模块名（如 "import os" → "os"，"from datetime import foo" → "datetime"） */
export function extractPythonTopLevelImports(content: string): string[] {
    const result = new Set<string>();
    const patterns = [/^\s*(?:from\s+(\S+?)(?:\s+import|\s*$))/gm, /^\s*import\s+(\S+?)(?:\s*,|\s*$)/gm];
    for (const p of patterns) {
        let m: RegExpExecArray | null;
        while ((m = p.exec(content)) !== null) {
            const mod = m[1]!.split('.')[0]!;
            if (mod && /^[a-zA-Z_]\w*$/.test(mod)) {
                result.add(mod);
            }
        }
    }
    return [...result].sort();
}

/** 从 Python 源码中提取 subprocess/os.system 调用的命令名（如 subprocess.run(['ls']) → "ls"） */
export function extractSubprocessCommands(content: string): string[] {
    const result = new Set<string>();
    // subprocess.run(['cmd', ...]) / subprocess.call(['cmd', ...]) / subprocess.Popen(['cmd', ...])
    const subprocessRe = /subprocess\.(?:run|call|check_output|check_call|Popen)\s*\(\s*\[['"](\w+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = subprocessRe.exec(content)) !== null) {
        const cmd = m[1]!;
        if (/^[a-z][a-z0-9_-]*$/i.test(cmd)) {
            result.add(cmd);
        }
    }
    // os.system('cmd ...') / os.popen('cmd ...')
    const osRe = /os\.(?:system|popen)\s*\(\s*['"](\w+)/g;
    while ((m = osRe.exec(content)) !== null) {
        const cmd = m[1]!;
        if (/^[a-z][a-z0-9_-]*$/i.test(cmd)) {
            result.add(cmd);
        }
    }
    return [...result].sort();
}

/** Shell 控制流关键字，不作为命令提取 */
const SHELL_KEYWORDS = new Set([
    'if',
    'then',
    'else',
    'elif',
    'fi',
    'for',
    'while',
    'do',
    'done',
    'case',
    'esac',
    'in',
    'function',
    'select',
    'until'
]);

/** 检查 shell 脚本中匹配到的词是否为噪音（变量赋值、函数定义、关键字） */
function _isShellNoise(cmd: string, content: string, pos: number): boolean {
    if (SHELL_KEYWORDS.has(cmd)) return true;
    // 变量赋值：CMD=value
    const lineStart = content.lastIndexOf('\n', pos - 1) + 1;
    const line = content.slice(lineStart, pos + cmd.length + 10).trim();
    if (new RegExp(`^${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`).test(line)) return true;
    // 函数定义：function cmd { } 或 cmd() {
    const ctx = content.slice(Math.max(0, pos - 20), pos + cmd.length + 15);
    if (/function\s+\w+\s*\{/.test(ctx)) return true;
    if (new RegExp(`${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(\\s*\\)\\s*\\{`).test(ctx)) return true;
    return false;
}

/** 从 Shell 脚本中提取命令引用，采用多模式匹配 + 噪音过滤（参考 skill-dependency-extractor 的 parse_shell_cli） */
export function extractShellCommands(content: string): string[] {
    const result = new Set<string>();

    // 模式 1: 行首命令（排除 # 注释行）
    const lineCmdRe = /^\s*([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+|$)/gm;
    let m: RegExpExecArray | null;
    while ((m = lineCmdRe.exec(content)) !== null) {
        const cmd = m[1]!;
        // 跳过 shebang 和注释行
        const lineStart = content.lastIndexOf('\n', m.index - 1) + 1;
        if (content[lineStart] === '#') continue;
        if (!_isShellNoise(cmd, content, m.index)) {
            result.add(cmd);
        }
    }

    // 模式 2: 管道后的命令 | cmd
    const pipeRe = /\|\s*([a-zA-Z][a-zA-Z0-9_-]*)/g;
    while ((m = pipeRe.exec(content)) !== null) {
        result.add(m[1]!);
    }

    // 模式 3: 命令替换 $(cmd ...)
    const subRe = /\$\(\s*([a-zA-Z][a-zA-Z0-9_-]*)/g;
    while ((m = subRe.exec(content)) !== null) {
        result.add(m[1]!);
    }

    // 模式 4: 反引号命令替换 `cmd ...`
    const backtickRe = /`([a-zA-Z][a-zA-Z0-9_-]*)\s+/g;
    while ((m = backtickRe.exec(content)) !== null) {
        result.add(m[1]!);
    }

    // 模式 5: && 或 || 后的命令
    const condRe = /(?:&&|\|\|)\s*([a-zA-Z][a-zA-Z0-9_-]*)/g;
    while ((m = condRe.exec(content)) !== null) {
        result.add(m[1]!);
    }

    return [...result].sort();
}
