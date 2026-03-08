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
import { logger } from '../../../utils/logger.js';

/**
 * Ensure the openclaw shim is available in the extensions node_modules.
 * Generates the shim inline so plugins can resolve `openclaw/plugin-sdk`.
 */
export function ensureOpenClawShim(extensionsDir: string): void {
    const shimTarget = path.join(extensionsDir, 'node_modules', 'openclaw');
    if (fs.existsSync(path.join(shimTarget, 'package.json'))) {
        return;
    }
    logger.info('正在生成 openclaw 兼容层...');
    generateInlineShim(shimTarget);
}

/**
 * Generate the complete inline shim at the target directory.
 */
function generateInlineShim(shimTarget: string): void {
    fs.mkdirSync(path.join(shimTarget, 'plugin-sdk'), { recursive: true });

    // Generate package.json with exports
    fs.writeFileSync(path.join(shimTarget, 'package.json'), JSON.stringify({
        name: 'openclaw',
        version: '2026.3.0',
        type: 'module',
        exports: {
            '.': './index.js',
            './plugin-sdk': './plugin-sdk/index.js',
            './plugin-sdk/account-id': './plugin-sdk/account-id.js',
            './plugin-sdk/keyed-async-queue': './plugin-sdk/keyed-async-queue.js',
            './plugin-sdk/feishu': './plugin-sdk/feishu.js',
        },
    }, null, 2));

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

// ── Pairing (delegates to runtime's persistent pairing store) ────────────────

export function createScopedPairingAccess({ core, channel, accountId } = {}) {
  const ch = channel || 'unknown';
  const acc = accountId || 'default';
  const p = core?.channel?.pairing;

  return {
    check: async ({ userId } = {}) => {
      if (p?.isUserApproved) return { allowed: p.isUserApproved(ch, acc, userId) };
      return { allowed: true };
    },
    revoke: async ({ userId } = {}) => {
      if (p?.revokeUser) p.revokeUser(ch, acc, userId);
    },
    readAllowFromStore: async () => {
      if (p?.readAllowFromStore) return p.readAllowFromStore(ch, acc);
      return [];
    },
    upsertPairingRequest: async (params) => {
      if (p?.upsertPairingRequest) return p.upsertPairingRequest(ch, acc, params?.id, params?.meta);
      return { code: String(Math.floor(100000 + Math.random() * 900000)), created: true };
    },
    removePairingRequest: async ({ userId } = {}) => {
      if (p?.removePairingRequest) return p.removePairingRequest(ch, acc, userId);
    },
    listPairingRequests: async () => {
      if (p?.listPairingRequests) return p.listPairingRequests(ch, acc);
      return [];
    },
  };
}
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

/**
 * Generate the account-id shim module.
 */
function generateAccountIdShim(): string {
    return `
export const DEFAULT_ACCOUNT_ID = 'default';
export function normalizeAccountId(id) { return id || DEFAULT_ACCOUNT_ID; }
export function isDefaultAccountId(id) { return !id || id === DEFAULT_ACCOUNT_ID; }
export function parseAccountId(raw) { const p = String(raw||'').split(':'); return { channelId: p[0]||'', accountId: p[1]||DEFAULT_ACCOUNT_ID }; }
export function formatAccountId(c, a) { return c + ':' + (a||DEFAULT_ACCOUNT_ID); }
`.trim();
}

/**
 * Generate the keyed-async-queue shim module.
 */
function generateKeyedAsyncQueueShim(): string {
    return `
export class KeyedAsyncQueue {
  constructor() { this._q = new Map(); }
  async enqueue(k, fn) { if(!this._q.has(k)) this._q.set(k,Promise.resolve()); const p=this._q.get(k); const n=p.then(()=>fn()).catch(()=>fn()); this._q.set(k,n.catch(()=>{})); return n; }
  has(k) { return this._q.has(k); }
  clear(k) { k ? this._q.delete(k) : this._q.clear(); }
}
export function createKeyedAsyncQueue() { return new KeyedAsyncQueue(); }
`.trim();
}