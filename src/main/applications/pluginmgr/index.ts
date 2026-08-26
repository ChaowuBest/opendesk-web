/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

export {
    definePlugin,
    tool,
    actionHint,
    textHint,
    OPENDESK_PLUGIN_API_VERSION,
    OPENDESK_PLUGIN_CAPABILITIES,
    OPENDESK_PLUGIN_HOOK_NAMES
} from '../../../../packages/plugin-sdk/src/index.js';
export type {
    OpenDeskPlugin,
    ActionHint,
    AgentDefinition,
    BrowserContext,
    BrowserHint,
    BrowserHintGenerator,
    PluginApplicationEvent,
    PluginApplicationEventCallback,
    PluginApplicationEventFilter,
    PluginCapability,
    PluginChatRequestInput,
    PluginChatHeadersOutput,
    PluginChatParams,
    PluginSkillLoadContext,
    PluginSkillLoadBeforeOutput,
    PluginSkillInstallContext,
    PluginSkillInstallBeforeOutput,
    PluginSkillInstallAfterContext,
    PluginCommandContext,
    PluginCommandArgsBuilder,
    PluginCommandArgumentOptions,
    PluginCommandOptionOptions,
    PluginCommandValueOptions,
    PluginCommandDefinition,
    PluginTextCommandDefinition,
    PluginStructuredCommandDefinition,
    PluginParsedCommandArgs,
    PluginCommandResult,
    PluginContext,
    PluginFailureMode,
    PluginHookCallback,
    PluginHookMap,
    PluginHookName,
    PluginHookRegistrationOptions,
    PluginRegistration,
    PluginSetupResult,
    PluginSkillDefinition,
    PluginStaticResources,
    PluginMcpRemoteServerDefinition,
    PluginMcpServerDefinition,
    PluginMcpStdioServerDefinition,
    TextHint
} from '../../../../packages/plugin-sdk/src/index.js';
export { PluginHost, getPluginHost } from './runtime/host.js';
export type {
    ActivatePluginOptions,
    PluginDiagnostic,
    PluginHostEntry,
    PluginStatus,
    RecordPluginErrorOptions
} from './runtime/host.js';
export { initializePluginHost, disposePluginHost, reloadPluginHost } from './runtime/bootstrap.js';
export { getRuntimePluginDirectories, setRuntimePluginDirectories } from './management/config.js';
export { getPluginRuntimeEntry, setPluginOptions, setPluginGrantedCapabilities } from './management/policy.js';
export { discoverPlugins, verifyPluginRecord } from './discovery/discovery.js';
export {
    getBuiltinPluginsDirectory,
    getPluginsDirectory,
    getPluginManagerDirectory,
    getPluginRegistryPath,
    getPluginCacheDirectory
} from './management/paths.js';
export { getPluginRecord, listPluginRecords } from './management/registry.js';
export {
    installPlugin,
    uninstallPlugin,
    listInstalledPlugins,
    setPluginEnabled,
    verifyInstalledPlugin
} from './management/manager.js';
export type {
    DiscoveredPluginCandidate,
    PluginDiscoveryConflict,
    PluginDiscoveryResult,
    PluginVerification
} from './discovery/discovery.js';
export type { PluginRegistryData, PluginRegistryRecord, PluginSourceKind } from './management/registry.js';
export {
    runPluginChatHeaders,
    runPluginChatParams,
    runPluginBeforeSkillInstall,
    runPluginAfterSkillInstall
} from './runtime/hooks.js';
export { runPluginBeforePermissionAsk, runPluginShellEnv } from './runtime/hooks.js';
export {
    applyPluginToolDefinitions,
    CompositeToolsetProvider,
    PluginToolsetProvider,
    combineToolsetProviders
} from './runtime/tool-provider.js';
export { syncPluginTuiCommands } from './runtime/commands.js';
export { formatPluginInstallError } from './management/errors.js';
