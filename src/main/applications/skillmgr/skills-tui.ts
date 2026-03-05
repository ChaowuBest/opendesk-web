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

import { type Component, SelectList, Box, Text, Input, TUI, Key, matchesKey } from "@mariozechner/pi-tui";
import chalk from "chalk";
import { defaultSelectListTheme } from "../../tui/theme";
import { OpenDeskTUI } from "../../tui/entry";
import { SkillRegistry } from "./skillregistry.js";
import { RegistryAdapters } from "./registry-adapters.js";
import { Setting } from "../../utils/setting.js";

interface RegistrySkill {
    id: string;
    name: string;
    description: string;
    author?: string;
    source: string;
    installUrl: string;
    stars?: number;
    canInstall: boolean;
}

interface SkillDetail {
    id: string;
    name: string;
    description: string;
    body: string;
    skillDir: string;
    license?: string;
    compatibility?: string;
    metadata?: Record<string, any>;
    allowedTools?: string[];
    resources: {
        references: Array<{ name: string; content?: string }>;
        scripts: string[];
        assets: string[];
    };
}

type ViewState =
    | 'main'
    | 'select-registry'
    | 'search'
    | 'search-results'
    | 'install-local'
    | 'install-zip'
    | 'install-url'
    | 'install-github'
    | 'install-clawhub'
    | 'view-installed'
    | 'skill-detail'
    | 'skill-content'
    | 'skill-resources'
    | 'confirm-delete';

type DetailTab = 'info' | 'body' | 'resources';

