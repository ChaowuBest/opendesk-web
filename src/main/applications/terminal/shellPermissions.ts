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
 * 将 bash/zsh 命令字符串拆分为简单命令列表（按 ;、&&、||、| 拆分），
 * 忽略引号和括号内的分隔符。供权限配置规则（如 bash(npm run *)）匹配
 * 复合命令中的各子命令使用。
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
