/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { z } from 'zod';
import type { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { BaseApplication, type EventDecl } from '../base.js';
import { Skill } from '../../aikernel/skill.js';
import { BaseToolset } from '../../aikernel/tool.js';
import { registerPluginsCommand } from '../../tui/subcommands/plugins.js';
import { getOpendeskDirectory, Setting } from '../../utils/setting.js';
import { GlobalState } from '../../aikernel/states/global.js';
import { getPlatform } from '../../../platforms/base.js';
import { logger } from '../../utils/logger.js';
import { compareVersion, OPENDESK_RUNTIME_VERSION } from '../../utils/version.js';
import { toErrorMessage } from '../../../common/utils/error.js';
import {
    disposePluginHost,
    initializePluginHost,
    reloadPluginHost,
    applyPluginEnabledChange,
    applyPluginInstall,
    applyPluginUninstall
} from './runtime/bootstrap.js';
import { discoverPlugins, resolvePluginRecordPath } from './discovery/discovery.js';
import { getPluginHost } from './runtime/host.js';
import { pluginCommandAcceptsArgs } from './runtime/command-arguments.js';
import { getPluginToolLocalName } from './runtime/tool-names.js';
import { resolvePluginEntry } from './discovery/loader.js';
import { loadPluginResources, readPluginManifest, type PluginManifest } from './discovery/manifest.js';
import {
    installPlugin,
    isBuiltinPluginId,
    isPluginEnabledFixed,
    listInstalledPlugins,
    resolveUninstallTarget,
    setPluginEnabled,
    uninstallPlugin,
    verifyInstalledPlugin
} from './management/manager.js';
import { setPluginGrantedCapabilities, setPluginOptions } from './management/policy.js';
import { isStalePluginRecord, listPluginRecords } from './management/registry.js';
import type {
    PluginAuthor,
    PluginCapability,
    PluginLocalizedText,
    PluginPlatform
} from '../../../../packages/plugin-sdk/src/index.js';
import { localePrimaryTag } from '../../../../packages/plugin-sdk/src/index.js';
import {
    formatPluginInstallError,
    formatPluginUninstallError,
    isHostVersionInstallError,
    type PluginInstallResult
} from './management/errors.js';
import { validateOpenDeskPluginDirectory } from '../../../../packages/plugin-sdk/src/package.js';
import { t } from './locale/index.js';
import { t as translate, getLocale } from '../../../locale/index.js';
import { MANAGE_PLUGINS_SKILL } from './skills.js';
import {
    GetPluginDetailsTool,
    InstallPluginTool,
    ListPluginsTool,
    ReloadPluginsTool,
    SetPluginEnabledTool,
    UninstallPluginTool
} from './tools.js';
import {
    createPluginRegistries,
    customPluginChannelCacheFile,
    filterCatalogByQuery,
    OFFICIAL_REGISTRY_DISPLAY_NAME,
    PluginMarketError,
    resolvePluginRegistryDisplayName,
    type BasePluginRegistry,
    type PluginCatalogEntry
} from './registry/index.js';
import {
    assertChannelNameAvailable,
    assertChannelUrlAvailable,
    fetchChannelCatalog,
    MAX_PLUGIN_CHANNELS,
    normalizeChannelName,
    normalizeChannelUrl,
    normalizePluginChannels,
    OFFICIAL_PLUGIN_CHANNEL_ID,
    type PluginChannel,
    type PluginChannelView
} from './channels.js';
import {
    describeHostVersionIssue,
    parsePluginHostVersionMessage,
    type PluginHostVersionIssueData,
    type PluginMarketInstallOutcome
} from './catalog-common.js';

/** 单个插件渠道的配置形状；系统默认渠道只有 isEnabled 会被采用 */
const PluginChannelSchema = z.object({
    id: z.string().default(''),
    name: z.string().default(''),
    url: z.string().default(''),
    isEnabled: z.boolean().default(true)
});

const PluginMgrConfigSchema = z.object({
    externalPaths: z.array(z.string()).default([]),
    channels: z.array(PluginChannelSchema).default([]).describe('插件渠道（插件市场来源）')
});

/** 下载进度事件的最小间隔：一个几十兆的包按块回调会有上千次，界面按这个节奏更新足够顺滑 */
const DOWNLOAD_PROGRESS_THROTTLE_MS = 120;

/** 从市场安装的结果：形状定义在 catalog-common，渲染层用同一份类型解析返回值 */
export type { PluginMarketInstallOutcome } from './catalog-common.js';

/** 平台 fetch 只接受字符串/URL，把 Request 对象也归一化掉，免得被当成 "[object Request]" */
function toPlatformFetchInput(input: RequestInfo | URL): string | URL {
    if (typeof input === 'string' || input instanceof URL) return input;
    return input.url;
}

/** 内联为本地图标的单文件大小上限：图标只是展示，超过这个大小多半是给错了文件 */
const INLINE_ICON_MAX_BYTES = 1024 * 1024;

/** 可内联为本地图标的扩展名 → data URL 的 MIME */
const ICON_MIME_BY_EXTENSION: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp'
};

/**
 * 把本地图标文件读成渲染层可显示的 data URL。
 *
 * 渲染层页面（dev 模式是 http://localhost、生产是 file://）加载不了本地路径的图片，
 * 所以清单里解析出本地路径的图标（本地调试市场清单的相对链接、已安装插件的包内相对路径）
 * 都在这里读文件转成 data URL 后再下发。读不到、不是常见图片格式或超出大小上限时
 * 返回 undefined——图标只是展示字段，缺失时界面回退首字母图标即可。
 */
async function readLocalIconAsDataUrl(iconPath: string): Promise<string | undefined> {
    const mime = ICON_MIME_BY_EXTENSION[path.extname(iconPath).toLowerCase()];
    if (!mime) return undefined;
    try {
        const stat = await fs.promises.stat(iconPath);
        if (!stat.isFile() || stat.size > INLINE_ICON_MAX_BYTES) return undefined;
        const data = await fs.promises.readFile(iconPath);
        return `data:${mime};base64,${data.toString('base64')}`;
    } catch {
        return undefined;
    }
}

