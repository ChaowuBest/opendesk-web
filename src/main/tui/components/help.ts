import { type Component, Box, Text, Key, matchesKey } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import { SlashCommandRegistry } from '../commands';
import { defaultSelectListTheme } from '../theme';
import { OpenDeskTUI } from '../entry';
import { SelectTable, type SelectRow } from './selecttable';
import { SkillRegistry } from '../../aikernel/skill';
import { getShortcuts } from '../../utils/setting.js';
import { t } from '../../../locale/index.js';

type HelpTab = 'commands' | 'skills' | 'shortcuts';

export class HelpOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private box: Box;
    private headerText: Text;

    private commandTable: SelectTable;
    private skillTable: SelectTable;
    private shortcutTable: SelectTable;

    private activeTab: HelpTab = 'commands';
    private readonly tabOrder: HelpTab[] = ['commands', 'skills', 'shortcuts'];
    private overlayHandle?: { hide: () => void };
    private removeInputListener?: () => void;

    constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;
        const maxVisibleRows = this.getMaxVisibleRows();

        // ── 构建 Commands 表格 ──
        const commands = this.openDeskTUI.commandRegistry.getAll();
        const commandRows: SelectRow[] = commands.map((cmd) => ({
            labels: [
                chalk.bold('/' + cmd.name),
                cmd.shortcut ? chalk.cyan(SlashCommandRegistry.formatKeyLabel(cmd.shortcut)) : '',
                cmd.description
            ],
            value: cmd.name
        }));
        if (commandRows.length === 0) {
            commandRows.push({ labels: ['', '', chalk.dim(t('help.no.commands'))], value: '_empty' });
        }

        this.commandTable = new SelectTable(commandRows, maxVisibleRows, defaultSelectListTheme);
        this.commandTable.setColumnStrechFactors([0, 0, 1]);

        // ── 构建 Skills 表格（初始为空，异步填充） ──
        const placeholderRows: SelectRow[] = [{ labels: [chalk.dim(t('help.skills.loading'))], value: '_loading' }];
        this.skillTable = new SelectTable(placeholderRows, maxVisibleRows, defaultSelectListTheme);
        this.skillTable.setColumnStrechFactors([0, 1]);

        // 异步加载 skill 列表
        this.loadSkills();

        // ── 构建 Shortcuts 表格 ──
        this.shortcutTable = this.buildShortcutTable(maxVisibleRows);

        this.headerText = new Text(this.buildHeader());

        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex('#2d2d2d').hex('#e0e0e0')(text));
        this.box.addChild(this.headerText);
        this.box.addChild(this.commandTable);

        // 代理 SelectTable 事件
        this.setupTableCallbacks(this.commandTable);
        this.setupTableCallbacks(this.skillTable);
        this.setupTableCallbacks(this.shortcutTable);
    }

    private setupTableCallbacks(table: SelectTable) {
        table.onSelect = () => {
            this.close();
        };
        table.onCancel = () => {
            this.close();
        };
    }

    private close() {
        this.removeInputListener?.();
        this.removeInputListener = undefined;
        this.overlayHandle?.hide();
        this.openDeskTUI.hasOpenOverlay = false;
        this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
    }

    private buildShortcutTable(maxVisibleRows: number): SelectTable {
        const shortcuts = getShortcuts();
        const shortcutDefs: Array<{ key: string; descKey: string }> = [
            { key: 'switch_mode', descKey: 'shortcut.switch_mode' },
            { key: 'switch_model', descKey: 'shortcut.switch_model' },
            { key: 'endline', descKey: 'shortcut.endline' },
            { key: 'show_help', descKey: 'shortcut.show_help' },
            { key: 'clear_input', descKey: 'shortcut.clear_input' },
            { key: 'list_tasks', descKey: 'shortcut.list_tasks' }
        ];

        const rows: SelectRow[] = shortcutDefs.map((def) => ({
            labels: [
                chalk.bold(t(def.descKey)),
                chalk.cyan(SlashCommandRegistry.formatKeyLabel(shortcuts[def.key as keyof typeof shortcuts]))
            ],
            value: def.key
        }));

        if (rows.length === 0) {
            rows.push({ labels: [chalk.dim(t('help.no.shortcuts')), ''], value: '_empty' });
        }

        const table = new SelectTable(rows, maxVisibleRows, defaultSelectListTheme);
        table.setColumnStrechFactors([1, 0]);
        return table;
    }

    private buildHeader(): string {
        const cmdText = ` ${t('help.tab.commands')} `;
        const skillText = ` ${t('help.tab.skills')} `;
        const shortcutText = ` ${t('help.tab.shortcuts')} `;
        const cmdLabel = this.activeTab === 'commands' ? chalk.bold.underline(cmdText) : chalk.dim(cmdText);
        const skillLabel = this.activeTab === 'skills' ? chalk.bold.underline(skillText) : chalk.dim(skillText);
        const shortcutLabel =
            this.activeTab === 'shortcuts' ? chalk.bold.underline(shortcutText) : chalk.dim(shortcutText);
        return ` ${cmdLabel}  ${skillLabel}  ${shortcutLabel}  ${chalk.dim(t('help.tab.switch'))}`;
    }

    private async loadSkills() {
        try {
            const registry = SkillRegistry.getInstance();
            const userInvocable = await registry.getUserInvocableSkills();

            const rows: SelectRow[] = userInvocable.map(({ bundleName, skill }) => {
                const invocableTag = skill.isModelInvocable ? chalk.green('auto') : chalk.yellow('manual');
                return {
                    labels: [
                        chalk.bold('/' + skill.frontmatter.name),
                        invocableTag,
                        skill.frontmatter.description || ''
                    ],
                    value: skill.frontmatter.name
                };
            });

            if (rows.length === 0) {
                rows.push({
                    labels: [chalk.dim(t('help.skills.none')), '', chalk.dim(t('help.skills.manage'))],
                    value: '_empty'
                });
            }

            this.skillTable = new SelectTable(rows, this.getMaxVisibleRows(), defaultSelectListTheme);
            this.skillTable.setColumnStrechFactors([0, 0, 1]);
            this.setupTableCallbacks(this.skillTable);

            if (this.activeTab === 'skills') {
                this.rebuildBox();
                this.openDeskTUI.tui.setFocus(this.skillTable.innerList);
            }
            this.openDeskTUI.tui.requestRender();
        } catch {
            // 加载失败不影响主流程
        }
    }

    private getMaxVisibleRows(): number {
        // 预留标题栏和边框空间，避免列表高度超过 overlay 可见区域而被裁剪
        const available = this.openDeskTUI.tui.terminal.rows - 10;
        return Math.max(5, Math.min(20, available));
    }

    private switchTab(tab: HelpTab) {
        if (this.activeTab === tab) return;
        this.activeTab = tab;
        this.headerText.setText(this.buildHeader());
        this.rebuildBox();

        const activeTable = this.getActiveTable();
        this.openDeskTUI.tui.setFocus(activeTable.innerList);
        this.openDeskTUI.tui.requestRender();
    }

    private getActiveTable(): SelectTable {
        if (this.activeTab === 'commands') return this.commandTable;
        if (this.activeTab === 'skills') return this.skillTable;
        return this.shortcutTable;
    }

    private rebuildBox() {
        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex('#2d2d2d').hex('#e0e0e0')(text));
        this.box.addChild(this.headerText);
        this.box.addChild(this.getActiveTable());
    }

    invalidate(): void {
        this.box.invalidate();
    }

    render(width: number): string[] {
        return this.box.render(width);
    }

    show() {
        const terminalWidth = this.openDeskTUI.tui.terminal.columns;
        const terminalHeight = this.openDeskTUI.tui.terminal.rows;
        const overlayWidth = Math.min(90, terminalWidth - 4);
        const overlayMaxHeight = Math.max(5, terminalHeight - 4);

        this.overlayHandle = this.openDeskTUI.tui.showOverlay(this, {
            width: overlayWidth,
            maxHeight: overlayMaxHeight,
            anchor: 'center'
        });

        this.openDeskTUI.hasOpenOverlay = true;
        this.openDeskTUI.tui.setFocus(this.commandTable.innerList);

        // 拦截左右键输入来切换 tab
        this.removeInputListener = this.openDeskTUI.tui.addInputListener((data) => {
            if (!this.openDeskTUI.hasOpenOverlay) {
                return undefined;
            }

            if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
                const idx = this.tabOrder.indexOf(this.activeTab);
                const dir = matchesKey(data, Key.right) ? 1 : -1;
                const newIdx = (idx + dir + this.tabOrder.length) % this.tabOrder.length;
                this.switchTab(this.tabOrder[newIdx]);
                return { consume: true };
            }
            return undefined;
        });
    }
}
