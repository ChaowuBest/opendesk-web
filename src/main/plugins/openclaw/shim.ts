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
 * OpenClaw compatibility shim generator.
 * Generates the `openclaw/plugin-sdk` shim that allows OpenClaw-compatible
 * plugins to run within OpenDesk's plugin system.
 */

import path from 'path';
import fs from 'fs';
import { logger } from '../../utils/logger.js';

export const PAIRING_REPLY_TEMPLATE = `为了让消息收发更加安全，你得先在OpenDesk中批准配对请求 😉
请求ID: {idLine}
配对码: {code}

你可以在OpenDesk中直接问：现在有哪些设备配对请求？或者直接说：批准配对码尾号是{codeSuffix}的请求。`.trim();

/**
 * Ensure the openclaw shim is available in the extensions node_modules.
 * Generates the shim inline so plugins can resolve `openclaw/plugin-sdk`.
 */
const SHIM_VERSION = '25';

export function ensureOpenClawShim(extensionsDir: string): void {
    const shimTarget = path.join(extensionsDir, 'node_modules', 'openclaw');
    const versionFile = path.join(shimTarget, '.shim-version');
    const requiredFiles = [
        'package.json',
        'plugin-sdk/index.js',
        'plugin-sdk/account-id.js',
        'plugin-sdk/keyed-async-queue.js',
        'plugin-sdk/feishu.js',
        'plugin-sdk/compat.js',
        'plugin-sdk/core.js',
        'plugin-sdk/channel-entry-contract.js'
    ];
    const allExist = requiredFiles.every((f) => fs.existsSync(path.join(shimTarget, f)));
    const versionMatch = fs.existsSync(versionFile) && fs.readFileSync(versionFile, 'utf-8').trim() === SHIM_VERSION;
    if (allExist && versionMatch) {
        return;
    }
    logger.info('正在生成 openclaw 兼容层...');
    generateInlineShim(shimTarget);
    fs.writeFileSync(versionFile, SHIM_VERSION);
}

/**
 * Generate the complete inline shim at the target directory.
 */
function generateInlineShim(shimTarget: string): void {
    fs.mkdirSync(path.join(shimTarget, 'plugin-sdk'), { recursive: true });

    // Generate package.json with exports.
    // All plugin-sdk sub-paths that don't have a dedicated shim file
    // fall back to the main plugin-sdk/index.js which re-exports stubs
    // for every symbol plugins might reference.
    const dedicatedShims: Record<string, string> = {
        './plugin-sdk/account-id': './plugin-sdk/account-id.js',
        './plugin-sdk/keyed-async-queue': './plugin-sdk/keyed-async-queue.js',
        './plugin-sdk/feishu': './plugin-sdk/feishu.js',
        './plugin-sdk/compat': './plugin-sdk/compat.js',
        './plugin-sdk/core': './plugin-sdk/core.js',
        './plugin-sdk/channel-entry-contract': './plugin-sdk/channel-entry-contract.js'
    };
    const allPluginSdkSubpaths = [
        'account-helpers',
        'account-id',
        'account-resolution',
        'acp-runtime',
        'agent-media-payload',
        'agent-runtime',
        'allow-from',
        'allowlist-config-edit',
        'approval-auth-runtime',
        'bluebubbles',
        'boolean-param',
        'channel-actions',
        'channel-config-helpers',
        'channel-config-primitives',
        'channel-config-schema',
        'channel-config-writes',
        'channel-contract',
        'channel-core',
        'channel-entry-contract',
        'channel-feedback',
        'channel-inbound',
        'channel-ingress-runtime',
        'channel-lifecycle',
        'channel-message',
        'channel-pairing',
        'channel-policy',
        'channel-reply-pipeline',
        'channel-runtime',
        'channel-secret-basic-runtime',
        'channel-send-result',
        'channel-setup',
        'channel-status',
        'channel-streaming',
        'channel-targets',
        'cli-runtime',
        'command-auth',
        'command-primitives-runtime',
        'config-runtime',
        'context-visibility-runtime',
        'conversation-runtime',
        'core',
        'device-bootstrap',
        'diagnostics-otel',
        'diffs',
        'directory-runtime',
        'discord',
        'discord-core',
        'error-runtime',
        'extension-shared',
        'feishu',
        'gateway-runtime',
        'googlechat',
        'group-access',
        'hook-runtime',
        'image-generation',
        'imessage',
        'imessage-core',
        'infra-runtime',
        'interactive-runtime',
        'irc',
        'json-store',
        'keyed-async-queue',
        'lazy-runtime',
        'line',
        'line-core',
        'llm-task',
        'markdown-table-runtime',
        'matrix',
        'matrix-runtime-heavy',
        'matrix-runtime-shared',
        'mattermost',
        'media-mime',
        'media-runtime',
        'media-understanding',
        'media-understanding-runtime',
        'memory-core',
        'memory-lancedb',
        'models-provider-runtime',
        'msteams',
        'nextcloud-talk',
        'nostr',
        'ollama-setup',
        'outbound-runtime',
        'persistent-dedupe',
        'plugin-entry',
        'plugin-runtime',
        'process-runtime',
        'provider-auth',
        'provider-auth-api-key',
        'provider-auth-login',
        'provider-catalog',
        'provider-env-vars',
        'provider-google',
        'provider-models',
        'provider-onboard',
        'provider-setup',
        'provider-stream',
        'provider-usage',
        'provider-web-search',
        'provider-zai-endpoint',
        'reply-history',
        'reply-payload',
        'reply-runtime',
        'request-url',
        'routing',
        'runtime',
        'runtime-env',
        'runtime-group-policy',
        'runtime-store',
        'sandbox',
        'secret-input',
        'security-runtime',
        'self-hosted-provider-setup',
        'session-store-runtime',
        'setup',
        'setup-adapter-runtime',
        'setup-runtime',
        'setup-tools',
        'signal',
        'slack',
        'slack-core',
        'speech',
        'speech-runtime',
        'ssrf-runtime',
        'state-paths',
        'status-helpers',
        'string-coerce-runtime',
        'telegram',
        'telegram-core',
        'temp-path',
        'testing',
        'text-chunking',
        'text-runtime',
        'thread-bindings-runtime',
        'thread-ownership',
        'tlon',
        'tool-send',
        'twitch',
        'voice-call',
        'web-media',
        'webhook-ingress',
        'webhook-path',
        'webhook-request-guards',
        'whatsapp-core',
        'whatsapp-shared',
        'windows-spawn',
        'zalo',
        'zalouser'
    ];
    const exports: Record<string, string> = {
        '.': './index.js',
        './plugin-sdk': './plugin-sdk/index.js',
        ...dedicatedShims
    };
    for (const sub of allPluginSdkSubpaths) {
        const key = `./plugin-sdk/${sub}`;
        if (!exports[key]) {
            exports[key] = './plugin-sdk/index.js';
        }
    }
    fs.writeFileSync(
        path.join(shimTarget, 'package.json'),
        JSON.stringify(
            {
                name: 'openclaw',
                version: '2026.3.0',
                type: 'module',
                exports
            },
            null,
            2
        )
    );

    // Generate main index.js
    fs.writeFileSync(path.join(shimTarget, 'index.js'), 'export default {};\n');

    // Generate plugin-sdk/index.js with full shim source
    const sdkContent = generatePluginSdkShimSource();
    fs.writeFileSync(path.join(shimTarget, 'plugin-sdk', 'index.js'), sdkContent);

    // Generate plugin-sdk/account-id.js
    fs.writeFileSync(path.join(shimTarget, 'plugin-sdk', 'account-id.js'), generateAccountIdShim());

    // Generate plugin-sdk/keyed-async-queue.js
    fs.writeFileSync(path.join(shimTarget, 'plugin-sdk', 'keyed-async-queue.js'), generateKeyedAsyncQueueShim());

    // Generate plugin-sdk/feishu.js
    fs.writeFileSync(path.join(shimTarget, 'plugin-sdk', 'feishu.js'), generateFeishuShim());

    // Generate plugin-sdk/compat.js
    fs.writeFileSync(path.join(shimTarget, 'plugin-sdk', 'compat.js'), generateCompatShim());

    // Generate plugin-sdk/core.js
    fs.writeFileSync(path.join(shimTarget, 'plugin-sdk', 'core.js'), generateCoreShim());

    // Generate plugin-sdk/channel-entry-contract.js
    fs.writeFileSync(
        path.join(shimTarget, 'plugin-sdk', 'channel-entry-contract.js'),
        generateChannelEntryContractShim()
    );
}

/**
 * Generate the main plugin-sdk shim source code.
 */
