
import { Box, Component, Text, Editor, TUI, CombinedAutocompleteProvider, Markdown, type AutocompleteProvider, type AutocompleteItem } from "@mariozechner/pi-tui";
import { defaultEditorTheme, defaultMarkdownTheme } from "../theme";
import { SlashCommandRegistry } from "../commands";
import type { OpenDeskTUI } from "../entry";
import chalk from "chalk";
import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import { getNotificationBadge } from "./notification";
import { getFileCompletions, extractAtQuery, FILE_COMPLETION_MAX_RESULTS } from "./file-completions";
import { spawnSync, spawn, type ChildProcess } from "child_process";
import process from "process";
import path from "path";
import fs from "fs";

type AgentInputStatus = 'idle' | 'running';

export interface ChannelStatusEntry {
    label: string;
    online: boolean;
}

export interface StatusBarData {
    elapsedMs: number;
    totalTokens: number;
    contextSize: number;
    modelName: string;
    channelStates?: ChannelStatusEntry[];
    shellMode?: boolean;
}

/**
 * 底部状态栏：灰色背景，显示任务执行时间、token 用量及上下文占比。
 * 计时器跟踪的是任务内所有 agent 执行时间的累计总和。
 */
export class StatusBar implements Component {
    private static readonly SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

    private data: StatusBarData = { elapsedMs: 0, totalTokens: 0, contextSize: 0, modelName: '' };
    private timerStarted = false;
    private timerStart: number = 0;
    private accumulatedMs: number = 0;
    private spinnerFrame: number = 0;
    private timerInterval?: ReturnType<typeof setInterval>;
    private tui?: TUI;
    private invalidated = true;
    private lastWidth?: number;
    private cachedOutput?: string[];

    onTimerStop?: () => void;

    setTUI(tui: TUI) {
        this.tui = tui;
    }

    startTimer() {
        this.stopTimer();
        this.timerStarted = true;
        this.timerStart = Date.now();
        this.spinnerFrame = 0;
        this.timerInterval = setInterval(() => {
            this.data.elapsedMs = this.accumulatedMs + (Date.now() - this.timerStart);
            this.spinnerFrame = (this.spinnerFrame + 1) % StatusBar.SPINNER.length;
            this.invalidated = true;
            this.tui?.requestRender();
        }, 200);
    }

    stopTimer() {
        if (this.timerStarted) {
            this.accumulatedMs += Date.now() - this.timerStart;
            this.data.elapsedMs = this.accumulatedMs;
        }
        this.timerStarted = false;
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = undefined;
        }
        this.invalidated = true;
        this.onTimerStop?.();
    }

    resetAccumulated() {
        this.accumulatedMs = 0;
        this.data.elapsedMs = 0;
        this.invalidated = true;
    }

    setAccumulatedMs(ms: number) {
        this.accumulatedMs = ms;
        if (!this.timerStarted) {
            this.data.elapsedMs = ms;
        }
        this.invalidated = true;
    }

    getAccumulatedMs(): number {
        if (this.timerStarted) {
            return this.accumulatedMs + (Date.now() - this.timerStart);
        }
        return this.accumulatedMs;
    }

    update(partial: Partial<StatusBarData>) {
        Object.assign(this.data, partial);
        this.invalidated = true;
        if (this.timerStarted) {
            this.data.elapsedMs = this.accumulatedMs + (Date.now() - this.timerStart);
        }
        this.tui?.requestRender();
    }

    private formatElapsed(ms: number): string {
        const totalSec = Math.floor(ms / 1000);
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }

    invalidate() {
        this.invalidated = true;
    }

    render(width: number): string[] {
        if (!this.invalidated && this.lastWidth === width && this.cachedOutput) {
            return this.cachedOutput;
        }
        this.lastWidth = width;
        const { elapsedMs, totalTokens, contextSize, modelName, channelStates, shellMode } = this.data;

        const parts: string[] = [];
        if (shellMode) {
            parts.push(chalk.cyan('📟 Shell 命令模式'));
        } else {
            if (this.timerStarted) {
                const icon = StatusBar.SPINNER[this.spinnerFrame];
                parts.push(chalk.greenBright(`${icon} ${this.formatElapsed(elapsedMs)}`));
            } else if (elapsedMs > 0) {
                parts.push(chalk.hex('#d4d4d4')(`⏱ ${this.formatElapsed(elapsedMs)}`));
            }
            if (totalTokens > 0) {
                const pct = contextSize > 0 ? ((totalTokens / contextSize) * 100).toFixed(1) : '—';
                parts.push(`Tokens: ${totalTokens}/${contextSize} (${pct}%)`);
            }
            if (modelName) {
                parts.push(modelName);
            }
        }

        const leftContent = parts.length > 0 ? ` ${parts.join('  │  ')}` : '';

        const rightParts: string[] = [];
        if (channelStates && channelStates.length > 0) {
            const channelLabels = channelStates.map(ch =>
                ch.online
                    ? chalk.greenBright(`● ${ch.label}`)
                    : chalk.hex('#666666')(`○ ${ch.label}`)
            );
            rightParts.push(channelLabels.join('  '));
        }
        const badge = getNotificationBadge();
        if (badge) {
            rightParts.push(badge);
        }
        rightParts.push(chalk.hex('#d4d4d4')('/help 帮助'));
        const rightHint = rightParts.join(chalk.hex('#d4d4d4')('  │  ')) + ' ';

        let leftW = visibleWidth(leftContent);
        const rightW = visibleWidth(rightHint);
        const totalNeeded = leftW + 1 + rightW;

        let finalLeft = leftContent;
        if (totalNeeded > width) {
            const maxLeftW = Math.max(0, width - rightW - 2);
            finalLeft = truncateToWidth(leftContent, maxLeftW);
            leftW = visibleWidth(finalLeft);
        }

        const gap = Math.max(1, width - leftW - rightW);
        const line = chalk.bgHex('#3a3a3a')(
            chalk.hex('#d4d4d4')(finalLeft) + ' '.repeat(gap) + rightHint
        );
        this.cachedOutput = [line];
        this.invalidated = false;
        return this.cachedOutput;
    }
}

