import {
    Box,
    Component,
    Text,
    Editor,
    TUI,
    CombinedAutocompleteProvider,
    Markdown,
    type AutocompleteProvider,
    type AutocompleteItem
} from '@mariozechner/pi-tui';
import { defaultEditorTheme, defaultMarkdownTheme, getStatusBarColors } from '../theme';
import { SlashCommandRegistry } from '../commands';
import type { OpenDeskTUI } from '../entry';
import type { PermissionPromptWidget } from './permission';
import chalk from 'chalk';
import { visibleWidth, truncateToWidth } from '@mariozechner/pi-tui';
import { getFileCompletions, extractAtQuery, FILE_COMPLETION_MAX_RESULTS } from './file-completions';
import { getShellCompletions, executeShellCommand } from './shell';
import { findExecutableInPath } from '../../applications/terminal/shellExec.js';
import { SkillRegistry as AISkillRegistry } from '../../aikernel/skill';
import { getShortcuts } from '../../utils/setting.js';
import { t } from '../../../locale/index.js';

type AgentInputStatus = 'idle' | 'running';

export interface TaskStatusBarData {
    elapsedMs: number;
    totalTokens: number;
    contextSize: number;
    modelName: string;
    shellMode?: boolean;
    /** 当前模式的显示文本 (如 "⚡ Standard") */
    modeDisplay?: string;
    /** 当前模式的颜色 (如 '#00E5FF') */
    modeColor?: string;
}

/**
 * 任务级状态栏（TaskStatusBar）：灰色背景，仅显示当前任务相关的信息——
 * 执行计时、token 用量、上下文占比、当前模型。
 * 所有不涉及任务的全局状态（文件扫描配置、消息插件连接等）请放到 DashboardBar 中。
 * 宽度不足时使用 ResponsiveBar 从右到左逐个隐藏。
 */
export class TaskStatusBar implements Component {
    private static readonly SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

    private data: TaskStatusBarData = {
        elapsedMs: 0,
        totalTokens: 0,
        contextSize: 0,
        modelName: ''
    };
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
            this.spinnerFrame = (this.spinnerFrame + 1) % TaskStatusBar.SPINNER.length;
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