function generatePluginSdkShimSource(): string {
    return `
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';

// getPlatform is exposed on globalThis by the host application (setPlatform in platforms/base.ts).
// This avoids a brittle file:// import back into the bundled app.
const getPlatform = globalThis.__opendesk_getPlatform;

// ── Helpers ──────────────────────────────────────────────────────────────────

export function createAccountListHelpers(channelKey, options) {
  function listConfiguredAccountIds(cfg) {
    const channel = cfg?.channels?.[channelKey];
    const accounts = channel?.accounts;
    if (!accounts || typeof accounts !== 'object') return [];
    return Object.keys(accounts).filter(k => k !== '__proto__' && k !== 'constructor' && k !== 'prototype');
  }
  function listAccountIds(cfg) {
    const configured = listConfiguredAccountIds(cfg);
    return configured.length > 0 ? configured : ['default'];
  }
  function resolveDefaultAccountId(cfg) {
    const channel = cfg?.channels?.[channelKey];
    const preferred = channel?.defaultAccount;
    if (!preferred) {
      const ids = listAccountIds(cfg);
      return ids[0] || 'default';
    }
    if (options?.allowUnlistedDefaultAccount) return String(preferred);
    const ids = listAccountIds(cfg);
    return ids.includes(String(preferred)) ? String(preferred) : ids[0] || 'default';
  }
  return { listConfiguredAccountIds, listAccountIds, resolveDefaultAccountId };
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
export const AllowFromEntrySchema = z.union([z.string(), z.number()]);
export const AllowFromListSchema = z.array(AllowFromEntrySchema).optional();
export function buildNestedDmConfigSchema() {
  return z.object({ enabled: z.boolean().optional(), policy: DmPolicySchema.optional(), allowFrom: AllowFromListSchema }).optional();
}
export function buildCatchallMultiAccountChannelSchema(accountSchema) {
  return accountSchema.extend({ accounts: z.object({}).catchall(accountSchema).optional(), defaultAccount: z.string().optional() });
}
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
export function normalizeOptionalAccountId(id) { const trimmed = (id ?? '').trim(); return trimmed ? trimmed.toLowerCase() : undefined; }
export function normalizeAllowFrom(a) { return (Array.isArray(a) ? a : a ? [a] : []).map(s => s.toLowerCase()); }
export function requireOpenAllowFrom(a) { return normalizeAllowFrom(a); }
export function addWildcardAllowFrom(cfg, channelId) { return cfg; }
export function formatAllowFromLowercase(l) { return (l||[]).map(s=>s.toLowerCase()); }
export function isAllowedParsedChatSender(s, l) { return !l||!l.length||l.includes(String(s).toLowerCase()); }
export function isNormalizedSenderAllowed(s, l) { return !l||!l.length||l.includes(s); }

// ── Group / Policy ───────────────────────────────────────────────────────────

export function evaluateSenderGroupAccess() { return { allowed: true, reason: 'open' }; }
export function resolveSenderCommandAuthorization() { return { authorized: true }; }
export async function resolveSenderCommandAuthorizationWithRuntime() { return { senderAllowedForCommands: true, commandAuthorized: true }; }
export function resolveDefaultGroupPolicy() { return 'open'; }
export function resolveRuntimeGroupPolicy(p) { return p?.policy||'open'; }
export function resolveOpenProviderRuntimeGroupPolicy() { return { groupPolicy: 'open' }; }
export function resolveAllowlistProviderRuntimeGroupPolicy(p) { return { groupPolicy: p?.groupPolicy || 'allowlist' }; }
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
  try { return { value: JSON.parse(fs.readFileSync(filePath, 'utf-8')) }; } catch { return { value: typeof fallback === 'function' ? fallback() : fallback }; }
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
export function normalizeResolvedSecretInputString(v) { if (typeof v === 'string') return v; if (v && typeof v === 'object' && 'value' in v) { const raw = v.value; return typeof raw === 'string' ? raw : ''; } return ''; }
export function buildSecretInputSchema() { return z.union([z.string(), z.object({ source: z.string(), provider: z.string(), id: z.string() })]); }

// ── Pairing ─────────────────────────────────────────────────────────────────
// buildPairingReply uses PAIRING_REPLY_TEMPLATE (exported from the top of
// shim.ts). The same template is also imported by api.ts for the runtime's
// channel.pairing.buildPairingReply, ensuring a single source of truth.

const _PAIRING_TPL = ${JSON.stringify(PAIRING_REPLY_TEMPLATE)};
export function buildPairingReply({ channel, idLine, code } = {}) {
  const codeSuffix = code ? String(code).slice(-4) : '';
  return _PAIRING_TPL
    .replace('{idLine}', idLine || '')
    .replace('{code}', code || '')
    .replace('{codeSuffix}', codeSuffix);
}

// createScopedPairingAccess: wraps core.channel.pairing with pre-bound
// channel + accountId so callers don't repeat them on every call.
// Real SDK signature: { accountId, readAllowFromStore, readStoreForDmPolicy, upsertPairingRequest }

export function createScopedPairingAccess({ core, channel, accountId } = {}) {
  const ch = channel || 'unknown';
  const acc = accountId || 'default';
  const p = core?.channel?.pairing;

  return {
    accountId: acc,
    readAllowFromStore: async () => {
      if (p?.readAllowFromStore) return p.readAllowFromStore({ channel: ch, accountId: acc });
      return [];
    },
    readStoreForDmPolicy: async (provider, acctId) => {
      if (p?.readAllowFromStore) return p.readAllowFromStore({ channel: provider || ch, accountId: acctId || acc });
      return [];
    },
    upsertPairingRequest: async (input) => {
      if (p?.upsertPairingRequest) return p.upsertPairingRequest({ channel: ch, accountId: acc, id: input?.id, meta: input?.meta });
      return { code: String(Math.floor(100000 + Math.random() * 900000)), created: true };
    },
  };
}

// issuePairingChallenge: shared pairing challenge issuance for DM pairing
// policy pathways. Calls upsertPairingRequest to persist the request (and
// obtain its code), then sends the challenge text via sendPairingReply.
// Returns { created, code }.

export async function issuePairingChallenge(params) {
  if (!params) return { created: false };
  let code;
  let created = false;
  try {
    const result = await params.upsertPairingRequest({ id: params.senderId, meta: params.meta });
    code = result?.code;
    created = result?.created ?? false;
  } catch {
    return { created: false };
  }
  if (!code) return { created, code };
  if (created) {
    try { params.onCreated?.({ code }); } catch {}
  }
  if (params.sendPairingReply) {
    const text = typeof params.buildReplyText === 'function'
      ? params.buildReplyText({ code, senderIdLine: params.senderIdLine })
      : buildPairingReply({ channel: params.channel, idLine: params.senderIdLine, code });
    try {
      await params.sendPairingReply(text);
    } catch (err) {
      try { params.onReplyError?.(err); } catch {}
    }
  }
  return { created, code };
}
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
export function resolveOutboundMediaUrls(p) { const u=[]; if(p?.mediaUrl)u.push(p.mediaUrl); if(p?.mediaUrls)u.push(...p.mediaUrls); return u.filter(Boolean); }
export async function sendMediaWithLeadingCaption(params) {
  if (!params?.mediaUrls?.length) return false;
  let first = true;
  for (const mediaUrl of params.mediaUrls) {
    const caption = first ? params.caption : undefined;
    first = false;
    try { await params.send({ mediaUrl, caption }); }
    catch (error) { if (params.onError) { params.onError(error, mediaUrl); continue; } throw error; }
  }
  return true;
}
export function buildMediaPayload(p) { return {type:'media',...p}; }
export function buildAgentMediaPayload(mediaList) {
  if (!Array.isArray(mediaList) || mediaList.length === 0) return {};
  const first = mediaList[0];
  const mediaPaths = mediaList.map((m) => m.path);
  const mediaTypes = mediaList.map((m) => m.contentType).filter(Boolean);
  return {
    MediaPath: first?.path,
    MediaType: first?.contentType ?? undefined,
    MediaUrl: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}
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

export function createDedupeCache(opts) {
  const m = new Map();
  const ttl = opts?.ttlMs || 0;
  const maxSize = opts?.maxSize || 10000;
  function prune() { if (ttl <= 0) return; const now = Date.now(); for (const [k,v] of m) { if (now - v > ttl) m.delete(k); } }
  function trim() { while (m.size > maxSize) { const first = m.keys().next().value; m.delete(first); } }
  return {
    has: (k) => { prune(); return m.has(k); },
    check: (k) => { prune(); if (m.has(k)) return true; m.set(k, Date.now()); trim(); return false; },
    peek: (k) => { prune(); return m.has(k); },
    add: (k) => { m.set(k, Date.now()); trim(); },
    record: (k) => { m.set(k, Date.now()); trim(); },
    delete: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
    size: () => m.size,
  };
}
export function createPersistentDedupe(opts) {
  const memory = createDedupeCache({ ttlMs: opts?.ttlMs, maxSize: opts?.memoryMaxSize || 1000 });
  const resolvePath = opts?.resolveFilePath;
  return {
    checkAndRecord: async (key, options) => {
      if (memory.has(key)) return false;
      memory.add(key);
      if (resolvePath && options?.namespace) {
        try {
          const fp = resolvePath(options.namespace);
          const dir = path.dirname(fp);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          let data = {};
          try { data = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch {}
          if (data[key]) return false;
          data[key] = Date.now();
          const maxEntries = opts?.fileMaxEntries || 10000;
          const keys = Object.keys(data);
          if (keys.length > maxEntries) { for (const old of keys.slice(0, keys.length - maxEntries)) delete data[old]; }
          fs.writeFileSync(fp, JSON.stringify(data), 'utf-8');
        } catch (e) { options?.onDiskError?.(e); }
      }
      return true;
    },
    warmup: async (namespace, onError) => {
      if (!resolvePath) return 0;
      try {
        const fp = resolvePath(namespace);
        if (!fs.existsSync(fp)) return 0;
        const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
        const now = Date.now();
        const ttl = opts?.ttlMs || 0;
        let count = 0;
        for (const [k, v] of Object.entries(data)) {
          if (ttl > 0 && now - Number(v) >= ttl) continue;
          memory.add(k);
          count++;
        }
        return count;
      } catch (e) { onError?.(e); return 0; }
    },
    has: (k) => memory.has(k),
    check: (k) => memory.check(k),
    peek: (k) => memory.peek(k),
    clear: () => memory.clear(),
  };
}
export function createFixedWindowRateLimiter(opts) {
  const windows = new Map();
  const windowMs = opts?.windowMs || 60000;
  const maxReq = opts?.maxRequests || 100;
  return {
    check: (key, nowMs) => { const now = nowMs || Date.now(); const w = windows.get(key); if (!w || now - w.start >= windowMs) { windows.set(key, { start: now, count: 1 }); return { allowed: true }; } w.count++; return { allowed: w.count <= maxReq }; },
    isRateLimited: (key, nowMs) => { const now = nowMs || Date.now(); const w = windows.get(key); if (!w || now - w.start >= windowMs) return false; return w.count > maxReq; },
    reset: () => { windows.clear(); },
    clear: () => { windows.clear(); },
    size: () => windows.size,
  };
}
export function createWebhookAnomalyTracker(opts) {
  const counts = new Map();
  return {
    record: (p) => { const k = p?.key || ''; const c = (counts.get(k) || 0) + 1; counts.set(k, c); if (opts?.logEvery && c % opts.logEvery === 0 && p?.message) { (p.log || console.log)(p.message(c)); } },
    check: () => ({ anomaly: false }),
    reset: () => { counts.clear(); },
    clear: () => { counts.clear(); },
  };
}

// ── Network ──────────────────────────────────────────────────────────────────

export async function fetchWithSsrFGuard(url, opts) { return getPlatform().fetch(url, opts); }

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

// ── Additional constants ─────────────────────────────────────────────────────

export const SILENT_REPLY_TOKEN = '__SILENT__';
export const DEFAULT_WEBHOOK_BODY_TIMEOUT_MS = 30000;
export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 10 * 1024 * 1024;
export const DM_GROUP_ACCESS_REASON = 'dm';
export const WEBHOOK_ANOMALY_STATUS_CODES = [429, 500, 502, 503, 504];
export const WEBHOOK_BODY_READ_DEFAULTS = { timeoutMs: 30000, maxBytes: 10 * 1024 * 1024 };
export const WEBHOOK_IN_FLIGHT_DEFAULTS = { maxConcurrent: 50 };
export const SecretInputSchema = z.union([z.string(), z.object({ source: z.string(), provider: z.string(), id: z.string() })]);
export const GoogleChatConfigSchema = z.object({}).passthrough();
export const IMessageConfigSchema = z.object({}).passthrough();
export const WhatsAppConfigSchema = z.object({}).passthrough();
export const LineConfigSchema = z.object({}).passthrough();
export const MSTeamsConfigSchema = z.object({}).passthrough();
export const SignalConfigSchema = z.object({}).passthrough();
export class RequestBodyLimitError extends Error { constructor(m) { super(m); this.name='RequestBodyLimitError'; } }
export class SsrFBlockedError extends Error { constructor(m) { super(m); this.name='SsrFBlockedError'; } }
export class KeyedAsyncQueue {
  constructor() { this.tails = new Map(); }
  getTailMapForTesting() { return this.tails; }
  enqueue(key, task, hooks) {
    return enqueueKeyedTask({ tails: this.tails, key, task, ...(hooks ? { hooks } : {}) });
  }
}
export function enqueueKeyedTask(params) {
  params.hooks?.onEnqueue?.();
  const current = (params.tails.get(params.key) ?? Promise.resolve()).catch(() => void 0).then(params.task).finally(() => { params.hooks?.onSettle?.(); });
  const tail = current.then(() => void 0, () => void 0);
  params.tails.set(params.key, tail);
  tail.finally(() => { if (params.tails.get(params.key) === tail) params.tails.delete(params.key); });
  return current;
}

// ── Channel status (extended) ────────────────────────────────────────────────

export function buildProbeChannelStatusSummary(p) { return { channelId: p?.channelId||'', accountId: p?.accountId||'default', online: false, statusText: 'probe' }; }
export function buildRuntimeAccountStatusSnapshot(p) { return { channelId: p?.channelId||'', accountId: p?.accountId||'default', online: false, statusText: 'unknown', ...(p||{}) }; }
export function buildBaseAccountStatusSnapshot(p) { return { channelId: p?.channelId||'', accountId: p?.accountId||'default', online: false, statusText: 'unknown' }; }
export function buildComputedAccountStatusSnapshot(p) { return buildBaseAccountStatusSnapshot(p); }
export function buildTokenChannelStatusSummary(p) { return buildBaseChannelStatusSummary(p); }
export function buildChannelSendResult(p) { return { delivered: false, ...(p||{}) }; }

// ── Config / Channel (extended) ──────────────────────────────────────────────

export function evaluateSenderGroupAccessForPolicy() { return { allowed: true, reason: 'open' }; }
export function mergeAllowFromEntries(...lists) { return lists.flat().filter(Boolean); }
export function normalizeAgentId(id) { return String(id || 'default'); }
export function normalizeChannelSlug(s) { return String(s||'').toLowerCase().replace(/[^a-z0-9_-]/g, '-'); }
export function setTopLevelChannelAllowFrom(cfg, channelId, entries) { return cfg; }
export function setTopLevelChannelDmPolicyWithAllowFrom(cfg, channelId, policy, entries) { return cfg; }
export function setTopLevelChannelGroupPolicy(cfg, channelId, policy) { return cfg; }
export function splitOnboardingEntries(entries) { return { valid: entries || [], invalid: [] }; }
export function buildSingleChannelSecretPromptState() { return { prompted: false, value: '' }; }
export function buildChannelConfigSchema(shape) { return z.object(shape || {}); }
export function buildChannelKeyCandidates(channelId) { return [channelId]; }
export function listConfiguredAccountIds(cfg, channelId) { return ['default']; }

// ── Misc utilities ───────────────────────────────────────────────────────────

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
export function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
export function safeParseJson(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }
export function stripAnsi(s) { return String(s||'').replace(/\\x1B\\[[0-9;]*[a-zA-Z]/g, ''); }
export function stripMarkdown(s) { return String(s||''); }
export function isSilentReplyText(t) { return t === '__SILENT__'; }
export function isTruthyEnvValue(v) { return v === '1' || v === 'true' || v === 'yes'; }
export function resolveTimezone(tz) { return tz || 'UTC'; }
export function formatUtcTimestamp(d) { return (d || new Date()).toISOString(); }
export function formatZonedTimestamp(d) { return (d || new Date()).toISOString(); }
export function formatErrorMessage(e) { return e?.message || String(e || 'Unknown error'); }
export function redactSensitiveText(t) { return t || ''; }
export function rawDataToString(d) { return typeof d === 'string' ? d : JSON.stringify(d); }
export function writeJsonFileAtomically(fp, data) { fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8'); }
export function assertSecretInputResolved() {}
export function isSecretRef(v) { return v && typeof v === 'object' && 'source' in v; }
export function isRequestBodyLimitError(e) { return e instanceof RequestBodyLimitError; }
export function isJsonContentType(ct) { return /application\\/json/i.test(ct || ''); }
export function jsonResult(data) { return { status: 200, body: data }; }
export function resolveRuntimeEnv() { return {}; }
export function resolveRuntimeEnvWithUnavailableExit() { return {}; }
export function resolvePreferredOpenClawTmpDir() { return os.tmpdir(); }
export function createLoggerBackedRuntime() { return {}; }
export function waitUntilAbort(signal) { return new Promise((_, reject) => { signal?.addEventListener?.('abort', () => reject(signal.reason)); }); }
export function keepHttpServerTaskAlive() {}

// ── Inbound / Dispatch ───────────────────────────────────────────────────────

export function buildInboundReplyDispatchBase(p) { return p || {}; }
export function createInboundEnvelopeBuilder() { return (p) => p; }
export function dispatchInboundReplyWithBase() { return Promise.resolve({ delivered: false }); }
export function dispatchReplyFromConfigWithSettledDispatcher() { return Promise.resolve({ delivered: false }); }
export function recordInboundSession(params) { return Promise.resolve(); }
export function recordInboundSessionAndDispatchReply() { return Promise.resolve({ delivered: false }); }
export function resolveInboundRouteEnvelopeBuilder() { return (p) => p; }
export function resolveInboundRouteEnvelopeBuilderWithRuntime() { return (p) => p; }
export function resolveInboundSessionEnvelopeContext(p) { return p || {}; }
export function logInboundDrop() {}
export function formatInboundFromLabel(p) { return p?.from || 'unknown'; }

// ── Webhook (extended) ───────────────────────────────────────────────────────

export function registerWebhookTarget() {}
export function registerWebhookTargetWithPluginRoute() {}
export function resolveWebhookTargets() { return []; }
export function resolveSingleWebhookTarget() { return null; }
export function resolveSingleWebhookTargetAsync() { return Promise.resolve(null); }
export function resolveWebhookTargetWithAuthOrReject() { return null; }
export function resolveWebhookTargetWithAuthOrRejectSync() { return null; }
export function rejectNonPostWebhookRequest() { return false; }
export function readWebhookBodyOrReject() { return Promise.resolve(null); }
export function readJsonWebhookBodyOrReject() { return Promise.resolve(null); }
export function readRequestBodyWithLimit() { return Promise.resolve(Buffer.alloc(0)); }
export function readJsonBodyWithLimit() { return Promise.resolve({}); }
export function requestBodyErrorToText(e) { return e?.message || ''; }
export function beginWebhookRequestPipelineOrReject() { return Promise.resolve(null); }
export function withResolvedWebhookRequestPipeline() { return Promise.resolve(); }
export function createWebhookInFlightLimiter() { return { check: () => ({ allowed: true }), reset: () => {} }; }
export function resolveRequestUrl(req) { return req?.url || ''; }

// ── Allowlist / DM / Group (extended) ────────────────────────────────────────

export function buildAccountScopedDmSecurityPolicy() { return { policy: 'open', allowFrom: [] }; }
export function createAllowedChatSenderMatcher() { return () => true; }
export function resolveEffectiveAllowFromLists() { return []; }
export function resolveDmAllowState() { return { allowed: true }; }
export function resolveDmGroupAccessDecision() { return { allowed: true, reason: 'open' }; }
export function resolveDmGroupAccessWithCommandGate() { return { allowed: true, reason: 'open' }; }
export function resolveDmGroupAccessWithLists() { return { allowed: true, reason: 'open' }; }
export function resolveDirectDmAuthorizationOutcome() { return { allowed: true }; }
export function resolveNestedAllowlistDecision() { return { allowed: true }; }
export function evaluateGroupRouteAccessForPolicy() { return { allowed: true }; }
export function evaluateMatchedGroupAccessForPolicy() { return { allowed: true }; }
export function resolveSenderScopedGroupPolicy() { return 'open'; }
export function resolveControlCommandGate() { return { allowed: true }; }
export function resolveToolsBySender() { return []; }
export function createActionGate() { return { check: () => true }; }
export function mapAllowFromEntries(entries) { return entries || []; }
export function mapAllowlistResolutionInputs(entries) { return entries || []; }
export function mapBasicAllowlistResolutionEntries(entries) { return entries || []; }
export function formatAllowlistMatchMeta() { return ''; }
export function formatNormalizedAllowFromEntries(entries) { return entries || []; }
export function formatTrimmedAllowFromEntries(entries) { return entries || []; }
export function resolveAllowlistMatchByCandidates() { return null; }
export function resolveAllowlistMatchSimple() { return null; }
export function readStoreAllowFromForDmPolicy() { return []; }
export function formatPairingApproveHint() { return ''; }
export function formatResolvedUnresolvedNote() { return ''; }
export function mergeAllowlist(...lists) { return lists.flat().filter(Boolean); }

// ── Config helpers (extended) ────────────────────────────────────────────────

export function createScopedAccountConfigAccessors() { return { get: () => ({}), set: () => {} }; }
export function resolveAccountWithDefaultFallback(cfg, channelId, accountId) { return cfg?.channels?.[channelId]?.accounts?.[accountId] || {}; }
export function resolveAccountIdForConfigure() { return 'default'; }
export function resolveOptionalConfigString(v) { return v || undefined; }
export function deleteAccountFromConfigSection() {}
export function setAccountEnabledInConfigSection() {}
export function clearAccountEntryFields() {}
export function applyAccountNameToChannelSection() {}
export function migrateBaseNameToDefaultAccount() {}
export function resolveChannelEntryMatch() { return null; }
export function resolveChannelEntryMatchWithFallback() { return null; }
export function resolveChannelMediaMaxBytes() { return 10 * 1024 * 1024; }
export function resolveChannelGroupRequireMention() { return false; }
export function promptChannelAccessConfig() { return Promise.resolve({}); }
export function createPluginRuntimeStore(errorMessage) {
  let runtime = null;
  return {
    setRuntime(next) { runtime = next; },
    clearRuntime() { runtime = null; },
    tryGetRuntime() { return runtime; },
    getRuntime() { if (!runtime) throw new Error(errorMessage); return runtime; },
  };
}
export function createScopedChannelConfigBase() { return { get: () => ({}), set: () => {} }; }

// ── Mention / Gating (extended) ──────────────────────────────────────────────

export function resolveMentionGating(opts) { return { allowed: true, reason: 'bypass' }; }

// ── Outbound (extended) ──────────────────────────────────────────────────────

export function chunkTextForOutbound(text) { return [text]; }

function _detectMimeFromBuf(buf) {
  if (!buf || buf.length < 4) return 'application/octet-stream';
  if (buf[0]===0xFF&&buf[1]===0xD8) return 'image/jpeg';
  if (buf[0]===0x89&&buf[1]===0x50) return 'image/png';
  if (buf[0]===0x47&&buf[1]===0x49) return 'image/gif';
  if (buf[0]===0x52&&buf[1]===0x49) return 'image/webp';
  if (buf[0]===0x25&&buf[1]===0x50) return 'application/pdf';
  if (buf[0]===0x50&&buf[1]===0x4B) return 'application/zip';
  return 'application/octet-stream';
}
function _detectKind(ct) {
  if (!ct) return undefined;
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('audio/')) return 'audio';
  if (ct.startsWith('video/')) return 'video';
  return undefined;
}
export async function loadOutboundMediaFromUrl(mediaUrl, options) {
  if (!mediaUrl) return null;
  options = options || {};
  const maxBytes = options.maxBytes || 50*1024*1024;
  if (mediaUrl.startsWith('file://')) {
    let fp;
    try { fp = decodeURIComponent(mediaUrl.replace('file://', '')); if (process.platform==='win32'&&fp.startsWith('/')) fp=fp.slice(1); } catch { fp = mediaUrl.slice(7); }
    const roots = options.localRoots || options.mediaLocalRoots;
    if (roots?.length && !roots.some(r => fp.startsWith(r))) throw new Error('File path not allowed: '+fp);
    if (!fs.existsSync(fp)) throw new Error('File not found: '+fp);
    const buffer = fs.readFileSync(fp);
    if (buffer.length>maxBytes) throw new Error('File too large');
    const ct = _detectMimeFromBuf(buffer);
    return { buffer, contentType: ct, fileName: path.basename(fp), kind: _detectKind(ct) };
  }
  if (mediaUrl.startsWith('data:')) {
    const m = mediaUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) return null;
    const buffer = Buffer.from(m[2],'base64');
    if (buffer.length>maxBytes) throw new Error('Data URL too large');
    return { buffer, contentType: m[1], fileName: 'data.'+(m[1].split('/')[1]||'bin'), kind: _detectKind(m[1]) };
  }
  if (mediaUrl.startsWith('http://') || mediaUrl.startsWith('https://')) {
    const resp = await getPlatform().fetch(mediaUrl);
    if (!resp.ok) throw new Error('HTTP '+resp.status);
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length>maxBytes) throw new Error('Downloaded file too large');
    const ct = resp.headers.get('content-type')?.split(';')[0]?.trim() || _detectMimeFromBuf(buffer);
    return { buffer, contentType: ct, fileName: path.basename(new URL(mediaUrl).pathname)||'download', kind: _detectKind(ct) };
  }
  return null;
}
export async function loadWebMedia(mediaUrl, maxBytes) { return loadOutboundMediaFromUrl(mediaUrl, { maxBytes: typeof maxBytes==='number'?maxBytes:undefined }); }
function _resolveOutMediaUrls(p) { const u=[]; if(p?.mediaUrl)u.push(p.mediaUrl); if(p?.mediaUrls)u.push(...p.mediaUrls); return u.filter(Boolean); }
export async function sendPayloadWithChunkedTextAndMedia(params) {
  const payload = params.ctx?.payload || params.ctx || {};
  const text = payload.text ?? '';
  const urls = _resolveOutMediaUrls(payload);
  if (!text && urls.length===0) return params.emptyResult || { delivered: false };
  if (urls.length>0) {
    let r; for (let i=0;i<urls.length;i++) r=await params.sendMedia({...params.ctx, text:i===0?text:'', mediaUrl:urls[i]});
    return r;
  }
  const limit = params.textChunkLimit;
  const chunks = limit&&params.chunker ? params.chunker(text,limit) : [text];
  let r; for (const c of chunks) r=await params.sendText({...params.ctx, text:c});
  return r;
}
export function detectMime() { return 'application/octet-stream'; }
export function extensionForMime() { return ''; }
export function getFileExtension(f) { return path.extname(f || ''); }
export function extractOriginalFilename() { return ''; }
export function buildRandomTempFilePath() { return path.join(os.tmpdir(), 'tmp-' + Date.now()); }
export function missingTargetError(target) { return new Error('Missing target: ' + target); }

// ── Ack / Reaction ──────────────────────────────────────────────────────────

export function shouldAckReaction() { return false; }
export function shouldAckReactionForWhatsApp() { return false; }
export function resolveAckReaction() { return null; }
export function removeAckReactionAfterReply() { return Promise.resolve(); }
export function logAckFailure() {}

// ── Reply prefix / history (extended) ────────────────────────────────────────

export function createReplyPrefixOptions() { return {}; }
export function recordPendingHistoryEntry() {}
export function clearHistoryEntries() {}
export function evictOldHistoryKeys() {}

// ── Hostname / Network (extended) ────────────────────────────────────────────

export function buildHostnameAllowlistPolicyFromSuffixAllowlist() { return { check: () => true }; }
export function normalizeHostnameSuffixAllowlist() { return []; }
export function isBlockedHostname() { return false; }
export function isBlockedHostnameOrIp() { return false; }
export function isHttpsUrlAllowedByHostnameSuffixAllowlist() { return true; }
export function isPrivateIpAddress() { return false; }
export function fetchWithBearerAuthScopeFallback(url, opts) { return getPlatform().fetch(url, opts); }
export function resolveGatewayBindUrl() { return ''; }
export function resolveTailnetHostWithRunner() { return Promise.resolve(''); }
export function toFormUrlEncoded(obj) { return new URLSearchParams(obj).toString(); }

// ── Windows / WSL ────────────────────────────────────────────────────────────

export function isWSLEnv() { return false; }
export function isWSLSync() { return false; }
export function isWSL2Sync() { return false; }
export function applyWindowsSpawnProgramPolicy() { return {}; }
export function resolveWindowsExecutablePath() { return ''; }
export function resolveWindowsSpawnProgram() { return ''; }
export function resolveWindowsSpawnProgramCandidate() { return ''; }
export function materializeWindowsSpawnProgram() { return ''; }

// ── Diagnostics ──────────────────────────────────────────────────────────────

export function isDiagnosticsEnabled() { return false; }
export function emitDiagnosticEvent() {}
export function onDiagnosticEvent() { return () => {}; }
export function registerLogTransport() {}
export function registerContextEngine() {}

// ── Text / Format ────────────────────────────────────────────────────────────

export function hasMarkdownToConvert(t) { return false; }
export function toLocationContext() { return ''; }
export function formatLocationText() { return ''; }
export function summarizeMapping() { return ''; }
export function optionalStringEnum() { return z.string().optional(); }
export function stringEnum() { return z.string(); }
export function readBooleanParam(p) { return !!p; }
export function readNumberParam(p) { return Number(p) || 0; }
export function readStringParam(p) { return String(p || ''); }
export function readReactionParams() { return {}; }
export function createBoundedCounter() { let c = 0; return { inc: () => ++c, dec: () => --c, value: () => c, reset: () => { c = 0; } }; }
export function generatePkceVerifierChallenge() { return { verifier: '', challenge: '' }; }

// ── Pairing (extended) ───────────────────────────────────────────────────────

export function approveDevicePairing() { return Promise.resolve(); }
export function rejectDevicePairing() { return Promise.resolve(); }
export function listDevicePairing() { return Promise.resolve([]); }

// ── Plugin command ───────────────────────────────────────────────────────────

export function runPluginCommandWithTimeout() { return Promise.resolve(); }
export function listSkillCommandsForAgents() { return []; }
export function buildOauthProviderAuthResult() { return {}; }

// ── Hook runtime stubs ───────────────────────────────────────────────────────

export async function fireAndForgetHook() {}
export function buildCanonicalSentMessageHookContext() { return {}; }
export function toPluginMessageContext() { return {}; }
export function toPluginMessageSentEvent() { return {}; }
export function getGlobalHookRunner() { return { fire: async () => {}, register: () => {}, hasHooks: () => false, runMessageSent: async () => {}, runMessageSending: async () => undefined }; }

// ── Platform-specific stubs ──────────────────────────────────────────────────

export function extractSlackToolSend() { return null; }
export function buildSlackThreadingToolContext() { return {}; }
export function listSlackMessageActions() { return []; }
export function listEnabledSlackAccounts() { return []; }
export function resolveSlackReplyToMode() { return 'thread'; }
export function buildDiscordSendOptions() { return {}; }
export function buildDiscordSendMediaOptions() { return {}; }
export function tagDiscordChannelResult() { return {}; }
export function collectDiscordAuditChannelIds() { return []; }
export function processLineMessage() { return Promise.resolve(); }
export function parseTelegramReplyToMessageId() { return null; }
export function parseTelegramThreadId() { return null; }
export function normalizeE164(v) { return String(v || ''); }
export function isNumericTargetId(v) { return /^\\d+$/.test(v || ''); }
export function isWhatsAppGroupJid(v) { return false; }
export function getChatChannelMeta() { return {}; }
export function parseChatAllowTargetPrefixes() { return []; }
export function parseChatTargetPrefixesOrThrow() { return []; }
export function resolveServicePrefixedTarget() { return ''; }
export function resolveServicePrefixedChatTarget() { return ''; }
export function resolveServicePrefixedAllowTarget() { return ''; }
export function resolveServicePrefixedOrChatAllowTarget() { return ''; }

// ── Platform account resolvers ───────────────────────────────────────────────

export function listTelegramAccountIds() { return ['default']; }
export function listDiscordAccountIds() { return ['default']; }
export function listSlackAccountIds() { return ['default']; }
export function listSignalAccountIds() { return ['default']; }
export function listWhatsAppAccountIds() { return ['default']; }
export function listIMessageAccountIds() { return ['default']; }
export function listLineAccountIds() { return ['default']; }
export function resolveDefaultTelegramAccountId() { return 'default'; }
export function resolveDefaultDiscordAccountId() { return 'default'; }
export function resolveDefaultSlackAccountId() { return 'default'; }
export function resolveDefaultSignalAccountId() { return 'default'; }
export function resolveDefaultWhatsAppAccountId() { return 'default'; }
export function resolveDefaultIMessageAccountId() { return 'default'; }
export function resolveDefaultLineAccountId() { return 'default'; }
export function resolveTelegramAccount(cfg) { return cfg || {}; }
export function resolveDiscordAccount(cfg) { return cfg || {}; }
export function resolveSlackAccount(cfg) { return cfg || {}; }
export function resolveSignalAccount(cfg) { return cfg || {}; }
export function resolveWhatsAppAccount(cfg) { return cfg || {}; }
export function resolveIMessageAccount(cfg) { return cfg || {}; }
export function resolveLineAccount(cfg) { return cfg || {}; }

// ── Platform directory ───────────────────────────────────────────────────────

export function listTelegramDirectoryGroupsFromConfig() { return []; }
export function listTelegramDirectoryPeersFromConfig() { return []; }
export function listDiscordDirectoryGroupsFromConfig() { return []; }
export function listDiscordDirectoryPeersFromConfig() { return []; }
export function listSlackDirectoryGroupsFromConfig() { return []; }
export function listSlackDirectoryPeersFromConfig() { return []; }
export function listWhatsAppDirectoryGroupsFromConfig() { return []; }
export function listWhatsAppDirectoryPeersFromConfig() { return []; }
export function listDirectoryGroupEntriesFromMapKeys() { return []; }
export function listDirectoryGroupEntriesFromMapKeysAndAllowFrom() { return []; }
export function listDirectoryUserEntriesFromAllowFrom() { return []; }
export function listDirectoryUserEntriesFromAllowFromAndMapKeys() { return []; }

// ── Platform messaging targets ───────────────────────────────────────────────

export function normalizeTelegramMessagingTarget(t) { return t || ''; }
export function normalizeDiscordMessagingTarget(t) { return t || ''; }
export function normalizeDiscordOutboundTarget(t) { return t || ''; }
export function normalizeSlackMessagingTarget(t) { return t || ''; }
export function normalizeSignalMessagingTarget(t) { return t || ''; }
export function normalizeWhatsAppMessagingTarget(t) { return t || ''; }
export function normalizeWhatsAppTarget(t) { return t || ''; }
export function normalizeIMessageMessagingTarget(t) { return t || ''; }
export function normalizeLineAccountId(id) { return id || 'default'; }

// ── Platform looksLike targets ───────────────────────────────────────────────

export function looksLikeTelegramTargetId() { return false; }
export function looksLikeDiscordTargetId() { return false; }
export function looksLikeSlackTargetId() { return false; }
export function looksLikeSignalTargetId() { return false; }
export function looksLikeWhatsAppTargetId() { return false; }
export function looksLikeIMessageTargetId() { return false; }

// ── Platform group policy ────────────────────────────────────────────────────

export function resolveTelegramGroupRequireMention() { return false; }
export function resolveDiscordGroupRequireMention() { return false; }
export function resolveSlackGroupRequireMention() { return false; }
export function resolveGoogleChatGroupRequireMention() { return false; }
export function resolveBlueBubblesGroupRequireMention() { return false; }
export function resolveIMessageGroupRequireMention() { return false; }
export function resolveWhatsAppGroupRequireMention() { return false; }
export function resolveTelegramGroupToolPolicy() { return 'auto'; }
export function resolveDiscordGroupToolPolicy() { return 'auto'; }
export function resolveSlackGroupToolPolicy() { return 'auto'; }
export function resolveGoogleChatGroupToolPolicy() { return 'auto'; }
export function resolveBlueBubblesGroupToolPolicy() { return 'auto'; }
export function resolveIMessageGroupToolPolicy() { return 'auto'; }
export function resolveWhatsAppGroupToolPolicy() { return 'auto'; }

// ── Platform status / inspect ────────────────────────────────────────────────

export function collectTelegramStatusIssues() { return []; }
export function collectDiscordStatusIssues() { return []; }
export function collectWhatsAppStatusIssues() { return []; }
export function collectBlueBubblesStatusIssues() { return []; }
export function collectStatusIssuesFromLastError() { return []; }
export function inspectTelegramAccount() { return {}; }
export function inspectDiscordAccount() { return {}; }
export function inspectSlackAccount() { return {}; }

// ── Platform onboarding adapters ─────────────────────────────────────────────

export function telegramOnboardingAdapter() { return {}; }
export function discordOnboardingAdapter() { return {}; }
export function slackOnboardingAdapter() { return {}; }
export function signalOnboardingAdapter() { return {}; }
export function imessageOnboardingAdapter() { return {}; }
export function whatsappOnboardingAdapter() { return {}; }

// ── Platform config helpers ──────────────────────────────────────────────────

export function resolveIMessageConfigAllowFrom() { return []; }
export function resolveIMessageConfigDefaultTo() { return ''; }
export function resolveWhatsAppConfigAllowFrom() { return []; }
export function resolveWhatsAppConfigDefaultTo() { return ''; }
export function normalizeWhatsAppAllowFromEntries() { return []; }
export function formatWhatsAppConfigAllowFromEntries() { return []; }
export function resolveWhatsAppOutboundTarget() { return ''; }
export function resolveWhatsAppGroupIntroHint() { return ''; }
export function resolveWhatsAppHeartbeatRecipients() { return []; }
export function resolveWhatsAppMentionStripPatterns() { return []; }
export function collectAllowlistProviderGroupPolicyWarnings() { return []; }
export function collectAllowlistProviderRestrictSendersWarnings() { return []; }
export function collectOpenProviderGroupPolicyWarnings() { return []; }
export function collectOpenGroupPolicyConfiguredRouteWarnings() { return []; }
export function collectOpenGroupPolicyRestrictSendersWarnings() { return []; }
export function collectOpenGroupPolicyRouteAllowlistWarnings() { return []; }
export function buildOpenGroupPolicyWarning() { return ''; }
export function buildOpenGroupPolicyConfigureRouteAllowlistWarning() { return ''; }
export function buildOpenGroupPolicyNoRouteAllowlistWarning() { return ''; }
export function buildOpenGroupPolicyRestrictSendersWarning() { return ''; }

// ── Cards ────────────────────────────────────────────────────────────────────

export function createActionCard() { return {}; }
export function createImageCard() { return {}; }
export function createInfoCard() { return {}; }
export function createListCard() { return {}; }
export function createReceiptCard() { return {}; }

// ── String coerce runtime ────────────────────────────────────────────────────

export function normalizeOptionalString(v) { return v != null ? String(v) : undefined; }
export function normalizeOptionalLowercaseString(v) { return v != null ? String(v).toLowerCase() : undefined; }
export function normalizeLowercaseStringOrEmpty(v) { return v != null ? String(v).toLowerCase() : ''; }
export function readStringValue(v) { return v != null ? String(v) : ''; }
export function isRecord(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

// ── Error runtime ────────────────────────────────────────────────────────────

// (formatErrorMessage already defined above)

// ── Channel message ──────────────────────────────────────────────────────────

export function createChannelMessageReplyPipeline(params) { return { run: async () => {} }; }
export function defineChannelMessageAdapter(opts) { return opts || {}; }
export function createMessageReceiptFromOutboundResults() { return {}; }

// ── Channel pairing (extended) ───────────────────────────────────────────────

export function createChannelPairingController(opts) {
  return {
    handleInbound: async () => ({ allowed: true }),
    isApproved: () => true,
    approveUser: async () => {},
    revokeUser: async () => {},
    listPending: () => [],
  };
}
export function createPairingPrefixStripper() { return (text) => text; }

// ── Channel status ───────────────────────────────────────────────────────────

export function buildTokenChannelStatusSummaryFromProbe(p) { return buildBaseChannelStatusSummary(p); }
export function createComputedAccountStatusAdapter() { return { compute: async () => ({}) }; }

// ── Channel core ─────────────────────────────────────────────────────────────

export function buildChannelOutboundSessionRoute(p) { return p?.sessionKey || ''; }
export function createChatChannelPlugin(params) {
  if (!params) return {};
  const base = params.base || {};
  return {
    ...base,
    conversationBindings: { supportsCurrentConversationBinding: true, ...base.conversationBindings },
    ...(params.security ? { security: params.security } : {}),
    ...(params.pairing ? { pairing: params.pairing } : {}),
    ...(params.threading ? { threading: params.threading } : {}),
    ...(params.outbound ? { outbound: params.outbound } : {}),
  };
}
export function stripChannelTargetPrefix(t) { return t || ''; }

// ── Channel config ───────────────────────────────────────────────────────────

export function adaptScopedAccountAccessor(accessor) { return (cfg, accountId) => accessor({ cfg, accountId }); }
export function createHybridChannelConfigAdapter(opts) { return opts || {}; }
export function resolveChannelConfigWrites() { return {}; }
export function patchTopLevelChannelConfigSection() { return {}; }
export function splitSetupEntries(entries) { return { valid: entries || [], invalid: [] }; }

// ── Channel ingress ──────────────────────────────────────────────────────────

export function createChannelIngressResolver(base) {
  const _resolve = async (input) => ({
    state: {},
    ingress: { admission: 'dispatch' },
    senderAccess: { decision: 'allow', effectiveAllowFrom: base?.allowFrom || [] },
    routeAccess: { decision: 'allow' },
    commandAccess: { authorized: true },
    activationAccess: { activated: true },
  });
  return {
    message: _resolve,
    command: _resolve,
    event: _resolve,
  };
}
export function defineStableChannelIngressIdentity(opts) { return opts || {}; }

// ── Channel streaming ────────────────────────────────────────────────────────

export function formatChannelProgressDraftLineForEntry() { return ''; }
export function isChannelProgressDraftWorkToolName() { return false; }

// ── Channel secret basic runtime ─────────────────────────────────────────────

export function collectConditionalChannelFieldAssignments() { return []; }
export function collectSimpleChannelFieldAssignments() { return []; }
export function getChannelSurface() { return {}; }
export function hasOwnProperty(obj, key) { return Object.prototype.hasOwnProperty.call(obj || {}, key); }
export function normalizeSecretStringValue(v) { return typeof v === 'string' ? v : ''; }

// ── Text chunking ────────────────────────────────────────────────────────────

export function convertMarkdownTables(text, mode) { return text || ''; }
export function stripReasoningTagsFromText(text) { return text || ''; }

// ── Media mime ───────────────────────────────────────────────────────────────

export function mediaKindFromMime(ct) {
  if (!ct) return undefined;
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('audio/')) return 'audio';
  if (ct.startsWith('video/')) return 'video';
  return 'document';
}

// ── Media runtime (extended) ─────────────────────────────────────────────────

export const MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS = 300;
export async function runFfmpeg() { throw new Error('ffmpeg not available in OpenDesk shim'); }
export function renderQrTerminal(text) { console.log(text); }
export async function transcribeFirstAudio() { return ''; }

// ── Security runtime (extended) ──────────────────────────────────────────────

export function readRegularFile(fp) { return fs.readFileSync(fp); }
export function writeExternalFileWithinRoot(fp, data) { fs.writeFileSync(fp, data); }
export function statRegularFileSync(fp) { try { return fs.statSync(fp); } catch { return null; } }
export function safeEqualSecret(a, b) { if (!a || !b) return false; return a === b; }

// ── Temp path ────────────────────────────────────────────────────────────────

export function withTempWorkspace(fn) {
  const tmpDir = path.join(os.tmpdir(), 'opendesk-ws-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  return fn(tmpDir).finally(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch {} });
}

// ── Markdown table runtime ───────────────────────────────────────────────────

export function resolveMarkdownTableMode() { return 'native'; }

// ── Conversation runtime ─────────────────────────────────────────────────────

export function registerSessionBindingAdapter() { return () => {}; }
export function unregisterSessionBindingAdapter() {}
export function resolveThreadBindingConversationIdFromBindingId() { return null; }
export function resolveThreadBindingIdleTimeoutMsForChannel() { return 0; }
export function resolveThreadBindingMaxAgeMsForChannel() { return 0; }
export function ensureConfiguredBindingRouteReady() { return Promise.resolve(); }
export function resolveConfiguredBindingRoute(params) { return { route: params?.route || null, bindingResolution: null }; }
export function resolveRuntimeConversationBindingRoute(params) { return { route: params?.route || null, bindingRecord: null, boundSessionKey: null }; }
export function getSessionBindingService() { return null; }
export function resolveAgentIdFromSessionKey(sk) { return sk?.split(':')[0] || 'default'; }

// ── Routing (extended) ───────────────────────────────────────────────────────

export function resolveMergedAccountConfig(params) {
  const omitKeys = new Set(['accounts', ...(params?.omitKeys || [])]);
  const channelConfig = params?.channelConfig || {};
  const base = Object.fromEntries(Object.entries(channelConfig).filter(([k]) => !omitKeys.has(k)));
  const accountConfig = params?.accounts?.[params?.accountId] || {};
  return { ...base, ...accountConfig };
}

// ── Interactive runtime ──────────────────────────────────────────────────────

export function interactiveReplyToPresentation() { return {}; }
export function normalizeInteractiveReply(r) { return r || {}; }
export function normalizeMessagePresentation(p) { return p || {}; }
export function renderMessagePresentationFallbackText(params) { return params?.text || ''; }
export function resolveInteractiveTextFallback(params) { return typeof params === 'string' ? params : params?.text || ''; }

// ── Reply payload (extended) ─────────────────────────────────────────────────

export function resolvePayloadMediaUrls(p) { const u=[]; if(p?.mediaUrl)u.push(p.mediaUrl); if(p?.mediaUrls)u.push(...p.mediaUrls); return u.filter(Boolean); }
export function sendMediaWithLeadingCaptionFromParts() { return Promise.resolve(); }
export async function sendPayloadMediaSequence(params) {
  let lastResult;
  for (let i = 0; i < (params?.mediaUrls?.length || 0); i++) {
    const mediaUrl = params.mediaUrls[i];
    if (!mediaUrl) continue;
    lastResult = await params.send({ text: i === 0 ? (params.text || '') : '', mediaUrl, index: i, isFirst: i === 0 });
  }
  return lastResult;
}
export async function sendPayloadMediaSequenceAndFinalize(params) {
  if (params?.mediaUrls?.length > 0) await sendPayloadMediaSequence(params);
  return params?.finalize ? await params.finalize() : undefined;
}
export async function sendTextMediaPayload(params) {
  const text = params?.ctx?.payload?.text ?? '';
  const urls = resolvePayloadMediaUrls(params?.ctx?.payload);
  const channel = params?.channel || '';
  if (!text && urls.length === 0) return { channel, messageId: '' };
  if (urls.length > 0) {
    const audioAsVoice = params.ctx.payload.audioAsVoice ?? params.ctx.audioAsVoice;
    const lastResult = await sendPayloadMediaSequence({
      text,
      mediaUrls: urls,
      send: async ({ text: t, mediaUrl }) => await params.adapter.sendMedia({ ...params.ctx, text: t, mediaUrl, ...(audioAsVoice !== undefined ? { audioAsVoice } : {}) }),
    });
    return lastResult ?? { channel, messageId: '' };
  }
  const limit = params.adapter?.textChunkLimit;
  const chunks = limit && params.adapter?.chunker ? params.adapter.chunker(text, limit) : [text];
  let lastResult;
  for (const chunk of chunks) {
    lastResult = await params.adapter.sendText({ ...params.ctx, text: chunk });
  }
  return lastResult;
}
export function resolveSendableOutboundReplyParts(params) { return { text: params?.text || '', media: [] }; }
export function resolveTextChunksWithFallback(text, limit) { return [text || '']; }

// ── Outbound runtime ─────────────────────────────────────────────────────────

export function resolveAgentOutboundIdentity() { return {}; }
export function createRuntimeOutboundDelegates(params) {
  const result = {};
  for (const method of ['sendText', 'sendMedia', 'sendPayload', 'sendPoll', 'renderPresentation']) {
    if (params?.[method]) {
      result[method] = async (ctx) => {
        const runtime = await params.getRuntime();
        const fn = params[method].resolve(runtime);
        if (!fn) throw new Error(params[method].unavailableMessage || method + ' is not available');
        return await fn(ctx);
      };
    }
  }
  return result;
}

// ── Context visibility runtime ───────────────────────────────────────────────

export function evaluateSupplementalContextVisibility() { return true; }
export function filterSupplementalContextItems(items) { return items || []; }
export function resolveChannelContextVisibilityMode() { return 'visible'; }

// ── Session store runtime ────────────────────────────────────────────────────

export function loadSessionStore() { return {}; }
export function resolveSessionStoreEntry() { return {}; }

// ── Persistent dedupe ────────────────────────────────────────────────────────

// createPersistentDedupe already defined above

// ── Webhook request guards ───────────────────────────────────────────────────

export function readWebhookBodyOrRejectSync() { return null; }
export function isAbortRequestText(t) { return t === '!stop' || t === '/stop'; }
export function isBtwRequestText() { return false; }

// ── Command primitives runtime ───────────────────────────────────────────────

// isAbortRequestText / isBtwRequestText defined in webhook request guards

// ── Agent media payload ──────────────────────────────────────────────────────

// buildAgentMediaPayload already defined above

// ── Approval auth runtime ────────────────────────────────────────────────────

export function createResolvedApproverActionAuthAdapter() { return { check: () => true }; }
export function resolveApprovalApprovers() { return []; }

// ── Channel policy (extended) ────────────────────────────────────────────────

export function createAllowlistProviderGroupPolicyWarningCollector() { return { collect: () => [] }; }
export function projectConfigAccountIdWarningCollector() { return { collect: () => [] }; }

// ── Directory runtime (extended) ──────────────────────────────────────────────

export function createChannelDirectoryAdapter() { return {}; }
export function createRuntimeDirectoryLiveAdapter() { return {}; }

// ── Lazy runtime ─────────────────────────────────────────────────────────────

export function createLazyRuntimeNamedExport(loader, key) { let cached; return async () => { if (!cached) cached = await loader(); return key ? cached[key] : cached; }; }

// ── Extension shared ─────────────────────────────────────────────────────────

export function readPluginPackageVersion() { return '0.0.0'; }
export function resolveAmbientNodeProxyAgent() { return undefined; }

// ── Provider auth ────────────────────────────────────────────────────────────

export function coerceSecretRef(v) { return v; }

// ── Runtime group policy ─────────────────────────────────────────────────────

// resolveDefaultGroupPolicy, resolveOpenProviderRuntimeGroupPolicy,
// warnMissingProviderGroupPolicyFallbackOnce already defined above

// ── Channel send result (extended) ───────────────────────────────────────────

export function attachChannelToResult(channel, result) { return { ...result, channel }; }
export function createAttachedChannelResultAdapter(params) {
  return {
    sendText: params?.sendText ? async (ctx) => attachChannelToResult(params.channel, await params.sendText(ctx)) : undefined,
    sendMedia: params?.sendMedia ? async (ctx) => attachChannelToResult(params.channel, await params.sendMedia(ctx)) : undefined,
    sendPoll: params?.sendPoll ? async (ctx) => attachChannelToResult(params.channel, await params.sendPoll(ctx)) : undefined,
  };
}

// ── Setup runtime ────────────────────────────────────────────────────────────

export function createClackPrompter() { return { prompt: async () => '' }; }

// ── Agent runtime (extended) ─────────────────────────────────────────────────

export function formatReasoningMessage(text) { return text || ''; }

// ── Channel feedback (extended) ──────────────────────────────────────────────

// logTypingFailure already defined above

// ── Ssrf runtime ─────────────────────────────────────────────────────────────

// fetchWithSsrFGuard already defined above

// ── Models provider runtime ──────────────────────────────────────────────────

export function resolveModelsProviderRuntime() { return {}; }

// ── Describe account ─────────────────────────────────────────────────────────

export function describeAccountSnapshot(p) { return p?.accountId || 'default'; }
`.trim();
}

