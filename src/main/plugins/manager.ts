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

/**
 * Plugin manager: handles install, uninstall, discovery, and loading of
 * OpenClaw-compatible channel plugins.
 */

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getAppDirectory } from '../utils/setting.js';
import { logger } from '../utils/logger.js';
import module from 'module';
import type {
    PluginManifest,
    PluginInstallRecord,
    PluginEntry,
    ChannelPlugin,
    OpenClawPluginApi,
    PluginLogger,
    PluginsConfig,
} from './types.js';

const EXTENSIONS_DIR_NAME = 'extensions';
const PLUGIN_MANIFEST = 'openclaw.plugin.json';
const INSTALLS_FILE = 'plugins.json';

function getExtensionsDir(): string {
    const dir = path.join(getAppDirectory(), EXTENSIONS_DIR_NAME);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function getInstallsFilePath(): string {
    return path.join(getExtensionsDir(), INSTALLS_FILE);
}

// ── Install records persistence ──────────────────────────────────────────────

function loadInstallRecords(): PluginInstallRecord[] {
    const filePath = getInstallsFilePath();
    if (!fs.existsSync(filePath)) return [];
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return [];
    }
}

function saveInstallRecords(records: PluginInstallRecord[]): void {
    fs.writeFileSync(getInstallsFilePath(), JSON.stringify(records, null, 2), 'utf-8');
}

// ── npm operations ───────────────────────────────────────────────────────────

function ensureExtensionPackageJson(): void {
    const pkgPath = path.join(getExtensionsDir(), 'package.json');
    if (!fs.existsSync(pkgPath)) {
        fs.writeFileSync(pkgPath, JSON.stringify({
            name: 'opendesk-extensions',
            private: true,
            version: '1.0.0',
            description: 'OpenDesk plugin extensions',
            type: 'module',
            dependencies: {
                zod: '^3.22.0',
            },
        }, null, 2), 'utf-8');
    }
}

/**
 * Ensure the openclaw shim is available in the extensions node_modules.
 * Generates the shim inline so plugins can resolve `openclaw/plugin-sdk`.
 */
function ensureOpenClawShim(): void {
    const shimTarget = path.join(getExtensionsDir(), 'node_modules', 'openclaw');
    if (fs.existsSync(path.join(shimTarget, 'package.json'))) {
        return;
    }
    logger.info('正在生成 openclaw 兼容层...');
    generateInlineShim(shimTarget);
}

