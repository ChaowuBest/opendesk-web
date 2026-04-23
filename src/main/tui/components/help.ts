import { type Component, Box, Text, Key, matchesKey } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import { SlashCommandRegistry } from '../commands';
import { defaultSelectListTheme } from '../theme';
import { OpenDeskTUI } from '../entry';
import { SelectTable, type SelectRow } from './selecttable';
import { SkillRegistry } from '../../aikernel/skill';

type HelpTab = 'commands' | 'skills';

export class HelpOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private box: Box;
    private headerText: Text;

    private commandTable: SelectTable;
    private skillTable: SelectTable;

    private activeTab: HelpTab = 'commands';
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
            commandRows.push({ labels: ['', '', chalk.dim('暂无命令')], value: '_empty' });
        }

        this.commandTable = new SelectTable(commandRows, maxVisibleRows, defaultSelectListTheme);
        this.commandTable.setColumnStrechFactors([0, 0, 1]);

        // ── 构建 Skills 表格（初始为空，异步填充） ──
        const placeholderRows: SelectRow[] = [{ labels: [chalk.dim('加载中...')], value: '_loading' }];
        this.skillTable = new SelectTable(placeholderRows, maxVisibleRows, defaultSelectListTheme);
        this.skillTable.setColumnStrechFactors([0, 1]);

        // 异步加载 skill 列表
        this.loadSkills();

        this.headerText = new Text(this.buildHeader());

        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex('#2d2d2d').hex('#e0e0e0')(text));
        this.box.addChild(this.headerText);
        this.box.addChild(this.commandTable);

        // 代理 SelectTable 事件
        this.setupTableCallbacks(this.commandTable);
        this.setupTableCallbacks(this.skillTable);
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

    private buildHeader(): string {
        const cmdLabel = this.activeTab === 'commands' ? chalk.bold.underline(' 指令 ') : chalk.dim(' 指令 ');
        const skillLabel = this.activeTab === 'skills' ? chalk.bold.underline(' 技能 ') : chalk.dim(' 技能 ');
        return ` ${cmdLabel}  ${skillLabel}  ${chalk.dim('← → 切换')}`;
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
                    labels: [chalk.dim('暂无可用技能'), '', chalk.dim('使用 /skills 管理技能')],
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

        const activeTable = this.activeTab === 'commands' ? this.commandTable : this.skillTable;
        this.openDeskTUI.tui.setFocus(activeTable.innerList);
        this.openDeskTUI.tui.requestRender();
    }

    private rebuildBox() {
        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex('#2d2d2d').hex('#e0e0e0')(text));
        this.box.addChild(this.headerText);
        this.box.addChild(this.activeTab === 'commands' ? this.commandTable : this.skillTable);
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
                const newTab: HelpTab = this.activeTab === 'commands' ? 'skills' : 'commands';
                this.switchTab(newTab);
                return { consume: true };
            }
            return undefined;
        });
    }
}