/**
 * Generate the account-id shim module.
 */
function generateAccountIdShim(): string {
    return `
const DEFAULT_ACCOUNT_ID = 'default';
const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
function canonicalizeAccountId(value) {
  if (VALID_ID_RE.test(value)) return value.toLowerCase();
  return value.toLowerCase().replace(INVALID_CHARS_RE, '-').replace(/^-+/, '').replace(/-+$/, '').slice(0, 64);
}
function normalizeAccountId(value) {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return DEFAULT_ACCOUNT_ID;
  const canonical = canonicalizeAccountId(trimmed);
  return (!canonical || canonical === '__proto__' || canonical === 'prototype' || canonical === 'constructor') ? 'default' : canonical;
}
function normalizeOptionalAccountId(value) {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return undefined;
  const canonical = canonicalizeAccountId(trimmed);
  return (!canonical || canonical === '__proto__' || canonical === 'prototype' || canonical === 'constructor') ? undefined : canonical;
}
export { DEFAULT_ACCOUNT_ID, normalizeAccountId, normalizeOptionalAccountId };
`.trim();
}

/**
 * Generate the keyed-async-queue shim module.
 */
function generateKeyedAsyncQueueShim(): string {
    return `
function enqueueKeyedTask(params) {
  params.hooks?.onEnqueue?.();
  const current = (params.tails.get(params.key) ?? Promise.resolve()).catch(() => void 0).then(params.task).finally(() => { params.hooks?.onSettle?.(); });
  const tail = current.then(() => void 0, () => void 0);
  params.tails.set(params.key, tail);
  tail.finally(() => { if (params.tails.get(params.key) === tail) params.tails.delete(params.key); });
  return current;
}
class KeyedAsyncQueue {
  constructor() { this.tails = new Map(); }
  getTailMapForTesting() { return this.tails; }
  enqueue(key, task, hooks) {
    return enqueueKeyedTask({ tails: this.tails, key, task, ...(hooks ? { hooks } : {}) });
  }
}
export { KeyedAsyncQueue, enqueueKeyedTask };
`.trim();
}