function generatePluginSdkShimSource(): string {
    return `
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Helpers ──────────────────────────────────────────────────────────────────

export function createAccountListHelpers(channelId, configAdapter) {
  return {
    listAccountIds: (cfg) => configAdapter?.listAccountIds?.(cfg) ?? ['default'],
    resolveAccount: (cfg, id) => configAdapter?.resolveAccount?.(cfg, id) ?? cfg?.channels?.[channelId] ?? {},
    defaultAccountId: (cfg) => configAdapter?.defaultAccountId?.(cfg) ?? 'default',
  };
}

// ── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_ACCOUNT_ID = 'default';
export const PAIRING_APPROVED_MESSAGE = 'Your account has been approved.';
export const DEFAULT_GROUP_HISTORY_LIMIT = 50;
export const GROUP_POLICY_BLOCKED_LABEL = 'blocked';
export const CHANNEL_MESSAGE_ACTION_NAMES = { reply:'reply', react:'react', edit:'edit', delete:'delete' };
export const BLUEBUBBLES_ACTIONS = {};
export const BLUEBUBBLES_ACTION_NAMES = {};
export const BLUEBUBBLES_GROUP_ACTIONS = {};
export const ACP_ERROR_CODES = {};
export const WEBHOOK_ANOMALY_COUNTER_DEFAULTS = { windowMs: 60000, threshold: 100 };
export const WEBHOOK_RATE_LIMIT_DEFAULTS = { windowMs: 1000, maxRequests: 50 };

// ── Zod Schemas ──────────────────────────────────────────────────────────────

export const DmPolicySchema = z.enum(['open', 'allowlist']).default('open');
export const GroupPolicySchema = z.enum(['open', 'allowlist', 'blocked']).default('blocked');
export const DmConfigSchema = z.object({ enabled: z.boolean().default(true), policy: DmPolicySchema, allowFrom: z.array(z.string()).default([]) }).default({});
export const BlockStreamingCoalesceSchema = z.object({ enabled: z.boolean().default(false), intervalMs: z.number().default(1500) }).default({});
export const MarkdownTableModeSchema = z.enum(['native', 'code', 'none']).default('native');
export const MarkdownConfigSchema = z.object({ tableMode: MarkdownTableModeSchema }).default({});
export const TtsModeSchema = z.enum(['off', 'auto', 'always']).default('off');
export const TtsProviderSchema = z.enum(['openai', 'elevenlabs', 'azure']).default('openai');
export const TtsAutoSchema = z.object({ minLength: z.number().default(100) }).default({});
export const TtsConfigSchema = z.object({ mode: TtsModeSchema, provider: TtsProviderSchema, auto: TtsAutoSchema }).default({});
export const ReplyRuntimeConfigSchemaShape = { streaming: z.boolean().default(true), blockStreaming: BlockStreamingCoalesceSchema, markdown: MarkdownConfigSchema, tts: TtsConfigSchema };
export const ToolPolicySchema = z.enum(['auto', 'manual', 'disabled']).default('auto');
export const TelegramConfigSchema = z.object({}).passthrough();
export const DiscordConfigSchema = z.object({}).passthrough();
export const SlackConfigSchema = z.object({}).passthrough();
export function emptyPluginConfigSchema() { return z.object({}); }

// ── Account / Allow ──────────────────────────────────────────────────────────

export function normalizeAccountId(id) { return id || 'default'; }
export function normalizeAllowFrom(a) { return (Array.isArray(a) ? a : a ? [a] : []).map(s => s.toLowerCase()); }
export function requireOpenAllowFrom(a) { return normalizeAllowFrom(a); }
export function addWildcardAllowFrom(cfg, channelId) { return cfg; }
export function formatAllowFromLowercase(l) { return (l||[]).map(s=>s.toLowerCase()); }
export function isAllowedParsedChatSender(s, l) { return !l||!l.length||l.includes(String(s).toLowerCase()); }
export function isNormalizedSenderAllowed(s, l) { return !l||!l.length||l.includes(s); }

// ── Group / Policy ───────────────────────────────────────────────────────────

export function evaluateSenderGroupAccess() { return { allowed: true, reason: 'open' }; }
export function resolveSenderCommandAuthorization() { return { authorized: true }; }
export function resolveDefaultGroupPolicy() { return 'open'; }
export function resolveRuntimeGroupPolicy(p) { return p?.policy||'open'; }
export function resolveOpenProviderRuntimeGroupPolicy() { return 'open'; }
export function resolveAllowlistProviderRuntimeGroupPolicy() { return 'allowlist'; }
export function resetMissingProviderGroupPolicyFallbackWarningsForTesting() {}
export function warnMissingProviderGroupPolicyFallbackOnce() {}

// ── Config / Path ────────────────────────────────────────────────────────────

export function resolveChannelAccountConfigBasePath(c, a) { return 'channels.'+c+'.accounts.'+(a||'default'); }
export function resolveThreadSessionKeys(p) { return { sessionKey: (p?.channelId||'')+':'+(p?.accountId||'default')+':'+(p?.to||''), threadKey: p?.threadId }; }

// ── HTTP / Webhook ───────────────────────────────────────────────────────────

export function normalizePluginHttpPath(p) { return p?.startsWith('/')?p:('/'+(p||'')); }
export function registerPluginHttpRoute() {}
export function normalizeWebhookPath(p) { return p?.startsWith('/')?p:('/'+(p||'')); }
export function resolveWebhookPath(b, s) { return normalizeWebhookPath(b)+normalizeWebhookPath(s); }
export function applyBasicWebhookRequestGuards(app) { return app; }
export function installRequestBodyLimitGuard(app) { return app; }

// ── File / Lock ──────────────────────────────────────────────────────────────

export async function acquireFileLock() { return { release: async()=>{} }; }
export async function withFileLock(f, fn) { return await fn(); }
export function readJsonFileWithFallback(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return typeof fallback === 'function' ? fallback() : fallback; }
}
export async function withTempDownloadPath(fn) {
  const tmpDir = path.join(os.tmpdir(), 'opendesk-dl-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  try { return await fn(tmpDir); }
  finally { try { fs.rmSync(tmpDir, { recursive: true }); } catch {} }
}

// ── Secret Input ─────────────────────────────────────────────────────────────

export function hasConfiguredSecretInput(v) { return !!v && v !== '' && v !== null && v !== undefined; }
export function normalizeSecretInputString(v) { return typeof v === 'string' ? v : v?.id || ''; }
export function normalizeResolvedSecretInputString(v) { return typeof v === 'string' ? v : ''; }
export function buildSecretInputSchema() { return z.union([z.string(), z.object({ source: z.string(), provider: z.string(), id: z.string() })]); }

// ── Pairing ──────────────────────────────────────────────────────────────────

export function createScopedPairingAccess() { return { check: async()=>({allowed:true}), revoke: async()=>{} }; }
export function issuePairingChallenge() { return { code:'000000', expiresAt: new Date(Date.now()+300000) }; }
export function isDangerousNameMatchingEnabled() { return false; }
export function promptSingleChannelSecretInput() { return Promise.resolve(''); }
export function promptAccountId() { return Promise.resolve('default'); }

// ── Mention / Gating ────────────────────────────────────────────────────────

export function resolveMentionGatingWithBypass(opts) {
  return { allowed: true, reason: 'bypass' };
}

// ── Outbound / Delivery ──────────────────────────────────────────────────────

export function createNormalizedOutboundDeliverer(a) { return async(c)=>a?.sendText?.(c)??a?.sendPayload?.(c)??{delivered:false}; }
export function formatTextWithAttachmentLinks(t) { return t||''; }
export function normalizeOutboundReplyPayload(p) { return p||{}; }
export function resolveOutboundMediaUrls(m) { return m||[]; }
export async function sendMediaWithLeadingCaption() { return {delivered:false}; }
export function buildMediaPayload(p) { return {type:'media',...p}; }
export function buildAgentMediaPayload(p) { return p||{}; }
export function extractToolSend() { return null; }

// ── Channel Status ───────────────────────────────────────────────────────────

export function buildBaseChannelStatusSummary(p) { return { channelId: p?.channelId||'', accountId: p?.accountId||'default', online: false, statusText: 'unknown' }; }
export function createDefaultChannelRuntimeState(channelId, accountId) { return { channelId, accountId: accountId||'default', online: false, statusText: 'init' }; }

// ── History / Context ────────────────────────────────────────────────────────

export function buildPendingHistoryContextFromMap() { return ''; }
export function clearHistoryEntriesIfEnabled() {}
export function recordPendingHistoryEntryIfEnabled() {}

// ── Reply / Typing ───────────────────────────────────────────────────────────

export function createReplyPrefixContext() { return { prefix: '', suffix: '' }; }
export function createTypingCallbacks() { return { start: async()=>{}, stop: async()=>{} }; }
export function logTypingFailure() {}

// ── Dedup / Rate limit ───────────────────────────────────────────────────────

export function createDedupeCache(opts) { const s = new Set(); return { has: (k)=>s.has(k), add: (k)=>{s.add(k)}, delete: (k)=>{s.delete(k)}, clear: ()=>{s.clear()} }; }
export function createPersistentDedupe(opts) { return createDedupeCache(opts); }
export function createFixedWindowRateLimiter(opts) { return { check: ()=>({ allowed: true }), reset: ()=>{} }; }
export function createWebhookAnomalyTracker(opts) { return { record: ()=>{}, check: ()=>({ anomaly: false }), reset: ()=>{} }; }

// ── Network ──────────────────────────────────────────────────────────────────

export async function fetchWithSsrFGuard(url, opts) { return fetch(url, opts); }

// ── Docs / Onboarding ────────────────────────────────────────────────────────

export function formatDocsLink(p) { return 'https://docs.openclaw.dev' + (p || ''); }

// ── Platform integrations ────────────────────────────────────────────────────

export function handleSlackMessageAction() { return {handled:false}; }
export function autoBindSpawnedDiscordSubagent() {}
export function listThreadBindingsBySessionKey() { return []; }
export function unbindThreadBindingsBySessionKey() {}
export function getAcpRuntimeBackend() { return null; }
export function registerAcpRuntimeBackend() {}
export function requireAcpRuntimeBackend() { return null; }
export function unregisterAcpRuntimeBackend() {}
export class AcpRuntimeError extends Error { constructor(m,c) { super(m); this.code=c; } }
`.trim();
}