    update(partial: Partial<TaskStatusBarData>) {
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
        const { elapsedMs, totalTokens, contextSize, modelName, shellMode, modeDisplay, modeColor } = this.data;
        const colors = getStatusBarColors();

        // 构建左侧 cells（任务级信息）
        const leftCells: { text: string }[] = [];

        // 模式指示器始终显示在最左侧
        if (modeDisplay) {
            const colorFn = modeColor ? chalk.hex(modeColor) : chalk.hex(colors.fg);
            leftCells.push({ text: colorFn(modeDisplay) });
        }

        if (shellMode) {
            leftCells.push({ text: chalk.cyan('📟 Shell 命令模式') });
        } else {
            if (this.timerStarted) {
                const icon = TaskStatusBar.SPINNER[this.spinnerFrame];
                leftCells.push({ text: chalk.hex(colors.fgAccent)(`${icon} ${this.formatElapsed(elapsedMs)}`) });
            } else if (elapsedMs > 0) {
                leftCells.push({ text: chalk.hex(colors.fgDim)(`⏱ ${this.formatElapsed(elapsedMs)}`) });
            }
            if (totalTokens > 0) {
                const pct = contextSize > 0 ? ((totalTokens / contextSize) * 100).toFixed(1) : '—';
                leftCells.push({ text: `Tokens: ${totalTokens}/${contextSize} (${pct}%)` });
            }
            if (modelName) {
                leftCells.push({ text: modelName });
            }
        }

        const leftContent = leftCells.length > 0 ? ` ${leftCells.map((c) => c.text).join('  │  ')}` : '';

        // 右侧固定区域：帮助提示（含模式切换提示，使用可配置快捷键）
        const shortcuts = getShortcuts();
        const fmtKey = (k: string) => SlashCommandRegistry.formatKeyLabel(k);
        const rightHint =
            chalk.hex(colors.fgDim)(
                `${fmtKey(shortcuts.switch_mode)} ${t('input.statusbar.switchmode')}  ${fmtKey(shortcuts.show_help)} ${t('input.statusbar.help')}`
            ) + ' ';

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
        const line = chalk.bgHex(colors.bg)(
            chalk.hex(colors.fg)(finalLeft) + ' '.repeat(gap) + chalk.hex(colors.fg)(rightHint)
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
    for (const bin of ['fd', 'fdfind']) {
        const p = findExecutableInPath(bin);
        if (p) {
            _cachedFdPath = p;
            return _cachedFdPath;
        }
    }
    _cachedFdPath = null;
    return null;
}

/** 缓存的 user-invocable skill 列表（name -> description），用于同步的自动补全 */
interface CachedSkillInfo {
    name: string;
    description: string;
    bundleName: string;
    argumentHint?: string;
}

let _cachedUserInvocableSkills: CachedSkillInfo[] = [];

/**
 * 异步刷新 user-invocable skill 缓存
 */
async function refreshSkillCache() {
    try {
        const registry = AISkillRegistry.getInstance();
        const skills = await registry.getUserInvocableSkills();
        _cachedUserInvocableSkills = skills.map(({ bundleName, skill }) => ({
            name: skill.frontmatter.name,
            description: skill.frontmatter.description || '',
            bundleName,
            argumentHint: skill.frontmatter['argument-hint']
        }));
    } catch {
        // 初始阶段 registry 可能还没就绪，静默忽略
    }
}

export function getCachedUserInvocableSkills(): CachedSkillInfo[] {
    return _cachedUserInvocableSkills;
}

/**
 * 包装 CombinedAutocompleteProvider，当 fd 不可用时为 @ 前缀提供
 * 基于 readdirSync 的本地文件补全回退；当以 ! 开头时提供 shell 命令补全。
 * 同时提供 /skillname 的自动补全支持。
 */
class FileAwareAutocompleteProvider implements AutocompleteProvider {
    private commandNames: Set<string>;

    constructor(
        private inner: CombinedAutocompleteProvider,
        private basePath: string,
        commandNames: string[]
    ) {
        this.commandNames = new Set(commandNames);
    }

    updateBasePath(newBasePath: string) {
        this.basePath = newBasePath;
    }

    /**
     * 获取行内（非行首） /skillname 的补全建议
     * 当用户在非行首位置输入 / 或 /xxx 时触发
     */
    private getInlineSkillSuggestions(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null {
        // 匹配行内的 / 或 /xxx 模式：前面必须有空格
        const match = textBeforeCursor.match(/(?:\s)(\/[a-z0-9][-a-z0-9]*)$|(?:\s)(\/)$/);
        if (!match) return null;

        const slashPrefix = match[1] || match[2]; // e.g. "/exp" or "/"
        const namePrefix = slashPrefix.slice(1); // e.g. "exp" or ""

        const skills = _cachedUserInvocableSkills;
        if (skills.length === 0) return null;

        const items: AutocompleteItem[] = [];
        for (const skill of skills) {
            if (namePrefix === '' || skill.name.startsWith(namePrefix) || skill.name.includes(namePrefix)) {
                items.push({
                    value: skill.name,
                    label: skill.name,
                    description: `[skill] ${skill.description.slice(0, 60)}`
                });
            }
        }
        if (items.length === 0) return null;
        return { items, prefix: slashPrefix };
    }

    getSuggestions(lines: string[], cursorLine: number, cursorCol: number) {
        const currentLine = lines[cursorLine] || '';
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

        // 判断是否行首（trimmed 后以 / 开头且不含空格）
        const trimmedBefore = textBeforeCursor.trimStart();
        const isLineStart = trimmedBefore.startsWith('/') && !trimmedBefore.includes(' ');

        if (isLineStart) {
            // 行首：由 CombinedAutocompleteProvider 补全 command，我们再追加 skill
            const result = this.inner.getSuggestions(lines, cursorLine, cursorCol);
            const namePrefix = trimmedBefore.slice(1);

            // 过滤不与 command 重名的 user-invocable skill
            const skillItems: AutocompleteItem[] = [];
            for (const skill of _cachedUserInvocableSkills) {
                if (this.commandNames.has(skill.name)) continue; // command 优先
                if (skill.name.startsWith(namePrefix) || skill.name.includes(namePrefix)) {
                    skillItems.push({
                        value: skill.name,
                        label: skill.name,
                        description: `[skill] ${skill.description.slice(0, 60)}`
                    });
                }
            }

            if (result && result.items.length > 0) {
                if (skillItems.length > 0) {
                    result.items.push(...skillItems);
                }
                return result;
            }

            if (skillItems.length > 0) {
                return { items: skillItems, prefix: textBeforeCursor };
            }
            return result;
        }

        // 非行首：检查是否有行内 /skillname 需要补全
        const inlineSkill = this.getInlineSkillSuggestions(textBeforeCursor);
        if (inlineSkill) return inlineSkill;

        const result = this.inner.getSuggestions(lines, cursorLine, cursorCol);
        if (result && result.items.length > 0) return result;

        const atMatch = extractAtQuery(textBeforeCursor);
        if (atMatch) {
            const items = getFileCompletions(this.basePath, atMatch.query, {
                atPrefix: true,
                maxResults: FILE_COMPLETION_MAX_RESULTS
            });
            if (items.length > 0) {
                return { items, prefix: atMatch.fullPrefix };
            }
        }

        return result;
    }

    applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
        // For shell mode completions, handle insertion manually
        const currentLine = lines[cursorLine] || '';
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

        // 行内 /skillname 补全：替换 /prefix 为 /skillname + 空格
        if (prefix.startsWith('/') && item.description?.startsWith('[skill]')) {
            const before = currentLine.slice(0, cursorCol);
            const after = currentLine.slice(cursorCol);
            const prefixStart = cursorCol - prefix.length;
            const newLine = before.slice(0, prefixStart) + '/' + item.value + ' ' + after;
            const newLines = [...lines];
            newLines[cursorLine] = newLine;
            const newCol = prefixStart + item.value.length + 2; // +2 for "/" and space
            return { lines: newLines, cursorLine, cursorCol: newCol };
        }

        return this.inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    }
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

    invalidate(): void {}

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
            scrollHints.push(chalk.dim(t('inline.panel.scroll')));
        }
        scrollHints.push(chalk.dim(t('inline.panel.close')));
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
    /** 任务级状态栏，仅展示当前任务相关信息（计时、token、模型）。 */
    statusBar: TaskStatusBar = new TaskStatusBar();
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
    private permissionWidget: PermissionPromptWidget | null = null;

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
            this.tryTriggerInlineSkillAutocomplete();
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

    /**
     * 检测行内 /skillname 上下文并手动触发自动补全。
     * pi-tui 的 Editor 仅在行首输入 / 时自动触发补全，
     * 行内的 / 不会触发。此方法弥补这一缺口。
     */
    private tryTriggerInlineSkillAutocomplete() {
        const editor = this.input as any;
        // 如果已经在显示自动补全，不重复触发
        if (editor.autocompleteState) return;
        if (!editor.autocompleteProvider) return;

        const lines: string[] = editor.state.lines;
        const cursorLine: number = editor.state.cursorLine;
        const cursorCol: number = editor.state.cursorCol;
        const currentLine = lines[cursorLine] || '';
        const textBeforeCursor = currentLine.slice(0, cursorCol);

        // 行首的 / 由 Editor 原生处理，这里只处理行内
        const trimmedBefore = textBeforeCursor.trimStart();
        if (trimmedBefore.startsWith('/') && !trimmedBefore.includes(' ')) return;

        // 检测行内 / 或 /xxx 模式（前面有空格）
        if (/\s\/[a-z0-9]?[-a-z0-9]*$/.test(textBeforeCursor)) {
            if (_cachedUserInvocableSkills.length > 0) {
                editor.tryTriggerAutocomplete();
            }
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
        this.hintText.setText(chalk.cyan(t('input.hint.shell.executing', { cmd })));
        this.openDeskTUI.tui.requestRender();

        const cwd = this.openDeskTUI.workspace;

        executeShellCommand(cmd, cwd, {
            onHint: (text) => {
                this.hintText.setText(text);
            },
            onResult: (header, output) => {
                this.shellResultPanel.show(header, output);
                this.hintText.setText('');
                this.refreshHint();
            },
            onError: (header, output) => {
                this.shellResultPanel.show(header, output);
                this.hintText.setText('');
                this.refreshHint();
            },
            onCwdChanged: (newCwd) => {
                this.openDeskTUI.updateWorkspace(newCwd);
            },
            requestRender: () => {
                this.openDeskTUI.tui.requestRender();
            }
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
        if (this.shellResultPanel.isVisible()) {
            this.shellResultPanel.hide();
            changed = true;
        }
        if (this.btwResultPanel.isVisible()) {
            this.btwResultPanel.hide();
            changed = true;
        }
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
        const commands = this.commandRegistry.toPiTuiSlashCommands();
        const commandNames = this.commandRegistry.getAll().map((c) => c.name);
        const inner = new CombinedAutocompleteProvider(commands, basePath, fdPath);
        const provider = new FileAwareAutocompleteProvider(inner, basePath, commandNames);
        this.input.setAutocompleteProvider(provider);
        // 异步刷新 skill 缓存
        refreshSkillCache();
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
            this.hintText.setText(chalk.dim(t('input.hint.running')));
        } else {
            this.hintText.setText('');
        }
    }

    setStatus(status: AgentInputStatus) {
        this.status = status;
        this.refreshHint();
        // 配置模式（/config）未设置 hasOpenOverlay，但输入区不在当前布局中；
        // 若在 idle 时抢焦点会导致焦点落到不可见组件，界面表现为卡死。
        if (this.status === 'idle' && !this.openDeskTUI.isInputBlocked()) {
            this.openDeskTUI.tui.setFocus(this.input);
        }
    }

    private updateQueueHint() {
        const len = this.messageQueue.length;
        if (len === 0) {
            this.hintText.setText('');
        } else if (len === 1) {
            const preview =
                this.messageQueue[0].length > 60 ? this.messageQueue[0].slice(0, 57) + '...' : this.messageQueue[0];
            this.hintText.setText(chalk.yellow(t('input.hint.queue.single', { preview })));
        } else {
            this.hintText.setText(chalk.yellow(t('input.hint.queue.multiple', { count: len })));
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

    /**
     * 显示权限确认 widget，临时替换掉 Editor 输入框。
     */
    showPermissionPrompt(widget: PermissionPromptWidget) {
        this.permissionWidget = widget;
        this.layout.removeChild(this.input);
        this.layout.removeChild(this.statusBar);
        this.layout.addChild(widget);
        this.layout.addChild(this.statusBar);
    }

    /**
     * 是否有权限/问答/计划审批等 prompt widget 正在显示。
     */
    hasPromptWidget(): boolean {
        return this.permissionWidget !== null;
    }

    /**
     * 隐藏权限确认 widget，恢复 Editor 输入框。
     */
    hidePermissionPrompt() {
        if (!this.permissionWidget) return;
        this.layout.removeChild(this.permissionWidget);
        this.layout.removeChild(this.statusBar);
        this.layout.addChild(this.input);
        this.layout.addChild(this.statusBar);
        this.permissionWidget = null;
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