// ── fd 检测 & @ 文件补全回退 ──────────────────────────────────────────────

let _cachedFdPath: string | null | undefined;

function detectFd(): string | null {
    if (_cachedFdPath !== undefined) return _cachedFdPath;
    for (const bin of ["fd", "fdfind"]) {
        try {
            const cmd = process.platform === "win32" ? "where" : "which";
            const r = spawnSync(cmd, [bin], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
            if (r.status === 0 && r.stdout.trim()) {
                _cachedFdPath = r.stdout.trim().split(/\r?\n/)[0]!;
                return _cachedFdPath;
            }
        } catch { /* ignore */ }
    }
    _cachedFdPath = null;
    return null;
}

// ── Shell 命令补全 ──────────────────────────────────────────────────────

const SHELL_COMPLETION_MAX = 30;
let _shellCompletionCache: Map<string, { items: AutocompleteItem[]; ts: number }> = new Map();
const SHELL_CACHE_TTL = 30_000;

function getShellCompletions(inputCmd: string, cwd: string): AutocompleteItem[] {
    const trimmed = inputCmd.trim();
    if (trimmed.length === 0) return [];

    const cacheKey = `${cwd}::${trimmed}`;
    const cached = _shellCompletionCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SHELL_CACHE_TTL) return cached.items;

    const { shell, args } = getShell();
    const isBashLike = /bash|zsh|sh$/.test(shell);

    let completions: string[] = [];

    if (isBashLike) {
        // Split into tokens to determine whether we're completing a command or an argument
        const tokens = trimmed.split(/\s+/);
        const isFirstToken = tokens.length <= 1;
        const lastToken = tokens[tokens.length - 1] || '';

        if (isFirstToken) {
            // Complete commands (builtins + executables on PATH)
            const result = spawnSync(shell, [...args, `compgen -c -- '${lastToken.replace(/'/g, "'\\''")}'`], {
                cwd, encoding: 'utf-8', timeout: 3000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            if (result.status === 0 && result.stdout) {
                completions = result.stdout.trim().split('\n').filter(Boolean);
            }
        } else {
            // Complete file/directory paths for arguments
            const result = spawnSync(shell, [...args, `compgen -f -- '${lastToken.replace(/'/g, "'\\''")}'`], {
                cwd, encoding: 'utf-8', timeout: 3000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            if (result.status === 0 && result.stdout) {
                completions = result.stdout.trim().split('\n').filter(Boolean);
            }
        }
    } else {
        // PowerShell: use Get-Command for first token
        const tokens = trimmed.split(/\s+/);
        const isFirstToken = tokens.length <= 1;
        const lastToken = tokens[tokens.length - 1] || '';

        if (isFirstToken && lastToken.length > 0) {
            const psCmd = `(Get-Command '${lastToken}*' -ErrorAction SilentlyContinue | Select-Object -First ${SHELL_COMPLETION_MAX} -ExpandProperty Name) -join "\\n"`;
            const result = spawnSync(shell, [...args, psCmd], {
                cwd, encoding: 'utf-8', timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            if (result.status === 0 && result.stdout) {
                completions = result.stdout.trim().split(/\r?\n/).filter(Boolean);
            }
        } else if (!isFirstToken) {
            // For arguments, list files in cwd matching the partial path
            try {
                const dir = lastToken.includes('/') || lastToken.includes('\\')
                    ? path.resolve(cwd, path.dirname(lastToken))
                    : cwd;
                const prefix = lastToken.includes('/') || lastToken.includes('\\')
                    ? path.basename(lastToken)
                    : lastToken;
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.name.toLowerCase().startsWith(prefix.toLowerCase())) {
                        completions.push(entry.name + (entry.isDirectory() ? '/' : ''));
                    }
                }
            } catch { /* ignore */ }
        }
    }

    // Deduplicate and limit
    const seen = new Set<string>();
    const items: AutocompleteItem[] = [];
    for (const c of completions) {
        if (seen.has(c)) continue;
        seen.add(c);
        items.push({ value: c, label: c });
        if (items.length >= SHELL_COMPLETION_MAX) break;
    }

    _shellCompletionCache.set(cacheKey, { items, ts: Date.now() });
    if (_shellCompletionCache.size > 200) {
        const first = _shellCompletionCache.keys().next().value;
        if (first) _shellCompletionCache.delete(first);
    }

    return items;
}

/**
 * 包装 CombinedAutocompleteProvider，当 fd 不可用时为 @ 前缀提供
 * 基于 readdirSync 的本地文件补全回退；当以 ! 开头时提供 shell 命令补全。
 */
class FileAwareAutocompleteProvider implements AutocompleteProvider {
    constructor(
        private inner: CombinedAutocompleteProvider,
        private basePath: string,
    ) {}

    updateBasePath(newBasePath: string) {
        this.basePath = newBasePath;
    }

    getSuggestions(lines: string[], cursorLine: number, cursorCol: number) {
        const currentLine = lines[cursorLine] || "";
        const textBeforeCursor = currentLine.slice(0, cursorCol);
        const trimmedFull = currentLine.trimStart();

        // Shell command mode: input starts with !
        if (trimmedFull.startsWith('!')) {
            const bangIdx = currentLine.indexOf('!');
            const cmdText = textBeforeCursor.slice(bangIdx + 1);
            const tokens = cmdText.trimStart().split(/\s+/);
            const lastToken = tokens[tokens.length - 1] || '';

            const items = getShellCompletions(cmdText, this.basePath);
            if (items.length > 0) {
                return { items, prefix: lastToken };
            }
            return null;
        }

        const result = this.inner.getSuggestions(lines, cursorLine, cursorCol);
        if (result && result.items.length > 0) return result;

        const atMatch = extractAtQuery(textBeforeCursor);
        if (atMatch) {
            const items = getFileCompletions(this.basePath, atMatch.query, {
                atPrefix: true,
                maxResults: FILE_COMPLETION_MAX_RESULTS,
            });
            if (items.length > 0) {
                return { items, prefix: atMatch.fullPrefix };
            }
        }

        return result;
    }

    applyCompletion(
        lines: string[], cursorLine: number, cursorCol: number,
        item: AutocompleteItem, prefix: string,
    ) {
        // For shell mode completions, handle insertion manually
        const currentLine = lines[cursorLine] || "";
        const trimmedFull = currentLine.trimStart();
        if (trimmedFull.startsWith('!')) {
            const before = currentLine.slice(0, cursorCol);
            const after = currentLine.slice(cursorCol);
            const prefixStart = cursorCol - prefix.length;
            const newLine = before.slice(0, prefixStart) + item.value + after;
            const newLines = [...lines];
            newLines[cursorLine] = newLine;
            const newCol = prefixStart + item.value.length;
            return { lines: newLines, cursorLine, cursorCol: newCol };
        }

        return this.inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    }
}

// ── Shell 检测 ──────────────────────────────────────────────────────────

function detectShell(): { shell: string; args: string[] } {
    const isOpenHarmony = process.env.OPENHARMONY === '1' || process.env.OHOS_SDK_HOME != null;
    if (isOpenHarmony) {
        return { shell: 'zsh', args: ['-c'] };
    }
    if (process.platform === 'win32') {
        for (const bin of ['bash']) {
            try {
                const r = spawnSync('where', [bin], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
                if (r.status === 0 && r.stdout.trim()) {
                    return { shell: r.stdout.trim().split(/\r?\n/)[0]!, args: ['-c'] };
                }
            } catch { /* ignore */ }
        }
        return { shell: 'powershell.exe', args: ['-Command'] };
    }
    for (const bin of ['bash', 'sh']) {
        try {
            const r = spawnSync('which', [bin], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
            if (r.status === 0 && r.stdout.trim()) {
                return { shell: r.stdout.trim().split(/\r?\n/)[0]!, args: ['-c'] };
            }
        } catch { /* ignore */ }
    }
    return { shell: '/bin/sh', args: ['-c'] };
}

let _cachedShell: { shell: string; args: string[] } | undefined;
function getShell() {
    if (!_cachedShell) _cachedShell = detectShell();
    return _cachedShell;
}

// ── InlineResultPanel：通用内联结果面板 ──────────────────────────────────

export class InlineResultPanel implements Component {
    private lines: string[] = [];
    private scrollOffset = 0;
    private maxVisibleLines = 15;
    private visible = false;
    private headerText = '';
    private colorFn: (s: string) => string;

    constructor(colorFn?: (s: string) => string) {
        this.colorFn = colorFn ?? ((s: string) => chalk.cyan(s));
    }

    show(header: string, output: string) {
        this.headerText = header;
        this.lines = output.split('\n');
        if (this.lines.length > 0 && this.lines[this.lines.length - 1] === '') {
            this.lines.pop();
        }
        this.scrollOffset = 0;
        this.maxVisibleLines = this.lines.length;
        this.visible = true;
    }

    showMarkdown(header: string, markdown: string, width = 80) {
        this.headerText = header;
        const md = new Markdown(markdown, 0, 0, defaultMarkdownTheme);
        this.lines = md.render(width);
        this.scrollOffset = 0;
        this.maxVisibleLines = this.lines.length; // no limit - show all
        this.visible = true;
    }

    hide() {
        this.visible = false;
        this.lines = [];
    }

    isVisible() {
        return this.visible;
    }

    scrollUp(n = 3) {
        this.scrollOffset = Math.max(0, this.scrollOffset - n);
    }

    scrollDown(n = 3) {
        const max = Math.max(0, this.lines.length - this.maxVisibleLines);
        this.scrollOffset = Math.min(max, this.scrollOffset + n);
    }

    invalidate(): void { }

    render(width: number): string[] {
        if (!this.visible || this.lines.length === 0) return [];

        const c = this.colorFn;
        const innerW = Math.max(1, width - 4);
        const result: string[] = [];

        const header = ` ${truncateToWidth(this.headerText, Math.max(1, innerW))} `;
        const headerW = visibleWidth(header);
        const topBar = c('┌') + c(header) + c('─'.repeat(Math.max(0, width - headerW - 2))) + c('┐');
        result.push(topBar);

        const visibleLines = this.lines.slice(this.scrollOffset, this.scrollOffset + this.maxVisibleLines);
        for (const line of visibleLines) {
            const truncated = truncateToWidth(line, innerW);
            const lineW = visibleWidth(truncated);
            const padR = Math.max(0, innerW - lineW);
            result.push(c('│') + ' ' + truncated + ' '.repeat(padR) + ' ' + c('│'));
        }

        const scrollHints: string[] = [];
        if (this.lines.length > this.maxVisibleLines) {
            const total = this.lines.length;
            const pos = this.scrollOffset + 1;
            const end = Math.min(this.scrollOffset + this.maxVisibleLines, total);
            scrollHints.push(chalk.dim(`${pos}-${end}/${total}`));
            scrollHints.push(chalk.dim('Ctrl+↑/↓ 翻页'));
        }
        scrollHints.push(chalk.dim('Esc 关闭'));
        const bottomInfo = ' ' + scrollHints.join('  ') + ' ';
        const bottomInfoW = visibleWidth(bottomInfo);
        const bottomBar = c('└') + c(bottomInfo) + c('─'.repeat(Math.max(0, width - bottomInfoW - 2))) + c('┘');
        result.push(bottomBar);

        return result;
    }
}

export type ShellResultPanel = InlineResultPanel;

/**
 * AgentInputArea: 输入区域 + 斜杠指令 + 消息队列 + 状态栏
 *
 * 任务运行期间用户仍可输入，新消息入队，当前回复完成后自动发送。
 */
export class AgentInputArea implements Component {

    input: Editor;
    statusBar: StatusBar = new StatusBar();
    shellResultPanel: InlineResultPanel = new InlineResultPanel((s) => chalk.cyan(s));
    btwResultPanel: InlineResultPanel = new InlineResultPanel((s) => chalk.magenta(s));

    private openDeskTUI: OpenDeskTUI;
    private layout: Box;
    private status: AgentInputStatus = 'idle';
    private hintText: Text = new Text('');

    private messageQueue: string[] = [];
    private submitCallback?: (text: string) => void;
    private commandRegistry?: SlashCommandRegistry;
    private onQueueChange?: (queue: string[]) => void;
    private externalHint: string | null = null;
    private quickPassHandler?: (text: string) => boolean;
    private shellCommandMode = false;
    private defaultBorderColor: (str: string) => string;
    private runningShellProcess?: ChildProcess;

    constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;
        this.layout = new Box(0, 0);
        this.input = new Editor(this.openDeskTUI.tui, defaultEditorTheme);
        this.defaultBorderColor = this.input.borderColor;
        this.layout.addChild(this.hintText);
        this.layout.addChild(this.btwResultPanel);
        this.layout.addChild(this.shellResultPanel);
        this.layout.addChild(this.input);
        this.layout.addChild(this.statusBar);
        this.statusBar.setTUI(this.openDeskTUI.tui);

        this.input.onChange = (text: string) => {
            this.updateShellCommandMode(text);
        };

        this.input.onSubmit = (text: string) => {
            if (text.trim() === '') return;
            this.input.addToHistory(text);
            this.handleSubmit(text);
        };
    }

    private updateShellCommandMode(text: string) {
        const trimmed = text.trimStart();
        const isCmd = trimmed.startsWith('!') && trimmed.length >= 1;
        if (isCmd !== this.shellCommandMode) {
            this.shellCommandMode = isCmd;
            if (isCmd) {
                this.input.borderColor = (str: string) => chalk.cyan(str);
            } else {
                this.input.borderColor = this.defaultBorderColor;
            }
            this.statusBar.update({ shellMode: isCmd });
            this.openDeskTUI.tui.requestRender();
        }
    }

    private isShellCommand(text: string): string | null {
        const trimmed = text.trimStart();
        if (trimmed.startsWith('!')) {
            const cmd = trimmed.slice(1).trim();
            return cmd.length > 0 ? cmd : null;
        }
        return null;
    }

    private executeShellCommand(cmd: string) {
        if (this.runningShellProcess) {
            try { this.runningShellProcess.kill(); } catch { /* ignore */ }
            this.runningShellProcess = undefined;
        }

        const { shell, args } = getShell();
        this.hintText.setText(chalk.cyan(`⏳ 正在执行: ${cmd}`));
        this.openDeskTUI.tui.requestRender();

        const cwd = this.openDeskTUI.workspace;
        const isWin = process.platform === 'win32';

        // Use `pwd -W` on Windows (Git Bash) to get native Windows paths;
        // plain `pwd` everywhere else.
        const pwdCmd = isWin ? 'pwd -W' : 'pwd';
        const wrappedCmd = `${cmd} && ${pwdCmd}`;
        const child = spawn(shell, [...args, wrappedCmd], {
            cwd,
            env: { ...process.env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.runningShellProcess = child;

        child.stdin?.end();

        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
        child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

        child.on('close', (code) => {
            if (this.runningShellProcess === child) {
                this.runningShellProcess = undefined;
            }
            const exitLabel = code === 0
                ? chalk.green(`exit: ${code}`)
                : chalk.red(`exit: ${code ?? '?'}`);
            const header = `${chalk.cyan('$')} ${chalk.bold(cmd)}  ${exitLabel}`;

            let displayOutput = stdout;
            let cwdChangedMsg = '';

            if (code === 0 && stdout.trim()) {
                const lines = stdout.trimEnd().split('\n');
                let lastLine = lines[lines.length - 1].trim();
                // Convert MSYS-style /c/... paths to Windows C:\... as fallback
                if (isWin) {
                    const msysMatch = lastLine.match(/^\/([a-zA-Z])\/(.*)/);
                    if (msysMatch) {
                        lastLine = msysMatch[1].toUpperCase() + ':\\' + msysMatch[2].replace(/\//g, '\\');
                    }
                }
                const resolvedNew = path.resolve(lastLine);
                if (lastLine && path.isAbsolute(lastLine) && fs.existsSync(resolvedNew)) {
                    const oldCwd = path.resolve(cwd);
                    displayOutput = lines.slice(0, -1).join('\n');
                    const cwdChanged = isWin
                        ? resolvedNew.toLowerCase() !== oldCwd.toLowerCase()
                        : resolvedNew !== oldCwd;
                    if (cwdChanged) {
                        this.openDeskTUI.updateWorkspace(resolvedNew);
                        cwdChangedMsg = chalk.yellow(`📂 工作空间已切换: ${oldCwd} → ${resolvedNew}`);
                    }
                }
            }

            const parts: string[] = [];
            const trimmedOutput = (displayOutput + (stderr ? chalk.red(stderr) : '')).trimEnd();
            if (trimmedOutput) parts.push(trimmedOutput);
            if (cwdChangedMsg) parts.push(cwdChangedMsg);
            const finalOutput = parts.length > 0 ? parts.join('\n') : chalk.dim('(无输出)');

            this.shellResultPanel.show(header, finalOutput);
            this.hintText.setText('');
            this.refreshHint();
            this.openDeskTUI.tui.requestRender();
        });

        child.on('error', (err) => {
            if (this.runningShellProcess === child) {
                this.runningShellProcess = undefined;
            }
            const header = `${chalk.cyan('$')} ${chalk.bold(cmd)}  ${chalk.red('error')}`;
            this.shellResultPanel.show(header, chalk.red(`执行失败: ${err.message}`));
            this.hintText.setText('');
            this.refreshHint();
            this.openDeskTUI.tui.requestRender();
        });
    }

    dismissShellResult() {
        if (this.shellResultPanel.isVisible()) {
            this.shellResultPanel.hide();
            this.openDeskTUI.tui.requestRender();
        }
    }

    dismissBtwResult() {
        if (this.btwResultPanel.isVisible()) {
            this.btwResultPanel.hide();
            this.openDeskTUI.tui.requestRender();
        }
    }

    dismissAllInlinePanels() {
        let changed = false;
        if (this.shellResultPanel.isVisible()) { this.shellResultPanel.hide(); changed = true; }
        if (this.btwResultPanel.isVisible()) { this.btwResultPanel.hide(); changed = true; }
        if (changed) this.openDeskTUI.tui.requestRender();
    }

    /**
     * 注入斜杠指令注册中心并配置自动补全
     */
    setCommandRegistry(registry: SlashCommandRegistry) {
        this.commandRegistry = registry;
        this.refreshAutocomplete();
    }

    /**
     * 设置口令处理回调，返回 true 表示输入已作为口令处理
     */
    setQuickPassHandler(handler: (text: string) => boolean) {
        this.quickPassHandler = handler;
    }

    /**
     * 刷新 Editor 的自动补全（在注册/注销命令后调用）
     */
    refreshAutocomplete() {
        if (!this.commandRegistry) return;
        const basePath = this.openDeskTUI.workspace;
        const fdPath = detectFd();
        const inner = new CombinedAutocompleteProvider(
            this.commandRegistry.toPiTuiSlashCommands(),
            basePath,
            fdPath,
        );
        const provider = new FileAwareAutocompleteProvider(inner, basePath);
        this.input.setAutocompleteProvider(provider);
    }

    private async handleSubmit(text: string) {
        // Shell 命令拦截：优先级最高
        const shellCmd = this.isShellCommand(text);
        if (shellCmd) {
            this.input.setText('!');
            this.executeShellCommand(shellCmd);
            return;
        }

        // 检查是否处于模型未配置模式
        if (this.openDeskTUI.isModelNotConfiguredMode()) {
            if (this.commandRegistry) {
                const handled = await this.commandRegistry.execute(text);
                if (handled) {
                    this.input.setText('');
                    return;
                }
            }
            if (this.quickPassHandler && this.quickPassHandler(text)) {
                this.input.setText('');
                return;
            }
            this.input.setText('');
            return;
        }

        if (this.commandRegistry) {
            const handled = await this.commandRegistry.execute(text);
            if (handled) {
                this.input.setText('');
                return;
            }
        }

        if (this.quickPassHandler && this.quickPassHandler(text)) {
            this.input.setText('');
            return;
        }

        if (this.status === 'running') {
            this.messageQueue.push(text);
            this.updateQueueHint();
            this.notifyQueueChange();
            this.input.setText('');
            return;
        }

        this.setStatus('running');
        this.submitCallback?.(text);
    }

    /**
     * 设置队列变化回调
     */
    setOnQueueChange(callback: (queue: string[]) => void) {
        this.onQueueChange = callback;
    }

    /**
     * 通知队列变化
     */
    private notifyQueueChange() {
        if (this.onQueueChange) {
            this.onQueueChange(this.getQueueSnapshot());
        }
    }

    setExternalHint(text: string) {
        this.externalHint = text;
        this.hintText.setText(text);
    }

    clearExternalHint() {
        this.externalHint = null;
        this.refreshHint();
    }

    private refreshHint() {
        if (this.externalHint) {
            this.hintText.setText(this.externalHint);
            return;
        }
        if (this.messageQueue.length > 0) {
            this.updateQueueHint();
        } else if (this.status === 'running') {
            this.hintText.setText(chalk.dim('任务进行中，你仍然可以继续输入...'));
        } else {
            this.hintText.setText('');
        }
    }

    setStatus(status: AgentInputStatus) {
        this.status = status;
        this.refreshHint();
        if (this.status === 'idle' && !this.openDeskTUI.hasOpenOverlay) {
            this.openDeskTUI.tui.setFocus(this.input);
        }
    }

    private updateQueueHint() {
        const len = this.messageQueue.length;
        if (len === 0) {
            this.hintText.setText('');
        } else if (len === 1) {
            const preview = this.messageQueue[0].length > 60
                ? this.messageQueue[0].slice(0, 57) + '...'
                : this.messageQueue[0];
            this.hintText.setText(chalk.yellow(`📨 待发送: ${preview} (输入 /cancel 撤销)`));
        } else {
            this.hintText.setText(chalk.yellow(`📨 ${len} 条消息待发送 (输入 /cancel 撤销)`));
        }
    }

    /**
     * 清空消息队列中的所有待发送消息
     */
    clearMessageQueue(): string[] {
        const oldQueue = [...this.messageQueue];
        this.messageQueue = [];
        this.updateQueueHint();
        this.notifyQueueChange();
        return oldQueue;
    }

    /**
     * 检查队列，返回下一条待发送的消息（如有），否则返回 undefined
     */
    dequeueMessage(): string | undefined {
        const msg = this.messageQueue.shift();
        this.updateQueueHint();
        this.notifyQueueChange();
        return msg;
    }

    hasQueuedMessages(): boolean {
        return this.messageQueue.length > 0;
    }

    /**
     * 绑定到特定任务的队列
     */
    bindToTaskQueue(taskId: string, queue: string[]) {
        this.currentTaskId = taskId;
        this.messageQueue = [...queue];
        this.updateQueueHint();
    }

    /**
     * 获取当前队列的副本（用于保存）
     */
    getQueueSnapshot(): string[] {
        return [...this.messageQueue];
    }

    /**
     * 解除当前任务的绑定
     */
    unbindTaskQueue(): void {
        this.currentTaskId = undefined;
        this.messageQueue = [];
        this.updateQueueHint();
    }

    invalidate() {
        this.layout.invalidate();
    }

    render(width: number): string[] {
        return this.layout.render(width);
    }

    onSubmit(callback: (text: string) => void) {
        this.submitCallback = callback;
    }
}
