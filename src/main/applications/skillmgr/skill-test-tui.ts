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
    private readonly maxVisibleLines = 15;

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

        if (!this.currentResult) {
            this.showMain();
            return;
        }

        const result = this.currentResult;
        const statusIcon = result.summary.failed === 0 && result.summary.error === 0
            ? chalk.green('✓')
            : chalk.red('✗');
        
        this.header = new Text(chalk.bold(` 测试结果 ${statusIcon} ${result.skillName}`));

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
                    this.adjustScrollOffset();
                    this.renderBox();
                }
                return { consume: true };
            }
            if (matchesKey(data, Key.down) || data === 'j') {
                if (this.currentResult && this.selectedTestIndex < this.currentResult.tests.length - 1) {
                    this.selectedTestIndex++;
                    this.adjustScrollOffset();
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

        const test = this.currentResult.tests[this.selectedTestIndex];
        this.header = new Text(chalk.bold(` 测试详情: ${test.name}`));

        this.renderBox();

        this.removeInputListener = this.openDeskTUI.tui.addInputListener((data: string) => {
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
                this.showResults();
                return { consume: true };
            }
            if (matchesKey(data, Key.up) || data === 'k') {
                if (this.resultScrollOffset > 0) {
                    this.resultScrollOffset--;
                    this.renderBox();
                }
                return { consume: true };
            }
            if (matchesKey(data, Key.down) || data === 'j') {
                this.renderBox();
                return { consume: true };
            }
            return undefined;
        });
    }

    private adjustScrollOffset() {
        const halfVisible = Math.floor(this.maxVisibleLines / 2);
        if (this.selectedTestIndex < this.resultScrollOffset + halfVisible) {
            this.resultScrollOffset = Math.max(0, this.selectedTestIndex - halfVisible);
        } else if (this.selectedTestIndex >= this.resultScrollOffset + this.maxVisibleLines - halfVisible) {
            this.resultScrollOffset = this.selectedTestIndex - this.maxVisibleLines + halfVisible + 1;
        }
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
        if (!this.currentResult) return;

        const result = this.currentResult;
        const terminalWidth = this.openDeskTUI.tui.terminal.columns;
        const overlayWidth = Math.min(90, terminalWidth - 4);

        this.box.addChild(new Text(''));

        // 环境检查
        this.box.addChild(new Text(chalk.cyan('环境检查')));
        for (const check of result.environment.checks) {
            const icon = check.passed ? chalk.green('✓') : chalk.red('✗');
            const line = `  ${icon} ${check.name}: ${check.message}`;
            this.box.addChild(new Text(line));
        }

        this.box.addChild(new Text(''));

        // 测试摘要
        const summary = result.summary;
        const summaryLine = `总计: ${summary.total} | ` +
            chalk.green(`通过: ${summary.passed}`) + ' | ' +
            chalk.red(`失败: ${summary.failed}`) + ' | ' +
            chalk.yellow(`跳过: ${summary.skipped}`) + ' | ' +
            `耗时: ${(summary.duration / 1000).toFixed(2)}s`;
        this.box.addChild(new Text(summaryLine));
        this.box.addChild(new Text(chalk.dim('─'.repeat(overlayWidth - 4))));

        // 测试用例列表
        this.box.addChild(new Text(chalk.cyan('测试用例')));

        const visibleTests = result.tests.slice(
            this.resultScrollOffset,
            this.resultScrollOffset + this.maxVisibleLines
        );

        for (let i = 0; i < visibleTests.length; i++) {
            const test = visibleTests[i];
            const actualIndex = this.resultScrollOffset + i;
            const isSelected = actualIndex === this.selectedTestIndex;
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
            const line = `${prefix}${color(icon)} ${test.name} ${chalk.dim(duration)}`;
            this.box.addChild(new Text(line));

            if (test.message && test.status !== 'passed') {
                const msgLine = `      ${chalk.dim(truncateToWidth(test.message, overlayWidth - 10, '...', false))}`;
                this.box.addChild(new Text(msgLine));
            }
        }

        if (result.tests.length > this.maxVisibleLines) {
            const scrollInfo = `[${this.selectedTestIndex + 1}/${result.tests.length}]`;
            this.box.addChild(new Text(chalk.dim(scrollInfo)));
        }

        this.box.addChild(new Text(''));
        this.box.addChild(new Text(chalk.dim('↑/↓ 选择  Enter 详情  R 重跑  Esc 返回')));
    }

    private renderTestDetailContent() {
        if (!this.currentResult) return;

        const test = this.currentResult.tests[this.selectedTestIndex];
        const terminalWidth = this.openDeskTUI.tui.terminal.columns;
        const overlayWidth = Math.min(90, terminalWidth - 4);

        this.box.addChild(new Text(''));

        // 基本信息
        this.box.addChild(new Text(`${chalk.bold('名称')}: ${test.name}`));
        this.box.addChild(new Text(`${chalk.bold('文件')}: ${truncateToWidth(test.file, overlayWidth - 10, '...', false)}`));
        this.box.addChild(new Text(`${chalk.bold('状态')}: ${this.formatStatus(test.status)}`));
        this.box.addChild(new Text(`${chalk.bold('耗时')}: ${test.duration}ms`));

        if (test.message) {
            this.box.addChild(new Text(''));
            this.box.addChild(new Text(chalk.bold('消息:')));
            this.box.addChild(new Text(`  ${test.message}`));
        }

        if (test.error) {
            this.box.addChild(new Text(''));
            this.box.addChild(new Text(chalk.bold('错误输出:')));
            const errorLines = test.error.split('\n').slice(0, 10);
            for (const line of errorLines) {
                this.box.addChild(new Text(chalk.red(`  ${truncateToWidth(line, overlayWidth - 6, '...', false)}`)));
            }
            if (test.error.split('\n').length > 10) {
                this.box.addChild(new Text(chalk.dim('  ... (更多内容已截断)')));
            }
        }

        if (test.details) {
            this.box.addChild(new Text(''));
            this.box.addChild(new Text(chalk.bold('详细输出:')));
            const detailLines = test.details.split('\n').slice(0, 10);
            for (const line of detailLines) {
                this.box.addChild(new Text(chalk.dim(`  ${truncateToWidth(line, overlayWidth - 6, '...', false)}`)));
            }
        }

        this.box.addChild(new Text(''));
        this.box.addChild(new Text(chalk.dim('Esc 返回')));
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

    show(skillId?: string) {
        const terminalWidth = this.openDeskTUI.tui.terminal.columns;
        const terminalHeight = this.openDeskTUI.tui.terminal.rows;
        const overlayWidth = Math.min(90, terminalWidth - 4);
        const overlayMaxHeight = Math.max(15, terminalHeight - 4);

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