/**
 * Generate the feishu shim module.
 */
function generateFeishuShim(): string {
    return `export {
  DEFAULT_ACCOUNT_ID, DEFAULT_GROUP_HISTORY_LIMIT, PAIRING_APPROVED_MESSAGE,
  WEBHOOK_ANOMALY_COUNTER_DEFAULTS, WEBHOOK_RATE_LIMIT_DEFAULTS,
  addWildcardAllowFrom, applyBasicWebhookRequestGuards, buildAgentMediaPayload,
  buildBaseChannelStatusSummary, buildPendingHistoryContextFromMap,
  buildProbeChannelStatusSummary, buildRuntimeAccountStatusSnapshot,
  buildSecretInputSchema, buildSingleChannelSecretPromptState,
  clearHistoryEntriesIfEnabled, createDedupeCache, createDefaultChannelRuntimeState,
  createFixedWindowRateLimiter, createPersistentDedupe, createReplyPrefixContext,
  createScopedPairingAccess, createTypingCallbacks, createWebhookAnomalyTracker,
  emptyPluginConfigSchema, evaluateSenderGroupAccessForPolicy, fetchWithSsrFGuard,
  formatDocsLink, hasConfiguredSecretInput, installRequestBodyLimitGuard,
  issuePairingChallenge, logTypingFailure, mergeAllowFromEntries, normalizeAgentId,
  normalizeResolvedSecretInputString, normalizeSecretInputString,
  promptSingleChannelSecretInput, readJsonBodyWithLimit, readJsonFileWithFallback,
  recordPendingHistoryEntryIfEnabled, resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy, resolveOpenProviderRuntimeGroupPolicy,
  setTopLevelChannelAllowFrom, setTopLevelChannelDmPolicyWithAllowFrom,
  setTopLevelChannelGroupPolicy, splitOnboardingEntries,
  warnMissingProviderGroupPolicyFallbackOnce, withTempDownloadPath,
} from './index.js';
`.trim();
}

