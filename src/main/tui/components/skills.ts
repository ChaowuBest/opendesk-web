import { type Component, SelectList, Box, Text, Input, TUI, Key, matchesKey } from "@mariozechner/pi-tui";
import chalk from "chalk";
import { defaultSelectListTheme } from "../theme";
import { OpenDeskTUI } from "../entry";
import { SkillRegistry } from "../../applications/skillmgr/skillregistry.js";
import { RegistryAdapters } from "../../applications/skillmgr/registry-adapters.js";
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

type ViewState =
    | 'main'
    | 'search'
    | 'search-results'
    | 'install-local'
    | 'install-url'
    | 'install-github'
    | 'install-clawhub'
    | 'view-installed';

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
    private message: { text: string; isError: boolean } | null = null;
    private loading = false;

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

    private showMessage(text: string, isError: boolean = false) {
        this.message = { text, isError };
        this.openDeskTUI.tui.requestRender();
        setTimeout(() => {
            this.message = null;
            this.openDeskTUI.tui.requestRender();
        }, 3000);
    }

    private setLoading(loading: boolean) {
        this.loading = loading;
        this.openDeskTUI.tui.requestRender();
    }

    private showMain() {
        this.state = 'main';
        this.input = undefined;

        const items = [
            { value: 'search', label: chalk.cyan('🔍 从 Registry 搜索技能') },
            { value: 'install-local', label: chalk.green('📁 从本地目录添加') },
            { value: 'install-url', label: chalk.blue('🌐 从 URL 添加') },
            { value: 'install-github', label: chalk.magenta('📦 从 GitHub 添加') },
            { value: 'install-clawhub', label: chalk.yellow('⚡ 从 ClawHub 添加') },
            { value: 'view-installed', label: chalk.white('📋 查看已安装技能') },
        ];

        this.list = new SelectList(items, items.length, defaultSelectListTheme);
        this.setupListHandlers();
        this.renderBox();
    }

    private showSearch() {
        this.state = 'search';
        this.list = undefined;

        this.input = new Input();
        this.input.setValue(this.selectedInputValue);
        this.input.onSubmit = () => this.performSearch();

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
            if (this.searchResults.length === 0) {
                this.showMessage('未找到匹配的技能', true);
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
        this.state = 'search-results';
        this.input = undefined;

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
    }

    private showInstallLocal() {
        this.state = 'install-local';
        this.list = undefined;

        this.input = new Input();
        this.input.setValue(this.selectedInputValue);
        this.input.onSubmit = () => this.performInstallLocal();

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
                this.showMessage(`成功添加技能: ${result.name}`);
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

    private showInstallUrl() {
        this.state = 'install-url';
        this.list = undefined;

        this.input = new Input();
        this.input.setValue(this.selectedInputValue);
        this.input.onSubmit = () => this.performInstallUrl();

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
                this.showMessage(`成功添加技能: ${result.name}`);
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
        this.state = 'install-github';
        this.list = undefined;

        this.input = new Input();
        this.input.setValue(this.selectedInputValue);
        this.input.onSubmit = () => this.performInstallGitHub();

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
                this.showMessage(`成功添加技能: ${result.name}`);
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
        this.state = 'install-clawhub';
        this.list = undefined;

        this.input = new Input();
        this.input.setValue(this.selectedInputValue);
        this.input.onSubmit = () => this.performInstallClawHub();

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
                this.showMessage(`成功添加技能: ${result.name}`);
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
        this.state = 'view-installed';
        this.input = undefined;

        if (this.installedSkills.length === 0) {
            const items = [{ value: 'back', label: chalk.gray('暂无已安装技能，按 Enter 返回') }];
            this.list = new SelectList(items, 1, defaultSelectListTheme);
        } else {
            const items = this.installedSkills.map(skill => ({
                value: skill.id,
                label: `${chalk.bold(skill.name)} - ${skill.description || '无描述'}`,
            }));
            this.list = new SelectList(items, Math.min(items.length, 10), defaultSelectListTheme);
        }

        this.setupListHandlers();
        this.renderBox();
    }

    private async deleteSkill(skillId: string) {
        this.setLoading(true);
        try {
            const result = SkillRegistry.deleteSkill(skillId);
            if (result.success) {
                this.showMessage(`成功删除技能: ${skillId}`);
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

        this.list.onSelect = (item) => {
            switch (this.state) {
                case 'main':
                    this.handleMainSelection(item.value);
                    break;
                case 'search-results':
                    this.handleSearchResultSelection(item.value);
                    break;
                case 'view-installed':
                    this.handleInstalledSelection(item.value);
                    break;
            }
        };

        this.list.onCancel = () => {
            this.goBack();
        };
    }

    private handleMainSelection(value: string) {
        switch (value) {
            case 'search':
                this.showSearch();
                break;
            case 'install-local':
                this.showInstallLocal();
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
            } else if (skill.installUrl.includes('github.com') && skill) {
                result = await SkillRegistry.addSkillFromGitHubUrl(skill.installUrl);
            } else {
                result = await SkillRegistry.addSkillFromUrl(skill.installUrl);
            }

            if (result?.success) {
                this.showMessage(`成功安装技能: ${result.name}`);
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

        const skill = this.installedSkills.find(s => s.id === skillId);
        if (!skill) return;

        this.deleteSkill(skillId);
    }

    private setupInputHandlers() {
        if (!this.input) return;

        const listener = this.openDeskTUI.tui.addInputListener((data: string) => {
            if (matchesKey(data, Key.escape)) {
                this.goBack();
                return { consume: true };
            }
            return undefined;
        });

        this.input.onSubmit = () => {
            listener();
        };
    }

    private goBack() {
        switch (this.state) {
            case 'search':
            case 'install-local':
            case 'install-url':
            case 'install-github':
            case 'install-clawhub':
            case 'view-installed':
                this.showMain();
                break;
            case 'search-results':
                this.showSearch();
                break;
            default:
                this.showMain();
        }
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

        this.openDeskTUI.tui.requestRender();
    }

    private getInputLabel(): string {
        switch (this.state) {
            case 'search':
                return `搜索 [${this.selectedRegistry}]:`;
            case 'install-local':
                return '输入本地目录路径:';
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

        const handle = this.openDeskTUI.tui.showOverlay(this, {
            width: overlayWidth,
            maxHeight: overlayMaxHeight,
            anchor: "center",
        });

        this.openDeskTUI.hasOpenOverlay = true;
        this.showMain();
        this.openDeskTUI.tui.setFocus(this.list);

        if (this.list) {
            this.list.onCancel = () => {
                handle.hide();
                this.openDeskTUI.hasOpenOverlay = false;
                this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
            };
        }
    }
}
