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

import {
    type Component,
    SelectList,
    Box,
    Text,
    Input,
    Key,
    matchesKey,
    Markdown,
    visibleWidth,
    wrapTextWithAnsi,
    truncateToWidth
} from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { defaultSelectListTheme, defaultMarkdownTheme } from '../../tui/theme';
import { SelectTable, type SelectRow } from '../../tui/components/selecttable';
import { OpenDeskTUI } from '../../tui/entry';
import { Setting } from '../../utils/setting.js';
import { SkillMgrApplication } from './app.js';
import { getSkillStatus, setSkillStatus } from './status.js';
import {
    SkillRegistry,
    installSkillFromDirectory,
    installSkillFromLocalZip,
    installSkillFromUrl,
    installFromRegistryInstallUrl,
    searchRegistry
} from './utils.js';

interface RegistrySkill {
    id: string;
    name: string;
    description: string;
    author?: string;
    source: string;
    installUrl: string;
    stars?: number;
    downloads?: number;
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
    | 'view-installed'
    | 'skill-detail'
    | 'skill-content'
    | 'skill-resources'
    | 'confirm-delete'
    | 'confirm-duplicate'
    | 'install-custom-name';

type DetailTab = 'info' | 'body' | 'resources';

export class SkillsOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private box: Box;
    private header: Text;
    private list?: SelectList | SelectTable;
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
    private visible = false;
    private currentSkillDetail: SkillDetail | null = null;
    private currentDetailTab: DetailTab = 'info';
    private previousState: ViewState = 'main';
    private contentScrollOffset = 0;
    private readonly detailMaxVisibleLines = 12;
    private pendingInstallSkill: RegistrySkill | null = null;
    private duplicateDefaultName = '';

    constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;
        this.header = new Text(chalk.bold(' 技能中心'));
        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex('#2d2d2d').hex('#e0e0e0')(text));
        this.box.addChild(this.header);
    }

    private async loadInstalledSkills() {
        try {
            this.installedSkills = SkillRegistry.listSkills().map((skill: any) => ({
                ...skill,
                enabled: getSkillStatus(skill.id)
            }));
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
        this.header = new Text(chalk.bold(' 技能中心'));

        const items = [
            { value: 'search', label: chalk.cyan('🔍 从 Registry 搜索技能') },
            { value: 'install-local', label: chalk.green('📁 从本地目录添加') },
            { value: 'install-zip', label: chalk.green('📦 从本地 zip 添加') },
            { value: 'install-url', label: chalk.blue('🌐 从 zip URL 添加') },
            { value: 'view-installed', label: chalk.white('📋 查看已安装技能') }
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
            { value: 'matrix', label: 'Matrix Skill - OpenHarmony 社区' },
            { value: 'clawhub', label: 'ClawHub - 技能仓库' },
            { value: 'modelscope', label: 'ModelScope - 魔搭技能' },
            { value: 'skillhub', label: 'SkillHub - 腾讯技能中心' },
            { value: 'skill0', label: 'skill0.io - 公开技能库' },
            { value: 'skillsmp', label: 'SkillsMP - 技能市场 (需 API Key)' }
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
            this.performSearch().catch((err) => {
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
            const config = Setting.getInstance().getData() as any;
            const apiKey = config.applications?.skillmgr?.skillsmp_api_key || '';

            const result = await searchRegistry(this.selectedRegistry, {
                query,
                page: 1,
                limit: 20,
                apiKey: this.selectedRegistry === 'skillsmp' ? apiKey : undefined
            });

            this.searchResults = result.skills || [];
            if (this.searchResults.length === 0) {
                if ((result as any).message) {
                    this.showMessage((result as any).message, false);
                } else {
                    this.showMessage('未找到匹配的技能', true);
                    this.showSearch();
                }
            } else {
                if ((result as any).message) {
                    this.showMessage((result as any).message, false);
                }
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

        const rows: SelectRow[] = this.searchResults.map((skill) => {
            const name = this.normalizeInlineText(skill.name || '未命名技能');
            const scoreNum = Number((skill as any).score);
            const score = Number.isFinite(scoreNum) ? '(' + scoreNum.toFixed(3) + ')' : '';
            const stars = skill.stars ? '★' + skill.stars : '';
            const installIcon = skill.canInstall ? '✓' : '✗';
            const statusParts = [score, stars, installIcon].filter((p) => p.length > 0);
            const status = statusParts.join(' ');
            const desc = this.normalizeInlineText(skill.description || '无描述');
            return {
                value: skill.id,
                labels: [name, status, desc]
            };
        });

        const table = new SelectTable(rows, Math.min(rows.length, 10), defaultSelectListTheme);
        table.setColumnStrechFactors([0, 0, 1]);
        table.setAlignments(['left', 'right', 'left']);
        this.list = table;
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
            case 'matrix':
                return 'Matrix Skill';
            case 'modelscope':
                return 'ModelScope';
            case 'skillhub':
                return 'SkillHub';
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
            this.performInstallLocal().catch((err) => {
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
            const result = installSkillFromDirectory(path);
            if (result.success) {
                SkillMgrApplication.notifySkillsChanged();
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
            this.performInstallZip().catch((err) => {
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
            const result = installSkillFromLocalZip(path);
            if (result.success) {
                SkillMgrApplication.notifySkillsChanged();
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
            this.performInstallUrl().catch((err) => {
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
            const result = await installSkillFromUrl(url);
            if (result.success) {
                SkillMgrApplication.notifySkillsChanged();
                this.showMessage(`成功添加技能: ${result.name ?? ''}`, false, 'main');
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

    private showViewInstalled() {
        this.cleanup();
        this.state = 'view-installed';
        this.input = undefined;
        this.header = new Text(chalk.bold(' 已安装技能'));

        if (this.installedSkills.length === 0) {
            const items = [{ value: 'back', label: chalk.gray('暂无已安装技能，按 Enter 返回') }];
            this.list = new SelectList(items, 1, defaultSelectListTheme);
        } else {
            const rows: SelectRow[] = this.installedSkills.map((skill: any) => {
                const enabled = skill.enabled !== false;
                const status = enabled ? chalk.green('● 已启用') : chalk.gray('○ 已禁用');
                const name = this.normalizeInlineText(skill.name || '未命名技能');
                const desc = this.normalizeInlineText(skill.description || '无描述');
                return {
                    value: skill.id,
                    labels: [status, name, desc]
                };
            });
            const table = new SelectTable(rows, Math.min(rows.length, 10), defaultSelectListTheme);
            table.setColumnStrechFactors([0, 0, 1]);
            table.setAlignments(['left', 'left', 'left']);
            this.list = table;
        }

        this.setupListHandlers();
        this.setupInstalledListShortcuts();
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

    private setupInstalledListShortcuts() {
        this.removeInputListener = this.openDeskTUI.tui.addInputListener((data: string) => {
            if (this.state !== 'view-installed') return undefined;
            if (matchesKey(data, Key.space)) {
                const skillId = this.getSelectedListValue();
                if (skillId && skillId !== 'back') {
                    this.toggleSkillStatus(skillId).catch((err) => {
                        this.showMessage(err?.message || '切换失败', true);
                    });
                }
                return { consume: true };
            }
            if (data === 'd' || data === 'D') {
                const skillId = this.getSelectedListValue();
                if (skillId && skillId !== 'back') {
                    const detail = SkillRegistry.getSkillDetail(skillId);
                    if (detail) {
                        this.currentSkillDetail = detail;
                        this.currentDetailTab = 'info';
                        this.contentScrollOffset = 0;
                        this.previousState = 'view-installed';
                        this.confirmDeleteSkill(skillId);
                    }
                }
                return { consume: true };
            }
            return undefined;
        });
    }

    private async toggleSkillStatus(skillId: string) {
        const enabled = !getSkillStatus(skillId);
        setSkillStatus(skillId, enabled);
        SkillMgrApplication.notifySkillsChanged();
        await this.loadInstalledSkills();

        if (this.currentSkillDetail?.id === skillId) {
            const detail = SkillRegistry.getSkillDetail(skillId);
            if (detail) {
                this.currentSkillDetail = detail;
            }
            this.renderSkillDetail();
            return;
        }

        this.showMessage(enabled ? '技能已启用' : '技能已禁用', false, 'view-installed');
        this.showViewInstalled();
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
                const terminalWidth = this.openDeskTUI.tui.terminal.columns;
                const overlayWidth = Math.min(80, terminalWidth - 4);
                const contentWidth = overlayWidth - 4;
                const contentLines = this.formatSkillDetailContent(detail, contentWidth);
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
            if (matchesKey(data, Key.space) || data === 'e' || data === 'E') {
                this.toggleSkillStatus(detail.id).catch((err) => {
                    this.showMessage(err?.message || '切换失败', true);
                });
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
            { value: 'cancel', label: chalk.green('取消') }
        ];

        this.list = new SelectList(items, items.length, defaultSelectListTheme);
        this.setupListHandlers();
        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.list);
    }

    private showConfirmDuplicate() {
        this.cleanup();
        this.state = 'confirm-duplicate';
        const name = this.pendingInstallSkill?.name || '未知技能';
        this.header = new Text(chalk.yellow.bold(` 技能「${name}」已安装，如何处理?`));

        const items = [
            { value: 'overwrite', label: chalk.yellow('覆盖安装') },
            { value: 'install-as-new', label: chalk.cyan('以新名称安装') },
            { value: 'cancel', label: chalk.green('取消') }
        ];

        this.list = new SelectList(items, items.length, defaultSelectListTheme);
        this.setupListHandlers();
        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.list);
    }

    private showInstallCustomName() {
        this.cleanup();
        this.state = 'install-custom-name';
        this.list = undefined;
        this.header = new Text(chalk.bold(' 以新名称安装'));

        this.input = new Input();
        this.input.setValue(this.duplicateDefaultName);
        this.input.onSubmit = () => {
            this.performInstallWithCustomName().catch((err) => {
                console.error('Install with custom name error:', err);
            });
        };

        this.setupInputHandlers();
        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.input);
    }

    private async performInstallWithCustomName() {
        const name = this.input?.getValue().trim() || '';
        if (!name) {
            this.showMessage('请输入技能名称', true);
            return;
        }

        if (!this.pendingInstallSkill) return;

        this.setLoading(true);
        try {
            const result = await installFromRegistryInstallUrl(this.pendingInstallSkill.installUrl, false, name);

            if (result && result.success) {
                SkillMgrApplication.notifySkillsChanged();
                this.showMessage(`成功安装技能: ${result.name ?? ''}`, false, 'main');
                await this.loadInstalledSkills();
                this.pendingInstallSkill = null;
                this.duplicateDefaultName = '';
                this.showMain();
            } else {
                this.showMessage(result?.error || '安装失败', true);
                this.showInstallCustomName();
            }
        } catch (e: any) {
            this.showMessage(e?.message || '安装失败', true);
            this.showInstallCustomName();
        } finally {
            this.setLoading(false);
        }
    }

    private formatSkillDetailContent(detail: SkillDetail, contentWidth: number): string[] {
        const lines: string[] = [];
        const indent = '  ';

        const wrapLine = (text: string, maxLen: number): string[] => {
            return wrapTextWithAnsi(text, maxLen);
        };

        if (this.currentDetailTab === 'info') {
            lines.push(chalk.cyan('基本信息'));
            lines.push(`${indent}${chalk.bold('名称')}: ${detail.name}`);
            lines.push(`${indent}${chalk.bold('ID')}: ${detail.id}`);
            lines.push(
                `${indent}${chalk.bold('状态')}: ${
                    getSkillStatus(detail.id) ? chalk.green('已启用') : chalk.gray('已禁用')
                }`
            );
            lines.push(`${indent}${chalk.bold('描述')}:`);
            const descLines = wrapLine(detail.description, contentWidth - 4);
            for (const dl of descLines) {
                lines.push(`${indent}${indent}${dl}`);
            }
            if (detail.license) {
                lines.push(`${indent}${chalk.bold('许可证')}: ${detail.license}`);
            }
            if (detail.compatibility) {
                lines.push(`${indent}${chalk.bold('兼容性')}: ${detail.compatibility}`);
            }
            const dirText = truncateToWidth(detail.skillDir, contentWidth - 8, '...', false);
            lines.push(`${indent}${chalk.bold('目录')}: ${chalk.dim(dirText)}`);

            const res = detail.resources;
            lines.push('');
            lines.push(chalk.cyan('资源统计'));
            lines.push(
                `${indent}${chalk.bold('参考文档')}: ${res.references.length > 0 ? chalk.green(res.references.length + ' 个') : chalk.dim('无')}`
            );
            lines.push(
                `${indent}${chalk.bold('脚本文件')}: ${res.scripts.length > 0 ? chalk.green(res.scripts.length + ' 个') : chalk.dim('无')}`
            );
            lines.push(
                `${indent}${chalk.bold('资源文件')}: ${res.assets.length > 0 ? chalk.green(res.assets.length + ' 个') : chalk.dim('无')}`
            );

            if (detail.allowedTools && detail.allowedTools.length > 0) {
                lines.push('');
                lines.push(chalk.cyan('预授权工具'));
                for (const tool of detail.allowedTools) {
                    lines.push(`${indent}• ${tool}`);
                }
            }

            if (detail.metadata && Object.keys(detail.metadata).length > 0) {
                lines.push('');
                lines.push(chalk.cyan('元数据'));
                for (const [key, value] of Object.entries(detail.metadata)) {
                    const valStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
                    const truncatedVal = truncateToWidth(valStr, contentWidth - 10, '...', false);
                    lines.push(`${indent}${key}: ${chalk.dim(truncatedVal)}`);
                }
            }
        } else if (this.currentDetailTab === 'body') {
            lines.push(chalk.cyan('SKILL.md 内容'));
            const markdown = new Markdown(detail.body, 0, 0, defaultMarkdownTheme);
            const mdLines = markdown.render(contentWidth - 2);
            for (const mdLine of mdLines) {
                lines.push(`${indent}${mdLine}`);
            }
        } else if (this.currentDetailTab === 'resources') {
            const res = detail.resources;

            if (res.references.length > 0) {
                lines.push(chalk.cyan('参考文档'));
                for (const ref of res.references) {
                    lines.push(`${indent}${chalk.green('📄')} ${ref.name}`);
                    if (ref.content) {
                        const previewLines = ref.content.split('\n').slice(0, 3);
                        for (const pl of previewLines) {
                            const truncated = truncateToWidth(pl, contentWidth - 8, '...', false);
                            lines.push(`${indent}${indent}${chalk.dim(truncated)}`);
                        }
                    }
                    lines.push('');
                }
            }

            if (res.scripts.length > 0) {
                lines.push(chalk.cyan('脚本文件'));
                for (const script of res.scripts) {
                    const ext = script.split('.').pop() || '';
                    const icon = ext === 'js' || ext === 'mjs' ? '🟨' : ext === 'py' ? '🐍' : '📜';
                    lines.push(`${indent}${icon} ${script}`);
                }
                lines.push('');
            }

            if (res.assets.length > 0) {
                lines.push(chalk.cyan('资源文件'));
                for (const asset of res.assets) {
                    lines.push(`${indent}📦 ${asset}`);
                }
            }

            if (res.references.length === 0 && res.scripts.length === 0 && res.assets.length === 0) {
                lines.push(chalk.dim(`${indent}该技能没有额外的资源文件`));
            }
        }

        return this.compactEmptyLines(lines, 1);
    }

    private async deleteSkill(skillId: string) {
        this.setLoading(true);
        try {
            const result = SkillRegistry.deleteSkill(skillId);
            if (result.success) {
                SkillMgrApplication.notifySkillsChanged();
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

        this.list.onSelect = (itemOrValue: any) => {
            const value = this.resolveSelectionValue(itemOrValue);
            if (!value) return;
            switch (this.state) {
                case 'main':
                    this.handleMainSelection(value);
                    break;
                case 'select-registry':
                    this.handleRegistrySelection(value);
                    break;
                case 'search-results':
                    this.handleSearchResultSelection(value);
                    break;
                case 'view-installed':
                    this.handleInstalledSelection(value);
                    break;
                case 'skill-detail':
                    this.handleDetailSelection(value);
                    break;
                case 'confirm-delete':
                    this.handleDetailSelection(value);
                    break;
                case 'confirm-duplicate':
                    this.handleDuplicateSelection(value);
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

    private handleDuplicateSelection(value: string) {
        switch (value) {
            case 'overwrite':
                this.performOverwriteInstall();
                break;
            case 'install-as-new':
                this.showInstallCustomName();
                break;
            case 'cancel':
                this.pendingInstallSkill = null;
                this.duplicateDefaultName = '';
                this.showSearchResults();
                break;
        }
    }

    private async performOverwriteInstall() {
        if (!this.pendingInstallSkill) return;

        this.setLoading(true);
        try {
            const result = await installFromRegistryInstallUrl(this.pendingInstallSkill.installUrl, true);

            if (result && result.success) {
                SkillMgrApplication.notifySkillsChanged();
                this.showMessage(`成功覆盖安装技能: ${result.name ?? ''}`, false, 'main');
                await this.loadInstalledSkills();
                this.pendingInstallSkill = null;
                this.duplicateDefaultName = '';
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
        const skill = this.searchResults.find((s) => s.id === skillId);
        if (!skill) return;

        if (!skill.canInstall) {
            this.showMessage('该技能不支持直接安装', true);
            return;
        }

        // 检测到已安装的同名技能，提示用户选择处理方式
        const skillNameToCheck = skill.name;
        if (skillNameToCheck && SkillRegistry.skillExists(skillNameToCheck)) {
            this.pendingInstallSkill = skill;
            this.duplicateDefaultName = `${skillNameToCheck}-1`;
            this.showConfirmDuplicate();
            return;
        }

        this.setLoading(true);
        try {
            const result = await installFromRegistryInstallUrl(skill.installUrl);

            if (result && result.success) {
                SkillMgrApplication.notifySkillsChanged();
                this.showMessage(`成功安装技能: ${result.name ?? ''}`, false, 'main');
                await this.loadInstalledSkills();
                this.showMain();
            } else {
                const conflictSkillName = result?.error?.match(/^技能「(.+?)」已存在(?:，.*)?$/)?.[1];
                if (conflictSkillName) {
                    this.pendingInstallSkill = { ...skill, name: conflictSkillName };
                    this.duplicateDefaultName = `${conflictSkillName}-1`;
                    this.showConfirmDuplicate();
                } else {
                    this.showMessage(result?.error || '安装失败', true);
                }
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
            case 'confirm-duplicate':
                this.pendingInstallSkill = null;
                this.duplicateDefaultName = '';
                this.showSearchResults();
                break;
            case 'install-custom-name':
                this.showConfirmDuplicate();
                break;
            case 'main':
                this.close();
                break;
            default:
                this.close();
        }
    }

    private close() {
        this.visible = false;
        const restored = this.openDeskTUI.closeInputPrompt(this);
        this.cleanup();
        if (this.messageTimeout) {
            clearTimeout(this.messageTimeout);
            this.messageTimeout = undefined;
        }
        this.message = null;
        this.openDeskTUI.focusAfterInputPromptClose(restored);
    }

    private renderBox() {
        this.box.clear();
        this.box.addChild(this.header);

        if (this.state === 'skill-detail' && this.currentSkillDetail) {
            this.box.addChild(new Text(chalk.dim('  ←/→ 切换标签  ↑/↓ 滚动  Space/E 启用或禁用  D 删除  Esc 返回')));
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
        const terminalWidth = this.openDeskTUI.tui.terminal.columns;
        const overlayWidth = Math.max(40, terminalWidth - 2);
        const contentWidth = overlayWidth - 4;

        const tabs = ['info', 'body', 'resources'] as DetailTab[];
        const tabLabels = { info: '基本信息', body: 'SKILL.md', resources: '资源文件' };
        const tabLine = tabs
            .map((t) => {
                const label = tabLabels[t];
                return t === this.currentDetailTab ? chalk.black.bgCyan(` ${label} `) : chalk.dim(` ${label} `);
            })
            .join(chalk.dim('│'));

        this.box.addChild(new Text(`  ${tabLine}`));
        const dividerLen = Math.max(8, overlayWidth - 8);
        this.box.addChild(new Text(chalk.dim(`  ${'─'.repeat(dividerLen)}`)));

        const contentLines = this.formatSkillDetailContent(detail, contentWidth);
        const maxOffset = Math.max(0, contentLines.length - this.detailMaxVisibleLines);
        if (this.contentScrollOffset > maxOffset) {
            this.contentScrollOffset = maxOffset;
        }
        const visibleLines = contentLines.slice(
            this.contentScrollOffset,
            this.contentScrollOffset + this.detailMaxVisibleLines
        );

        const bgFn = (text: string) => chalk.bgHex('#2d2d2d').hex('#e0e0e0')(text);

        for (let i = 0; i < visibleLines.length; i++) {
            const line = visibleLines[i];
            const paddedLine = this.padLineToWidth(line, overlayWidth - 2);
            this.box.addChild(new Text(bgFn(`  ${paddedLine}`)));
        }

        if (contentLines.length > this.detailMaxVisibleLines) {
            const scrollInfo = `  [行 ${this.contentScrollOffset + 1}-${Math.min(this.contentScrollOffset + this.detailMaxVisibleLines, contentLines.length)} / ${contentLines.length}]`;
            this.box.addChild(new Text(chalk.dim(scrollInfo)));
        }
    }

    private padLineToWidth(line: string, width: number): string {
        const visWidth = visibleWidth(line);
        if (visWidth >= width) {
            return truncateToWidth(line, width, '', false);
        }
        return line + ' '.repeat(width - visWidth);
    }

    private normalizeInlineText(value: unknown): string {
        return String(value ?? '')
            .replace(/\r?\n/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private resolveSelectionValue(itemOrValue: any): string | undefined {
        if (typeof itemOrValue === 'string') {
            return itemOrValue;
        }
        if (itemOrValue && typeof itemOrValue.value === 'string') {
            return itemOrValue.value;
        }
        return undefined;
    }

    private getSelectedListValue(): string | undefined {
        const anyList = this.list as any;
        const selected = anyList?.innerList?.getSelectedItem?.() ?? anyList?.getSelectedItem?.();
        return this.resolveSelectionValue(selected);
    }

    private compactEmptyLines(lines: string[], maxConsecutiveEmpty = 1): string[] {
        const compacted: string[] = [];
        let emptyCount = 0;
        for (const line of lines) {
            const isEmpty = line.trim().length === 0;
            if (isEmpty) {
                if (emptyCount < maxConsecutiveEmpty) {
                    compacted.push(line);
                }
                emptyCount++;
            } else {
                compacted.push(line);
                emptyCount = 0;
            }
        }
        while (compacted.length > 0 && compacted[0].trim().length === 0) {
            compacted.shift();
        }
        while (compacted.length > 0 && compacted[compacted.length - 1].trim().length === 0) {
            compacted.pop();
        }
        return compacted;
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
                return '输入 zip URL:';
            case 'install-custom-name':
                return '输入新的技能名称:';
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
                return '输入 zip URL  Enter 添加  Esc 返回';
            case 'view-installed':
                return '↑↓ 选择  Enter 查看详情  Space 启用或禁用  D 删除  Esc 返回';
            case 'skill-detail':
                return '←/→ 切换标签  ↑/↓ 滚动  Space/E 启用或禁用  D 删除  Esc 返回';
            case 'confirm-delete':
                return '↑↓ 选择  Enter 确认  Esc 返回';
            case 'confirm-duplicate':
                return '↑↓ 选择  Enter 确认  Esc 返回';
            case 'install-custom-name':
                return '输入新名称  Enter 安装  Esc 返回';
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
        if (this.openDeskTUI.deferInputPromptIfBlockedByMode(() => this.show())) {
            return;
        }
        this.visible = true;
        this.openDeskTUI.inputArea.showPromptWidget(this);
        this.openDeskTUI.hasOpenOverlay = true;
        this.loadInstalledSkills().then(() => {
            if (!this.visible) return;
            this.showMain();
        });
    }
}