/**
 * Generate the compat shim module.
 */
function generateCompatShim(): string {
    return `export * from './index.js';`;
}

/**
 * Generate the core shim module.
 */
function generateCoreShim(): string {
    return `export {
  DEFAULT_ACCOUNT_ID,
  approveDevicePairing, rejectDevicePairing, listDevicePairing,
  emptyPluginConfigSchema, resolveGatewayBindUrl,
  resolvePreferredOpenClawTmpDir, resolveTailnetHostWithRunner,
  runPluginCommandWithTimeout, buildOauthProviderAuthResult,
  buildChannelConfigSchema, createActionGate, createDedupeCache,
  formatDocsLink, hasConfiguredSecretInput, mergeAllowFromEntries,
  patchTopLevelChannelConfigSection, promptSingleChannelSecretInput,
  splitSetupEntries,
} from './index.js';
`.trim();
}

/**
 * Generate the channel-entry-contract shim module.
 *
 * Provides `defineBundledChannelEntry`, `defineBundledChannelSetupEntry`,
 * and `loadBundledEntryExportSync` — the three symbols that bundled channel
 * plugins (e.g. Feishu >= 2026.5, Slack, Signal) import from
 * `openclaw/plugin-sdk/channel-entry-contract`.
 *
 * In the real OpenClaw host these are heavy implementations that handle
 * module resolution, profiler hooks, and dist-vs-source fallback logic.
 * Here we provide lightweight shims that:
 *   - `defineBundledChannelEntry`: builds a BundledChannelEntryContract
 *     whose `register(api)` calls `api.registerChannel` with the plugin
 *     loaded via `loadChannelPlugin`, and invokes `setChannelRuntime` if
 *     the host passes `api.runtime`.
 *   - `defineBundledChannelSetupEntry`: returns a minimal setup contract.
 *   - `loadBundledEntryExportSync`: synchronously loads a sibling module
 *     and returns a named export.
 */