function generateInlineShim(shimTarget: string): void {
    fs.mkdirSync(path.join(shimTarget, 'plugin-sdk'), { recursive: true });

    fs.writeFileSync(path.join(shimTarget, 'package.json'), JSON.stringify({
        name: 'openclaw',
        version: '2026.3.0',
        type: 'module',
        exports: {
            '.': './index.js',
            './plugin-sdk': './plugin-sdk/index.js',
            './plugin-sdk/account-id': './plugin-sdk/account-id.js',
            './plugin-sdk/keyed-async-queue': './plugin-sdk/keyed-async-queue.js',
        },
    }, null, 2));

    fs.writeFileSync(path.join(shimTarget, 'index.js'),
        'export default {};\n');

    const sdkContent = generatePluginSdkShimSource();

    fs.writeFileSync(path.join(shimTarget, 'plugin-sdk', 'index.js'), sdkContent);

    fs.writeFileSync(path.join(shimTarget, 'plugin-sdk', 'account-id.js'), `
export const DEFAULT_ACCOUNT_ID = 'default';
export function normalizeAccountId(id) { return id || DEFAULT_ACCOUNT_ID; }
export function isDefaultAccountId(id) { return !id || id === DEFAULT_ACCOUNT_ID; }
export function parseAccountId(raw) { const p = String(raw||'').split(':'); return { channelId: p[0]||'', accountId: p[1]||DEFAULT_ACCOUNT_ID }; }
export function formatAccountId(c, a) { return c + ':' + (a||DEFAULT_ACCOUNT_ID); }
`.trim());

    fs.writeFileSync(path.join(shimTarget, 'plugin-sdk', 'keyed-async-queue.js'), `
export class KeyedAsyncQueue {
  constructor() { this._q = new Map(); }
  async enqueue(k, fn) { if(!this._q.has(k)) this._q.set(k,Promise.resolve()); const p=this._q.get(k); const n=p.then(()=>fn()).catch(()=>fn()); this._q.set(k,n.catch(()=>{})); return n; }
  has(k) { return this._q.has(k); }
  clear(k) { k ? this._q.delete(k) : this._q.clear(); }
}
export function createKeyedAsyncQueue() { return new KeyedAsyncQueue(); }
`.trim());
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Install a plugin from an npm spec (e.g. `@ynhcj/xiaoyi@latest`).
 */
export async function installPlugin(npmSpec: string): Promise<{ success: boolean; id?: string; error?: string }> {
    const extensionsDir = getExtensionsDir();
    ensureExtensionPackageJson();

    try {
        logger.info(`Installing plugin: ${npmSpec}`);

        // Install the npm package with --ignore-scripts for security
        execSync(`npm install ${npmSpec} --ignore-scripts --save`, {
            cwd: extensionsDir,
            stdio: 'pipe',
            timeout: 120000,
        });

        // Ensure the openclaw shim is in place
        ensureOpenClawShim();

        // Determine the installed package name
        const pkgName = extractPackageName(npmSpec);
        if (!pkgName) {
            return { success: false, error: `Could not determine package name from spec: ${npmSpec}` };
        }

        // Try to find the plugin manifest
        const pluginDir = path.join(extensionsDir, 'node_modules', pkgName);
        let manifest: PluginManifest = { id: pkgName };
        const manifestPath = path.join(pluginDir, PLUGIN_MANIFEST);
        if (fs.existsSync(manifestPath)) {
            try {
                manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            } catch {
                logger.warn(`Failed to parse ${PLUGIN_MANIFEST} for ${pkgName}`);
            }
        }

        // Also check the npm package.json for additional info
        const npmPkgPath = path.join(pluginDir, 'package.json');
        if (fs.existsSync(npmPkgPath)) {
            const npmPkg = JSON.parse(fs.readFileSync(npmPkgPath, 'utf-8'));
            if (!manifest.name) manifest.name = npmPkg.description || pkgName;
            if (!manifest.version) manifest.version = npmPkg.version;
        }

        // Save install record
        const records = loadInstallRecords();
        const existingIdx = records.findIndex(r => r.id === (manifest.id || pkgName));
        const record: PluginInstallRecord = {
            id: manifest.id || pkgName,
            npmSpec,
            installedAt: new Date().toISOString(),
            enabled: true,
            source: 'npm',
            path: pluginDir,
        };

        if (existingIdx >= 0) {
            records[existingIdx] = record;
        } else {
            records.push(record);
        }
        saveInstallRecords(records);

        logger.info(`Plugin installed: ${manifest.id || pkgName}`);
        return { success: true, id: manifest.id || pkgName };
    } catch (err: any) {
        const message = err?.stderr?.toString() || err?.message || String(err);
        logger.error(`Plugin install failed: ${message}`);
        return { success: false, error: message };
    }
}

/**
 * Uninstall a plugin by its id or npm package name.
 */
export async function uninstallPlugin(pluginId: string): Promise<{ success: boolean; error?: string }> {
    const extensionsDir = getExtensionsDir();
    const records = loadInstallRecords();
    const record = records.find(r => r.id === pluginId || r.npmSpec.startsWith(pluginId));

    if (!record) {
        return { success: false, error: `Plugin not found: ${pluginId}` };
    }

    try {
        const pkgName = extractPackageName(record.npmSpec) || pluginId;
        execSync(`npm uninstall ${pkgName}`, {
            cwd: extensionsDir,
            stdio: 'pipe',
            timeout: 60000,
        });

        const updatedRecords = records.filter(r => r.id !== record.id);
        saveInstallRecords(updatedRecords);

        logger.info(`Plugin uninstalled: ${pluginId}`);
        return { success: true };
    } catch (err: any) {
        const message = err?.stderr?.toString() || err?.message || String(err);
        logger.error(`Plugin uninstall failed: ${message}`);
        return { success: false, error: message };
    }
}

/**
 * List installed plugins.
 */
export function listInstalledPlugins(): PluginInstallRecord[] {
    return loadInstallRecords();
}

/**
 * Enable or disable a plugin.
 */
export function setPluginEnabled(pluginId: string, enabled: boolean): boolean {
    const records = loadInstallRecords();
    const record = records.find(r => r.id === pluginId);
    if (!record) return false;
    record.enabled = enabled;
    saveInstallRecords(records);
    return true;
}

/**
 * Load all enabled plugins and return their entries.
 * Channel plugins are extracted and returned separately.
 */
export async function loadPlugins(): Promise<PluginEntry[]> {
    const records = loadInstallRecords();
    const enabledRecords = records.filter(r => r.enabled);
    const entries: PluginEntry[] = [];

    // Make sure the shim is in place
    ensureOpenClawShim();

    for (const record of enabledRecords) {
        try {
            const entry = await loadSinglePlugin(record);
            if (entry) entries.push(entry);
        } catch (err: any) {
            logger.error(`Failed to load plugin ${record.id}: ${err?.message || err}`);
        }
    }

    return entries;
}

// ── Internal ─────────────────────────────────────────────────────────────────

/**
 * Resolve the entry point for a plugin.
 * Checks package.json openclaw.extensions, then main/module/exports, then index.{ts,js}.
 */
function resolvePluginEntryPoint(pluginDir: string): string | null {
    const pkgJsonPath = path.join(pluginDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) return null;

    let pkgJson: any;
    try { pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')); } catch { return null; }

    // openclaw.extensions field (e.g., ["./index.ts"])
    const extensions = pkgJson?.openclaw?.extensions;
    if (Array.isArray(extensions) && extensions.length > 0) {
        const entry = path.join(pluginDir, extensions[0]);
        if (fs.existsSync(entry)) return entry;
    }

    // Standard Node.js resolution: exports -> module -> main
    if (pkgJson.exports) {
        const root = typeof pkgJson.exports === 'string' ? pkgJson.exports
            : pkgJson.exports['.']?.import || pkgJson.exports['.']?.default || pkgJson.exports['.'];
        if (typeof root === 'string') {
            const entry = path.join(pluginDir, root);
            if (fs.existsSync(entry)) return entry;
        }
    }
    for (const field of ['module', 'main']) {
        if (pkgJson[field]) {
            const entry = path.join(pluginDir, pkgJson[field]);
            if (fs.existsSync(entry)) return entry;
        }
    }

    // Fallback: index.ts or index.js
    for (const name of ['index.ts', 'index.js']) {
        const entry = path.join(pluginDir, name);
        if (fs.existsSync(entry)) return entry;
    }
    return null;
}

/**
 * Compile a TypeScript plugin entry to a single ESM JavaScript bundle using esbuild.
 * Returns the path to the compiled .mjs file, or null if compilation failed.
 */
async function compileTypeScriptPlugin(entryPoint: string, pluginDir: string): Promise<string | null> {
    const compiledPath = path.join(pluginDir, '.opendesk-compiled.mjs');

    // Use cached compilation if source hasn't changed
    if (fs.existsSync(compiledPath)) {
        try {
            const compiledMtime = fs.statSync(compiledPath).mtimeMs;
            const sourceMtime = fs.statSync(entryPoint).mtimeMs;
            if (compiledMtime > sourceMtime) {
                return compiledPath;
            }
        } catch { /* recompile */ }
    }

    // Collect plugin's own dependencies to mark as external
    const pkgJsonPath = path.join(pluginDir, 'package.json');
    const externalPackages: string[] = [];
    try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        for (const depField of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
            if (pkgJson[depField]) {
                externalPackages.push(...Object.keys(pkgJson[depField]));
            }
        }
    } catch { /* best effort */ }

    // Try dynamic import of esbuild
    try {
        const esbuild = await import('esbuild');
        await esbuild.build({
            entryPoints: [entryPoint],
            outfile: compiledPath,
            bundle: true,
            format: 'esm',
            platform: 'node',
            target: 'node20',
            external: externalPackages,
            logLevel: 'silent',
        });
        logger.info(`Compiled TypeScript plugin: ${entryPoint}`);
        return compiledPath;
    } catch (err: any) {
        logger.warn(`esbuild API not available (${err?.message}), trying npx esbuild...`);
    }

    // Fallback: use npx esbuild CLI
    try {
        const externals = externalPackages.map(p => `--external:${p}`).join(' ');
        execSync(
            `npx esbuild "${entryPoint}" --bundle --format=esm --platform=node --target=node20 ${externals} --outfile="${compiledPath}"`,
            { stdio: 'pipe', timeout: 30000 },
        );
        logger.info(`Compiled TypeScript plugin via CLI: ${entryPoint}`);
        return compiledPath;
    } catch (err: any) {
        logger.error(`Failed to compile TypeScript plugin: ${err?.message || err}`);
    }

    return null;
}

async function loadSinglePlugin(record: PluginInstallRecord): Promise<PluginEntry | null> {
    const extensionsDir = getExtensionsDir();
    const pkgName = extractPackageName(record.npmSpec) || record.id;
    const pluginDir = path.join(extensionsDir, 'node_modules', pkgName);

    if (!fs.existsSync(pluginDir)) {
        logger.warn(`Plugin directory not found: ${pluginDir}`);
        return null;
    }

    // Load manifest
    let manifest: PluginManifest = { id: record.id };
    const manifestPath = path.join(pluginDir, PLUGIN_MANIFEST);
    if (fs.existsSync(manifestPath)) {
        try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        } catch { /* use defaults */ }
    }

    // Resolve and load the plugin module
    let pluginModule: any;
    const entryPoint = resolvePluginEntryPoint(pluginDir);
    const isTypeScript = entryPoint?.endsWith('.ts');

    if (isTypeScript && entryPoint) {
        // TypeScript plugins: compile to JS first, then import
        const compiledPath = await compileTypeScriptPlugin(entryPoint, pluginDir);
        const importTarget = compiledPath || entryPoint;

        try {
            const fileUrl = 'file://' + importTarget;
            pluginModule = await import(fileUrl);
            if (pluginModule && pluginModule.default) {
                pluginModule = pluginModule.default;
            }
            logger.info(`Loaded TypeScript plugin: ${pkgName} (${importTarget})`);
        } catch (err: any) {
            logger.error(`Failed to import TypeScript plugin ${pkgName}: ${err?.message || err}`);
            return null;
        }
    } else {
        // JavaScript plugins: use createRequire
        const require = module.createRequire(path.join(extensionsDir, 'package.json'));
        try {
            pluginModule = require(pkgName);
            if (pluginModule && pluginModule.default) {
                pluginModule = pluginModule.default;
            }
        } catch (err: any) {
            logger.error(`Failed to require plugin ${pkgName}: ${err?.message || err}`);
            return null;
        }
    }

    const entry: PluginEntry = {
        id: manifest.id || record.id,
        manifest,
        installRecord: record,
        module: pluginModule,
    };

    // Execute the plugin's register function with our API shim
    let channelPlugin: ChannelPlugin | null = null;
    const api = createPluginApi(entry, (cp: ChannelPlugin) => {
        channelPlugin = cp;
    });

    try {
        if (typeof pluginModule === 'function') {
            await pluginModule(api);
        } else if (typeof pluginModule?.register === 'function') {
            await pluginModule.register(api);
        } else {
            logger.warn(`Plugin ${record.id} does not export a register function`);
        }
    } catch (err: any) {
        logger.error(`Plugin ${record.id} registration failed: ${err?.message || err}`);
    }

    if (channelPlugin) {
        entry.channelPlugin = channelPlugin;
    }

    return entry;
}

