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

import { type Component, SelectList, Box, Text, Input, TUI, Key, matchesKey, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import chalk from "chalk";
import { defaultSelectListTheme } from "../../tui/theme";
import { OpenDeskTUI } from "../../tui/entry";
import { SkillTestFramework, type TestSuiteResult, type TestResult, type EnvironmentCheck } from "./skill-test.js";
import { SkillRegistry } from "./skillregistry.js";

type TestViewState =
    | 'main'
    | 'select-skill'
    | 'running'
    | 'results'
    | 'test-detail';

export class SkillTestOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private box: Box;
    private header: Text;
    private list?: SelectList;
    private input?: Input;
    private state: TestViewState = 'main';
    private message: { text: string; isError: boolean } | null = null;
    private loading = false;
    private removeInputListener?: () => void;
    private messageTimeout?: NodeJS.Timeout;
    private overlayHandle?: any;
    private testableSkills: string[] = [];
    private currentResult: TestSuiteResult | null = null;
    private selectedTestIndex = 0;
    private resultScrollOffset = 0;
    private detailScrollOffset = 0;
    private detailContentLines: string[] = [];
    private resultContentLines: string[] = [];
    private testStartLineIndex = 0;
    /**  overlay 实际可用高度（由 show() 设置），用于计算可显示内容行数 */
    private overlayMaxHeight = 20;
    private readonly maxVisibleLines = 40;
    private readonly maxDetailLines = 30;

    constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;
        this.header = new Text(chalk.bold(' 技能测试'));
        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex('#1a1a2e').hex('#e0e0e0')(text));
        this.box.addChild(this.header);
    }

    private async loadTestableSkills() {
        try {
            this.testableSkills = SkillTestFramework.listTestableSkills();
        } catch (e) {
            this.testableSkills = [];
        }
    }

    private showMessage(text: string, isError: boolean = false) {
        if (this.messageTimeout) {
            clearTimeout(this.messageTimeout);
        }
        this.message = { text, isError };
        this.renderBox();
        this.messageTimeout = setTimeout(() => {
            this.message = null;
            this.renderBox();
        }, 3000);
    }

    private setLoading(loading: boolean) {
        this.loading = loading;
        this.renderBox();
    }

    private cleanup() {
        if (this.removeInputListener) {
            this.removeInputListener();
            this.removeInputListener = undefined;
        }
        this.loading = false;
    }

    private showMain() {
        this.cleanup();
        this.state = 'main';
        this.input = undefined;
        this.currentResult = null;
        this.header = new Text(chalk.bold(' 技能测试'));

        const items = [
            { value: 'select', label: chalk.cyan('🔍 选择技能进行测试') },
            { value: 'input', label: chalk.green('⌨️ 输入技能名称测试') },
            { value: 'all', label: chalk.yellow('📋 测试所有可测试技能') },
        ];

        this.list = new SelectList(items, items.length, defaultSelectListTheme);
        this.setupListHandlers();
        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.list);
    }

    private showSelectSkill() {
        this.cleanup();
        this.state = 'select-skill';
        this.input = undefined;

        this.header = new Text(chalk.bold(' 选择技能'));

        if (this.testableSkills.length === 0) {
            const items = [{ value: 'back', label: chalk.gray('没有可测试的技能，按 Enter 返回') }];
            this.list = new SelectList(items, 1, defaultSelectListTheme);
        } else {
            const items = this.testableSkills.map(skillId => {
                const skill = SkillRegistry.getSkillBody(skillId);
                const name = skill?.frontmatter?.name || skillId;
                const desc = skill?.frontmatter?.description || '';
                const truncatedDesc = truncateToWidth(desc, 30, '...', false);
                return {
                    value: skillId,
                    label: `${chalk.bold(name)} ${chalk.dim('·')} ${chalk.dim(truncatedDesc)}`,
                };
            });
            this.list = new SelectList(items, Math.min(items.length, 10), defaultSelectListTheme);
        }

        this.setupListHandlers();
        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.list);
    }

    private showInputSkill() {
        this.cleanup();
        this.state = 'select-skill';
        this.list = undefined;

        this.header = new Text(chalk.bold(' 输入技能名称'));

        this.input = new Input();
        this.input.onSubmit = () => {
            this.runTestForSkill(this.input?.getValue().trim() || '').catch(err => {
                console.error('Test error:', err);
            });
        };

        this.setupInputHandlers();
        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.input);
    }

    private async runTestForSkill(skillId: string) {
        if (!skillId) {
            this.showMessage('请输入技能名称', true);
            return;
        }

        this.setLoading(true);
        this.state = 'running';
        this.renderBox();

        try {
            const result = await SkillTestFramework.runSkillTests(skillId);
            
            if (!result) {
                this.showMessage(`技能 "${skillId}" 不存在`, true);
                this.showMain();
                return;
            }

            this.currentResult = result;
            this.showResults();
        } catch (e: any) {
            this.showMessage(e?.message || '测试失败', true);
            this.showMain();
        } finally {
            this.setLoading(false);
        }
    }

    private async runAllTests() {
        if (this.testableSkills.length === 0) {
            this.showMessage('没有可测试的技能', true);
            return;
        }

        this.setLoading(true);
        this.state = 'running';
        this.renderBox();

        let totalPassed = 0;
        let totalFailed = 0;
        let totalTests = 0;

        for (const skillId of this.testableSkills) {
            try {
                const result = await SkillTestFramework.runSkillTests(skillId);
                if (result) {
                    totalPassed += result.summary.passed;
                    totalFailed += result.summary.failed + result.summary.error;
                    totalTests += result.summary.total;
                }
            } catch (e) {
                totalFailed++;
            }
        }

        this.setLoading(false);
        this.showMessage(`测试完成: ${totalPassed}/${totalTests} 通过, ${totalFailed} 失败`, totalFailed > 0);
        this.showMain();
    }

    private showResults() {
        this.cleanup();
        this.state = 'results';
        this.list = undefined;
        this.input = undefined;
        this.resultScrollOffset = 0;
        this.selectedTestIndex = 0;
        this.resultContentLines = [];
        this.testStartLineIndex = 0;

        if (!this.currentResult) {
            this.showMain();
            return;
        }

        const result = this.currentResult;
        const statusIcon = result.summary.failed === 0 && result.summary.error === 0
            ? chalk.green('✓')
            : chalk.red('✗');
        
        this.header = new Text(chalk.bold(` 测试结果 ${statusIcon} ${result.skillName}`));

        this.buildResultContent();
        this.renderBox();

        this.removeInputListener = this.openDeskTUI.tui.addInputListener((data: string) => {
            if (matchesKey(data, Key.escape)) {
                this.currentResult = null;
                this.showMain();
                return { consume: true };
            }
            if (matchesKey(data, Key.up) || data === 'k') {
                if (this.selectedTestIndex > 0) {
                    this.selectedTestIndex--;
                    this.buildResultContent();
                    this.adjustScrollOffset();
                    this.renderBox();
                }
                return { consume: true };
            }
            if (matchesKey(data, Key.down) || data === 'j') {
                if (this.currentResult && this.selectedTestIndex < this.currentResult.tests.length - 1) {
                    this.selectedTestIndex++;
                    this.buildResultContent();
                    this.adjustScrollOffset();
                    this.renderBox();
                }
                return { consume: true };
            }
            if (matchesKey(data, Key.pageUp) || data === 'b' || data === 'B') {
                const h = this.contentHeight;
                this.resultScrollOffset = Math.max(0, this.resultScrollOffset - h);
                this.buildResultContent();
                this.adjustScrollOffset();
                this.renderBox();
                return { consume: true };
            }
            if (matchesKey(data, Key.pageDown) || data === 'f' || data === 'F') {
                const h = this.contentHeight;
                const maxOffset = Math.max(0, this.resultContentLines.length - h);
                this.resultScrollOffset = Math.min(maxOffset, this.resultScrollOffset + h);
                this.buildResultContent();
                this.adjustScrollOffset();
                this.renderBox();
                return { consume: true };
            }
            if (data === 'g') {
                this.selectedTestIndex = 0;
                this.resultScrollOffset = 0;
                this.buildResultContent();
                this.renderBox();
                return { consume: true };
            }
            if (data === 'G') {
                if (this.currentResult && this.currentResult.tests.length > 0) {
                    this.selectedTestIndex = this.currentResult.tests.length - 1;
                    this.buildResultContent();
                    const maxOffset = Math.max(0, this.resultContentLines.length - this.contentHeight);
                    this.resultScrollOffset = maxOffset;
                    this.renderBox();
                }
                return { consume: true };
            }
            if (data === 'r' || data === 'R') {
                if (this.currentResult) {
                    this.runTestForSkill(this.currentResult.skillId);
                }
                return { consume: true };
            }
            if (matchesKey(data, Key.enter)) {
                this.showTestDetail();
                return { consume: true };
            }
            return undefined;
        });
    }

    private showTestDetail() {
        if (!this.currentResult || this.currentResult.tests.length === 0) return;

        this.cleanup();
        this.state = 'test-detail';
        this.list = undefined;
        this.input = undefined;
        this.detailScrollOffset = 0;
        this.detailContentLines = [];

        const test = this.currentResult.tests[this.selectedTestIndex];
        this.header = new Text(chalk.bold(` 测试详情: ${test.name}`));

        this.buildDetailContent();
        this.renderBox();

        this.removeInputListener = this.openDeskTUI.tui.addInputListener((data: string) => {
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
                this.showResults();
                return { consume: true };
            }
            if (matchesKey(data, Key.up) || data === 'k') {
                if (this.detailScrollOffset > 0) {
                    this.detailScrollOffset--;
                    this.renderBox();
                }
                return { consume: true };
            }
            if (matchesKey(data, Key.down) || data === 'j') {
                const maxOffset = Math.max(0, this.detailContentLines.length - this.contentHeight);
                if (this.detailScrollOffset < maxOffset) {
                    this.detailScrollOffset++;
                    this.renderBox();
                }
                return { consume: true };
            }
            if (matchesKey(data, Key.pageUp) || data === 'b' || data === 'B') {
                this.detailScrollOffset = Math.max(0, this.detailScrollOffset - this.contentHeight);
                this.renderBox();
                return { consume: true };
            }
            if (matchesKey(data, Key.pageDown) || data === 'f' || data === 'F') {
                const maxOffset = Math.max(0, this.detailContentLines.length - this.contentHeight);
                this.detailScrollOffset = Math.min(maxOffset, this.detailScrollOffset + this.contentHeight);
                this.renderBox();
                return { consume: true };
            }
            if (data === 'g') {
                this.detailScrollOffset = 0;
                this.renderBox();
                return { consume: true };
            }
            if (data === 'G') {
                const maxOffset = Math.max(0, this.detailContentLines.length - this.contentHeight);
                this.detailScrollOffset = maxOffset;
                this.renderBox();
                return { consume: true };
            }
            return undefined;
        });
    }

    private buildDetailContent() {
        this.detailContentLines = [];
        if (!this.currentResult) return;

        const test = this.currentResult.tests[this.selectedTestIndex];
        const terminalWidth = this.openDeskTUI.tui.terminal.columns;
        const overlayWidth = Math.min(90, terminalWidth - 4);

        this.detailContentLines.push(`${chalk.bold('名称')}: ${test.name}`);
        this.detailContentLines.push(`${chalk.bold('文件')}: ${truncateToWidth(test.file, overlayWidth - 10, '...', false)}`);
        this.detailContentLines.push(`${chalk.bold('状态')}: ${this.formatStatus(test.status)}`);
        this.detailContentLines.push(`${chalk.bold('耗时')}: ${test.duration}ms`);

        if (test.message) {
            this.detailContentLines.push(chalk.bold('消息:') + ` ${test.message}`);
        }

        if (test.error) {
            this.detailContentLines.push(chalk.bold('错误输出:'));
            const errorLines = test.error.split('\n');
            for (const line of errorLines) {
                this.detailContentLines.push(chalk.red(`  ${truncateToWidth(line, overlayWidth - 6, '...', false)}`));
            }
        }

        if (test.details) {
            this.detailContentLines.push(chalk.bold('详细输出:'));
            const detailLines = test.details.split('\n');
            for (const line of detailLines) {
                this.detailContentLines.push(chalk.dim(`  ${truncateToWidth(line, overlayWidth - 6, '...', false)}`));
            }

        }
    }

    private buildResultContent() {
        this.resultContentLines = [];
        this.testStartLineIndex = 0;
        if (!this.currentResult) return;

        const result = this.currentResult;
        const terminalWidth = this.openDeskTUI.tui.terminal.columns;
        const overlayWidth = Math.min(90, terminalWidth - 4);

        this.resultContentLines.push(chalk.cyan('环境检查'));
        for (const check of result.environment.checks) {
            const icon = check.passed ? chalk.green('✓') : chalk.red('✗');
            this.resultContentLines.push(`  ${icon} ${check.name}: ${check.message}`);
        }

        const summary = result.summary;
        const summaryLine = `总计: ${summary.total} | ` +
            chalk.green(`通过: ${summary.passed}`) + ' | ' +
            chalk.red(`失败: ${summary.failed}`) + ' | ' +
            chalk.yellow(`跳过: ${summary.skipped}`) + ' | ' +
            `耗时: ${(summary.duration / 1000).toFixed(2)}s`;
        this.resultContentLines.push(summaryLine);

        this.testStartLineIndex = this.resultContentLines.length;

        for (let i = 0; i < result.tests.length; i++) {
            const test = result.tests[i];
            const isSelected = i === this.selectedTestIndex;
            const prefix = isSelected ? chalk.cyan('▶ ') : '  ';

            let icon: string;
            let color: (text: string) => string;
            switch (test.status) {
                case 'passed':
                    icon = '✓';
                    color = chalk.green;
                    break;
                case 'failed':
                    icon = '✗';
                    color = chalk.red;
                    break;
                case 'skipped':
                    icon = '○';
                    color = chalk.yellow;
                    break;
                default:
                    icon = '!';
                    color = chalk.red;
            }

            const duration = `(${test.duration}ms)`;
            this.resultContentLines.push(`${prefix}${color(icon)} ${test.name} ${chalk.dim(duration)}`);
        }
    }

    private adjustScrollOffset() {
        if (!this.currentResult) return;
        const h = this.contentHeight;
        const maxOffset = Math.max(0, this.resultContentLines.length - h);
        const selectedTestLine = this.testStartLineIndex + this.selectedTestIndex;
        if (selectedTestLine < this.resultScrollOffset) {
            this.resultScrollOffset = selectedTestLine;
        } else if (selectedTestLine >= this.resultScrollOffset + h) {
            this.resultScrollOffset = Math.min(maxOffset, selectedTestLine - h + 1);
        }
        this.resultScrollOffset = Math.max(0, Math.min(maxOffset, this.resultScrollOffset));
    }

    private setupListHandlers() {
        if (!this.list) return;

        this.list.onSelect = (item: any) => {
            switch (this.state) {
                case 'main':
                    this.handleMainSelection(item.value);
                    break;
                case 'select-skill':
                    this.handleSkillSelection(item.value);
                    break;
            }
        };

        this.list.onCancel = () => {
            if (this.state === 'main') {
                this.close();
            } else {
                this.showMain();
            }
        };
    }

    private handleMainSelection(value: string) {
        switch (value) {
            case 'select':
                this.loadTestableSkills().then(() => this.showSelectSkill());
                break;
            case 'input':
                this.showInputSkill();
                break;
            case 'all':
                this.loadTestableSkills().then(() => this.runAllTests());
                break;
        }
    }

    private handleSkillSelection(value: string) {
        if (value === 'back') {
            this.showMain();
            return;
        }

        this.runTestForSkill(value);
    }

    private setupInputHandlers() {
        if (!this.input) return;

        this.removeInputListener = this.openDeskTUI.tui.addInputListener((data: string) => {
            if (matchesKey(data, Key.escape)) {
                this.showMain();
                return { consume: true };
            }
            return undefined;
        });
    }

    private close() {
        if (!this.overlayHandle) return;

        const handle = this.overlayHandle;
        this.overlayHandle = undefined;

        this.openDeskTUI.hasOpenOverlay = false;
        handle.hide();

        this.cleanup();
        if (this.messageTimeout) {
            clearTimeout(this.messageTimeout);
            this.messageTimeout = undefined;
        }
        this.message = null;
        this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
    }

    private renderBox() {
        this.box.clear();
        this.box.addChild(this.header);

        if (this.message) {
            const msgText = this.message.isError
                ? chalk.red(`❌ ${this.message.text}`)
                : chalk.green(`✓ ${this.message.text}`);
            this.box.addChild(new Text(msgText));
        }

        if (this.loading) {
            this.box.addChild(new Text(chalk.yellow('⏳ 测试运行中...')));
        }

        if (this.state === 'results' && this.currentResult) {
            this.renderResultsContent();
            this.openDeskTUI.tui.requestRender();
            return;
        }

        if (this.state === 'test-detail' && this.currentResult) {
            this.renderTestDetailContent();
            this.openDeskTUI.tui.requestRender();
            return;
        }

        if (this.list) {
            this.box.addChild(this.list);
        }

        if (this.input) {
            this.box.addChild(new Text(chalk.cyan('输入技能名称:')));
            this.box.addChild(this.input);
        }

        const helpText = this.getHelpText();
        if (helpText) {
            this.box.addChild(new Text(''));
            this.box.addChild(new Text(chalk.dim(helpText)));
        }

        this.openDeskTUI.tui.requestRender();
    }

    private renderResultsContent() {
        if (!this.currentResult || this.resultContentLines.length === 0) return;

        const h = this.contentHeight;
        const maxOffset = Math.max(0, this.resultContentLines.length - h);
        if (this.resultScrollOffset > maxOffset) {
            this.resultScrollOffset = maxOffset;
        }

        const visibleLines = this.resultContentLines.slice(
            this.resultScrollOffset,
            this.resultScrollOffset + h
        );

        for (const line of visibleLines) {
            this.box.addChild(new Text(line));
        }

        if (this.resultContentLines.length > h) {
            const scrollInfo = `[行 ${this.resultScrollOffset + 1}-${Math.min(this.resultScrollOffset + h, this.resultContentLines.length)} / ${this.resultContentLines.length}]`;
            this.box.addChild(new Text(chalk.dim(scrollInfo)));
        }

        this.box.addChild(new Text(chalk.dim('↑/↓ 选择  PgUp/PgDn 翻页  g 顶部 G 底部  Enter 详情  R 重跑  Esc 返回')));
    }

    private renderTestDetailContent() {
        if (!this.currentResult || this.detailContentLines.length === 0) return;

        const h = this.contentHeight;
        const maxOffset = Math.max(0, this.detailContentLines.length - h);
        if (this.detailScrollOffset > maxOffset) {
            this.detailScrollOffset = maxOffset;
        }

        const visibleLines = this.detailContentLines.slice(
            this.detailScrollOffset,
            this.detailScrollOffset + h
        );

        for (const line of visibleLines) {
            this.box.addChild(new Text(line));
        }

        if (this.detailContentLines.length > h) {
            const scrollInfo = `[行 ${this.detailScrollOffset + 1}-${Math.min(this.detailScrollOffset + h, this.detailContentLines.length)} / ${this.detailContentLines.length}]`;
            this.box.addChild(new Text(chalk.dim(scrollInfo)));
        }

        this.box.addChild(new Text(chalk.dim('↑/↓ 滚动  PgUp/PgDn 翻页  g 顶部 G 底部  Esc 返回')));
    }

    private formatStatus(status: string): string {
        switch (status) {
            case 'passed':
                return chalk.green('✓ 通过');
            case 'failed':
                return chalk.red('✗ 失败');
            case 'skipped':
                return chalk.yellow('○ 跳过');
            case 'error':
                return chalk.red('! 错误');
            default:
                return status;
        }
    }

    private getHelpText(): string {
        switch (this.state) {
            case 'main':
                return '↑↓ 选择  Enter 确认  Esc 退出';
            case 'select-skill':
                return '↑↓ 选择技能  Enter 测试  Esc 返回';
            default:
                return '';
        }
    }

    invalidate(): void {
        this.box.invalidate();
    }

    render(width: number): string[] {
        return this.box.render(width);
    }

    /** 结果/详情内容区可用行数（扣除 Box 上下 padding、标题、翻页提示、帮助行） */
    private get contentHeight(): number {
        // Box(1,1) 上下各 1 行 padding；再加 header(1) + scrollInfo(1) + help(1) = 5 行固定
        const reserved = 5;
        return Math.max(5, this.overlayMaxHeight - reserved);
    }

    show(skillId?: string) {
        const terminalWidth = this.openDeskTUI.tui.terminal.columns;
        const terminalHeight = this.openDeskTUI.tui.terminal.rows;
        const overlayWidth = Math.min(90, terminalWidth - 4);
        const overlayMaxHeight = Math.max(15, terminalHeight - 4);
        this.overlayMaxHeight = overlayMaxHeight;

        this.overlayHandle = this.openDeskTUI.tui.showOverlay(this, {
            width: overlayWidth,
            maxHeight: overlayMaxHeight,
            anchor: "center",
        });

        this.openDeskTUI.hasOpenOverlay = true;

        if (skillId) {
            this.runTestForSkill(skillId);
        } else {
            this.loadTestableSkills().then(() => {
                this.showMain();
            });
        }

        this.overlayHandle.onHide = () => {
            if (this.overlayHandle) {
                this.cleanup();
                if (this.messageTimeout) {
                    clearTimeout(this.messageTimeout);
                    this.messageTimeout = undefined;
                }
                this.message = null;
                this.openDeskTUI.hasOpenOverlay = false;
                this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
            }
        };
    }
}