function generateChannelEntryContractShim(): string {
    return `
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

export { buildChannelConfigSchema } from './index.js';

/**
 * Synchronously load a named export from a module relative to the caller.
 */
export function loadBundledEntryExportSync(importMetaUrl, reference, options) {
  const callerDir = path.dirname(fileURLToPath(importMetaUrl));
  const resolved = path.resolve(callerDir, reference.specifier);
  const require = createRequire(importMetaUrl);
  const mod = require(resolved);
  const exportName = reference.exportName || 'default';
  return mod[exportName] ?? mod.default?.[exportName] ?? mod.default ?? mod;
}

/**
 * Build a BundledChannelEntryContract from declarative options.
 */
export function defineBundledChannelEntry(options) {
  const {
    id, name, description, importMetaUrl,
    plugin: pluginRef, outbound: outboundRef, secrets: secretsRef,
    configSchema, runtime: runtimeRef, accountInspect,
    features, registerCliMetadata, registerFull,
  } = options;

  function loadChannelPlugin() {
    return loadBundledEntryExportSync(importMetaUrl, pluginRef);
  }

  function loadChannelOutbound() {
    if (!outboundRef) return undefined;
    try { return loadBundledEntryExportSync(importMetaUrl, outboundRef); } catch { return undefined; }
  }

  function loadChannelSecrets() {
    if (!secretsRef) return undefined;
    try { return loadBundledEntryExportSync(importMetaUrl, secretsRef); } catch { return undefined; }
  }

  function loadChannelAccountInspector() {
    if (!accountInspect) return undefined;
    try { return loadBundledEntryExportSync(importMetaUrl, accountInspect); } catch { return undefined; }
  }

  let _setChannelRuntime;
  if (runtimeRef) {
    _setChannelRuntime = (pluginRuntime) => {
      try {
        const setter = loadBundledEntryExportSync(importMetaUrl, runtimeRef);
        if (typeof setter === 'function') setter(pluginRuntime);
      } catch {}
    };
  }

  const resolvedConfigSchema = typeof configSchema === 'function' ? configSchema() : configSchema;

  const contract = {
    kind: 'bundled-channel-entry',
    id,
    name,
    description,
    configSchema: resolvedConfigSchema,
    features,
    loadChannelPlugin,
    loadChannelOutbound,
    loadChannelSecrets,
    loadChannelAccountInspector,
    setChannelRuntime: _setChannelRuntime,
    register(api) {
      const channelPlugin = loadChannelPlugin();
      if (_setChannelRuntime && api.runtime) {
        _setChannelRuntime(api.runtime);
      }
      api.registerChannel({ plugin: channelPlugin });
      if (typeof registerFull === 'function') {
        registerFull(api);
      }
    },
  };

  return contract;
}

/**
 * Build a BundledChannelSetupEntryContract from declarative options.
 */
export function defineBundledChannelSetupEntry(options) {
  const {
    importMetaUrl,
    plugin: pluginRef, secrets: secretsRef, runtime: runtimeRef,
    legacyStateMigrations, legacySessionSurface, features,
  } = options;

  function loadSetupPlugin() {
    return loadBundledEntryExportSync(importMetaUrl, pluginRef);
  }

  function loadSetupSecrets() {
    if (!secretsRef) return undefined;
    try { return loadBundledEntryExportSync(importMetaUrl, secretsRef); } catch { return undefined; }
  }

  let _setChannelRuntime;
  if (runtimeRef) {
    _setChannelRuntime = (pluginRuntime) => {
      try {
        const setter = loadBundledEntryExportSync(importMetaUrl, runtimeRef);
        if (typeof setter === 'function') setter(pluginRuntime);
      } catch {}
    };
  }

  return {
    kind: 'bundled-channel-setup-entry',
    loadSetupPlugin,
    loadSetupSecrets,
    setChannelRuntime: _setChannelRuntime,
    features,
  };
}
`.trim();
}