export class SkillsOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private box: Box;
    private header: Text;
    private list?: SelectList;
    private input?: Input;
    private state: ViewState = 'main';
    private installedSkills: any[] = [];
    private searchResults: RegistrySkill[] = [];
    private selectedInputValue = '';
    private selectedRegistry = 'skill0';
    private message: { text: string; isError: boolean; state: ViewState } | null = null;
    private loading = false;
    private removeInputListener?: () => void;
    private messageTimeout?: NodeJS.Timeout;
    private overlayHandle?: any;
    private currentSkillDetail: SkillDetail | null = null;
    private currentDetailTab: DetailTab = 'info';
    private previousState: ViewState = 'main';
    private contentScrollOffset = 0;
    private readonly detailMaxVisibleLines = 12;

    constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;
        this.header = new Text(chalk.bold(' 技能管理'));
        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex('#2d2d2d').hex('#e0e0e0')(text));
        this.box.addChild(this.header);
    }

    private async loadInstalledSkills() {
        try {
            this.installedSkills = SkillRegistry.listSkills();
        } catch (e) {
            this.installedSkills = [];
        }
    }

    private showMessage(text: string, isError: boolean = false, targetState?: ViewState) {
        if (this.messageTimeout) {
            clearTimeout(this.messageTimeout);
        }
        const messageState = targetState ?? this.state;
        this.message = { text, isError, state: messageState };
        this.renderBox();
        this.messageTimeout = setTimeout(() => {
            if (this.message && this.message.state === messageState) {
                this.message = null;
                this.renderBox();
            }
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
        this.header = new Text(chalk.bold(' 技能管理'));

        const items = [
            { value: 'search', label: chalk.cyan('🔍 从 Registry 搜索技能') },
            { value: 'install-local', label: chalk.green('📁 从本地目录添加') },
            { value: 'install-zip', label: chalk.green('📦 从本地 zip 添加') },
            { value: 'install-url', label: chalk.blue('🌐 从 URL 添加') },
            { value: 'install-github', label: chalk.magenta('📦 从 GitHub 添加') },
            { value: 'install-clawhub', label: chalk.yellow('⚡ 从 ClawHub 添加') },
            { value: 'view-installed', label: chalk.white('📋 查看已安装技能') },
        ];

        this.list = new SelectList(items, items.length, defaultSelectListTheme);
        this.setupListHandlers();
        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.list);
    }

    private showSearch() {
        this.showSelectRegistry();
    }

    private showSelectRegistry() {
        this.cleanup();
        this.state = 'select-registry';
        this.input = undefined;

        const registries = [
            { value: 'skill0', label: 'skill0.io - 公开技能库' },
            { value: 'skillsmp', label: 'SkillsMP - 技能市场 (需 API Key)' },
            { value: 'clawhub', label: 'ClawHub - 技能仓库 (需 CLI)' },
        ];

        this.list = new SelectList(registries, registries.length, defaultSelectListTheme);
        this.setupListHandlers();
        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.list);
    }

    private showSearchInput() {
        this.cleanup();
        this.state = 'search';
        this.list = undefined;

        const registryLabel = this.getRegistryLabel(this.selectedRegistry);
        this.header = new Text(chalk.bold(` 搜索技能 [${registryLabel}]`));

        this.input = new Input();
        this.input.setValue(this.selectedInputValue);
        this.input.onSubmit = () => {
            this.performSearch().catch(err => {
                console.error('Search error:', err);
            });
        };

        this.setupInputHandlers();
        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.input);
    }

    private async performSearch() {
        const query = this.input?.getValue().trim() || '';
        if (!query) {
            this.showMessage('请输入搜索关键词', true);
            return;
        }

        this.setLoading(true);
        try {
            const config = Setting.getInstance().getData();
            const apiKey = config.applications?.skillmgr?.skillsmp_api_key || '';

            const result = await RegistryAdapters.searchRegistry(this.selectedRegistry, {
                query,
                page: 1,
                limit: 20,
                apiKey: this.selectedRegistry === 'skillsmp' ? apiKey : undefined,
            });

this.searchResults = result.skills || [];
            if (result.message) {
                this.showMessage(result.message, false);
            }
            if (this.searchResults.length === 0) {
                if (!result.message) {
                    this.showMessage('未找到匹配的技能', true);
                }
                this.showSearch();
            } else {
                this.showSearchResults();
            }
        } catch (e: any) {
            this.showMessage(e?.message || '搜索失败', true);
            this.showSearch();
        } finally {
            this.setLoading(false);
        }
    }

    private showSearchResults() {
        this.cleanup();
        this.state = 'search-results';
        this.input = undefined;

        const registryLabel = this.getRegistryLabel(this.selectedRegistry);
        this.header = new Text(chalk.bold(` 搜索结果 [${registryLabel}]`));

        const items = this.searchResults.map(skill => {
            const stars = skill.stars ? chalk.yellow(`★${skill.stars}`) : '';
            const author = skill.author ? chalk.dim(`@${skill.author}`) : '';
            const canInstall = skill.canInstall ? chalk.green('✓') : chalk.red('✗');
            return {
                value: skill.id,
                label: `${chalk.bold(skill.name)} ${author} ${stars} ${canInstall}`,
                description: skill.description,
            };
        });

        this.list = new SelectList(items, Math.min(items.length, 10), defaultSelectListTheme);
        this.setupListHandlers();
        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.list);
    }

    private getRegistryLabel(registry: string): string {
        switch (registry) {
            case 'skill0':
                return 'skill0.io';
            case 'skillsmp':
                return 'SkillsMP';
            case 'clawhub':
                return 'ClawHub';
            default:
                return registry;
        }
    }

    private showInstallLocal() {
        this.cleanup();
        this.state = 'install-local';
        this.list = undefined;

        this.input = new Input();
        this.input.setValue(this.selectedInputValue);
        this.input.onSubmit = () => {
            this.performInstallLocal().catch(err => {
                console.error('Install local error:', err);
            });
        };

        this.setupInputHandlers();
        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.input);
    }

    private async performInstallLocal() {
        const path = this.input?.getValue().trim() || '';
        if (!path) {
            this.showMessage('请输入目录路径', true);
            return;
        }

        this.setLoading(true);
        try {
            const result = SkillRegistry.addSkillFromPath(path);
            if (result.success) {
                this.showMessage(`成功添加技能: ${result.name}`, false, 'main');
                await this.loadInstalledSkills();
                this.showMain();
            } else {
                this.showMessage(result.error || '添加失败', true);
                this.showInstallLocal();
            }
        } catch (e: any) {
            this.showMessage(e?.message || '添加失败', true);
            this.showInstallLocal();
        } finally {
            this.setLoading(false);
        }
    }

    private showInstallZip() {
        this.cleanup();
        this.state = 'install-zip';
        this.list = undefined;

        this.input = new Input();
        this.input.setValue(this.selectedInputValue);
        this.input.onSubmit = () => {
            this.performInstallZip().catch(err => {
                console.error('Install zip error:', err);
            });
        };

        this.setupInputHandlers();
        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.input);
    }

    private async performInstallZip() {
        const path = this.input?.getValue().trim() || '';
        if (!path) {
            this.showMessage('请输入 zip 文件路径', true);
            return;
        }

        this.setLoading(true);
        try {
            const result = SkillRegistry.addSkillFromZipPath(path);
            if (result.success) {
                this.showMessage(`成功添加技能: ${result.name}`, false, 'main');
                await this.loadInstalledSkills();
                this.showMain();
            } else {
                this.showMessage(result.error || '添加失败', true);
                this.showInstallZip();
            }
        } catch (e: any) {
            this.showMessage(e?.message || '添加失败', true);
            this.showInstallZip();
        } finally {
            this.setLoading(false);
        }
    }

    private showInstallUrl() {
        this.cleanup();
        this.state = 'install-url';
        this.list = undefined;

        this.input = new Input();
        this.input.setValue(this.selectedInputValue);
        this.input.onSubmit = () => {
            this.performInstallUrl().catch(err => {
                console.error('Install URL error:', err);
            });
        };

        this.setupInputHandlers();
        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.input);
    }

    private async performInstallUrl() {
        const url = this.input?.getValue().trim() || '';
        if (!url) {
            this.showMessage('请输入 URL', true);
            return;
        }

        this.setLoading(true);
        try {
            const result = await SkillRegistry.addSkillFromUrl(url);
            if (result.success) {
                this.showMessage(`成功添加技能: ${result.name}`, false, 'main');
                await this.loadInstalledSkills();
                this.showMain();
            } else {
                this.showMessage(result.error || '添加失败', true);
                this.showInstallUrl();
            }
        } catch (e: any) {
            this.showMessage(e?.message || '添加失败', true);
            this.showInstallUrl();
        } finally {
            this.setLoading(false);
        }
    }

    private showInstallGitHub() {
        this.cleanup();
        this.state = 'install-github';
        this.list = undefined;

        this.input = new Input();
        this.input.setValue(this.selectedInputValue);
        this.input.onSubmit = () => {
            this.performInstallGitHub().catch(err => {
                console.error('Install GitHub error:', err);
            });
        };

        this.setupInputHandlers();
        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.input);
    }

    private async performInstallGitHub() {
        const url = this.input?.getValue().trim() || '';
        if (!url) {
            this.showMessage('请输入 GitHub URL', true);
            return;
        }

        this.setLoading(true);
        try {
            const result = await SkillRegistry.addSkillFromGitHubUrl(url);
            if (result.success) {
                this.showMessage(`成功添加技能: ${result.name}`, false, 'main');
                await this.loadInstalledSkills();
                this.showMain();
            } else {
                this.showMessage(result.error || '添加失败', true);
                this.showInstallGitHub();
            }
        } catch (e: any) {
            this.showMessage(e?.message || '添加失败', true);
            this.showInstallGitHub();
        } finally {
            this.setLoading(false);
        }
    }

    private showInstallClawHub() {
        this.cleanup();
        this.state = 'install-clawhub';
        this.list = undefined;

        this.input = new Input();
        this.input.setValue(this.selectedInputValue);
        this.input.onSubmit = () => {
            this.performInstallClawHub().catch(err => {
                console.error('Install ClawHub error:', err);
            });
        };

        this.setupInputHandlers();
        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.input);
    }

    private async performInstallClawHub() {
        const slug = this.input?.getValue().trim() || '';
        if (!slug) {
            this.showMessage('请输入技能 slug', true);
            return;
        }

        this.setLoading(true);
        try {
            const result = await SkillRegistry.addSkillFromClawHubSlug(slug);
            if (result.success) {
                this.showMessage(`成功添加技能: ${result.name}`, false, 'main');
                await this.loadInstalledSkills();
                this.showMain();
            } else {
                this.showMessage(result.error || '添加失败', true);
                this.showInstallClawHub();
            }
        } catch (e: any) {
            this.showMessage(e?.message || '添加失败', true);
            this.showInstallClawHub();
        } finally {
            this.setLoading(false);
        }
    }

    private showViewInstalled() {
        this.cleanup();
        this.state = 'view-installed';
        this.input = undefined;
        this.header = new Text(chalk.bold(' 已安装技能'));

        if (this.installedSkills.length === 0) {
            const items = [{ value: 'back', label: chalk.gray('暂无已安装技能，按 Enter 返回') }];
            this.list = new SelectList(items, 1, defaultSelectListTheme);
        } else {
            const items = this.installedSkills.map((skill: any) => ({
                value: skill.id,
                label: `${chalk.bold(skill.name)} ${chalk.dim('·')} ${skill.description || '无描述'}`,
            }));
            this.list = new SelectList(items, Math.min(items.length, 10), defaultSelectListTheme);
        }

        this.setupListHandlers();
        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.list);
    }

    private showSkillDetail(skillId: string) {
        this.setLoading(true);
        try {
            const detail = SkillRegistry.getSkillDetail(skillId);
            if (!detail) {
                this.showMessage('无法获取技能详情', true);
                this.showViewInstalled();
                return;
            }
            this.currentSkillDetail = detail;
            this.currentDetailTab = 'info';
            this.contentScrollOffset = 0;
            this.previousState = 'view-installed';
            this.renderSkillDetail();
        } finally {
            this.setLoading(false);
        }
    }

    private renderSkillDetail() {
        this.cleanup();
        this.state = 'skill-detail';
        this.list = undefined;
        this.input = undefined;

        if (!this.currentSkillDetail) {
            this.showViewInstalled();
            return;
        }

        const detail = this.currentSkillDetail;
        this.header = new Text(chalk.bold(` 技能详情: ${detail.name}`));

        this.renderBox();

        this.removeInputListener = this.openDeskTUI.tui.addInputListener((data: string) => {
            if (matchesKey(data, Key.escape)) {
                this.currentSkillDetail = null;
                this.showViewInstalled();
                return { consume: true };
            }
            if (matchesKey(data, Key.left) || data === 'h') {
                this.currentDetailTab = this.getPrevTab(this.currentDetailTab);
                this.contentScrollOffset = 0;
                this.renderBox();
                return { consume: true };
            }
            if (matchesKey(data, Key.right) || data === 'l') {
                this.currentDetailTab = this.getNextTab(this.currentDetailTab);
                this.contentScrollOffset = 0;
                this.renderBox();
                return { consume: true };
            }
            if (matchesKey(data, Key.up) || data === 'k') {
                if (this.contentScrollOffset > 0) {
                    this.contentScrollOffset--;
                    this.renderBox();
                }
                return { consume: true };
            }
            if (matchesKey(data, Key.down) || data === 'j') {
                const contentLines = this.formatSkillDetailContent(detail);
                const maxOffset = Math.max(0, contentLines.length - this.detailMaxVisibleLines);
                if (this.contentScrollOffset < maxOffset) {
                    this.contentScrollOffset++;
                    this.renderBox();
                }
                return { consume: true };
            }
            if (data === 'd' || data === 'D') {
                this.confirmDeleteSkill(detail.id);
                return { consume: true };
            }
            return undefined;
        });
    }

    private getPrevTab(tab: DetailTab): DetailTab {
        const tabs: DetailTab[] = ['info', 'body', 'resources'];
        const idx = tabs.indexOf(tab);
        return tabs[(idx - 1 + tabs.length) % tabs.length];
    }

    private getNextTab(tab: DetailTab): DetailTab {
        const tabs: DetailTab[] = ['info', 'body', 'resources'];
        const idx = tabs.indexOf(tab);
        return tabs[(idx + 1) % tabs.length];
    }

    private confirmDeleteSkill(skillId: string) {
        this.cleanup();
        this.state = 'confirm-delete';
        this.header = new Text(chalk.red.bold(` 确认删除: ${skillId}?`));

        const items = [
            { value: 'confirm-delete', label: chalk.red('确认删除') },
            { value: 'cancel', label: chalk.green('取消') },
        ];

        this.list = new SelectList(items, items.length, defaultSelectListTheme);
        this.setupListHandlers();
        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.list);
    }

    private formatSkillDetailContent(detail: SkillDetail): string[] {
        const lines: string[] = [];
        const maxWidth = 76;

        const wrapText = (text: string, indent: number = 0): string[] => {
            const indentStr = ' '.repeat(indent);
            const words = text.split(' ');
            const result: string[] = [];
            let currentLine = indentStr;

            for (const word of words) {
                if (currentLine.length + word.length + 1 > maxWidth) {
                    if (currentLine.trim() !== indentStr.trim()) {
                        result.push(currentLine);
                    }
                    currentLine = indentStr + word;
                } else {
                    currentLine += (currentLine === indentStr ? '' : ' ') + word;
                }
            }
            if (currentLine.trim() !== indentStr.trim()) {
                result.push(currentLine);
            }
            return result.length > 0 ? result : [indentStr];
        };

        if (this.currentDetailTab === 'info') {
            lines.push(chalk.cyan('基本信息'));
            lines.push('');
            lines.push(`  ${chalk.bold('名称')}: ${detail.name}`);
            lines.push(`  ${chalk.bold('ID')}: ${detail.id}`);
            lines.push(`  ${chalk.bold('描述')}:`);
            for (const line of wrapText(detail.description, 4)) {
                lines.push(line);
            }
            if (detail.license) {
                lines.push(`  ${chalk.bold('许可证')}: ${detail.license}`);
            }
            if (detail.compatibility) {
                lines.push(`  ${chalk.bold('兼容性')}: ${detail.compatibility}`);
            }
            lines.push('');
            lines.push(`  ${chalk.bold('目录')}: ${chalk.dim(detail.skillDir)}`);
            lines.push('');

            const res = detail.resources;
            lines.push(chalk.cyan('资源统计'));
            lines.push('');
            lines.push(`  ${chalk.bold('参考文档')}: ${res.references.length > 0 ? chalk.green(res.references.length + ' 个') : chalk.dim('无')}`);
            lines.push(`  ${chalk.bold('脚本文件')}: ${res.scripts.length > 0 ? chalk.green(res.scripts.length + ' 个') : chalk.dim('无')}`);
            lines.push(`  ${chalk.bold('资源文件')}: ${res.assets.length > 0 ? chalk.green(res.assets.length + ' 个') : chalk.dim('无')}`);

            if (detail.allowedTools && detail.allowedTools.length > 0) {
                lines.push('');
                lines.push(chalk.cyan('预授权工具'));
                lines.push('');
                for (const tool of detail.allowedTools) {
                    lines.push(`  • ${tool}`);
                }
            }

            if (detail.metadata && Object.keys(detail.metadata).length > 0) {
                lines.push('');
                lines.push(chalk.cyan('元数据'));
                lines.push('');
                for (const [key, value] of Object.entries(detail.metadata)) {
                    const valStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
                    lines.push(`  ${key}: ${chalk.dim(valStr)}`);
                }
            }
        } else if (this.currentDetailTab === 'body') {
            lines.push(chalk.cyan('SKILL.md 内容'));
            lines.push('');
            const bodyLines = detail.body.split('\n');
            for (const line of bodyLines) {
                if (line.startsWith('# ')) {
                    lines.push(chalk.bold.cyan(line));
                } else if (line.startsWith('## ')) {
                    lines.push(chalk.bold(line));
                } else if (line.startsWith('### ')) {
                    lines.push(chalk.yellow(line));
                } else if (line.startsWith('- ') || line.startsWith('* ')) {
                    lines.push(`  ${chalk.cyan('•')} ${line.slice(2)}`);
                } else if (line.startsWith('```')) {
                    lines.push(chalk.dim(line));
                } else if (line.trim().startsWith('`') && line.trim().endsWith('`')) {
                    lines.push(`  ${chalk.yellow(line.trim())}`);
                } else {
                    lines.push(`  ${line}`);
                }
            }
        } else if (this.currentDetailTab === 'resources') {
            const res = detail.resources;

            if (res.references.length > 0) {
                lines.push(chalk.cyan('参考文档'));
                lines.push('');
                for (const ref of res.references) {
                    lines.push(`  ${chalk.green('📄')} ${ref.name}`);
                    if (ref.content) {
                        const preview = ref.content.split('\n').slice(0, 3).join('\n    ');
                        lines.push(`    ${chalk.dim(preview.substring(0, 100))}${preview.length > 100 ? '...' : ''}`);
                    }
                    lines.push('');
                }
            }

            if (res.scripts.length > 0) {
                lines.push(chalk.cyan('脚本文件'));
                lines.push('');
                for (const script of res.scripts) {
                    const ext = script.split('.').pop() || '';
                    const icon = ext === 'js' || ext === 'mjs' ? '🟨' : ext === 'py' ? '🐍' : '📜';
                    lines.push(`  ${icon} ${script}`);
                }
                lines.push('');
            }

            if (res.assets.length > 0) {
                lines.push(chalk.cyan('资源文件'));
                lines.push('');
                for (const asset of res.assets) {
                    lines.push(`  📦 ${asset}`);
                }
            }

            if (res.references.length === 0 && res.scripts.length === 0 && res.assets.length === 0) {
                lines.push(chalk.dim('  该技能没有额外的资源文件'));
            }
        }

        return lines;
    }

    private async deleteSkill(skillId: string) {
        this.setLoading(true);
        try {
            const result = SkillRegistry.deleteSkill(skillId);
            if (result.success) {
                this.showMessage(`成功删除技能: ${skillId}`, false, 'view-installed');
                await this.loadInstalledSkills();
                this.showViewInstalled();
            } else {
                this.showMessage(result.error || '删除失败', true);
                this.showViewInstalled();
            }
        } catch (e: any) {
            this.showMessage(e?.message || '删除失败', true);
            this.showViewInstalled();
        } finally {
            this.setLoading(false);
        }
    }

    private setupListHandlers() {
        if (!this.list) return;

        this.list.onSelect = (item: any) => {
            switch (this.state) {
                case 'main':
                    this.handleMainSelection(item.value);
                    break;
                case 'select-registry':
                    this.handleRegistrySelection(item.value);
                    break;
                case 'search-results':
                    this.handleSearchResultSelection(item.value);
                    break;
                case 'view-installed':
                    this.handleInstalledSelection(item.value);
                    break;
                case 'skill-detail':
                    this.handleDetailSelection(item.value);
                    break;
                case 'confirm-delete':
                    this.handleDetailSelection(item.value);
                    break;
            }
        };

        this.list.onCancel = () => {
            if (this.state === 'main') {
                this.close();
            } else {
                this.goBack();
            }
        };
    }

    private handleDetailSelection(value: string) {
        if (value === 'confirm-delete' && this.currentSkillDetail) {
            this.deleteSkill(this.currentSkillDetail.id);
        } else if (value === 'cancel') {
            this.renderSkillDetail();
        }
    }

    private handleMainSelection(value: string) {
        switch (value) {
            case 'search':
                this.showSearch();
                break;
            case 'install-local':
                this.showInstallLocal();
                break;
            case 'install-zip':
                this.showInstallZip();
                break;
            case 'install-url':
                this.showInstallUrl();
                break;
            case 'install-github':
                this.showInstallGitHub();
                break;
            case 'install-clawhub':
                this.showInstallClawHub();
                break;
            case 'view-installed':
                this.showViewInstalled();
                break;
        }
    }

    private handleRegistrySelection(value: string) {
        this.selectedRegistry = value;
        this.showSearchInput();
    }

    private async handleSearchResultSelection(skillId: string) {
        const skill = this.searchResults.find(s => s.id === skillId);
        if (!skill) return;

        if (!skill.canInstall) {
            this.showMessage('该技能不支持直接安装', true);
            return;
        }

        this.setLoading(true);
        try {
            let result;
            if (skill.installUrl.startsWith('clawhub:')) {
                const parsed = RegistryAdapters.parseClawHubInstallUrl(skill.installUrl);
                if (parsed) {
                    result = await SkillRegistry.addSkillFromClawHubSlug(parsed.slug, parsed.version);
                }
            } else if (skill.installUrl.includes('github.com') && skill.installUrl.includes('/tree/')) {
                result = await SkillRegistry.addSkillFromGitHubUrl(skill.installUrl);
            } else {
                result = await SkillRegistry.addSkillFromUrl(skill.installUrl);
            }

            if (result?.success) {
                this.showMessage(`成功安装技能: ${result.name}`, false, 'main');
                await this.loadInstalledSkills();
                this.showMain();
            } else {
                this.showMessage(result?.error || '安装失败', true);
            }
        } catch (e: any) {
            this.showMessage(e?.message || '安装失败', true);
        } finally {
            this.setLoading(false);
        }
    }

    private handleInstalledSelection(skillId: string) {
        if (skillId === 'back') {
            this.showMain();
            return;
        }

        const skill = this.installedSkills.find((s: any) => s.id === skillId);
        if (!skill) return;

        this.showSkillDetail(skillId);
    }

    private setupInputHandlers() {
        if (!this.input) return;

        this.removeInputListener = this.openDeskTUI.tui.addInputListener((data: string) => {
            if (matchesKey(data, Key.escape)) {
                if (this.state === 'main') {
                    this.close();
                } else {
                    this.goBack();
                }
                return { consume: true };
            }
            return undefined;
        });
    }

    private goBack() {
        switch (this.state) {
            case 'search':
                this.showSelectRegistry();
                break;
            case 'select-registry':
            case 'install-local':
            case 'install-zip':
            case 'install-url':
            case 'install-github':
            case 'install-clawhub':
            case 'view-installed':
                this.showMain();
                break;
            case 'search-results':
                this.showSearch();
                break;
            case 'skill-detail':
                this.currentSkillDetail = null;
                this.showViewInstalled();
                break;
            case 'confirm-delete':
                this.renderSkillDetail();
                break;
            case 'main':
                this.close();
                break;
            default:
                this.close();
        }
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

        if (this.state === 'skill-detail' && this.currentSkillDetail) {
            this.box.addChild(new Text(chalk.dim('  ←/→ 切换标签  ↑/↓ 滚动  D 删除  Esc 返回')));
            this.renderDetailContent();
            this.openDeskTUI.tui.requestRender();
            return;
        }

        if (this.message && this.message.state === this.state) {
            const msgText = this.message.isError
                ? chalk.red(`❌ ${this.message.text}`)
                : chalk.green(`✓ ${this.message.text}`);
            this.box.addChild(new Text(msgText));
        }

        if (this.loading) {
            this.box.addChild(new Text(chalk.yellow('⏳ 加载中...')));
        }

        if (this.list) {
            this.box.addChild(this.list);
        }

        if (this.input) {
            const inputLabel = this.getInputLabel();
            if (inputLabel) {
                this.box.addChild(new Text(chalk.cyan(inputLabel)));
            }
            this.box.addChild(this.input);
        }

        const helpText = this.getHelpText();
        if (helpText) {
            this.box.addChild(new Text(''));
            this.box.addChild(new Text(chalk.dim(helpText)));
        }

        this.openDeskTUI.tui.requestRender();
    }

    private renderDetailContent() {
        if (!this.currentSkillDetail) return;

        const detail = this.currentSkillDetail;

        const tabs = ['info', 'body', 'resources'] as DetailTab[];
        const tabLabels = { info: '基本信息', body: 'SKILL.md', resources: '资源文件' };
        const tabLine = tabs.map(t => {
            const label = tabLabels[t];
            return t === this.currentDetailTab
                ? chalk.black.bgCyan(` ${label} `)
                : chalk.dim(` ${label} `);
        }).join(chalk.dim('│'));

        this.box.addChild(new Text(''));
        this.box.addChild(new Text(`  ${tabLine}`));
        this.box.addChild(new Text(chalk.dim('  ──────────────────────────────────────────────────')));

        const contentLines = this.formatSkillDetailContent(detail);
        const maxOffset = Math.max(0, contentLines.length - this.detailMaxVisibleLines);
        if (this.contentScrollOffset > maxOffset) {
            this.contentScrollOffset = maxOffset;
        }
        const visibleLines = contentLines.slice(this.contentScrollOffset, this.contentScrollOffset + this.detailMaxVisibleLines);

        for (const line of visibleLines) {
            this.box.addChild(new Text(line));
        }

        if (contentLines.length > this.detailMaxVisibleLines) {
            const scrollInfo = `  [行 ${this.contentScrollOffset + 1}-${Math.min(this.contentScrollOffset + this.detailMaxVisibleLines, contentLines.length)} / ${contentLines.length}]`;
            this.box.addChild(new Text(chalk.dim(scrollInfo)));
        }
    }

    private getInputLabel(): string {
        switch (this.state) {
            case 'search':
                return `搜索 [${this.selectedRegistry}]:`;
            case 'install-local':
                return '输入本地目录路径:';
            case 'install-zip':
                return '输入本地 zip 文件路径:';
            case 'install-url':
                return '输入技能包 URL:';
            case 'install-github':
                return '输入 GitHub URL (tree 格式):';
            case 'install-clawhub':
                return '输入 ClawHub slug (如 my-skill 或 my-skill@1.2.3):';
            default:
                return '';
        }
    }

    private getHelpText(): string {
        switch (this.state) {
            case 'main':
                return '↑↓ 选择  Enter 确认  Esc 退出';
            case 'select-registry':
                return '↑↓ 选择 Registry  Enter 确认  Esc 返回';
            case 'search':
                return '输入搜索关键词  Enter 搜索  Esc 返回';
            case 'search-results':
                return '↑↓ 选择  Enter 安装  Esc 返回';
            case 'install-local':
                return '输入本地目录路径  Enter 添加  Esc 返回';
            case 'install-zip':
                return '输入本地 zip 文件路径  Enter 添加  Esc 返回';
            case 'install-url':
                return '输入技能包 URL  Enter 添加  Esc 返回';
            case 'install-github':
                return '输入 GitHub URL (如 https://github.com/user/repo/tree/branch)  Enter 添加  Esc 返回';
            case 'install-clawhub':
                return '输入 ClawHub slug (如 my-skill 或 my-skill@1.2.3)  Enter 添加  Esc 返回';
            case 'view-installed':
                return '↑↓ 选择  Enter 查看详情  Esc 返回';
            case 'skill-detail':
                return '←/→ 切换标签  ↑/↓ 滚动  D 删除  Esc 返回';
            case 'confirm-delete':
                return '↑↓ 选择  Enter 确认  Esc 返回';
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

    show() {
        const terminalWidth = this.openDeskTUI.tui.terminal.columns;
        const terminalHeight = this.openDeskTUI.tui.terminal.rows;
        const overlayWidth = Math.min(80, terminalWidth - 4);
        const overlayMaxHeight = Math.max(10, terminalHeight - 4);

        this.overlayHandle = this.openDeskTUI.tui.showOverlay(this, {
            width: overlayWidth,
            maxHeight: overlayMaxHeight,
            anchor: "center",
        });

        this.openDeskTUI.hasOpenOverlay = true;
        this.loadInstalledSkills().then(() => {
            this.showMain();
        });

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
