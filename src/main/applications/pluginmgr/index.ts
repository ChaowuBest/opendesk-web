/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

export {
    definePlugin,
    tool,
    OPENDESK_PLUGIN_API_VERSION,
    OPENDESK_PLUGIN_CAPABILITIES
} from '../../../../packages/plugin/src/index.js';
export type {
    OpenDeskPlugin,
    PluginApplicationEvent,
    PluginApplicationEventCallback,
    PluginApplicationEventFilter,
    PluginCapability,
    PluginChatHeadersInput,
    PluginChatHeadersOutput,
    PluginChatMessageInput,
    PluginChatMessageOutput,
    PluginChatParams,
    PluginSkillLoadContext,
    PluginSkillLoadBeforeOutput,
    PluginSkillInstallContext,
    PluginSkillInstallBeforeOutput,
    PluginSkillInstallAfterContext,
    PluginCommandContext,
    PluginCommandDefinition,
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
    PluginStaticContributions,
    PluginMcpRemoteServerDefinition,
    PluginMcpServerDefinition,
    PluginMcpStdioServerDefinition
} from '../../../../packages/plugin/src/index.js';
export { PluginHost, getPluginHost } from './runtime/host.js';
export type {
    ActivatePluginOptions,
    PluginDiagnostic,
    PluginHostEntry,
    PluginStatus,
    RecordPluginErrorOptions
} from './runtime/host.js';
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
export { formatPluginInstallError } from './management/errors.js';