/**
 * 展示图标下发渲染层前的归一（市场条目与已安装插件同一套）。
 *
 * http(s) 链接渲染层自己就能加载，原样返回；本地路径渲染层加载不了
 * （dev 模式是 http://localhost、生产是 file://），读文件转成 data URL，
 * 读不到按未声明处理——图标只是展示字段，缺失时界面回退首字母图标即可。
 * `toLocalPath` 把包内/清单目录内的相对路径解析到具体文件。
 */
async function resolveDisplayIconUrl(
    iconUrl: string | undefined,
    toLocalPath: (iconUrl: string) => string = (resolved) => resolved
): Promise<string | undefined> {
    if (!iconUrl) return undefined;
    if (!/^https?:\/\//i.test(iconUrl)) return readLocalIconAsDataUrl(toLocalPath(iconUrl));
    return iconUrl;
}

/**
 * 市场条目在当前平台是否可用。
 *
 * 与插件清单的加载期平台校验同一口径：声明了 `platforms` 且不含当前平台的条目
 * 既不展示、也不允许安装；未声明表示全平台。
 */
function isSupportedOnCurrentPlatform(entry: PluginCatalogEntry): boolean {
    return !entry.platforms?.length || entry.platforms.includes(process.platform as PluginPlatform);
}

/** 本地化文本未按语言拆分（纯字符串）时的统一槽位：只有两边都是简写才会逐字比较 */
const PLAIN_LOCALIZED_TAG = '*';

/** 把本地化文本摊成「主语言标签 → 文本」；纯字符串放进统一槽位 */
function toLocalizedMap(value: PluginLocalizedText | undefined): Record<string, string> {
    if (value === undefined) return {};
    if (typeof value === 'string') return { [PLAIN_LOCALIZED_TAG]: value.trim() };
    return Object.fromEntries(Object.entries(value).map(([tag, text]) => [localePrimaryTag(tag) || tag, text.trim()]));
}

/**
 * 两段本地化文本是否等价：只比两边都声明了的语言标签。
 *
 * 一个共同语言都没有时按等价处理——市场只补了一两种语言、插件只写了母语，
 * 属于「没写同一个东西」，不是「写了不一样的值」，报出来只会变成装完之后的一条假告警。
 */
function isSameLocalizedText(left: PluginLocalizedText | undefined, right: PluginLocalizedText | undefined): boolean {
    if (left === undefined || right === undefined) return left === right;
    const leftMap = toLocalizedMap(left);
    const rightMap = toLocalizedMap(right);
    return Object.keys(leftMap)
        .filter((tag) => tag in rightMap)
        .every((tag) => leftMap[tag] === rightMap[tag]);
}

/** 站点地址的规范化形式：`https://a.com` 与 `https://a.com/` 视为同一个地址 */
function normalizeUrl(value: string | undefined): string {
    if (!value) return '';
    try {
        return new URL(value).toString().replace(/\/$/, '');
    } catch {
        return value.trim();
    }
}

/** 市场条目与插件清单里的 author 是否等价 */
function isSameAuthor(left: PluginAuthor, right: PluginAuthor): boolean {
    return (
        isSameLocalizedText(left.name, right.name) &&
        // 市场往往只维护 name：institution / homepage 只在两边都声明时才比，
        // 与 version / homepage 等字段「市场未声明就不比」的核对口径一致
        (!left.institution || !right.institution || isSameLocalizedText(left.institution, right.institution)) &&
        (!left.homepage || !right.homepage || normalizeUrl(left.homepage) === normalizeUrl(right.homepage))
    );
}

/**
 * 本地目录安装时，可以在真正安装前解析出目标插件 id，
 * 让覆盖安装能先释放旧实例（Windows 下插件运行时会占用自身目录）。
 * 归档 / npm 源在安装完成前拿不到 id，返回 undefined。
 */
function resolveLocalPluginId(spec: string): string | undefined {
    try {
        const resolved = path.resolve(spec);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return undefined;
        return validateOpenDeskPluginDirectory(resolved).id;
    } catch {
        // 源本身不合法：交给 installPlugin 走正常的校验与错误上报
        return undefined;
    }
}

export class PluginMgrApplication extends BaseApplication {
    static bundleName = 'pluginmgr';

    private unsubscribeAppearanceChanged: (() => void) | undefined;
    /**
     * 当前生效的插件 registry 列表（每个是插件市场里的一个市场）。
     *
     * 惰性构造：只有真的打开插件市场或查询渠道时才读配置、建目录；渠道配置变更后置空，
     * 下一次取用时按最新配置重建（见 onConfigChanged）。
     */
    private registries: BasePluginRegistry[] | null = null;

    constructor() {
        super('pluginmgr');
        // 插件激活/停用会修改外观覆盖，转发为 appearanceChanged 事件供渲染进程热更新；
        // 本地化名称按当前界面语言解析后下发
        this.unsubscribeAppearanceChanged = getPluginHost().onAppearanceChanged(() => {
            this.emitEvent('appearanceChanged', getPluginHost().listAppearance(getLocale())).catch(() => {});
        });
    }

    getName(): string {
        return t('app.name');
    }

    static getConfigSchema(): z.ZodObject<any> {
        return PluginMgrConfigSchema;
    }

    static registerCliSubcommands(prog: Command): void {
        registerPluginsCommand(prog);
    }

    toJSON(): ReturnType<BaseApplication['toJSON']> & { source: string; removable: boolean; active: boolean } {
        return {
            ...super.toJSON(),
            source: 'system',
            removable: false,
            active: true
        };
    }

    async getSupportedEvents(): Promise<EventDecl[]> {
        return [
            {
                eventName: 'pluginsChanged',
                eventDescription: t('app.event.pluginsChanged')
            },
            {
                eventName: 'appearanceChanged',
                eventDescription: t('app.event.appearanceChanged')
            },
            {
                eventName: 'registriesChanged',
                eventDescription: t('app.event.registriesChanged')
            },
            {
                eventName: 'marketInstallProgress',
                eventDescription: t('app.event.marketInstallProgress')
            }
        ];
    }

    /**
     * 渠道配置变更（新增 / 删除 / 改名 / 启停）后丢弃已构建的 registry，
     * 并通知已打开的插件市场按最新渠道重新加载。
     *
     * 由 Setting.setData 触发（见 commitChannels），所以这里拿到的一定是最新配置。
     */
    override onConfigChanged(): void {
        super.onConfigChanged();
        this.registries = null;
        void this.emitEvent('registriesChanged').catch(() => undefined);
    }

    async getSkills(): Promise<Skill[]> {
        const managePluginsSkill = Skill.parseMd(MANAGE_PLUGINS_SKILL);
        const toolset = new BaseToolset('plugin-management');
        toolset.addTool(new ListPluginsTool(this));
        toolset.addTool(new GetPluginDetailsTool(this));
        toolset.addTool(new InstallPluginTool(this));
        toolset.addTool(new UninstallPluginTool(this));
        toolset.addTool(new SetPluginEnabledTool(this));
        toolset.addTool(new ReloadPluginsTool(this));
        managePluginsSkill.toolsets = [toolset];
        return [managePluginsSkill];
    }

    async list() {
        await initializePluginHost();
        const runtimeById = new Map(
            getPluginHost()
                .list()
                .map((entry) => [entry.id, entry])
        );
        const configDirectory = getOpendeskDirectory();
        const records = listPluginRecords();
        const discovery = discoverPlugins({ configDirectory });
        const candidatesById = new Map(discovery.candidates.map((candidate) => [candidate.id, candidate]));
        const skillsByPlugin = new Map<string, ReturnType<ReturnType<typeof getPluginHost>['listSkills']>>();
        for (const skill of getPluginHost().listSkills()) {
            const contributions = skillsByPlugin.get(skill.pluginId) ?? [];
            contributions.push(skill);
            skillsByPlugin.set(skill.pluginId, contributions);
        }
        const mcpServersByPlugin = new Map<string, ReturnType<ReturnType<typeof getPluginHost>['listMcpServers']>>();
        for (const server of getPluginHost().listMcpServers()) {
            const contributions = mcpServersByPlugin.get(server.pluginId) ?? [];
            contributions.push(server);
            mcpServersByPlugin.set(server.pluginId, contributions);
        }
        const toolsByPlugin = new Map<string, ReturnType<ReturnType<typeof getPluginHost>['listTools']>>();
        for (const tool of getPluginHost().listTools()) {
            const contributions = toolsByPlugin.get(tool.pluginId) ?? [];
            contributions.push(tool);
            toolsByPlugin.set(tool.pluginId, contributions);
        }
        const hooksByPlugin = new Map<string, ReturnType<ReturnType<typeof getPluginHost>['listHooks']>>();
        for (const hook of getPluginHost().listHooks()) {
            const contributions = hooksByPlugin.get(hook.pluginId) ?? [];
            if (!contributions.some((candidate) => candidate.name === hook.name)) contributions.push(hook);
            hooksByPlugin.set(hook.pluginId, contributions);
        }
        const agentsByPlugin = new Map<string, ReturnType<ReturnType<typeof getPluginHost>['listAgents']>>();
        for (const agent of getPluginHost().listAgents()) {
            const contributions = agentsByPlugin.get(agent.pluginId) ?? [];
            contributions.push(agent);
            agentsByPlugin.set(agent.pluginId, contributions);
        }
        const browserHintsByPlugin = new Map<
            string,
            ReturnType<ReturnType<typeof getPluginHost>['listBrowserHintPrefixes']>
        >();
        for (const hint of getPluginHost().listBrowserHintPrefixes()) {
            const contributions = browserHintsByPlugin.get(hint.pluginId) ?? [];
            contributions.push(hint);
            browserHintsByPlugin.set(hint.pluginId, contributions);
        }
        const ids = new Set([
            ...runtimeById.keys(),
            // 指向已不存在路径的记录（应用不再内置该插件、插件目录被手工删掉……）是幽灵条目：
            // 既不能启用也不能卸载，列出来只会让用户困惑
            ...records.filter((record) => !isStalePluginRecord(record, configDirectory)).map((record) => record.id),
            ...candidatesById.keys()
        ]);
        return (
            await Promise.all(
                Array.from(ids)
                    .sort()
                    .map(async (id) => {
                        const record = records.find((candidate) => candidate.id === id);
                        const candidate = candidatesById.get(id);
                        // 来源以 discovery 候选为准：残留的 local 记录不该让实际按内置插件加载的
                        // 插件显示成「可卸载的本地插件」（source 与 path/removable 必须同一口径）。
                        const source = candidate?.source ?? record?.source ?? 'local';
                        let skills = skillsByPlugin.get(id)?.map(({ definition }) => definition) ?? [];
                        let mcpServers = mcpServersByPlugin.get(id)?.map(({ definition }) => definition) ?? [];
                        let agents = agentsByPlugin.get(id)?.map(({ definition }) => definition) ?? [];
                        let manifest: PluginManifest | undefined;
                        /** 清单声明的图标内联后的地址（与 manifest 一起在 spec 可解析时赋值） */
                        let manifestIconUrl: string | undefined;
                        const spec =
                            candidate?.spec ?? (record ? resolvePluginRecordPath(record, configDirectory) : undefined);
                        if (spec) {
                            try {
                                const resolved = resolvePluginEntry(spec, configDirectory);
                                manifest = readPluginManifest(resolved.entry, resolved.rootDir);
                                // 已安装插件的图标以 zip 解压后的清单为准；包内相对路径指向插件目录里的文件
                                if (manifest) {
                                    manifestIconUrl = await resolveDisplayIconUrl(manifest.iconUrl, (icon) =>
                                        path.join(resolved.rootDir, icon)
                                    );
                                }
                                if (skills.length === 0 && mcpServers.length === 0 && agents.length === 0) {
                                    const resources = loadPluginResources(manifest, resolved.rootDir);
                                    skills = resources.skills ?? [];
                                    mcpServers = resources.mcpServers ?? [];
                                    agents = resources.agents ?? [];
                                }
                            } catch {
                                // Runtime diagnostics already describe malformed or unavailable plugins.
                            }
                        }
                        // 平台不匹配的插件仅在加载时记录警告（见 bootstrap），不出现在已安装插件列表。
                        if (
                            manifest?.platforms?.length &&
                            !manifest.platforms.includes(process.platform as PluginPlatform)
                        ) {
                            return undefined;
                        }
                        // system/enabled 以 discovery 候选为准（与 bootstrap 加载、listVisiblePlugins 同口径）。
                        // 不能按 record.source 重新解析清单判定：同名 local 记录残留时（插件后来变成内置）
                        // 会出现「GUI 显示可切换、后端 setEnabled 却以 system 拒绝」的分裂。
                        const system = candidate?.system === true;
                        return {
                            id,
                            source,
                            // 与 listVisiblePlugins 同口径：只有记录时也按记录解析成绝对路径
                            // （registry 里内置插件的相对路径只对内置插件目录成立）。
                            path: spec,
                            removable: source !== 'builtin',
                            system,
                            enabled: system ? (candidate?.enabled ?? true) : (record?.enabled ?? true),
                            installedAt: record?.installedAt,
                            spec: record?.spec,
                            verification: record ? verifyInstalledPlugin(id) : undefined,
                            runtime: runtimeById.get(id),
                            manifest: manifest
                                ? {
                                      displayName: manifest.displayName,
                                      description: manifest.description,
                                      version: manifest.version,
                                      apiVersion: manifest.apiVersion,
                                      author: manifest.author,
                                      homepage: manifest.homepage,
                                      iconUrl: manifestIconUrl,
                                      capabilities: manifest.capabilities
                                  }
                                : undefined,
                            skills: skills.map((definition) => ({
                                name: definition.name,
                                description: definition.description,
                                directory: definition.directory,
                                userInvocable: definition.userInvocable,
                                modelInvocable: definition.modelInvocable
                            })),
                            mcpServers: mcpServers.map((definition) => ({
                                name: definition.name,
                                transport: definition.transport,
                                command: definition.transport === 'stdio' ? definition.command : undefined,
                                cwd: definition.transport === 'stdio' ? definition.cwd : undefined,
                                url: definition.transport === 'stdio' ? undefined : definition.url
                            })),
                            tools: (toolsByPlugin.get(id) ?? []).map(({ pluginId, definition }) => ({
                                name: getPluginToolLocalName(pluginId, definition.name),
                                description: definition.description
                            })),
                            hooks: (hooksByPlugin.get(id) ?? []).map(({ name }) => ({ name })),
                            browserHints: (browserHintsByPlugin.get(id) ?? []).map(({ urlPrefix }) => ({ urlPrefix })),
                            agents: agents.map((definition) => ({
                                name: definition.name,
                                whenToUse: definition.whenToUse,
                                dispatchable: definition.dispatchable,
                                body: definition.body
                            }))
                        };
                    })
            )
        ).filter((entry) => entry !== undefined);
    }

    /** 广播插件变更：订阅方（渠道、待办触发器、插件自身）按宿主注册表差量自愈 */
    private notifyPluginsChanged(operation: string, id?: string): void {
        this.emitEvent('pluginsChanged', { operation, id }).catch(() => {});
    }

    async reload(id?: string) {
        await reloadPluginHost();
        this.notifyPluginsChanged('reload', id);
        return await this.list();
    }

    async install(spec: string) {
        // 差量安装：只加载目标插件（覆盖安装时先释放旧实例），其他插件不重启
        const targetId = resolveLocalPluginId(spec);
        // 宿主没就绪时运行时根本没被动过，下面失败分支的广播会把「空渠道注册表」当成
        // 「所有渠道都没了」，让订阅方停掉全部渠道连接。先初始化，失败就此打住。
        await initializePluginHost();
        try {
            const result = await applyPluginInstall(targetId, () => installPlugin(spec));
            if (!result.success) {
                if (isHostVersionInstallError(result.errorCode)) {
                    // 结构化串原样抛给渲染层：界面据此识别「宿主版本不满足」并弹升级引导模态，
                    // CLI / AI 工具不经过这条路径，仍用 result + formatPluginInstallError 组装文案
                    throw new Error(result.error ?? this.describeInstallFailure(result));
                }
                throw new Error(this.describeInstallFailure(result));
            }
            this.notifyPluginsChanged('install', result.id);
            return result;
        } catch (error) {
            // 覆盖安装失败时旧实例可能已被释放并装回（换成了新实例），订阅方必须重新对齐；
            // targetId 为空表示新装（归档 / npm 源）失败，运行时没被动过，无需广播
            if (targetId) this.notifyPluginsChanged('install', targetId);
            throw error;
        }
    }

    async uninstall(id: string, removeData = false) {
        // 差量卸载：只释放目标插件、删除磁盘文件、刷新派生注册表。
        // 此前的 dispose + reload 会让所有插件（含内置飞书/微信等渠道插件）整包重新
        // import + setup，卸载时主进程被阻塞数秒，界面随之失去响应。
        //
        // 先做纯检查再释放：内置/外部/不存在这些不该卸载的情况，不应该先把正在运行的
        // 内置渠道插件拆掉再装回来（渠道会白白断连一次）。
        const resolution = resolveUninstallTarget(id);
        if (!resolution.ok) throw new Error(formatPluginUninstallError(resolution.error, id));
        // 同 install：宿主未就绪时不要进入下面会广播的区域
        await initializePluginHost();
        try {
            const result = await applyPluginUninstall(id, () => uninstallPlugin(id, { removeData }));
            if (!result.success) throw new Error(formatPluginUninstallError(result.error, id));
            // 带 id 回给界面：run() 的成功通知要用插件展示名当正文，而不是重复一遍标题
            return { success: true, id };
        } finally {
            // 成功要刷新；失败时实例也可能已被装回成新实例（旧注册已释放），同样必须广播，
            // 否则渠道等订阅方会继续持有已卸载的旧实例
            this.notifyPluginsChanged('uninstall', id);
        }
    }

    async setEnabled(id: string, enabled: boolean) {
        // 清单固定启停的内置插件不允许改开关，实际状态由清单的 enabled 决定
        if (isPluginEnabledFixed(id)) {
            throw new Error(translate('plugin.enabledFixed', { id }));
        }
        if (!setPluginEnabled(id, enabled)) {
            throw new Error(translate('plugin.notFound', { id }));
        }
        try {
            await applyPluginEnabledChange(id, enabled);
        } catch (error) {
            // 启用后加载失败（完整性校验、入口缺失、平台不支持等）：回滚注册表，
            // 避免留下「注册表已启用但运行时未生效」的状态
            setPluginEnabled(id, !enabled);
            throw error;
        }
        // channelmgr 收到插件 id 后按宿主注册表差量增删渠道，非渠道插件的事件对它无副作用；
        // 事件本身是公开契约（todomgr 触发器、插件订阅者），因此启停一律广播
        this.notifyPluginsChanged(enabled ? 'enable' : 'disable', id);
        return await this.list();
    }

    async setOptions(id: string, options: Record<string, unknown>) {
        const entry = setPluginOptions(id, options);
        await reloadPluginHost();
        this.notifyPluginsChanged('configure', id);
        return entry;
    }

    async setGrantedCapabilities(id: string, capabilities: PluginCapability[]) {
        const entry = setPluginGrantedCapabilities(id, capabilities);
        await reloadPluginHost();
        this.notifyPluginsChanged('permissions', id);
        return entry;
    }

    /** 当前插件生效的应用外观覆盖，供渲染进程（侧边栏品牌区等）读取；名称按当前界面语言解析 */
    async getAppearance() {
        await initializePluginHost();
        return getPluginHost().listAppearance(getLocale());
    }

    async doctor() {
        await initializePluginHost();
        return {
            runtime: getPluginHost().list(),
            installed: listInstalledPlugins().map((record) => verifyInstalledPlugin(record.id)),
            discovery: discoverPlugins()
        };
    }

    async listCommandsForUI() {
        await initializePluginHost();
        return getPluginHost()
            .listCommands()
            .map(({ definition }) => ({
                name: definition.name,
                description: definition.description,
                acceptsArgs: pluginCommandAcceptsArgs(definition)
            }));
    }

    async runCommandForUI(name: string, rawArgs: string, taskId?: string) {
        await initializePluginHost();
        const contribution = getPluginHost()
            .listCommands()
            .find((candidate) => candidate.definition.name === name);
        if (!contribution) throw new Error(translate('plugin.command.notFound', { name }));
        const task = taskId ? GlobalState.getInstance().taskManagerState.getTask(taskId) : undefined;
        return await getPluginHost().runCommand(
            contribution.id,
            { raw: typeof rawArgs === 'string' ? rawArgs : '' },
            {
                taskId: task?.task_id,
                workspace: task?.getWorkspace() || Setting.getInstance().getEffectiveWorkspace(),
                abort: task?.getAbortSignal() ?? new AbortController().signal
            }
        );
    }

    async beforeExit(): Promise<void> {
        this.unsubscribeAppearanceChanged?.();
        this.unsubscribeAppearanceChanged = undefined;
        this.registries = null;
        await disposePluginHost();
    }

    // ── 插件市场（插件中心 → 插件市场） ─────────────────────────────────────

    /** 当前启用哪些插件 registry（每个 registry 是插件市场里的一个市场） */
    async listPluginRegistries(): Promise<{ name: string; displayName: string }[]> {
        const locale = getLocale();
        return this.ensureRegistries().map((registry) => ({
            name: registry.name,
            displayName: resolvePluginRegistryDisplayName(registry.displayName, locale)
        }));
    }

    /**
     * 某个插件市场的插件清单。
     *
     * @param categories 只取这些分类下的插件；省略（或空数组）表示取全部插件
     * @param query 关键词过滤（id / 显示名 / 描述），留空不过滤
     * @param forceRefresh 忽略 5 分钟清单缓存，强制重新拉取远端清单
     *
     * 注意分页：registry 的 `getCatalog` 支持 `startAt` / `limit`，但关键词与平台过滤在本方法里
     * 做（前者是界面行为、后者是宿主策略），都在分页之后。界面目前一次取全量所以没影响；
     * 将来若做「翻页加载」，必须先把这两个过滤下沉到 registry，否则每页条数会被再削一次。
     */
    async getPluginCatalog(
        registryName: string,
        categories?: string[],
        query?: string,
        forceRefresh?: boolean
    ): Promise<{ categories?: string[]; entries: PluginCatalogEntry[] }> {
        const registry = this.requireRegistry(registryName);
        if (forceRefresh === true) registry.invalidate?.();
        const entries = await registry.getCatalog({
            categories: Array.isArray(categories) ? categories : undefined
        });
        return {
            // 分类是 registry 自述的（清单拉下来才知道），界面据此决定要不要显示分类切换
            categories: registry.categories,
            // 当前平台用不了的插件不上架：市场里看不到它，也就不会去点安装。
            // 本地路径的图标先内联成 data URL（渲染层加载不了本地文件），再交给界面
            entries: await Promise.all(
                filterCatalogByQuery(entries, typeof query === 'string' ? query : '')
                    .filter(isSupportedOnCurrentPlatform)
                    .map(async (entry) => ({ ...entry, iconUrl: await resolveDisplayIconUrl(entry.iconUrl) }))
            )
        };
    }

    /**
     * 从插件市场下载并安装插件。
     *
     * 下载地址一律取清单里声明的那条，而不是渲染层传上来的：清单已经过渠道校验，
     * 按 id 取回它就不会把界面变成「任意 URL 安装」的入口。
     */
    async installFromPluginRegistry(registryName: string, pluginId: string): Promise<PluginMarketInstallOutcome> {
        const registry = this.requireRegistry(registryName);
        const id = typeof pluginId === 'string' ? pluginId.trim() : '';
        if (!id) throw new PluginMarketError(t('market.entryIdMissing'));
        const entry = (await registry.getCatalog()).find((item) => item.id === id);
        if (!entry) throw new PluginMarketError(t('market.entryNotFound', { id }));
        // 界面不展示平台不匹配的条目，这里再拦一次：直接调主进程 API 也不该绕过这条规则
        if (!isSupportedOnCurrentPlatform(entry)) {
            throw new PluginMarketError(
                t('market.platformUnsupported', {
                    id: entry.id,
                    platforms: (entry.platforms ?? []).join(', ')
                })
            );
        }
        // 宿主版本不满足的条目同样拦在这里：界面会把它标成「装不了」，直接调 API 也返回
        // 结构化 outcome（而不是抛错），让界面弹出「无法安装，请升级 OpenDesk」的模态
        const entryHostVersionIssue = describeHostVersionIssue(entry);
        if (entryHostVersionIssue) {
            return this.hostVersionOutcome(
                { ...entryHostVersionIssue, hostVersion: OPENDESK_RUNTIME_VERSION },
                t('market.hostVersionUnsupported', {
                    id: entry.id,
                    range: entryHostVersionIssue.range,
                    current: OPENDESK_RUNTIME_VERSION
                })
            );
        }
        // 内置插件优先：同 id 的包一定装不上（installPlugin 要到落盘前才拒绝）。这里先拦下来，
        // 既不白下几十兆，也不用为了这次安装先把正在运行的内置插件（飞书之类的渠道）停掉再装回去
        if (isBuiltinPluginId(entry.id)) {
            throw new PluginMarketError(
                t('error.installFailed', { reason: formatPluginInstallError({ errorCode: 'builtin_conflict' }) })
            );
        }
        // 宿主没就绪时运行时根本没被动过，下面失败分支的广播会被订阅方误读成「渠道全没了」
        await initializePluginHost();

        let lastEmitAt = 0;
        const notifyProgress = (receivedBytes: number, totalBytes: number | null) => {
            const now = Date.now();
            const finished = totalBytes !== null && receivedBytes >= totalBytes;
            // 首块、末块与节流窗口外的进度都要发：界面既能立刻有反馈，也不会被上千条事件刷屏
            if (!finished && now - lastEmitAt < DOWNLOAD_PROGRESS_THROTTLE_MS) return;
            lastEmitAt = now;
            void this.emitEvent('marketInstallProgress', {
                registry: registry.name,
                pluginId: entry.id,
                receivedBytes,
                totalBytes
            }).catch(() => undefined);
        };

        // 上架信息与包内清单的核对放在「下载解压之后、落盘之前」：对不上就整单失败，
        // 磁盘上不会留下这一版，已安装的旧版本也不动
        let mismatchMessage: string | undefined;
        // try 内广播过（旧实例可能已被释放并装回）就不再重复；没广播过的失败路径
        // （如临时目录创建就失败）在这里补上，口径与 install() 的 catch 一致
        let notifiedPluginsChanged = false;
        try {
            // 覆盖安装时先释放旧实例（Windows 下插件运行时会占用自身目录，直接替换会失败）
            const result = await applyPluginInstall(entry.id, () =>
                installPlugin(entry.downloadUrl, {
                    onDownloadProgress: notifyProgress,
                    verifyStaged: ({ id: stagedId, directory }) => {
                        const message = this.describeCatalogEntryMismatch(entry, stagedId, directory);
                        if (!message) return;
                        mismatchMessage = message;
                        throw new PluginMarketError(message);
                    }
                })
            );
            if (!result.success) {
                // 安装可能已经把旧实例释放并装回去了（换成了新实例），订阅方必须重新对齐；
                // 这跟 install() 的失败分支同口径，漏掉会让渠道插件握着一个已经不用的实例
                this.notifyPluginsChanged('install', entry.id);
                notifiedPluginsChanged = true;
                if (mismatchMessage) {
                    return { success: false as const, code: 'manifest_mismatch' as const, message: mismatchMessage };
                }
                if (isHostVersionInstallError(result.errorCode)) {
                    // 包内清单声明的宿主版本范围不满足（市场条目未声明时由 manager 的闸门兜住）：
                    // 与条目级拦截一样返回结构化 outcome，界面弹「请升级 OpenDesk」的模态
                    const stagedIssue = parsePluginHostVersionMessage(result.error ?? '');
                    if (stagedIssue) {
                        return this.hostVersionOutcome(stagedIssue, formatPluginInstallError(result));
                    }
                }
                throw new Error(this.describeInstallFailure(result));
            }
            // 走到这里插件已经落盘了：先按包内真实 id 广播，界面上的「已安装」才会更新
            this.notifyPluginsChanged('install', result.id);
            notifiedPluginsChanged = true;
            if (result.id !== entry.id) {
                throw new PluginMarketError(
                    t('market.entryIdMismatch', { expected: entry.id, actual: result.id ?? '' })
                );
            }
            return { success: true as const, id: result.id };
        } catch (error) {
            // 运行时实例可能已被释放并恢复，订阅方必须重新对齐；与 install() 的 catch 同口径
            if (!notifiedPluginsChanged) this.notifyPluginsChanged('install', entry.id);
            // 下载或校验失败：给界面一个终态，把卡片上的进度条收掉
            void this.emitEvent('marketInstallProgress', {
                registry: registry.name,
                pluginId: entry.id,
                receivedBytes: 0,
                totalBytes: null,
                failed: true
            }).catch(() => undefined);
            throw error;
        }
    }

    /**
     * 把安装失败的 result 变成一句带原因的文案。
     *
     * 界面（提示条 / 系统通知）只拿得到异常消息，所以底层原因在这里就拼进消息里：
     * 否则用户只看到「安装失败」，没法判断是断网、包坏了还是内置冲突。
     */
    private describeInstallFailure(result: PluginInstallResult): string {
        const reason = formatPluginInstallError(result);
        const detail = typeof result.error === 'string' ? result.error.trim() : '';
        return detail ? t('error.installFailedDetail', { reason, detail }) : t('error.installFailed', { reason });
    }

    /**
     * 组装「宿主版本不满足，安装已被拒绝」的结构化结果。
     *
     * 市场条目预检（上架信息）与包内清单校验（运行时真身）都走这里，
     * 界面据此按方向弹升级 / 换版本的模态，不需要各自拼字段。
     */
    private hostVersionOutcome(issue: PluginHostVersionIssueData, message: string): PluginMarketInstallOutcome {
        return {
            success: false,
            code: 'host_version',
            direction: issue.direction,
            range: issue.range,
            current: issue.hostVersion,
            message
        };
    }

    /**
     * 核对市场条目与暂存目录里的插件清单。
     *
     * 市场条目是「上架信息」，包内的 `opendesk.plugin.json` 才是运行时真身：两边都声明了的
     * 展示字段必须对得上，否则用户看到的市场描述与实际装进去的东西不符。
     * 只比有单一真值的字段（`version` / `minOpenDeskVersion` / `maxOpenDeskVersion` /
     * `homepage` / `author`）；`displayName` / `description` 允许市场只提供部分语言，
     * `category` 允许市场自行归类，因此不参与比较。
     *
     * 调用点在「下载解压之后、落盘之前」（见 installPlugin 的 verifyStaged），
     * 返回文案表示不一致，调用方据此中止安装。
     *
     * @returns 不一致时给用户看的文案；一致（或读不到清单）时 undefined
     */
    private describeCatalogEntryMismatch(
        entry: PluginCatalogEntry,
        pluginId: string,
        pluginDirectory: string
    ): string | undefined {
        const manifest = this.readStagedPluginManifest(pluginDirectory);
        if (!manifest) return undefined;
        const mismatched: string[] = [];
        // 版本按 SemVer 比较而不是比字符串：清单允许 `v1.0.0`、市场写 `1.0.0`，
        // 同一个版本号被当成不一致会让用户在装好之后收到一条假告警
        const pushVersionDiff = (field: string, market?: string, plugin?: string) => {
            if (!market || !plugin) return;
            if (compareVersion(market, plugin) === 0) return;
            mismatched.push(t('market.fieldDiff', { field, market, plugin }));
        };
        pushVersionDiff('version', entry.version, manifest.version);
        // 宿主版本上下界也是单一真值：市场说支持到 2.x、插件自己说只到 1.x，用户就会装到一个
        // 加载即报错的包（见 host.ts 的 opendesk_version_too_* 诊断）
        pushVersionDiff('minOpenDeskVersion', entry.minOpenDeskVersion, manifest.minOpenDeskVersion);
        pushVersionDiff('maxOpenDeskVersion', entry.maxOpenDeskVersion, manifest.maxOpenDeskVersion);
        if (entry.homepage && manifest.homepage && normalizeUrl(entry.homepage) !== normalizeUrl(manifest.homepage)) {
            mismatched.push(
                t('market.fieldDiff', { field: 'homepage', market: entry.homepage, plugin: manifest.homepage })
            );
        }
        if (entry.author && manifest.author && !isSameAuthor(entry.author, manifest.author)) {
            // 作者是本地化文本的集合，逐项摊开只会变成一屏噪音，这里只报字段名
            mismatched.push('author');
        }
        if (mismatched.length === 0) return undefined;
        return t('market.entryManifestMismatch', {
            id: pluginId,
            fields: mismatched.join(t('market.fieldSeparator'))
        });
    }

    /** 读暂存目录里的插件清单（用于落盘前的一致性校验）；读不到就跳过校验 */
    private readStagedPluginManifest(pluginDirectory: string): PluginManifest | undefined {
        try {
            const resolved = resolvePluginEntry(pluginDirectory, getOpendeskDirectory());
            return readPluginManifest(resolved.entry, resolved.rootDir);
        } catch {
            return undefined;
        }
    }

    // ── 插件渠道（设置界面 → 插件渠道） ─────────────────────────────────────

    /** 全部插件渠道（含已禁用的），系统默认渠道排第一 */
    async listPluginChannels(): Promise<PluginChannelView[]> {
        return this.resolveChannels().map((channel) => this.toChannelView(channel));
    }

    /**
     * 新增渠道：先校验输入、再联网验证清单确实可解析，最后才落配置。
     *
     * 验证放在主进程（而不是设置界面）里做，是为了保证「配置里存在的渠道一定验证过」，
     * 并且能复用主进程的代理设置。
     *
     * @returns 变更后的完整渠道列表，便于界面就地重绘
     */
    async addPluginChannel(input: { name?: unknown; url?: unknown }): Promise<PluginChannelView[]> {
        const name = normalizeChannelName(input?.name);
        const url = normalizeChannelUrl(input?.url);
        // 联网校验最长要等十几秒，期间配置可能已被别的窗口改过；先校验一次是为了把明显的
        // 错误立刻回给用户，校验后再按最新配置校验一遍才落盘。
        this.assertChannelAddable(this.resolveChannels(), name, url);
        await fetchChannelCatalog(url, { fetchImpl: this.platformFetch() });

        const channels = this.resolveChannels();
        this.assertChannelAddable(channels, name, url);
        const next: PluginChannel[] = [...channels, { id: `channel-${randomUUID()}`, name, url, isEnabled: true }];
        this.commitChannels(next);
        return next.map((channel) => this.toChannelView(channel));
    }

    /** 编辑渠道：同样先联网验证；系统默认渠道不可编辑 */
    async updatePluginChannel(id: string, input: { name?: unknown; url?: unknown }): Promise<PluginChannelView[]> {
        const name = normalizeChannelName(input?.name);
        const url = normalizeChannelUrl(input?.url);
        const before = this.resolveChannels();
        this.requireEditableChannel(before, id);
        this.assertChannelFree(before, name, url, id);
        await fetchChannelCatalog(url, { fetchImpl: this.platformFetch() });

        // 同样按最新配置重来一遍：验证期间这条渠道可能已经被删除
        const channels = this.resolveChannels();
        const target = this.requireEditableChannel(channels, id);
        this.assertChannelFree(channels, name, url, id);
        const next = channels.map((channel) => (channel.id === target.id ? { ...channel, name, url } : channel));
        this.commitChannels(next);
        // 地址变了：旧地址的清单缓存不会再被用到，顺手删掉，别在数据目录里越堆越多
        if (url !== target.url) this.dropChannelCache(target);
        return next.map((channel) => this.toChannelView(channel));
    }

    /** 删除渠道；系统默认渠道不可删除 */
    async deletePluginChannel(id: string): Promise<PluginChannelView[]> {
        const channels = this.resolveChannels();
        const target = this.requireEditableChannel(channels, id);
        const next = channels.filter((channel) => channel.id !== target.id);
        this.commitChannels(next);
        this.dropChannelCache(target);
        return next.map((channel) => this.toChannelView(channel));
    }

    /** 启用 / 禁用渠道：系统默认渠道也允许禁用 */
    async setPluginChannelEnabled(id: string, isEnabled: boolean): Promise<void> {
        const channels = this.resolveChannels();
        if (!channels.some((channel) => channel.id === id)) {
            throw new PluginMarketError(t('error.channelNotFound'));
        }
        const enabled = isEnabled === true;
        const next = channels.map((channel) => (channel.id === id ? { ...channel, isEnabled: enabled } : channel));
        this.commitChannels(next);
    }

    // ── 插件渠道 / 市场的内部实现 ───────────────────────────────────────────

    /** 按当前配置解析出渠道列表（系统默认渠道 + 用户渠道） */
    private resolveChannels(): PluginChannel[] {
        const config = this.getConfig() as { channels?: unknown } | undefined;
        return normalizePluginChannels(config?.channels);
    }

    /** 系统默认渠道按当前语言取显示名 */
    private officialChannelName(): string {
        return resolvePluginRegistryDisplayName(OFFICIAL_REGISTRY_DISPLAY_NAME, getLocale());
    }

    private toChannelView(channel: PluginChannel): PluginChannelView {
        const isDefault = channel.id === OFFICIAL_PLUGIN_CHANNEL_ID;
        return {
            id: channel.id,
            name: isDefault ? this.officialChannelName() : channel.name,
            url: channel.url,
            isEnabled: channel.isEnabled,
            isDefault
        };
    }

    /** 取一个可以改/删的渠道（系统默认渠道只能启停）；不存在或不可改时抛错 */
    private requireEditableChannel(channels: readonly PluginChannel[], id: string): PluginChannel {
        const target = channels.find((channel) => channel.id === id);
        if (!target) {
            throw new PluginMarketError(t('error.channelNotFound'));
        }
        if (target.id === OFFICIAL_PLUGIN_CHANNEL_ID) {
            throw new PluginMarketError(t('error.channelDefaultReadonly'));
        }
        return target;
    }

    /** 名字与地址没有和别的渠道撞车；`exceptId` 是正在编辑的那条，允许保留自身取值 */
    private assertChannelFree(channels: readonly PluginChannel[], name: string, url: string, exceptId?: string): void {
        assertChannelNameAvailable(channels, name, this.officialChannelName(), exceptId);
        assertChannelUrlAvailable(channels, url, exceptId);
    }

    /** 新增渠道的写前校验：自定义渠道数量没超限，且名字与地址不与他人冲突 */
    private assertChannelAddable(channels: readonly PluginChannel[], name: string, url: string): void {
        const customCount = channels.filter((channel) => channel.id !== OFFICIAL_PLUGIN_CHANNEL_ID).length;
        if (customCount >= MAX_PLUGIN_CHANNELS) {
            throw new PluginMarketError(t('error.channelLimit', { count: MAX_PLUGIN_CHANNELS }));
        }
        this.assertChannelFree(channels, name, url);
    }

    /** 请求实现：走平台 fetch 以继承代理设置（清单拉取与联网校验都用它） */
    private platformFetch(): typeof fetch {
        return (input, init) => getPlatform().fetch(toPlatformFetchInput(input), init);
    }

    /**
     * 把渠道列表写回应用配置。
     *
     * 走 Setting.setData（而不是 BaseApplication.setConfig）是必须的：只有 setData 会
     * 比对新旧应用配置并触发 onConfigChanged，registry 列表与插件市场才能立刻跟着变。
     * 深拷贝则是为了避免「改的就是当前配置对象」导致比对失效。
     */
    private commitChannels(channels: PluginChannel[]): void {
        const setting = Setting.getInstance();
        const data = JSON.parse(JSON.stringify(setting.getData())) as {
            applications?: Record<string, unknown>;
        };
        const applications = { ...(data.applications ?? {}) };
        applications[this.bundleName] = {
            ...((applications[this.bundleName] as Record<string, unknown> | undefined) ?? {}),
            channels
        };
        data.applications = applications;
        setting.setData(data);
    }

    private dropChannelCache(channel: PluginChannel): void {
        if (channel.id === OFFICIAL_PLUGIN_CHANNEL_ID) return;
        const cacheFile = customPluginChannelCacheFile(this.getDataDirectory(), channel.id, channel.url);
        try {
            fs.rmSync(cacheFile, { force: true });
        } catch (error) {
            logger.warn(`[pluginmgr] failed to remove catalog cache ${cacheFile}: ${toErrorMessage(error)}`);
        }
    }

    private ensureRegistries(): BasePluginRegistry[] {
        if (!this.registries) {
            const config = this.getConfig() as { channels?: unknown } | undefined;
            this.registries = createPluginRegistries({
                dataDirectory: this.getDataDirectory(),
                channels: config?.channels,
                fetchImpl: this.platformFetch()
            });
        }
        return this.registries;
    }

    private requireRegistry(registryName: string): BasePluginRegistry {
        const name = typeof registryName === 'string' ? registryName.trim() : '';
        const registry = this.ensureRegistries().find((candidate) => candidate.name === name);
        if (!registry) throw new PluginMarketError(t('market.registryNotFound', { name: name || registryName }));
        return registry;
    }
}