function createPluginApi(
    entry: PluginEntry,
    onChannelRegistered: (cp: ChannelPlugin) => void,
): OpenClawPluginApi {
    const pluginLogger: PluginLogger = {
        info: (...args: any[]) => logger.info(`[plugin:${entry.id}]`, ...args),
        warn: (...args: any[]) => logger.warn(`[plugin:${entry.id}]`, ...args),
        error: (...args: any[]) => logger.error(`[plugin:${entry.id}]`, ...args),
        debug: (...args: any[]) => logger.info(`[plugin:${entry.id}][debug]`, ...args),
    };

    return {
        id: entry.id,
        name: entry.manifest.name || entry.id,
        version: entry.manifest.version,
        description: entry.manifest.description,
        source: 'opendesk',
        config: {},
        pluginConfig: {},
        runtime: {
            platform: 'opendesk',
        },
        logger: pluginLogger,
        registerTool: (_tool: any, _opts?: any) => {
            pluginLogger.debug('registerTool (skipped in OpenDesk)');
        },
        registerHook: (_events: any, _handler: any, _opts?: any) => {
            pluginLogger.debug('registerHook (skipped in OpenDesk)');
        },
        registerHttpHandler: (_handler: any) => {
            pluginLogger.debug('registerHttpHandler (skipped in OpenDesk)');
        },
        registerHttpRoute: (_params: any) => {
            pluginLogger.debug('registerHttpRoute (skipped in OpenDesk)');
        },
        registerChannel: (registration: any) => {
            pluginLogger.info('registerChannel called');
            const plugin = registration?.plugin || registration;
            if (plugin && plugin.id) {
                onChannelRegistered(plugin as ChannelPlugin);
            }
        },
        registerGatewayMethod: (_method: string, _handler: any) => {
            pluginLogger.debug('registerGatewayMethod (skipped in OpenDesk)');
        },
        registerCli: (_registrar: any, _opts?: any) => {
            pluginLogger.debug('registerCli (skipped in OpenDesk)');
        },
        registerService: (_service: any) => {
            pluginLogger.debug('registerService (skipped in OpenDesk)');
        },
        registerProvider: (_provider: any) => {
            pluginLogger.debug('registerProvider (skipped in OpenDesk)');
        },
        registerCommand: (_command: any) => {
            pluginLogger.debug('registerCommand (skipped in OpenDesk)');
        },
        resolvePath: (input: string) => path.resolve(getAppDirectory(), input),
        on: (_hookName: string, _handler: any, _opts?: any) => {
            pluginLogger.debug(`on(${_hookName}) (skipped in OpenDesk)`);
        },
    };
}

function extractPackageName(npmSpec: string): string | null {
    // Handle specs like @scope/name@version, name@version, @scope/name, name
    const match = npmSpec.match(/^(@[^@/]+\/[^@/]+|[^@/]+)(?:@.*)?$/);
    return match ? match[1] : null;
}
