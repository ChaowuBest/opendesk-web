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

import { AgentOperableHTMLElement } from '../../widget_utils.js';
import { escapeHtml } from '../../../../common/utils/escape.js';
import { OPENDESK_THEME_CHANGED } from '../../../../renderer/theme/theme-iframe-bridge.ts';
import { syncShadowHostTheme } from '../../../../renderer/theme/theme-shadow-overrides.ts';
import { renderSafeMarkdown } from '../../../../renderer/utils/markdown.js';
import {
    SkillDetailCard,
    getSkillInitial,
    getSkillPastel,
    type SkillDetailCardModel
} from '../../../../renderer/components/skills/skill-detail-card.js';
import {
    unwrapAgentOfficeCallResult,
    type InstalledSkillSummary,
    type StaffDetail,
    type StaffListItem,
    type StaffMessage,
    type StaffSkillBatchImportResult,
    type StaffSkillImportCandidate,
    type StaffSkillSummary,
    type StaffUpdateInput
} from '../common.js';

type DetailSection = 'basic' | 'skills' | 'mcp' | 'security' | 'tasks';

interface ChatModelSummary {
    alias: string;
    provider_name: string;
    model_name: string;
}

interface ModelCatalog {
    default_model: string;
    models: ChatModelSummary[];
}

type AutoSaveState = 'idle' | 'saving' | 'saved' | 'invalid' | 'error';

const PORTRAIT_CANVAS_SIZE = 512;
const PORTRAIT_MAX_FILE_BYTES = 20 * 1024 * 1024;

const CSS = String.raw`
:host { display:block; width:100%; height:100%; background:#fff; color:#1d1d1f; }
:host([data-theme='dark']) { color-scheme:dark; background:#1e1e1e; color:#ccc; }
* { box-sizing:border-box; }
button,input,textarea,select { font:inherit; }
button { cursor:pointer; }
.fa-solid { display:inline-block; width:1.25em; font-family:'Font Awesome 7 Free'; font-style:normal; font-variant:normal; font-weight:900; line-height:1; text-align:center; text-rendering:auto; -webkit-font-smoothing:antialiased; }
.fa-solid::before { content:var(--fa); }.fa-arrow-left { --fa:'\f060'; }.fa-plus { --fa:'\2b'; }.fa-xmark { --fa:'\f00d'; }.fa-folder-open { --fa:'\f07c'; }.fa-file-zipper { --fa:'\f1c6'; }.fa-inbox { --fa:'\f01c'; }.fa-link { --fa:'\f0c1'; }.fa-download { --fa:'\f019'; }.fa-check { --fa:'\f00c'; }.fa-copy { --fa:'\f0c5'; }.fa-font { --fa:'\f031'; }.fa-arrow-up-right-from-square { --fa:'\f35d'; }
.root { --bg:#f6f7f9; --surface:#fff; --surface2:#f4f5f7; --border:#e7e8ec; --text:#1d1d1f; --muted:#777b84; --accent:#5b6ee1; --accentSoft:#eef0ff; height:100%; display:flex; flex-direction:column; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
:host([data-theme='dark']) .root { --bg:#1e1e1e; --surface:#252526; --surface2:#333; --border:rgba(255,255,255,.18); --text:#e4e4e4; --muted:#ababab; --accent:#6ba3ef; --accentSoft:rgba(96,165,250,.16); }
/* Shadow DOM equivalent of docs/specifications/scrollbar_specification.md. */
:is(.messages,.staff-list,.management,.detail-content)::-webkit-scrollbar { width:4px; height:4px; }
:is(.messages,.staff-list,.management,.detail-content)::-webkit-scrollbar-track { background:transparent; }
:is(.messages,.staff-list,.management,.detail-content)::-webkit-scrollbar-thumb { border-radius:4px; background:rgba(0,0,0,.12); }
:is(.messages,.staff-list,.management,.detail-content)::-webkit-scrollbar-thumb:hover { background:rgba(0,0,0,.22); }
:is(.messages,.staff-list,.management,.detail-content)::-webkit-scrollbar-corner { background:transparent; }
:is(.modal-body,.detail-nav,.installed-skill-list,.message-markdown pre,.message-markdown table,.compose-row textarea,.field textarea)::-webkit-scrollbar { width:4px; height:4px; }
:is(.modal-body,.detail-nav,.installed-skill-list,.message-markdown pre,.message-markdown table,.compose-row textarea,.field textarea)::-webkit-scrollbar-track { background:transparent; }
:is(.modal-body,.detail-nav,.installed-skill-list,.message-markdown pre,.message-markdown table,.compose-row textarea,.field textarea)::-webkit-scrollbar-thumb { border-radius:2px; background:#d1d5db; }
:is(.modal-body,.detail-nav,.installed-skill-list,.message-markdown pre,.message-markdown table,.compose-row textarea,.field textarea)::-webkit-scrollbar-thumb:hover { background:#bfc5ce; }
:is(.modal-body,.detail-nav,.installed-skill-list,.message-markdown pre,.message-markdown table,.compose-row textarea,.field textarea)::-webkit-scrollbar-corner { background:transparent; }
:host([data-theme='dark']) :is(.messages,.staff-list,.management,.detail-content,.modal-body,.detail-nav,.installed-skill-list,.message-markdown pre,.message-markdown table,.compose-row textarea,.field textarea)::-webkit-scrollbar-thumb { background:rgba(255,255,255,.18) !important; }
:host([data-theme='dark']) :is(.messages,.staff-list,.management,.detail-content,.modal-body,.detail-nav,.installed-skill-list,.message-markdown pre,.message-markdown table,.compose-row textarea,.field textarea)::-webkit-scrollbar-thumb:hover { background:rgba(255,255,255,.28) !important; }
.tabs { height:58px; display:flex; align-items:flex-end; gap:8px; padding:0 24px; border-bottom:1px solid var(--border); background:var(--surface); }
.tab { border:0; background:transparent; color:var(--muted); padding:18px 16px 14px; border-bottom:3px solid transparent; font-weight:600; }
.tab.active { color:var(--text); border-color:var(--accent); }
.body { flex:1; min-height:0; }
.office { height:100%; display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:16px; padding:16px; }
.chat,.staff-panel,.management-panel,.detail { background:var(--surface); border:1px solid var(--border); border-radius:20px; min-height:0; box-shadow:0 8px 28px rgba(0,0,0,.04); }
.chat { display:flex; flex-direction:column; overflow:hidden; }
.chat-head { min-height:70px; padding:14px 20px; display:flex; align-items:center; gap:12px; border-bottom:1px solid var(--border); }
.avatar { width:42px; height:42px; border-radius:14px; object-fit:cover; display:grid; place-items:center; background:linear-gradient(135deg,#6574e8,#8e68d5); color:white; font-weight:700; flex:none; }
.chat-title { font-weight:700; }
.sub { color:var(--muted); font-size:12px; margin-top:3px; }
.status-dot { width:8px; height:8px; border-radius:50%; background:#9ca3af; display:inline-block; margin-right:5px; }
.status-dot.on { background:#28b76b; }.status-dot.run { background:#f59e0b; box-shadow:0 0 0 4px rgba(245,158,11,.14); }
.messages { flex:1; overflow:auto; padding:22px; display:flex; flex-direction:column; gap:13px; }
.load-older { align-self:center; border:1px solid var(--border); background:var(--surface2); color:var(--muted); border-radius:999px; padding:6px 12px; }
.message { max-width:min(72%,720px); padding:11px 14px; border-radius:17px; line-height:1.5; overflow-wrap:anywhere; }
.message.user { align-self:flex-end; background:var(--accent); color:white; border-bottom-right-radius:5px; }
.message.assistant { align-self:flex-start; background:var(--surface2); border-bottom-left-radius:5px; }
.message.error { border:1px solid #ef4444; }
.message-meta { font-size:10px; opacity:.7; margin-top:7px; display:flex; gap:8px; }
.message-context-menu { position:fixed; z-index:50; min-width:188px; padding:4px; border:1px solid color-mix(in srgb,var(--border) 86%,transparent); border-radius:9px; background:color-mix(in srgb,var(--surface) 92%,transparent); box-shadow:0 14px 42px rgba(15,23,42,.18); backdrop-filter:blur(28px) saturate(1.5); }
.message-context-menu button { width:100%; padding:7px 9px; display:flex; align-items:center; gap:9px; border:0; border-radius:5px; background:transparent; color:var(--text); text-align:left; font-size:12px; }
.message-context-menu button:hover { background:var(--accent); color:#fff; }
.message-context-menu button i { width:15px; color:var(--muted); text-align:center; }
.message-context-menu button:hover i { color:#fff; }
.message-context-menu-separator { height:1px; margin:4px 2px; background:var(--border); }
.resource { margin-top:8px; max-width:360px; }
.resource img,.resource video { max-width:100%; max-height:260px; border-radius:11px; display:block; }
.resource audio { max-width:100%; }
.resource a { color:inherit; text-decoration:underline; }
.composer { border-top:1px solid var(--border); padding:13px 16px; }
.attachment-list { display:flex; gap:7px; flex-wrap:wrap; margin-bottom:8px; }
.chip { background:var(--surface2); border:1px solid var(--border); border-radius:999px; padding:5px 9px; font-size:12px; }
.compose-row { display:flex; align-items:flex-end; gap:9px; }
.compose-row textarea { flex:1; resize:none; min-height:44px; max-height:130px; padding:11px 13px; border-radius:14px; border:1px solid var(--border); background:var(--surface2); color:var(--text); outline:none; }
.icon-btn,.primary,.secondary,.danger { border-radius:11px; border:1px solid var(--border); padding:9px 13px; background:var(--surface); color:var(--text); }
.primary { background:var(--accent); border-color:var(--accent); color:white; }.danger { color:#ef4444; }.secondary:hover,.icon-btn:hover { background:var(--surface2); }
.staff-panel { display:flex; flex-direction:column; overflow:hidden; }
.panel-head { padding:16px; border-bottom:1px solid var(--border); }
.search { width:100%; border:1px solid var(--border); border-radius:11px; padding:9px 11px; background:var(--surface2); color:var(--text); }
.staff-list { padding:9px; overflow:auto; }
.staff-row { width:100%; display:flex; align-items:center; gap:10px; padding:10px; border:0; border-radius:14px; background:transparent; color:var(--text); text-align:left; }
.staff-row:hover,.staff-row.active { background:var(--accentSoft); }
.staff-copy { min-width:0; flex:1; display:flex; flex-direction:column; }
.staff-copy .sub { display:block; margin-top:2px; }
.ellipsis { display:block; max-width:100%; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.empty { height:100%; min-height:220px; display:grid; place-items:center; color:var(--muted); text-align:center; padding:32px; }
.management { height:100%; padding:16px; overflow:auto; }
.management-panel { min-height:100%; padding:20px; }
.toolbar { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:20px; }
.toolbar-actions { display:flex; gap:8px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:14px; }
.card { border:1px solid var(--border); border-radius:17px; padding:16px; background:var(--surface); text-align:left; color:var(--text); transition:.15s; }
.card:hover { transform:translateY(-2px); box-shadow:0 10px 25px rgba(0,0,0,.08); }
.card-top { display:flex; gap:12px; align-items:center; }.card h3 { margin:0 0 4px; }.tags { display:flex; gap:5px; flex-wrap:wrap; margin-top:13px; }.tag { font-size:11px; padding:4px 7px; border-radius:999px; background:var(--accentSoft); color:var(--accent); }
.detail { min-height:100%; overflow:hidden; }.detail-head { padding:18px 20px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--border); }.detail-main { display:grid; grid-template-columns:190px minmax(0,1fr); min-height:600px; }.detail-nav { padding:12px; border-right:1px solid var(--border); }.nav-btn { width:100%; text-align:left; border:0; border-radius:10px; padding:10px; color:var(--muted); background:transparent; }.nav-btn.active { color:var(--text); background:var(--accentSoft); }.detail-content { padding:22px; overflow:auto; }.form-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }.field { display:flex; flex-direction:column; gap:6px; }.field.full { grid-column:1/-1; }.field label { font-size:12px; color:var(--muted); }.field input,.field textarea,.field select { border:1px solid var(--border); border-radius:10px; padding:9px 10px; background:var(--surface2); color:var(--text); }.field textarea { min-height:150px; resize:vertical; }.stats { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin:0 0 18px; }.stat { border:1px solid var(--border); border-radius:13px; padding:12px; }.stat b { display:block; font-size:18px; }.list-row { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:11px; border-bottom:1px solid var(--border); }
.modal-backdrop { position:fixed; inset:0; z-index:30; background:rgba(15,23,42,.48); backdrop-filter:blur(6px); display:grid; place-items:center; padding:20px; }
.modal { width:min(560px,100%); max-height:min(720px,calc(100vh - 40px)); display:flex; flex-direction:column; overflow:hidden; background:color-mix(in srgb,var(--surface) 95%,transparent); border-radius:24px; border:1px solid color-mix(in srgb,var(--border) 72%,white); box-shadow:0 24px 70px rgba(15,23,42,.24); }
.modal-head { padding:17px 24px; border-bottom:1px solid var(--border); display:flex; align-items:flex-start; justify-content:space-between; gap:20px; }.modal-head h3 { margin:0; font-size:16px; line-height:1.5; }.modal-head .sub { max-width:400px; line-height:1.55; }
.modal-close { width:32px; height:32px; flex:none; display:grid; place-items:center; padding:0; border:0; border-radius:9px; background:transparent; color:var(--muted); font-size:20px; line-height:1; }.modal-close:hover { background:var(--surface2); color:var(--text); }
.modal-body { padding:20px 24px; overflow:auto; }.modal-form { display:flex; flex-direction:column; gap:16px; }
.modal .field { gap:7px; }.modal .field label { font-size:12px; font-weight:600; color:var(--muted); }.required-mark { color:#ef4444; margin-left:3px; }.optional-mark { color:var(--muted); font-weight:400; margin-left:5px; }
.modal .field input { width:100%; padding:10px 14px; background:color-mix(in srgb,var(--surface) 72%,var(--surface2)); border:1px solid var(--border); border-radius:12px; outline:none; transition:border-color .16s,box-shadow .16s,background .16s; }.modal .field input:focus { border-color:var(--accent); box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 20%,transparent); background:var(--surface); }
.modal .field.invalid input { border-color:#ef4444; box-shadow:0 0 0 3px rgba(239,68,68,.12); }.field-error { display:none; color:#ef4444; font-size:12px; }.field.invalid .field-error { display:block; }
.modal-error { margin-bottom:16px; padding:10px 12px; border:1px solid rgba(239,68,68,.28); border-radius:11px; background:rgba(239,68,68,.08); color:#ef4444; font-size:12px; line-height:1.5; }.modal-error:empty { display:none; }
.modal-footer { padding:15px 24px; border-top:1px solid var(--border); display:flex; justify-content:flex-end; gap:10px; }.modal-footer .secondary,.modal-footer .primary { min-width:76px; padding:9px 16px; border-radius:12px; }.modal-footer .primary { background:linear-gradient(135deg,var(--accent),#667eea); box-shadow:0 6px 16px color-mix(in srgb,var(--accent) 22%,transparent); }
.modal.submitting { pointer-events:none; opacity:.72; }.modal-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; }.notice { color:#ef4444; font-size:12px; margin:8px 0; }.busy { opacity:.6; pointer-events:none; }
@media(max-width:850px){.office{grid-template-columns:1fr}.staff-panel{max-height:240px;order:-1}.message{max-width:88%}.composer{padding-right:76px}.detail-main{grid-template-columns:1fr}.detail-nav{display:flex;overflow:auto;border-right:0;border-bottom:1px solid var(--border)}.nav-btn{width:auto;white-space:nowrap}.stats{grid-template-columns:1fr 1fr}}

/* Flat, information-dense application layout. Rounded treatment is reserved for controls and avatars. */
.root { --bg:#f7f8fa; --surface2:#f3f5f8; font-size:13px; background:var(--bg); }
.tabs { height:68px; align-items:stretch; gap:24px; padding:20px 22px 0; -webkit-app-region:drag; }
.tab { padding:0 2px; border-bottom-width:2px; font-size:13px; -webkit-app-region:no-drag; }
.office { grid-template-columns:minmax(0,1fr) 286px; gap:0; padding:0; background:var(--bg); }
.chat,.staff-panel,.management-panel,.detail { border:0; border-radius:0; box-shadow:none; background:var(--surface); }
.chat { border-right:1px solid var(--border); }
.chat-head { min-height:60px; padding:10px 22px; }
.avatar { width:36px; height:36px; border-radius:50%; font-size:12px; }
.chat-title { font-size:13px; }
.sub { font-size:11px; margin-top:2px; }
.messages { padding:26px max(24px,calc((100% - 820px)/2)); gap:18px; background:var(--surface); }
.load-older { border-radius:3px; padding:5px 9px; font-size:11px; }
.message { line-height:1.55; font-size:13px; }
.message.user { max-width:min(70%,620px); padding:9px 12px; border-radius:8px; border:1px solid var(--border); background:var(--surface2); color:var(--text); }
.message.assistant { width:100%; max-width:820px; padding:0; border-radius:0; background:transparent; }
.message.error { padding:10px 12px; border-radius:3px; background:rgba(239,68,68,.05); }
.message-markdown { min-width:0; overflow-wrap:anywhere; }
.message-markdown > :first-child { margin-top:0; }
.message-markdown > :last-child { margin-bottom:0; }
.message-markdown p { margin:0 0 .65em; }
.message-markdown h1,.message-markdown h2,.message-markdown h3,.message-markdown h4,.message-markdown h5,.message-markdown h6 { margin:1em 0 .45em; line-height:1.3; font-weight:650; }
.message-markdown h1 { font-size:1.35em; }.message-markdown h2 { font-size:1.22em; }.message-markdown h3 { font-size:1.1em; }
.message-markdown ul,.message-markdown ol { margin:.45em 0 .7em; padding-left:1.6em; }
.message-markdown li + li { margin-top:.2em; }
.message-markdown blockquote { margin:.7em 0; padding:.15em .8em; border-left:3px solid var(--accent); color:var(--muted); }
.message-markdown code { padding:.12em .35em; border-radius:4px; background:color-mix(in srgb,var(--surface2) 82%,var(--border)); font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:.9em; }
.message-markdown pre { max-width:100%; margin:.7em 0; padding:10px 12px; overflow:auto; border:1px solid var(--border); border-radius:6px; background:var(--surface2); }
.message-markdown pre code { padding:0; background:transparent; }
.message-markdown table { display:block; max-width:100%; margin:.7em 0; overflow:auto; border-collapse:collapse; }
.message-markdown th,.message-markdown td { padding:6px 8px; border:1px solid var(--border); text-align:left; }
.message-markdown th { background:var(--surface2); font-weight:650; }
.message-markdown a { color:var(--accent); text-decoration:none; }.message-markdown a:hover { text-decoration:underline; }
.message-markdown hr { margin:.8em 0; border:0; border-top:1px solid var(--border); }
.message-markdown img { display:block; max-width:100%; max-height:320px; margin:.6em 0; border-radius:4px; object-fit:contain; }
.message.user .message-markdown pre,.message.user .message-markdown code,.message.user .message-markdown th { background:var(--surface); }
.message-meta { margin-top:6px; font-size:9px; color:var(--muted); opacity:.68; align-items:center; }
.message-meta .chip { max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.resource img,.resource video { border-radius:3px; }
.composer { padding:10px max(20px,calc((100% - 840px)/2)) 12px; background:var(--surface); }
.compose-row { width:100%; padding:5px; gap:5px; align-items:center; border:1px solid var(--border); border-radius:10px; background:var(--surface); box-shadow:0 1px 4px rgba(15,23,42,.04); }
.compose-row textarea { min-height:38px; max-height:120px; padding:9px 8px; border:0; border-radius:0; background:transparent; }
.compose-row textarea:focus { box-shadow:none; }
.icon-btn,.primary,.secondary,.danger { border-radius:4px; padding:7px 10px; font-size:12px; }
.compose-row .icon-btn { width:34px; height:34px; padding:0; border:0; background:transparent; color:var(--muted); font-size:18px; }
.compose-row .primary { height:34px; padding:0 13px; }
.chip { border-radius:3px; padding:3px 6px; font-size:10px; }
.staff-panel { border-left:0; }
.panel-head { padding:10px 12px; }
.search { border-radius:4px; padding:7px 9px; font-size:12px; background:var(--surface); }
.staff-list { padding:0; }
.staff-row { gap:9px; padding:10px 12px; border-radius:0; border-bottom:1px solid var(--border); }
.staff-row[hidden] { display:none; }
.staff-row:hover { background:var(--surface2); }
.staff-row.active { box-shadow:inset 3px 0 0 var(--accent); background:var(--accentSoft); }
.staff-row .avatar { width:34px; height:34px; }
.staff-avatar-trigger { display:inline-flex; flex:none; }
.staff-preview { position:fixed; z-index:20; width:300px; min-height:158px; margin:0; pointer-events:auto; box-shadow:0 18px 46px rgba(15,23,42,.22); }
.staff-preview[hidden] { display:none; }
.staff-preview:hover { border-color:var(--border); background:var(--surface); box-shadow:0 18px 46px rgba(15,23,42,.22); }
:host([data-theme='dark']) .staff-preview { box-shadow:0 20px 50px rgba(0,0,0,.5); }
.management { padding:0; overflow:auto; background:var(--bg); font-size:12px; }
.management-panel { min-height:100%; padding:0; }
.toolbar { min-height:52px; margin:0; padding:8px 16px; border-bottom:1px solid var(--border); }
.toolbar-title { font-size:14px; font-weight:650; }
.toolbar-actions { gap:6px; }
.grid { grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:10px; padding:14px 16px; }
.card { min-height:158px; padding:13px 14px 12px; border:1px solid var(--border); border-radius:14px; background:var(--surface); }
.card:hover { transform:none; border-color:color-mix(in srgb,var(--accent) 46%,var(--border)); box-shadow:0 5px 14px rgba(15,23,42,.06); background:color-mix(in srgb,var(--surface) 94%,var(--accentSoft)); }
.card-profile { display:flex; align-items:center; gap:10px; }
.card-identity { min-width:0; flex:1; }
.card .avatar { width:38px; height:38px; border-radius:7px; }
.card h3 { margin:0 0 2px; font-size:13px; }
.card-status { flex:none; display:inline-flex; align-items:center; gap:4px; padding:3px 6px; border:1px solid var(--border); border-radius:999px; color:var(--muted); font-size:9px; font-weight:600; }
.card-status::before { content:''; width:5px; height:5px; border-radius:50%; background:#9ca3af; }
.card-status.on { color:#18864b; border-color:color-mix(in srgb,#28b76b 32%,var(--border)); background:color-mix(in srgb,#28b76b 9%,var(--surface)); }
.card-status.on::before { background:#28b76b; }
.card-status.run { color:#b46a05; border-color:color-mix(in srgb,#f59e0b 38%,var(--border)); background:color-mix(in srgb,#f59e0b 9%,var(--surface)); }
.card-status.run::before { background:#f59e0b; }
:host([data-theme='dark']) .card-status.on { color:#72d89e; }
:host([data-theme='dark']) .card-status.run { color:#f4bd64; }
.tags { gap:4px; margin-top:10px; min-height:18px; max-height:36px; overflow:hidden; }
.tag { padding:2px 5px; border-radius:2px; font-size:9px; }
.card-divider { margin:10px 0 9px; border-top:1px dashed color-mix(in srgb,var(--border) 82%,var(--muted)); }
.card-metrics { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:9px; }
.card-metric { position:relative; min-width:0; padding-top:7px; color:var(--muted); font-size:9px; }
.card-metric::before { content:''; position:absolute; top:0; left:0; right:0; height:2px; border-radius:999px; background:#36b96d; }
.card-metric:nth-child(2)::before { background:#47a9e8; }
.card-metric:nth-child(3)::before { background:#e7ad36; }
.card-metric b { display:block; overflow:hidden; color:var(--text); font-size:12px; line-height:1.35; text-overflow:ellipsis; white-space:nowrap; }
.card-metric span { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.detail { min-height:100%; }
.detail-head { min-height:58px; padding:9px 16px; }
.detail-head .avatar { width:36px; height:36px; }
.detail-avatar-button { width:36px; height:36px; flex:none; padding:0; border:0; border-radius:50%; background:transparent; }
.detail-avatar-button:hover { box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 20%,transparent); }
.detail-avatar-button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.auto-save-indicator { display:inline-flex; align-items:center; gap:5px; min-width:54px; color:var(--muted); font-size:10px; white-space:nowrap; }
.auto-save-indicator::before { content:''; width:6px; height:6px; border-radius:50%; background:currentColor; }
.auto-save-indicator[data-state='saving']::before { animation:auto-save-pulse 1s ease-in-out infinite; }
.auto-save-indicator[data-state='saved'] { color:#18864b; }
.auto-save-indicator[data-state='invalid'],.auto-save-indicator[data-state='error'] { color:#dc2626; }
.auto-save-indicator[data-state='idle'] { visibility:hidden; }
:host([data-theme='dark']) .auto-save-indicator[data-state='saved'] { color:#72d89e; }
:host([data-theme='dark']) .auto-save-indicator[data-state='invalid'],:host([data-theme='dark']) .auto-save-indicator[data-state='error'] { color:#fca5a5; }
@keyframes auto-save-pulse { 50% { opacity:.35; } }
.detail-notice { margin:0; padding:8px 16px; border-bottom:1px solid rgba(239,68,68,.22); background:rgba(239,68,68,.07); color:#dc2626; font-size:11px; line-height:1.5; }
.detail-notice[hidden] { display:none; }
:host([data-theme='dark']) .detail-notice { color:#fca5a5; }
.detail-main { grid-template-columns:164px minmax(0,1fr); min-height:calc(100vh - 126px); }
.detail-nav { padding:8px 0; background:var(--surface); }
.nav-btn { padding:8px 14px; border-radius:0; border-left:3px solid transparent; font-size:12px; }
.nav-btn:hover { background:var(--surface2); }
.nav-btn.active { border-left-color:var(--accent); background:var(--accentSoft); }
.detail-content { padding:20px 24px; font-size:12px; background:var(--bg); }
.settings-page { width:100%; max-width:980px; margin:0 auto; }
.settings-section { margin-bottom:16px; padding:17px 18px; border:1px solid var(--border); border-radius:12px; background:var(--surface); }
.settings-section-head { min-height:28px; margin-bottom:14px; display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
.settings-section-head:last-child { margin-bottom:0; }
.settings-section-title { margin:0; color:var(--text); font-size:13px; font-weight:650; line-height:1.5; }
.settings-section-desc { margin:3px 0 0; color:var(--muted); font-size:10px; line-height:1.5; }
.settings-actions { margin-top:14px; padding-top:14px; display:flex; align-items:center; justify-content:flex-end; gap:7px; border-top:1px solid var(--border); }
.settings-form { max-width:none; }
.form-grid { gap:13px 15px; max-width:none; }
.field { gap:6px; }
.field label { font-size:11px; font-weight:600; color:var(--text); }
.field input,.field textarea,.field select { border-radius:10px; padding:8px 10px; background:var(--surface); font-size:12px; outline:none; transition:border-color .15s,box-shadow .15s; }
.field input:focus,.field textarea:focus,.field select:focus { border-color:var(--accent); box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 14%,transparent); }
.settings-form .field.invalid input { border-color:#ef4444; box-shadow:0 0 0 3px rgba(239,68,68,.1); }
.field.invalid textarea { border-color:#ef4444; box-shadow:0 0 0 3px rgba(239,68,68,.1); }
.field textarea { min-height:130px; line-height:1.55; }
.setting-check-row { min-height:42px; padding:9px 0; display:flex; align-items:center; justify-content:space-between; gap:12px; border-bottom:1px solid var(--border); }
.network-setting-row { border-bottom:0; }
.setting-check-copy { min-width:0; color:var(--text); font-size:12px; font-weight:600; }
.setting-toggle { position:relative; width:40px; height:22px; flex:none; margin-left:16px; }
.setting-toggle input { position:absolute; width:1px; height:1px; opacity:0; }
.setting-toggle-track { position:absolute; inset:0; border-radius:11px; background:#d1d5db; cursor:pointer; transition:background .2s; }
.setting-toggle-track::after { content:''; position:absolute; top:2px; left:2px; width:18px; height:18px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(15,23,42,.3); transition:transform .2s; }
.setting-toggle input:checked + .setting-toggle-track { background:var(--accent); }
.setting-toggle input:checked + .setting-toggle-track::after { transform:translateX(18px); }
:host([data-theme='dark']) .setting-toggle-track { background:#4b5563; }
.stats { gap:9px; margin:0; border:0; max-width:none; }
.stat { min-height:66px; padding:10px 11px; border:1px solid var(--border); border-radius:10px; background:var(--surface2); color:var(--muted); font-size:10px; }
.stat b { margin-bottom:3px; color:var(--text); font-size:15px; }
.list-row { min-height:48px; padding:9px 2px; font-size:11px; }
.list-row select { max-width:150px; padding:7px 28px 7px 9px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--text); font-size:11px; }
.settings-section .list-row:last-child { border-bottom:0; }
.directory-table { overflow:hidden; border:1px solid var(--border); border-radius:10px; background:var(--surface); }
.directory-grid { display:grid; grid-template-columns:minmax(0,1fr) 116px 32px; align-items:center; gap:10px; }
.directory-header { min-height:34px; padding:7px 10px; border-bottom:1px solid var(--border); background:var(--surface2); color:var(--muted); font-size:10px; font-weight:600; }
.directory-row { min-height:46px; padding:7px 10px; border-bottom:1px solid var(--border); }
.directory-row:last-child { border-bottom:0; }
.directory-path { min-width:0; overflow:hidden; color:var(--text); font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
.directory-row select { width:100%; max-width:none; height:32px; padding:5px 30px 5px 9px; appearance:none; border:1px solid var(--border); border-radius:4px; background-color:var(--surface); background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='%236b7280' viewBox='0 0 16 16'%3E%3Cpath d='M4.5 6l3.5 4 3.5-4z'/%3E%3C/svg%3E"); background-repeat:no-repeat; background-position:right 8px center; color:var(--text); cursor:pointer; }
.directory-remove { width:32px; height:30px; padding:0; display:grid; place-items:center; }
.directory-empty { padding:22px 12px; color:var(--muted); text-align:center; font-size:11px; }
.settings-section .empty { min-height:160px; }
.modal-backdrop { background:rgba(0,0,0,.18); backdrop-filter:blur(8px); }
.modal { width:min(680px,94%); border:1px solid rgba(0,0,0,.05); border-radius:18px; background:var(--surface); box-shadow:0 24px 80px -16px rgba(0,0,0,.22); }
.modal-head { padding:20px 24px 16px; }
.modal-head h3 { font-size:16px; }
.modal-close { width:28px; height:28px; border-radius:50%; background:var(--surface2); font-size:16px; }
.modal-body { padding:20px 24px 24px; }
.modal-form { gap:14px; }
.modal .field input { padding:10px 12px; border-radius:10px; background:var(--surface); }
.modal-error { border-radius:8px; }
.modal-footer { padding:12px 24px; background:var(--surface); }
.modal-footer .secondary,.modal-footer .primary,.modal-footer .danger { min-width:68px; padding:7px 16px; border-radius:8px; }
.modal-footer .primary { background:#6ba3ef; box-shadow:none; }
:host([data-theme='dark']) .modal-backdrop { background:rgba(0,0,0,.55); }
:host([data-theme='dark']) .modal { border-color:rgba(255,255,255,.2); background:#252526; color:#ccc; }
:host([data-theme='dark']) .modal-head,:host([data-theme='dark']) .modal-footer { border-color:rgba(255,255,255,.12); background:#252526; }
:host([data-theme='dark']) .modal-close { background:#3f3f46; color:#ccc; }
:host([data-theme='dark']) .modal-close:hover { background:#4a4a4d; color:#fff; }
:host([data-theme='dark']) .modal .field input { border-color:rgba(255,255,255,.2); background:#333; color:#ccc; }
:host([data-theme='dark']) .modal-footer .secondary,:host([data-theme='dark']) .modal-footer .danger { border-color:rgba(255,255,255,.2); background:#333; color:#ccc; }
:host([data-theme='dark']) .modal-footer .danger { color:#f08a8a; }
:host([data-theme='dark']) .modal-footer .primary { border-color:#3b82f6; background:#3b82f6; color:#fff; }
.portrait-editor { display:grid; grid-template-columns:minmax(220px,300px) minmax(150px,1fr); gap:18px; align-items:start; }
.portrait-crop { position:relative; width:min(300px,100%); aspect-ratio:1; overflow:hidden; border:1px solid var(--border); background:linear-gradient(45deg,var(--surface2) 25%,transparent 25%,transparent 75%,var(--surface2) 75%),linear-gradient(45deg,var(--surface2) 25%,var(--surface) 25%,var(--surface) 75%,var(--surface2) 75%); background-position:0 0,8px 8px; background-size:16px 16px; touch-action:none; cursor:grab; }
.portrait-crop.dragging { cursor:grabbing; }
.portrait-crop canvas { display:block; width:100%; height:100%; }
.portrait-crop-guide { position:absolute; inset:8%; border:1px solid rgba(255,255,255,.92); border-radius:50%; box-shadow:0 0 0 999px rgba(15,23,42,.32),0 0 0 1px rgba(15,23,42,.25); pointer-events:none; }
.portrait-crop-empty { position:absolute; inset:0; display:grid; place-items:center; padding:24px; color:var(--muted); text-align:center; font-size:11px; line-height:1.6; pointer-events:none; }
.portrait-crop-empty[hidden] { display:none; }
.portrait-controls { display:flex; flex-direction:column; gap:14px; }
.portrait-controls .secondary { align-self:flex-start; }
.portrait-file-input { display:none; }
.portrait-zoom { display:flex; flex-direction:column; gap:7px; color:var(--muted); font-size:11px; }
.portrait-zoom input { width:100%; accent-color:var(--accent); }
.skills-page { position:relative; min-height:100%; }
.skills-toolbar { min-height:38px; display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
.skills-toolbar h3 { margin:0; font-size:13px; }
.skills-add-anchor { position:relative; }
.skills-add-button { width:30px; height:30px; padding:0; display:grid; place-items:center; border:0; border-radius:4px; background:transparent; color:var(--text); font-size:14px; }
.skills-add-button:hover { background:var(--surface2); }
.skills-add-menu { position:absolute; top:34px; right:0; z-index:12; width:255px; padding:4px; border:1px solid var(--border); border-radius:9px; background:var(--surface); box-shadow:0 12px 34px rgba(15,23,42,.18); }
.skills-add-menu button { width:100%; padding:8px 9px; display:flex; align-items:center; gap:10px; border:0; border-radius:6px; background:transparent; color:var(--text); text-align:left; }
.skills-add-menu button:hover { background:var(--surface2); }
.skills-add-menu-divider { height:1px; margin:4px 3px; background:var(--border); }
.skill-menu-icon { width:30px; height:30px; display:grid; place-items:center; flex:none; border-radius:8px; }
.skill-menu-icon.folder { color:#5b8def; background:#ebf3fe; }.skill-menu-icon.zip { color:#e8935a; background:#fef1e6; }.skill-menu-icon.batch,.skill-menu-icon.installed { color:#4caf6e; background:#e7f6ea; }.skill-menu-icon.url { color:#8b5cf6; background:#f1eafe; }
:host([data-theme='dark']) .skill-menu-icon.folder { background:rgba(91,141,239,.18); }:host([data-theme='dark']) .skill-menu-icon.zip { background:rgba(232,147,90,.18); }:host([data-theme='dark']) .skill-menu-icon.batch,:host([data-theme='dark']) .skill-menu-icon.installed { background:rgba(76,175,110,.18); }:host([data-theme='dark']) .skill-menu-icon.url { background:rgba(139,92,246,.18); }
.skill-menu-copy { display:flex; flex-direction:column; gap:2px; }.skill-menu-copy b { font-size:12px; }.skill-menu-copy span { color:var(--muted); font-size:10px; }
.skill-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:10px; }
.skill-card { min-height:126px; padding:13px; display:flex; flex-direction:column; border:1px solid var(--border); border-radius:14px; background:var(--surface); color:var(--text); text-align:left; }
.skill-card:hover { border-color:color-mix(in srgb,var(--accent) 48%,var(--border)); box-shadow:0 5px 14px rgba(15,23,42,.07); }
.skill-card-head { display:flex; align-items:center; gap:10px; }.skill-card-icon { width:36px; height:36px; display:grid; place-items:center; flex:none; border-radius:9px; background:var(--accentSoft); color:var(--accent); font-size:15px; }.skill-card h4 { margin:0; overflow:hidden; font-size:12px; text-overflow:ellipsis; white-space:nowrap; }.skill-card-id { margin-top:2px; color:var(--muted); font-size:9px; }.skill-card-desc { margin:10px 0 0; display:-webkit-box; overflow:hidden; color:var(--muted); font-size:10px; line-height:1.5; -webkit-box-orient:vertical; -webkit-line-clamp:2; }
.installed-skill-list { max-height:min(380px,50vh); overflow:auto; border:1px solid var(--border); border-radius:10px; background:var(--surface); }
.installed-skill-row { padding:10px 12px; display:grid; grid-template-columns:18px minmax(0,1fr); gap:10px; border-bottom:1px solid var(--border); cursor:pointer; transition:background .12s; }.installed-skill-row:last-child { border-bottom:0; }.installed-skill-row:hover { background:var(--surface2); }.installed-skill-row.disabled { opacity:.55; cursor:default; }.installed-skill-row input { width:15px; height:15px; margin:2px 0 0; accent-color:var(--accent); }.installed-skill-row b { display:block; font-size:12px; }.installed-skill-row span { display:block; margin-top:2px; color:var(--muted); font-size:10px; line-height:1.45; }
.skill-import-result-icon { width:18px; padding-top:1px; color:#22a061; text-align:center; }.skill-import-result-icon.error { color:#ef4444; }
.portrait-format-hint { margin:0; color:var(--muted); font-size:10px; line-height:1.55; }
@media(max-width:620px){.portrait-editor{grid-template-columns:1fr}.portrait-crop{margin:0 auto}.portrait-controls{align-items:stretch}}
@media(max-width:760px){.detail-head{align-items:flex-start;flex-wrap:wrap}.detail-head>.toolbar-actions{width:100%;padding-left:48px;flex-wrap:wrap}.detail-head>.toolbar-actions button{flex:1 1 auto}.form-grid{grid-template-columns:1fr}.field.full{grid-column:1}.directory-grid{grid-template-columns:minmax(0,1fr) 104px 32px}}
@media(max-width:850px){.office{grid-template-columns:1fr}.staff-panel{max-height:220px;order:-1;border-bottom:1px solid var(--border)}.chat{border-right:0}.composer{padding:10px 16px 12px}.detail-main{min-height:auto}.management{font-size:12px}}
`;

export class AgentOfficeEntryWidget extends AgentOperableHTMLElement {
    private strings: Record<string, string> = {};
    private locale = 'en-US';
    private staffs: StaffListItem[] = [];
    private selectedStaffId: string | null = null;
    private messages: StaffMessage[] = [];
    private historyCursor?: string;
    private activeTab: 'office' | 'management' = 'office';
    private detail: StaffDetail | null = null;
    private detailSection: DetailSection = 'basic';
    private skills: StaffSkillSummary[] = [];
    private installedSkills: InstalledSkillSummary[] = [];
    private selectedInstalledSkillIds = new Set<string>();
    private batchSkillCandidates: StaffSkillImportCandidate[] = [];
    private selectedBatchSkillPaths = new Set<string>();
    private skillBatchResult: StaffSkillBatchImportResult | null = null;
    private skillUrl = '';
    private skillModalError = '';
    private selectedSkill: StaffSkillSummary | null = null;
    private skillAddMenuOpen = false;
    private modelCatalog: ModelCatalog = { default_model: '', models: [] };
    private attachments: { path: string; name: string }[] = [];
    private query = '';
    private busy = false;
    private modal:
        | 'new'
        | 'delete'
        | 'portrait'
        | 'installed-skills'
        | 'batch-skills'
        | 'skill-url'
        | 'skill-detail'
        | null = null;
    private status = '';
    private previewHideTimer?: ReturnType<typeof setTimeout>;
    private portraitImage?: HTMLImageElement;
    private portraitZoom = 1;
    private portraitOffsetX = 0;
    private portraitOffsetY = 0;
    private portraitError = '';
    private autoSaveTimer?: ReturnType<typeof setTimeout>;
    private autoSaveIndicatorTimer?: ReturnType<typeof setTimeout>;
    private autoSaveRunning = false;
    private autoSaveState: AutoSaveState = 'idle';
    private autoSaveDetail = '';
    private readonly pendingAutoSaves = new Map<string, StaffUpdateInput>();
    private readonly failedAutoSaveStaffIds = new Set<string>();
    private readonly onStaffsChanged = () => void this.refreshStaffSummaries();
    private readonly onMessagesChanged = (staffId: string) => {
        if (staffId !== this.selectedStaffId) return;
        if (this.activeTab === 'office') void this.loadMessages();
        else void this.refreshStaffSummaries();
    };
    private readonly onThemeChanged = (event: Event) => {
        const detail = (event as CustomEvent<{ effective?: 'light' | 'dark' }>).detail;
        syncShadowHostTheme(this, detail?.effective);
        const skillDetail = this.shadowRoot?.querySelector<SkillDetailCard>('#staff-skill-detail-card');
        if (skillDetail && detail?.effective) skillDetail.dataset.theme = detail.effective;
    };
    private readonly dismissMessageContextMenu = (event?: Event) => {
        const target = event?.composedPath()[0];
        if (target instanceof Element && target.closest('.message-context-menu')) return;
        this.shadowRoot?.querySelector('.message-context-menu')?.remove();
        window.removeEventListener('mousedown', this.dismissMessageContextMenu);
    };

    connectedCallback(): void {
        if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
        syncShadowHostTheme(this);
        document.addEventListener(OPENDESK_THEME_CHANGED, this.onThemeChanged);
        window.applicationAPI.subscribe('staffsChanged', this.onStaffsChanged);
        window.applicationAPI.subscribe('messagesChanged', this.onMessagesChanged);
        window.applicationAPI.subscribe('staffTaskChanged', this.onStaffsChanged);
        void this.initialize();
    }

    disconnectedCallback(): void {
        if (this.previewHideTimer) clearTimeout(this.previewHideTimer);
        if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
        if (this.autoSaveIndicatorTimer) clearTimeout(this.autoSaveIndicatorTimer);
        window.removeEventListener('mousedown', this.dismissMessageContextMenu);
        void this.flushAutoSave();
        document.removeEventListener(OPENDESK_THEME_CHANGED, this.onThemeChanged);
        window.applicationAPI.unsubscribe('staffsChanged', this.onStaffsChanged);
        window.applicationAPI.unsubscribe('messagesChanged', this.onMessagesChanged);
        window.applicationAPI.unsubscribe('staffTaskChanged', this.onStaffsChanged);
    }

    private tr(key: string): string {
        return this.strings[key] ?? key;
    }

    private formatText(key: string, values: Record<string, string | number>): string {
        let result = this.tr(key);
        for (const [name, value] of Object.entries(values)) {
            result = result.replaceAll(`\${${name}}`, String(value));
        }
        return result;
    }

    private async call<T>(method: string, ...args: unknown[]): Promise<T> {
        return unwrapAgentOfficeCallResult<T>(
            await window.applicationAPI.callMainWorld(method, ...args),
            this.tr('agentoffice.operationFailed')
        );
    }

    private async initialize(): Promise<void> {
        try {
            [this.strings, this.locale, this.modelCatalog] = await Promise.all([
                this.call('getLocalizedStrings'),
                this.call('getLocale'),
                this.call('listChatModels')
            ]);
            await this.reloadStaffs();
        } catch (error) {
            this.status = `${this.tr('agentoffice.loadFailed')}: ${this.errorText(error)}`;
            this.render();
        }
    }

    private async reloadStaffs(): Promise<void> {
        this.staffs = await this.call('listStaffs');
        if (this.selectedStaffId && !this.staffs.some((staff) => staff.id === this.selectedStaffId)) {
            this.selectedStaffId = null;
            this.detail = null;
            this.messages = [];
        }
        if (!this.selectedStaffId && this.staffs.length > 0) this.selectedStaffId = this.staffs[0].id;
        if (this.activeTab === 'office' && this.selectedStaffId) await this.loadMessages();
        if (this.activeTab === 'management' && this.detail) await this.openDetail(this.detail.id);
        this.render();
    }

    private async refreshStaffSummaries(): Promise<void> {
        try {
            this.staffs = await this.call('listStaffs');
            if (this.selectedStaffId && !this.staffs.some((staff) => staff.id === this.selectedStaffId)) {
                this.selectedStaffId = null;
                this.detail = null;
                this.messages = [];
            }
            if (!this.selectedStaffId && this.staffs.length > 0) this.selectedStaffId = this.staffs[0].id;
            if (this.activeTab === 'office' && this.selectedStaffId) {
                await this.loadMessages();
            } else if (!this.detail) {
                this.render();
            }
        } catch (error) {
            this.status = `${this.tr('agentoffice.loadFailed')}: ${this.errorText(error)}`;
            if (!this.detail) this.render();
        }
    }

    private async loadMessages(cursor?: string): Promise<void> {
        if (!this.selectedStaffId) return;
        const result = await this.call<{ messages: StaffMessage[]; has_more: boolean; next_cursor?: string }>(
            'getHistoryMessagesForUI',
            this.selectedStaffId,
            { mode: 'recent', limit: 50, cursor }
        );
        this.messages = cursor ? [...result.messages, ...this.messages] : result.messages;
        this.historyCursor = result.next_cursor;
        this.render();
        if (!cursor) requestAnimationFrame(() => this.scrollMessages());
    }

    private render(): void {
        if (!this.shadowRoot) return;
        this.shadowRoot.innerHTML = `<style>${CSS}</style><div class="root ${this.busy ? 'busy' : ''}">
            <div class="tabs">
                ${this.tabButton('office', this.tr('agentoffice.tab.office'))}
                ${this.tabButton('management', this.tr('agentoffice.tab.management'))}
            </div>
            <div class="body">${this.activeTab === 'office' ? this.renderOffice() : this.renderManagement()}</div>
            ${this.renderModal()}
        </div>`;
        this.bindEvents();
    }

    private tabButton(id: 'office' | 'management', label: string): string {
        return `<button class="tab ${this.activeTab === id ? 'active' : ''}" data-tab="${id}">${escapeHtml(label)}</button>`;
    }

    private renderOffice(): string {
        if (this.staffs.length === 0) {
            return `<div class="empty"><div><h3>${escapeHtml(this.tr('agentoffice.noStaff'))}</h3><p>${escapeHtml(this.tr('agentoffice.noStaffHint'))}</p><button class="primary" data-tab="management">${escapeHtml(this.tr('agentoffice.tab.management'))}</button></div></div>`;
        }
        const staff = this.staffs.find((item) => item.id === this.selectedStaffId) ?? this.staffs[0];
        const normalizedQuery = this.query.trim().toLowerCase();
        return `<div class="office">
            <section class="chat">
                <div class="chat-head">${this.avatar(staff)}<div><div class="chat-title">${escapeHtml(staff.name)}</div><div class="sub"><span class="status-dot ${staff.active_task_id ? 'run' : staff.enabled ? 'on' : ''}"></span>${escapeHtml(staff.active_task_id ? this.tr('agentoffice.running') : staff.enabled ? this.tr('agentoffice.enabled') : this.tr('agentoffice.disabled'))} · ${escapeHtml(staff.title)}</div></div></div>
                <div class="messages" id="messages">${this.renderMessages(staff.id)}</div>
                <div class="composer">
                    ${this.status ? `<div class="notice">${escapeHtml(this.status)}</div>` : ''}
                    ${this.attachments.length ? `<div class="attachment-list">${this.attachments.map((item, index) => `<button class="chip" data-remove-attachment="${index}">${escapeHtml(item.name)} ×</button>`).join('')}</div>` : ''}
                    <div class="compose-row"><button class="icon-btn" data-action="attach" title="${escapeHtml(this.tr('agentoffice.attach'))}">＋</button><textarea id="message-input" placeholder="${escapeHtml(this.tr('agentoffice.messagePlaceholder'))}" ${staff.enabled ? '' : 'disabled'}></textarea><button class="primary" data-action="send" ${staff.enabled ? '' : 'disabled'}>${escapeHtml(this.tr('agentoffice.send'))}</button></div>
                </div>
            </section>
            <aside class="staff-panel"><div class="panel-head"><input class="search" id="staff-search" value="${escapeHtml(this.query)}" placeholder="${escapeHtml(this.tr('agentoffice.searchStaff'))}"></div><div class="staff-list">${this.staffs
                .map((item) => {
                    const searchText = `${item.name} ${item.title}`.toLowerCase();
                    return `<button class="staff-row ${item.id === staff.id ? 'active' : ''}" data-staff="${item.id}" data-search-text="${escapeHtml(searchText)}" ${normalizedQuery && !searchText.includes(normalizedQuery) ? 'hidden' : ''}><span class="staff-avatar-trigger" data-staff-preview="${item.id}">${this.avatar(item)}</span><span class="staff-copy"><b class="ellipsis">${escapeHtml(item.name)}</b><span class="sub ellipsis"><span class="status-dot ${item.active_task_id ? 'run' : item.enabled ? 'on' : ''}"></span>${escapeHtml(item.title)}</span></span></button>`;
                })
                .join('')}</div></aside><div class="card staff-preview" id="staff-preview" hidden></div>
        </div>`;
    }

    private avatar(staff: StaffListItem): string {
        return staff.portrait_url
            ? `<img class="avatar" src="${escapeHtml(staff.portrait_url)}" alt="">`
            : `<span class="avatar">${escapeHtml(staff.name.slice(0, 1).toUpperCase())}</span>`;
    }

    private renderMessages(staffId: string): string {
        if (this.messages.length === 0)
            return `<div class="empty">${escapeHtml(this.tr('agentoffice.noMessages'))}</div>`;
        return `${this.historyCursor ? `<button class="load-older" data-action="older">${escapeHtml(this.tr('agentoffice.loadOlder'))}</button>` : ''}${this.messages
            .map((message) => {
                const parts = message.content
                    .map((part) => {
                        if (part.type === 'text')
                            return `<div class="message-markdown markdown-body">${renderSafeMarkdown(part.text)}</div>`;
                        const url = `agentoffice://resource/${staffId}/${part.path}`;
                        if (part.media_type === 'image')
                            return `<div class="resource"><img src="${escapeHtml(url)}" alt="${escapeHtml(part.name)}"></div>`;
                        if (part.media_type === 'video')
                            return `<div class="resource"><video controls src="${escapeHtml(url)}"></video></div>`;
                        if (part.media_type === 'audio')
                            return `<div class="resource"><audio controls src="${escapeHtml(url)}"></audio></div>`;
                        return `<div class="resource"><a href="${escapeHtml(url)}" target="_blank">📎 ${escapeHtml(part.name)}</a></div>`;
                    })
                    .join('');
                return `<div class="message ${message.role} ${message.kind === 'error' ? 'error' : ''}" data-message-id="${escapeHtml(message.id)}" data-message-task="${escapeHtml(message.task_id)}">${parts}<div class="message-meta"><span>${escapeHtml(new Date(message.created_at).toLocaleString(this.locale))}</span></div></div>`;
            })
            .join('')}`;
    }

    private renderManagement(): string {
        if (this.detail) return `<div class="management">${this.renderDetail()}</div>`;
        return `<div class="management"><section class="management-panel"><div class="toolbar"><div><span class="toolbar-title">${escapeHtml(this.tr('agentoffice.tab.management'))}</span>${this.status ? `<span class="notice">${escapeHtml(this.status)}</span>` : ''}</div><div class="toolbar-actions"><button class="secondary" data-action="import">${escapeHtml(this.tr('agentoffice.importZip'))}</button><button class="primary" data-action="new">${escapeHtml(this.tr('agentoffice.newStaff'))}</button></div></div>${this.staffs.length === 0 ? `<div class="empty">${escapeHtml(this.tr('agentoffice.noStaffHint'))}</div>` : `<div class="grid">${this.staffs.map((staff) => `<button class="card" data-detail="${staff.id}">${this.staffCardContent(staff)}</button>`).join('')}</div>`}</section></div>`;
    }

    private staffCardContent(staff: StaffListItem): string {
        return `<div class="card-profile">${this.avatar(staff)}<div class="card-identity"><h3 class="ellipsis">${escapeHtml(staff.name)}</h3><div class="sub ellipsis">${escapeHtml(staff.title)} · ${escapeHtml(staff.vendor_name)}</div></div><span class="card-status ${staff.active_task_id ? 'run' : staff.enabled ? 'on' : ''}">${escapeHtml(staff.active_task_id ? this.tr('agentoffice.running') : staff.enabled ? this.tr('agentoffice.enabled') : this.tr('agentoffice.disabled'))}</span></div><div class="tags">${staff.specialties.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div><div class="card-divider"></div><div class="card-metrics"><div class="card-metric"><b>${staff.message_count.toLocaleString(this.locale)}</b><span>${escapeHtml(this.tr('agentoffice.messagesStat'))}</span></div><div class="card-metric"><b>${staff.task_count.toLocaleString(this.locale)}</b><span>${escapeHtml(this.tr('agentoffice.tasksStat'))}</span></div><div class="card-metric"><b>${(staff.usage_summary?.total_tokens ?? 0).toLocaleString(this.locale)}</b><span>${escapeHtml(this.tr('agentoffice.tokensStat'))}</span></div></div>`;
    }

    private renderDetail(): string {
        const detail = this.detail!;
        const portraitLabel = escapeHtml(this.tr('agentoffice.changePortrait'));
        return `<section class="detail"><div class="detail-head"><div style="display:flex;align-items:center;gap:12px"><button class="secondary" data-action="back" title="${escapeHtml(this.tr('agentoffice.back'))}" aria-label="${escapeHtml(this.tr('agentoffice.back'))}"><i class="fa-solid fa-arrow-left"></i></button><button class="detail-avatar-button" data-action="portrait" title="${portraitLabel}" aria-label="${portraitLabel}">${this.avatar(detail)}</button><div><b data-detail-name>${escapeHtml(detail.name)}</b><div class="sub" data-detail-title>${escapeHtml(detail.title)}</div></div><span class="auto-save-indicator" data-state="${this.autoSaveState}" aria-live="polite">${escapeHtml(this.autoSaveDetail)}</span></div><div class="toolbar-actions"><button class="secondary" data-action="portrait">${portraitLabel}</button><button class="secondary" data-action="open-directory">${escapeHtml(this.tr('agentoffice.openStaffDirectory'))}</button><button class="secondary" data-action="export">${escapeHtml(this.tr('agentoffice.exportZip'))}</button><button class="danger" data-action="delete">${escapeHtml(this.tr('agentoffice.delete'))}</button></div></div><p class="detail-notice" role="alert" ${this.status ? '' : 'hidden'}>${escapeHtml(this.status)}</p><div class="detail-main"><nav class="detail-nav">${(['basic', 'skills', 'mcp', 'security', 'tasks'] as DetailSection[]).map((section) => `<button class="nav-btn ${this.detailSection === section ? 'active' : ''}" data-section="${section}">${escapeHtml(this.tr(`agentoffice.${section}`))}</button>`).join('')}</nav><div class="detail-content">${this.renderDetailSection(detail)}</div></div></section>`;
    }

    private renderDetailSection(detail: StaffDetail): string {
        if (this.detailSection === 'basic') {
            const usage = detail.usage_summary?.total_tokens ?? 0;
            const required = `<span class="required-mark" aria-hidden="true">*</span>`;
            const requiredError = escapeHtml(this.tr('agentoffice.fieldRequired'));
            const defaultModelLabel = this.modelCatalog.default_model
                ? `${this.tr('agentoffice.modelGlobalDefault')} (${this.modelCatalog.default_model})`
                : this.tr('agentoffice.modelGlobalDefault');
            const missingSelectedModel =
                detail.model && !this.modelCatalog.models.some((model) => model.alias === detail.model)
                    ? `<option value="${escapeHtml(detail.model)}" selected>${escapeHtml(detail.model)}</option>`
                    : '';
            return `<div class="settings-page">
                <section class="settings-section"><div class="settings-section-head"><h3 class="settings-section-title">${escapeHtml(this.tr('agentoffice.basic'))}</h3></div><div class="stats"><div class="stat"><b>${detail.message_count}</b>${escapeHtml(this.tr('agentoffice.messagesStat'))}</div><div class="stat"><b>${detail.task_count}</b>${escapeHtml(this.tr('agentoffice.tasksStat'))}</div><div class="stat"><b>${usage.toLocaleString(this.locale)}</b>${escapeHtml(this.tr('agentoffice.tokensStat'))}</div><div class="stat"><b>${escapeHtml(new Date(detail.hired_at).toLocaleDateString(this.locale))}</b>${escapeHtml(this.tr('agentoffice.hiredAt'))}</div></div></section>
                <section class="settings-section"><div class="form-grid settings-form"><div class="field" data-basic-field="name"><label for="f-name">${escapeHtml(this.tr('agentoffice.nameLabel'))}${required}</label><input id="f-name" value="${escapeHtml(detail.name)}" required aria-required="true"><div class="field-error">${requiredError}</div></div><div class="field" data-basic-field="vendor"><label for="f-vendor">${escapeHtml(this.tr('agentoffice.vendorLabel'))}${required}</label><input id="f-vendor" value="${escapeHtml(detail.vendor_name)}" required aria-required="true"><div class="field-error">${requiredError}</div></div><div class="field" data-basic-field="title"><label for="f-title">${escapeHtml(this.tr('agentoffice.titleLabel'))}${required}</label><input id="f-title" value="${escapeHtml(detail.title)}" required aria-required="true"><div class="field-error">${requiredError}</div></div><div class="field"><label for="f-specialties">${escapeHtml(this.tr('agentoffice.specialtiesLabel'))}</label><input id="f-specialties" value="${escapeHtml(detail.specialties.join(', '))}"></div><div class="field full"><label for="f-model">${escapeHtml(this.tr('agentoffice.modelLabel'))}</label><select id="f-model"><option value="">${escapeHtml(defaultModelLabel)}</option>${missingSelectedModel}${this.modelCatalog.models.map((model) => `<option value="${escapeHtml(model.alias)}" ${detail.model === model.alias ? 'selected' : ''}>${escapeHtml(model.alias)} · ${escapeHtml(model.provider_name)} / ${escapeHtml(model.model_name)}</option>`).join('')}</select><div class="sub">${escapeHtml(this.tr('agentoffice.modelHint'))}</div></div><div class="field full"><div class="setting-check-row"><span class="setting-check-copy">${escapeHtml(this.tr('agentoffice.enableStaff'))}</span><label class="setting-toggle"><input type="checkbox" id="f-enabled" ${detail.enabled ? 'checked' : ''}><span class="setting-toggle-track"></span></label></div></div></div></section>
                <section class="settings-section"><div class="settings-section-head"><h3 class="settings-section-title">${escapeHtml(this.tr('agentoffice.instructionsLabel'))}</h3></div><div class="field"><textarea id="f-agents">${escapeHtml(detail.agents_md)}</textarea></div></section>
            </div>`;
        }
        if (this.detailSection === 'skills') {
            return `<div class="skills-page"><div class="skills-toolbar"><h3>${escapeHtml(this.tr('agentoffice.skills'))}</h3><div class="skills-add-anchor"><button class="skills-add-button" data-action="toggle-skill-menu" title="${escapeHtml(this.tr('agentoffice.addSkill'))}" aria-label="${escapeHtml(this.tr('agentoffice.addSkill'))}"><i class="fa-solid fa-plus"></i></button>${this.skillAddMenuOpen ? this.renderSkillAddMenu() : ''}</div></div>${
                this.skills.length === 0
                    ? `<div class="empty">${escapeHtml(this.tr('agentoffice.noSkills'))}</div>`
                    : `<div class="skill-grid">${this.skills
                          .map((skill) => {
                              const color = getSkillPastel(skill.name || skill.directory_name);
                              return `<button class="skill-card" data-skill-detail="${escapeHtml(skill.directory_name)}"><span class="skill-card-head"><span class="skill-card-icon" style="background:${color.bg};color:${color.text}">${escapeHtml(getSkillInitial(skill.name || skill.directory_name))}</span><span style="min-width:0"><h4>${escapeHtml(skill.name)}</h4><span class="skill-card-id">${escapeHtml(skill.directory_name)}</span></span></span><span class="skill-card-desc">${escapeHtml(skill.description)}</span></button>`;
                          })
                          .join('')}</div>`
            }</div>`;
        }
        if (this.detailSection === 'mcp') {
            return `<div class="settings-page"><section class="settings-section"><div class="settings-section-head"><div><h3 class="settings-section-title">${escapeHtml(this.tr('agentoffice.mcp'))}</h3><p class="settings-section-desc">${escapeHtml(this.tr('agentoffice.mcpExportWarning'))}</p></div></div><div class="field" data-mcp-field><label for="f-mcp">${escapeHtml(this.tr('agentoffice.mcpJsonHint'))}</label><textarea id="f-mcp" style="min-height:360px;font-family:monospace">${escapeHtml(JSON.stringify(detail.mcp, null, 4))}</textarea><div class="field-error" id="mcp-field-error"></div></div></section></div>`;
        }
        if (this.detailSection === 'security') {
            const directories = detail.permission.directories.length
                ? detail.permission.directories
                      .map(
                          (directory, index) =>
                              `<div class="directory-grid directory-row"><span class="directory-path" title="${escapeHtml(directory.path)}">${escapeHtml(directory.path)}</span><select data-dir-access="${index}" aria-label="${escapeHtml(this.tr('agentoffice.directoryAccess'))}"><option value="read" ${directory.access === 'read' ? 'selected' : ''}>${escapeHtml(this.tr('agentoffice.readOnly'))}</option><option value="readwrite" ${directory.access === 'readwrite' ? 'selected' : ''}>${escapeHtml(this.tr('agentoffice.readWrite'))}</option></select><button class="danger directory-remove" data-remove-dir="${index}" title="${escapeHtml(this.tr('agentoffice.removeDirectory'))}" aria-label="${escapeHtml(this.tr('agentoffice.removeDirectory'))}"><i class="fa-solid fa-xmark"></i></button></div>`
                      )
                      .join('')
                : `<div class="directory-empty">${escapeHtml(this.tr('agentoffice.noDirectories'))}</div>`;
            return `<div class="settings-page"><section class="settings-section"><div class="settings-section-head"><h3 class="settings-section-title">${escapeHtml(this.tr('agentoffice.security'))}</h3></div><div class="setting-check-row network-setting-row"><span class="setting-check-copy">${escapeHtml(this.tr('agentoffice.networkAccess'))}</span><label class="setting-toggle"><input id="f-network" type="checkbox" ${detail.permission.network_access ? 'checked' : ''}><span class="setting-toggle-track"></span></label></div></section><section class="settings-section"><div class="settings-section-head"><h3 class="settings-section-title">${escapeHtml(this.tr('agentoffice.directories'))}</h3><button class="secondary" data-action="add-directory">${escapeHtml(this.tr('agentoffice.addDirectory'))}</button></div><div class="directory-table"><div class="directory-grid directory-header"><span>${escapeHtml(this.tr('agentoffice.directoryPath'))}</span><span>${escapeHtml(this.tr('agentoffice.directoryAccess'))}</span><span></span></div><div id="directory-list">${directories}</div></div></section></div>`;
        }
        const tasks =
            detail.tasks.length === 0
                ? `<div class="empty">${escapeHtml(this.tr('agentoffice.noTasks'))}</div>`
                : detail.tasks
                      .slice()
                      .reverse()
                      .map(
                          (task) =>
                              `<div class="list-row"><div><b>${escapeHtml(task.task_id)}</b><div class="sub">${escapeHtml(this.taskStatus(task.status))} · ${escapeHtml(new Date(task.updated_at).toLocaleString(this.locale))} · ${(task.usage_summary?.total_tokens ?? 0).toLocaleString(this.locale)} ${escapeHtml(this.tr('agentoffice.tokensStat'))}</div></div><button class="secondary" data-task="${escapeHtml(task.task_id)}">${escapeHtml(this.tr('agentoffice.openTask'))}</button></div>`
                      )
                      .join('');
        return `<div class="settings-page"><section class="settings-section"><div class="settings-section-head"><h3 class="settings-section-title">${escapeHtml(this.tr('agentoffice.tasks'))}</h3></div>${tasks}</section></div>`;
    }

    private renderSkillAddMenu(): string {
        return `<div class="skills-add-menu" role="menu">
            <button data-action="add-skill-directory" role="menuitem"><span class="skill-menu-icon folder"><i class="fa-solid fa-folder-open"></i></span><span class="skill-menu-copy"><b>${escapeHtml(this.tr('agentoffice.addSkillFromDirectory'))}</b><span>${escapeHtml(this.tr('agentoffice.addSkillFromDirectoryHint'))}</span></span></button>
            <button data-action="add-skill-zip" role="menuitem"><span class="skill-menu-icon zip"><i class="fa-solid fa-file-zipper"></i></span><span class="skill-menu-copy"><b>${escapeHtml(this.tr('agentoffice.addSkillFromZip'))}</b><span>${escapeHtml(this.tr('agentoffice.addSkillFromZipHint'))}</span></span></button>
            <button data-action="batch-import-skills" role="menuitem"><span class="skill-menu-icon batch"><i class="fa-solid fa-inbox"></i></span><span class="skill-menu-copy"><b>${escapeHtml(this.tr('agentoffice.batchImportSkills'))}</b><span>${escapeHtml(this.tr('agentoffice.batchImportSkillsHint'))}</span></span></button>
            <div class="skills-add-menu-divider"></div>
            <button data-action="add-skill-url" role="menuitem"><span class="skill-menu-icon url"><i class="fa-solid fa-link"></i></span><span class="skill-menu-copy"><b>${escapeHtml(this.tr('agentoffice.addSkillFromUrl'))}</b><span>${escapeHtml(this.tr('agentoffice.addSkillFromUrlHint'))}</span></span></button>
            <button data-action="add-installed-skills" role="menuitem"><span class="skill-menu-icon installed"><i class="fa-solid fa-download"></i></span><span class="skill-menu-copy"><b>${escapeHtml(this.tr('agentoffice.addInstalledSkills'))}</b><span>${escapeHtml(this.tr('agentoffice.addInstalledSkillsHint'))}</span></span></button>
        </div>`;
    }

    private renderModal(): string {
        if (this.modal === 'new') {
            const required = `<span class="required-mark" aria-hidden="true">*</span>`;
            const error = escapeHtml(this.tr('agentoffice.fieldRequired'));
            return `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="new-staff-title">
                <div class="modal-head"><div><h3 id="new-staff-title">${escapeHtml(this.tr('agentoffice.newStaff'))}</h3><p class="sub">${escapeHtml(this.tr('agentoffice.newStaffHint'))}</p></div><button class="modal-close" data-action="close-modal" aria-label="${escapeHtml(this.tr('agentoffice.cancel'))}">×</button></div>
                <div class="modal-body"><div class="modal-error" id="new-modal-error" role="alert"></div><div class="modal-form">
                    <div class="field" data-new-field="name"><label for="new-name">${escapeHtml(this.tr('agentoffice.nameLabel'))}${required}</label><input id="new-name" autocomplete="off" required aria-required="true"><div class="field-error">${error}</div></div>
                    <div class="field" data-new-field="vendor"><label for="new-vendor">${escapeHtml(this.tr('agentoffice.vendorLabel'))}${required}</label><input id="new-vendor" autocomplete="organization" required aria-required="true"><div class="field-error">${error}</div></div>
                    <div class="field" data-new-field="title"><label for="new-title">${escapeHtml(this.tr('agentoffice.titleLabel'))}${required}</label><input id="new-title" autocomplete="organization-title" required aria-required="true"><div class="field-error">${error}</div></div>
                    <div class="field"><label for="new-specialties">${escapeHtml(this.tr('agentoffice.specialtiesLabel'))}<span class="optional-mark">${escapeHtml(this.tr('agentoffice.optional'))}</span></label><input id="new-specialties" autocomplete="off"></div>
                </div></div>
                <div class="modal-footer"><button class="secondary" data-action="close-modal">${escapeHtml(this.tr('agentoffice.cancel'))}</button><button class="primary" data-action="create">${escapeHtml(this.tr('agentoffice.save'))}</button></div>
            </div></div>`;
        }
        if (this.modal === 'batch-skills') {
            if (this.skillBatchResult) {
                const rows = [
                    ...this.skillBatchResult.added.map(
                        (item) =>
                            `<div class="installed-skill-row"><i class="fa-solid fa-check skill-import-result-icon"></i><span><b>${escapeHtml(item.name)}</b><span>${escapeHtml(item.path)}</span></span></div>`
                    ),
                    ...this.skillBatchResult.errors.map(
                        (item) =>
                            `<div class="installed-skill-row"><i class="fa-solid fa-xmark skill-import-result-icon error"></i><span><b>${escapeHtml(item.path.split(/[\\/]/).pop() || item.path)}</b><span>${escapeHtml(item.message)}</span></span></div>`
                    )
                ].join('');
                return `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="batch-skills-title"><div class="modal-head"><div><h3 id="batch-skills-title">${escapeHtml(this.tr('agentoffice.batchImportComplete'))}</h3><p class="sub">${escapeHtml(this.formatText('agentoffice.batchImportSummary', { added: this.skillBatchResult.added.length, failed: this.skillBatchResult.errors.length }))}</p></div><button class="modal-close" data-action="close-modal" aria-label="${escapeHtml(this.tr('agentoffice.close'))}">×</button></div><div class="modal-body"><div class="installed-skill-list">${rows}</div></div><div class="modal-footer"><button class="primary" data-action="close-modal">${escapeHtml(this.tr('agentoffice.close'))}</button></div></div></div>`;
            }
            const list = this.batchSkillCandidates.length
                ? this.batchSkillCandidates
                      .map(
                          (skill) =>
                              `<label class="installed-skill-row"><input type="checkbox" data-batch-skill="${escapeHtml(skill.path)}" ${this.selectedBatchSkillPaths.has(skill.path) ? 'checked' : ''}><span><b>${escapeHtml(skill.name)}</b><span>${escapeHtml(skill.type === 'directory' ? this.tr('agentoffice.skillSourceDirectory') : this.tr('agentoffice.skillSourceZip'))} · ${escapeHtml(skill.path)}</span></span></label>`
                      )
                      .join('')
                : `<div class="empty">${escapeHtml(this.tr('agentoffice.noBatchSkillsFound'))}</div>`;
            return `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="batch-skills-title"><div class="modal-head"><div><h3 id="batch-skills-title">${escapeHtml(this.tr('agentoffice.batchImportSkills'))}</h3><p class="sub">${escapeHtml(this.tr('agentoffice.batchImportSelectHint'))}</p></div><button class="modal-close" data-action="close-modal" aria-label="${escapeHtml(this.tr('agentoffice.cancel'))}">×</button></div><div class="modal-body"><div class="installed-skill-list">${list}</div></div><div class="modal-footer"><button class="secondary" data-action="close-modal">${escapeHtml(this.tr('agentoffice.cancel'))}</button><button class="primary" data-action="confirm-batch-skills" ${this.selectedBatchSkillPaths.size === 0 ? 'disabled' : ''}>${escapeHtml(this.tr('agentoffice.addSelectedSkills'))}</button></div></div></div>`;
        }
        if (this.modal === 'skill-url') {
            return `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="skill-url-title"><div class="modal-head"><div><h3 id="skill-url-title">${escapeHtml(this.tr('agentoffice.addSkillFromUrl'))}</h3><p class="sub">${escapeHtml(this.tr('agentoffice.addSkillFromUrlHint'))}</p></div><button class="modal-close" data-action="close-modal" aria-label="${escapeHtml(this.tr('agentoffice.cancel'))}">×</button></div><div class="modal-body"><div class="modal-error" id="skill-modal-error" role="alert">${escapeHtml(this.skillModalError)}</div><div class="field"><label for="skill-url-input">${escapeHtml(this.tr('agentoffice.skillUrlLabel'))}</label><input id="skill-url-input" type="url" value="${escapeHtml(this.skillUrl)}" placeholder="https://example.com/skill.zip" autocomplete="url"></div></div><div class="modal-footer"><button class="secondary" data-action="close-modal">${escapeHtml(this.tr('agentoffice.cancel'))}</button><button class="primary" data-action="confirm-skill-url">${escapeHtml(this.tr('agentoffice.addSkill'))}</button></div></div></div>`;
        }
        if (this.modal === 'installed-skills') {
            const available = this.installedSkills.filter((skill) => !skill.already_added);
            const list = this.installedSkills.length
                ? this.installedSkills
                      .map(
                          (skill) =>
                              `<label class="installed-skill-row ${skill.already_added ? 'disabled' : ''}"><input type="checkbox" data-installed-skill="${escapeHtml(skill.id)}" ${skill.already_added ? 'checked disabled' : this.selectedInstalledSkillIds.has(skill.id) ? 'checked' : ''}><span><b>${escapeHtml(skill.name)}</b><span>${escapeHtml(skill.description || skill.directory_name)}${skill.already_added ? ` · ${escapeHtml(this.tr('agentoffice.skillAlreadyAdded'))}` : ''}</span></span></label>`
                      )
                      .join('')
                : `<div class="empty">${escapeHtml(this.tr('agentoffice.noInstalledSkills'))}</div>`;
            return `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="installed-skills-title"><div class="modal-head"><div><h3 id="installed-skills-title">${escapeHtml(this.tr('agentoffice.addInstalledSkills'))}</h3><p class="sub">${escapeHtml(this.tr('agentoffice.addInstalledSkillsHint'))}</p></div><button class="modal-close" data-action="close-modal" aria-label="${escapeHtml(this.tr('agentoffice.cancel'))}">×</button></div><div class="modal-body"><div class="installed-skill-list">${list}</div></div><div class="modal-footer"><button class="secondary" data-action="close-modal">${escapeHtml(this.tr('agentoffice.cancel'))}</button><button class="primary" data-action="confirm-installed-skills" ${available.length === 0 ? 'disabled' : ''}>${escapeHtml(this.tr('agentoffice.addSelectedSkills'))}</button></div></div></div>`;
        }
        if (this.modal === 'skill-detail' && this.selectedSkill) {
            return '<skill-detail-card id="staff-skill-detail-card"></skill-detail-card>';
        }
        if (this.modal === 'portrait') {
            return `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="portrait-editor-title">
                <div class="modal-head"><div><h3 id="portrait-editor-title">${escapeHtml(this.tr('agentoffice.portraitEditorTitle'))}</h3><p class="sub">${escapeHtml(this.tr('agentoffice.portraitEditorHint'))}</p></div><button class="modal-close" data-action="close-modal" aria-label="${escapeHtml(this.tr('agentoffice.cancel'))}">×</button></div>
                <div class="modal-body"><div class="modal-error" id="portrait-modal-error" role="alert">${escapeHtml(this.portraitError)}</div><div class="portrait-editor">
                    <div class="portrait-crop" id="portrait-crop"><canvas id="portrait-canvas" width="${PORTRAIT_CANVAS_SIZE}" height="${PORTRAIT_CANVAS_SIZE}" aria-label="${escapeHtml(this.tr('agentoffice.portraitCropArea'))}"></canvas><div class="portrait-crop-guide"></div><div class="portrait-crop-empty" id="portrait-crop-empty">${escapeHtml(this.tr('agentoffice.portraitChooseHint'))}</div></div>
                    <div class="portrait-controls"><input class="portrait-file-input" id="portrait-file" type="file" accept="image/png,image/jpeg,image/webp"><button class="secondary" data-action="portrait-pick">${escapeHtml(this.tr('agentoffice.choosePortrait'))}</button><label class="portrait-zoom">${escapeHtml(this.tr('agentoffice.portraitZoom'))}<input id="portrait-zoom" type="range" min="1" max="3" step="0.01" value="1" disabled></label><p class="portrait-format-hint">${escapeHtml(this.tr('agentoffice.portraitFormatHint'))}</p></div>
                </div></div>
                <div class="modal-footer"><button class="secondary" data-action="close-modal">${escapeHtml(this.tr('agentoffice.cancel'))}</button><button class="primary" data-action="save-portrait" disabled>${escapeHtml(this.tr('agentoffice.savePortrait'))}</button></div>
            </div></div>`;
        }
        if (this.modal === 'delete') {
            return `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true"><div class="modal-head"><h3>${escapeHtml(this.tr('agentoffice.delete'))}</h3><button class="modal-close" data-action="close-modal" aria-label="${escapeHtml(this.tr('agentoffice.cancel'))}">×</button></div><div class="modal-body"><p>${escapeHtml(this.tr('agentoffice.deleteWarning'))}</p></div><div class="modal-footer"><button class="secondary" data-action="close-modal">${escapeHtml(this.tr('agentoffice.cancel'))}</button><button class="secondary" data-action="delete-trash">${escapeHtml(this.tr('agentoffice.moveToTrash'))}</button><button class="danger" data-action="delete-permanent">${escapeHtml(this.tr('agentoffice.deletePermanently'))}</button></div></div></div>`;
        }
        return '';
    }

    private bindSkillDetailCard(): void {
        if (this.modal !== 'skill-detail' || !this.selectedSkill) return;
        const card = this.shadowRoot?.querySelector<SkillDetailCard>('#staff-skill-detail-card');
        if (!card) return;
        const skill = this.selectedSkill;
        const metadata = [
            { label: this.tr('agentoffice.skillDirectory'), value: skill.directory_name },
            { label: this.tr('agentoffice.skillLicense'), value: skill.license },
            { label: this.tr('agentoffice.skillCompatibility'), value: skill.compatibility },
            { label: this.tr('agentoffice.skillAllowedTools'), value: skill.allowed_tools?.join(', ') }
        ].filter((item): item is { label: string; value: string } => Boolean(item.value));
        const model: SkillDetailCardModel = {
            id: skill.directory_name,
            name: skill.name,
            closeLabel: this.tr('agentoffice.close'),
            description: skill.description,
            descriptionLabel: this.tr('agentoffice.skillIntroduction'),
            bodyHtml: skill.body ? renderSafeMarkdown(skill.body) : undefined,
            bodyLabel: this.tr('agentoffice.skillContent'),
            metadata,
            metadataLabel: this.tr('agentoffice.skillMetadata'),
            actions: [
                {
                    id: 'delete',
                    data: skill.directory_name,
                    label: this.tr('agentoffice.delete'),
                    variant: 'danger'
                },
                { id: 'close', label: this.tr('agentoffice.close') }
            ]
        };
        card.dataset.theme = this.dataset.theme || 'light';
        card.model = model;
        card.addEventListener('skill-detail-action', (event) => {
            const detail = (event as CustomEvent<{ id: string; data?: string }>).detail;
            if (detail.id === 'delete' && detail.data) {
                this.runOperation(() => this.deleteSkill(detail.data!));
            } else if (detail.id === 'close') {
                this.closeModal();
            }
        });
    }

    private bindEvents(): void {
        this.bindSkillDetailCard();
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-tab]').forEach((element) =>
            element.addEventListener('click', () => {
                void this.flushAutoSave();
                this.activeTab = element.dataset.tab as 'office' | 'management';
                this.detail = null;
                this.status = '';
                this.render();
            })
        );
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-staff]').forEach((element) =>
            element.addEventListener('click', () => {
                this.selectedStaffId = element.dataset.staff!;
                void this.loadMessages();
            })
        );
        this.bindStaffPreviews();
        this.shadowRoot?.querySelector<HTMLInputElement>('#staff-search')?.addEventListener('input', (event) => {
            this.query = (event.target as HTMLInputElement).value;
            this.filterStaffRows();
        });
        this.shadowRoot
            ?.querySelector('[data-action="attach"]')
            ?.addEventListener('click', () => void this.pickAttachments());
        this.shadowRoot
            ?.querySelector('[data-action="send"]')
            ?.addEventListener('click', () => void this.sendMessage());
        this.shadowRoot?.querySelector<HTMLTextAreaElement>('#message-input')?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void this.sendMessage();
            }
        });
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-remove-attachment]').forEach((element) =>
            element.addEventListener('click', () => {
                this.attachments.splice(Number(element.dataset.removeAttachment), 1);
                this.render();
            })
        );
        this.shadowRoot
            ?.querySelector('[data-action="older"]')
            ?.addEventListener('click', () => void this.loadMessages(this.historyCursor));
        this.shadowRoot?.querySelectorAll<HTMLElement>('.message[data-message-id]').forEach((element) =>
            element.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopPropagation();
                (window as any).contextMenuAPI?.suppress?.();
                this.showMessageContextMenu(event.clientX, event.clientY, element);
            })
        );
        this.shadowRoot
            ?.querySelectorAll<HTMLElement>('[data-task]')
            .forEach((element) =>
                element.addEventListener('click', () =>
                    window.parent.postMessage({ type: 'openTask', taskId: element.dataset.task }, '*')
                )
            );
        this.shadowRoot?.querySelector('[data-action="new"]')?.addEventListener('click', () => {
            this.status = '';
            this.modal = 'new';
            this.render();
            this.shadowRoot?.querySelector<HTMLInputElement>('#new-name')?.focus();
        });
        this.shadowRoot
            ?.querySelector('[data-action="import"]')
            ?.addEventListener('click', () => void this.importStaff());
        this.shadowRoot
            ?.querySelectorAll<HTMLElement>('[data-detail]')
            .forEach((element) =>
                element.addEventListener('click', () => this.openDetailFromList(element.dataset.detail!))
            );
        this.shadowRoot?.querySelector('[data-action="back"]')?.addEventListener('click', () => {
            void this.flushAutoSave();
            this.detail = null;
            this.status = '';
            this.render();
        });
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-section]').forEach((element) =>
            element.addEventListener('click', () => {
                void this.flushAutoSave();
                this.detailSection = element.dataset.section as DetailSection;
                this.status = '';
                this.render();
            })
        );
        this.shadowRoot
            ?.querySelectorAll('[data-action="portrait"]')
            .forEach((element) => element.addEventListener('click', () => this.openPortraitEditor()));
        this.shadowRoot
            ?.querySelector('[data-action="add-directory"]')
            ?.addEventListener('click', () => this.runOperation(() => this.addDirectory()));
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-remove-dir]').forEach((element) =>
            element.addEventListener('click', () => {
                this.syncSecurityDraft();
                this.detail!.permission.directories.splice(Number(element.dataset.removeDir), 1);
                this.render();
                this.queueStaffUpdate({ permission: this.copyPermission() }, true);
            })
        );
        this.shadowRoot?.querySelectorAll<HTMLSelectElement>('[data-dir-access]').forEach((select) =>
            select.addEventListener('change', () => {
                this.syncSecurityDraft();
                this.queueStaffUpdate({ permission: this.copyPermission() }, true);
            })
        );
        this.shadowRoot?.querySelector<HTMLInputElement>('#f-network')?.addEventListener('change', () => {
            this.syncSecurityDraft();
            this.queueStaffUpdate({ permission: this.copyPermission() }, true);
        });
        this.shadowRoot?.querySelector('[data-action="toggle-skill-menu"]')?.addEventListener('click', () => {
            this.skillAddMenuOpen = !this.skillAddMenuOpen;
            this.render();
        });
        this.shadowRoot
            ?.querySelector('[data-action="add-skill-directory"]')
            ?.addEventListener('click', () => this.runOperation(() => this.addSkillFromDirectory()));
        this.shadowRoot
            ?.querySelector('[data-action="add-skill-zip"]')
            ?.addEventListener('click', () => this.runOperation(() => this.addSkillFromZip()));
        this.shadowRoot
            ?.querySelector('[data-action="batch-import-skills"]')
            ?.addEventListener('click', () => this.runOperation(() => this.openBatchSkillPicker()));
        this.shadowRoot?.querySelector('[data-action="add-skill-url"]')?.addEventListener('click', () => {
            this.skillAddMenuOpen = false;
            this.skillUrl = '';
            this.skillModalError = '';
            this.modal = 'skill-url';
            this.render();
            this.shadowRoot?.querySelector<HTMLInputElement>('#skill-url-input')?.focus();
        });
        this.shadowRoot
            ?.querySelector('[data-action="add-installed-skills"]')
            ?.addEventListener('click', () => this.runOperation(() => this.openInstalledSkillPicker()));
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-skill-detail]').forEach((element) =>
            element.addEventListener('click', () => {
                this.selectedSkill =
                    this.skills.find((skill) => skill.directory_name === element.dataset.skillDetail) ?? null;
                this.modal = this.selectedSkill ? 'skill-detail' : null;
                this.render();
            })
        );
        this.shadowRoot?.querySelectorAll<HTMLInputElement>('[data-installed-skill]').forEach((input) =>
            input.addEventListener('change', () => {
                if (input.checked) this.selectedInstalledSkillIds.add(input.dataset.installedSkill!);
                else this.selectedInstalledSkillIds.delete(input.dataset.installedSkill!);
            })
        );
        this.shadowRoot
            ?.querySelector('[data-action="confirm-installed-skills"]')
            ?.addEventListener('click', () => this.runOperation(() => this.addSelectedInstalledSkills()));
        this.shadowRoot?.querySelectorAll<HTMLInputElement>('[data-batch-skill]').forEach((input) =>
            input.addEventListener('change', () => {
                if (input.checked) this.selectedBatchSkillPaths.add(input.dataset.batchSkill!);
                else this.selectedBatchSkillPaths.delete(input.dataset.batchSkill!);
                const confirm = this.shadowRoot?.querySelector<HTMLButtonElement>(
                    '[data-action="confirm-batch-skills"]'
                );
                if (confirm) confirm.disabled = this.selectedBatchSkillPaths.size === 0;
            })
        );
        this.shadowRoot
            ?.querySelector('[data-action="confirm-batch-skills"]')
            ?.addEventListener('click', () => this.runOperation(() => this.addSelectedBatchSkills()));
        this.shadowRoot?.querySelector<HTMLInputElement>('#skill-url-input')?.addEventListener('input', (event) => {
            this.skillUrl = (event.target as HTMLInputElement).value;
            this.skillModalError = '';
            const error = this.shadowRoot?.querySelector<HTMLElement>('#skill-modal-error');
            if (error) error.textContent = '';
        });
        this.shadowRoot?.querySelector<HTMLInputElement>('#skill-url-input')?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.isComposing) {
                event.preventDefault();
                this.runOperation(() => this.addSkillFromUrl());
            }
        });
        this.shadowRoot
            ?.querySelector('[data-action="confirm-skill-url"]')
            ?.addEventListener('click', () => this.runOperation(() => this.addSkillFromUrl()));
        this.shadowRoot
            ?.querySelectorAll<HTMLElement>('[data-delete-skill]')
            .forEach((element) =>
                element.addEventListener('click', () =>
                    this.runOperation(() => this.deleteSkill(element.dataset.deleteSkill!))
                )
            );
        this.shadowRoot
            ?.querySelector('[data-action="export"]')
            ?.addEventListener('click', () => this.runOperation(() => this.exportStaff()));
        this.shadowRoot
            ?.querySelector('[data-action="open-directory"]')
            ?.addEventListener('click', () => this.runOperation(() => this.openStaffDirectory()));
        this.shadowRoot?.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
            this.modal = 'delete';
            this.render();
        });
        this.shadowRoot
            ?.querySelectorAll('[data-action="close-modal"]')
            .forEach((element) => element.addEventListener('click', () => this.closeModal()));
        this.shadowRoot
            ?.querySelector('[data-action="create"]')
            ?.addEventListener('click', () => void this.createStaff());
        this.shadowRoot?.querySelector('[data-action="portrait-pick"]')?.addEventListener('click', () => {
            const input = this.shadowRoot?.querySelector<HTMLInputElement>('#portrait-file');
            if (!input) return;
            input.value = '';
            input.click();
        });
        this.shadowRoot?.querySelector<HTMLInputElement>('#portrait-file')?.addEventListener('change', (event) => {
            const file = (event.target as HTMLInputElement).files?.[0];
            if (file) void this.loadPortraitFile(file);
        });
        this.shadowRoot?.querySelector<HTMLInputElement>('#portrait-zoom')?.addEventListener('input', (event) => {
            this.portraitZoom = Number((event.target as HTMLInputElement).value);
            this.clampPortraitOffset();
            this.drawPortrait();
        });
        this.shadowRoot
            ?.querySelector('[data-action="save-portrait"]')
            ?.addEventListener('click', () => void this.savePortrait());
        this.bindPortraitDrag();
        this.shadowRoot?.querySelectorAll<HTMLInputElement>('[data-new-field] input').forEach((input) =>
            input.addEventListener('input', () => {
                input.closest('.field')?.classList.remove('invalid');
                input.removeAttribute('aria-invalid');
                const modalError = this.shadowRoot?.querySelector<HTMLElement>('#new-modal-error');
                if (modalError) modalError.textContent = '';
            })
        );
        this.shadowRoot
            ?.querySelectorAll<HTMLInputElement>('[data-basic-field] input')
            .forEach((input) => input.addEventListener('input', () => this.handleBasicFieldInput(input)));
        this.shadowRoot
            ?.querySelector<HTMLInputElement>('#f-specialties')
            ?.addEventListener('input', (event) => this.handleSpecialtiesInput(event.target as HTMLInputElement));
        this.shadowRoot
            ?.querySelector<HTMLTextAreaElement>('#f-agents')
            ?.addEventListener('input', (event) => this.handleInstructionsInput(event.target as HTMLTextAreaElement));
        this.shadowRoot?.querySelector<HTMLSelectElement>('#f-model')?.addEventListener('change', (event) => {
            if (!this.detail) return;
            const model = (event.target as HTMLSelectElement).value || undefined;
            this.detail.model = model;
            this.queueStaffUpdate({ model: model ?? null }, true);
        });
        this.shadowRoot?.querySelector<HTMLInputElement>('#f-enabled')?.addEventListener('change', (event) => {
            if (!this.detail) return;
            const enabled = (event.target as HTMLInputElement).checked;
            this.detail.enabled = enabled;
            this.queueStaffUpdate({ enabled }, true);
        });
        this.shadowRoot
            ?.querySelector<HTMLTextAreaElement>('#f-mcp')
            ?.addEventListener('input', (event) => this.handleMcpInput(event.target as HTMLTextAreaElement));
        this.shadowRoot
            ?.querySelector('[data-action="delete-trash"]')
            ?.addEventListener('click', () => this.runOperation(() => this.performDelete('trash')));
        this.shadowRoot
            ?.querySelector('[data-action="delete-permanent"]')
            ?.addEventListener('click', () => this.runOperation(() => this.performDelete('permanent')));
    }

    private async openDetail(staffId: string): Promise<void> {
        if (this.detail?.id !== staffId) {
            this.autoSaveState = 'idle';
            this.autoSaveDetail = '';
            this.status = '';
        }
        [this.detail, this.skills, this.modelCatalog] = await Promise.all([
            this.call('getStaffDetail', staffId),
            this.call('listSkills', staffId),
            this.call('listChatModels')
        ]);
        this.render();
    }

    private openDetailFromList(staffId: string): void {
        this.status = '';
        this.runOperation(() => this.openDetail(staffId));
    }

    private showMessageContextMenu(x: number, y: number, element: HTMLElement): void {
        this.dismissMessageContextMenu();
        const message = this.messages.find((item) => item.id === element.dataset.messageId);
        if (!message || !this.shadowRoot) return;
        const menu = document.createElement('div');
        menu.className = 'message-context-menu';
        menu.innerHTML = `<button data-message-menu="copy"><i class="fa-solid fa-copy"></i><span>${escapeHtml(this.tr('agentoffice.copy'))}</span></button><button data-message-menu="copy-plain"><i class="fa-solid fa-font"></i><span>${escapeHtml(this.tr('agentoffice.copyPlain'))}</span></button><div class="message-context-menu-separator"></div><button data-message-menu="open-task"><i class="fa-solid fa-arrow-up-right-from-square"></i><span>${escapeHtml(this.tr('agentoffice.openTask'))}</span></button>`;
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        this.shadowRoot.querySelector('.root')?.appendChild(menu);
        requestAnimationFrame(() => {
            const margin = 12;
            const rect = menu.getBoundingClientRect();
            menu.style.left = `${Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - rect.width - margin))}px`;
            menu.style.top = `${Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - rect.height - margin))}px`;
        });
        menu.querySelector('[data-message-menu="copy"]')?.addEventListener('click', () => {
            void this.copyMessage(message, element, true).catch(() => {});
            this.dismissMessageContextMenu();
        });
        menu.querySelector('[data-message-menu="copy-plain"]')?.addEventListener('click', () => {
            void this.copyMessage(message, element, false).catch(() => {});
            this.dismissMessageContextMenu();
        });
        menu.querySelector('[data-message-menu="open-task"]')?.addEventListener('click', () => {
            window.parent.postMessage({ type: 'openTask', taskId: message.task_id }, '*');
            this.dismissMessageContextMenu();
        });
        setTimeout(() => window.addEventListener('mousedown', this.dismissMessageContextMenu), 0);
    }

    private async copyMessage(message: StaffMessage, element: HTMLElement, rich: boolean): Promise<void> {
        const body = element.cloneNode(true) as HTMLElement;
        body.querySelector('.message-meta')?.remove();
        const plainText = [
            body.textContent?.trim(),
            ...message.content
                .filter((part) => part.type === 'resource' && part.media_type !== 'file')
                .map((part) => part.name)
        ]
            .filter((part): part is string => Boolean(part))
            .join('\n');
        if (rich && typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
            try {
                await navigator.clipboard.write([
                    new ClipboardItem({
                        'text/plain': new Blob([plainText], { type: 'text/plain' }),
                        'text/html': new Blob([body.innerHTML], { type: 'text/html' })
                    })
                ]);
                return;
            } catch {
                // Fall back to plain text where rich clipboard writes are unavailable.
            }
        }
        await navigator.clipboard.writeText(plainText);
    }

    private async sendMessage(): Promise<void> {
        if (!this.selectedStaffId || this.busy) return;
        const input = this.shadowRoot?.querySelector<HTMLTextAreaElement>('#message-input');
        const text = input?.value.trim();
        if (!text && this.attachments.length === 0) return;
        this.busy = true;
        this.render();
        try {
            await this.call('sendMessage', this.selectedStaffId, { text, attachments: this.attachments });
            this.attachments = [];
            await this.reloadStaffs();
        } catch (error) {
            this.status = this.errorText(error);
        } finally {
            this.busy = false;
            this.render();
        }
    }

    private async pickAttachments(): Promise<void> {
        const paths = (await (window as any).fsAPI.selectFile()) as string[];
        this.attachments.push(
            ...paths.map((filePath) => ({ path: filePath, name: filePath.split(/[\\/]/).pop() || filePath }))
        );
        this.render();
    }

    private async createStaff(): Promise<void> {
        const fields = [
            { input: '#new-name', container: '[data-new-field="name"]' },
            { input: '#new-vendor', container: '[data-new-field="vendor"]' },
            { input: '#new-title', container: '[data-new-field="title"]' }
        ];
        let firstInvalid: HTMLInputElement | undefined;
        for (const field of fields) {
            const input = this.shadowRoot?.querySelector<HTMLInputElement>(field.input);
            const invalid = !input?.value.trim();
            this.shadowRoot?.querySelector(field.container)?.classList.toggle('invalid', invalid);
            if (invalid) {
                input?.setAttribute('aria-invalid', 'true');
                firstInvalid ??= input;
            } else {
                input?.removeAttribute('aria-invalid');
            }
        }
        if (firstInvalid) {
            firstInvalid.focus();
            return;
        }

        const value = (id: string) => this.shadowRoot?.querySelector<HTMLInputElement>(id)?.value.trim() ?? '';
        const modal = this.shadowRoot?.querySelector<HTMLElement>('.modal');
        const modalError = this.shadowRoot?.querySelector<HTMLElement>('#new-modal-error');
        modal?.classList.add('submitting');
        if (modalError) modalError.textContent = '';
        try {
            await this.call('createStaff', {
                name: value('#new-name'),
                vendor_name: value('#new-vendor'),
                title: value('#new-title'),
                specialties: value('#new-specialties')
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean)
            });
            this.modal = null;
            this.status = '';
            await this.reloadStaffs();
        } catch (error) {
            modal?.classList.remove('submitting');
            if (modalError) {
                modalError.textContent = `${this.tr('agentoffice.operationFailed')}: ${this.errorText(error)}`;
            }
        }
    }

    private async importStaff(): Promise<void> {
        const paths = (await (window as any).fsAPI.selectFile()) as string[];
        const zipPath = paths.find((item) => item.toLowerCase().endsWith('.zip'));
        if (!zipPath) return;
        try {
            await this.call('importStaff', zipPath);
            await this.reloadStaffs();
        } catch (error) {
            this.status = this.errorText(error);
            this.render();
        }
    }

    private handleBasicFieldInput(input: HTMLInputElement): void {
        if (!this.detail) return;
        const value = input.value.trim();
        const field = input.closest<HTMLElement>('[data-basic-field]');
        const invalid = value.length === 0;
        field?.classList.toggle('invalid', invalid);
        input.toggleAttribute('aria-invalid', invalid);
        if (invalid) {
            this.discardPendingField(this.detail.id, 'definition');
            this.showAutoSaveState('invalid', this.tr('agentoffice.autoSaveInvalid'), this.detail.id);
            return;
        }

        if (input.id === 'f-name') {
            this.detail.name = value;
            const heading = this.shadowRoot?.querySelector<HTMLElement>('[data-detail-name]');
            if (heading) heading.textContent = value;
        } else if (input.id === 'f-vendor') {
            this.detail.vendor_name = value;
        } else if (input.id === 'f-title') {
            this.detail.title = value;
            const heading = this.shadowRoot?.querySelector<HTMLElement>('[data-detail-title]');
            if (heading) heading.textContent = value;
        }
        this.queueDefinitionUpdate();
    }

    private handleSpecialtiesInput(input: HTMLInputElement): void {
        if (!this.detail) return;
        this.detail.specialties = input.value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
        this.queueDefinitionUpdate();
    }

    private handleInstructionsInput(input: HTMLTextAreaElement): void {
        if (!this.detail) return;
        this.detail.agents_md = input.value;
        this.queueStaffUpdate({ agents_md: input.value });
    }

    private handleMcpInput(input: HTMLTextAreaElement): void {
        if (!this.detail) return;
        const field = input.closest<HTMLElement>('[data-mcp-field]');
        const error = this.shadowRoot?.querySelector<HTMLElement>('#mcp-field-error');
        let parsed: { servers: unknown[] };
        try {
            parsed = JSON.parse(input.value) as { servers: unknown[] };
        } catch {
            const message = this.tr('agentoffice.mcpInvalidJson');
            this.discardPendingField(this.detail.id, 'mcp');
            field?.classList.add('invalid');
            input.setAttribute('aria-invalid', 'true');
            if (error) error.textContent = message;
            this.showAutoSaveState('invalid', this.tr('agentoffice.autoSaveInvalid'), this.detail.id);
            return;
        }
        if (!Array.isArray(parsed?.servers)) {
            const message = this.tr('agentoffice.mcpServersArray');
            this.discardPendingField(this.detail.id, 'mcp');
            field?.classList.add('invalid');
            input.setAttribute('aria-invalid', 'true');
            if (error) error.textContent = message;
            this.showAutoSaveState('invalid', this.tr('agentoffice.autoSaveInvalid'), this.detail.id);
            return;
        }
        field?.classList.remove('invalid');
        input.removeAttribute('aria-invalid');
        if (error) error.textContent = '';
        this.detail.mcp = parsed;
        this.queueStaffUpdate({ mcp: parsed });
    }

    private queueDefinitionUpdate(): void {
        if (!this.detail) return;
        this.queueStaffUpdate({
            definition: {
                name: this.detail.name,
                vendor_name: this.detail.vendor_name,
                title: this.detail.title,
                specialties: [...this.detail.specialties]
            }
        });
    }

    private openPortraitEditor(): void {
        this.portraitImage = undefined;
        this.portraitZoom = 1;
        this.portraitOffsetX = 0;
        this.portraitOffsetY = 0;
        this.portraitError = '';
        this.modal = 'portrait';
        this.render();
    }

    private closeModal(): void {
        this.modal = null;
        this.selectedSkill = null;
        this.selectedInstalledSkillIds.clear();
        this.batchSkillCandidates = [];
        this.selectedBatchSkillPaths.clear();
        this.skillBatchResult = null;
        this.skillUrl = '';
        this.skillModalError = '';
        this.portraitImage = undefined;
        this.portraitError = '';
        this.render();
    }

    private async loadPortraitFile(file: File): Promise<void> {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
            this.setPortraitError(this.tr('agentoffice.portraitFileInvalid'));
            return;
        }
        if (file.size > PORTRAIT_MAX_FILE_BYTES) {
            this.setPortraitError(this.tr('agentoffice.portraitFileTooLarge'));
            return;
        }
        try {
            const source = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(file);
            });
            const image = await new Promise<HTMLImageElement>((resolve, reject) => {
                const candidate = new Image();
                candidate.onload = () => resolve(candidate);
                candidate.onerror = reject;
                candidate.src = source;
            });
            this.portraitImage = image;
            this.portraitZoom = 1;
            this.portraitOffsetX = 0;
            this.portraitOffsetY = 0;
            this.setPortraitError('');
            const zoom = this.shadowRoot?.querySelector<HTMLInputElement>('#portrait-zoom');
            if (zoom) {
                zoom.disabled = false;
                zoom.value = '1';
            }
            const save = this.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="save-portrait"]');
            if (save) save.disabled = false;
            const empty = this.shadowRoot?.querySelector<HTMLElement>('#portrait-crop-empty');
            if (empty) empty.hidden = true;
            this.drawPortrait();
        } catch {
            this.setPortraitError(this.tr('agentoffice.portraitLoadFailed'));
        }
    }

    private portraitGeometry(): { scale: number; width: number; height: number; maxX: number; maxY: number } | null {
        if (!this.portraitImage) return null;
        const coverScale = Math.max(
            PORTRAIT_CANVAS_SIZE / this.portraitImage.naturalWidth,
            PORTRAIT_CANVAS_SIZE / this.portraitImage.naturalHeight
        );
        const scale = coverScale * this.portraitZoom;
        const width = this.portraitImage.naturalWidth * scale;
        const height = this.portraitImage.naturalHeight * scale;
        return {
            scale,
            width,
            height,
            maxX: Math.max(0, (width - PORTRAIT_CANVAS_SIZE) / 2),
            maxY: Math.max(0, (height - PORTRAIT_CANVAS_SIZE) / 2)
        };
    }

    private clampPortraitOffset(): void {
        const geometry = this.portraitGeometry();
        if (!geometry) return;
        this.portraitOffsetX = Math.max(-geometry.maxX, Math.min(geometry.maxX, this.portraitOffsetX));
        this.portraitOffsetY = Math.max(-geometry.maxY, Math.min(geometry.maxY, this.portraitOffsetY));
    }

    private drawPortrait(): void {
        const canvas = this.shadowRoot?.querySelector<HTMLCanvasElement>('#portrait-canvas');
        const geometry = this.portraitGeometry();
        if (!canvas || !geometry || !this.portraitImage) return;
        const context = canvas.getContext('2d');
        if (!context) return;
        context.clearRect(0, 0, PORTRAIT_CANVAS_SIZE, PORTRAIT_CANVAS_SIZE);
        context.drawImage(
            this.portraitImage,
            (PORTRAIT_CANVAS_SIZE - geometry.width) / 2 + this.portraitOffsetX,
            (PORTRAIT_CANVAS_SIZE - geometry.height) / 2 + this.portraitOffsetY,
            geometry.width,
            geometry.height
        );
    }

    private bindPortraitDrag(): void {
        const crop = this.shadowRoot?.querySelector<HTMLElement>('#portrait-crop');
        if (!crop) return;
        let pointerId: number | undefined;
        let previousX = 0;
        let previousY = 0;
        crop.addEventListener('pointerdown', (event) => {
            if (!this.portraitImage) return;
            pointerId = event.pointerId;
            previousX = event.clientX;
            previousY = event.clientY;
            crop.setPointerCapture(pointerId);
            crop.classList.add('dragging');
        });
        crop.addEventListener('pointermove', (event) => {
            if (pointerId !== event.pointerId) return;
            const rect = crop.getBoundingClientRect();
            const ratio = PORTRAIT_CANVAS_SIZE / rect.width;
            this.portraitOffsetX += (event.clientX - previousX) * ratio;
            this.portraitOffsetY += (event.clientY - previousY) * ratio;
            previousX = event.clientX;
            previousY = event.clientY;
            this.clampPortraitOffset();
            this.drawPortrait();
        });
        const finish = (event: PointerEvent) => {
            if (pointerId !== event.pointerId) return;
            crop.releasePointerCapture(pointerId);
            pointerId = undefined;
            crop.classList.remove('dragging');
        };
        crop.addEventListener('pointerup', finish);
        crop.addEventListener('pointercancel', finish);
    }

    private setPortraitError(message: string): void {
        this.portraitError = message;
        const error = this.shadowRoot?.querySelector<HTMLElement>('#portrait-modal-error');
        if (error) error.textContent = message;
    }

    private async savePortrait(): Promise<void> {
        if (!this.detail || !this.portraitImage) return;
        const canvas = this.shadowRoot?.querySelector<HTMLCanvasElement>('#portrait-canvas');
        const modal = this.shadowRoot?.querySelector<HTMLElement>('.modal');
        const save = this.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="save-portrait"]');
        if (!canvas || !save) return;
        modal?.classList.add('submitting');
        save.disabled = true;
        try {
            await this.call('updateStaff', this.detail.id, { portrait_data_uri: canvas.toDataURL('image/png') });
            const staffId = this.detail.id;
            this.modal = null;
            this.portraitImage = undefined;
            await this.openDetail(staffId);
            await this.reloadStaffs();
        } catch (error) {
            modal?.classList.remove('submitting');
            save.disabled = false;
            this.setPortraitError(this.errorText(error));
        }
    }

    private async addDirectory(): Promise<void> {
        if (!this.detail) return;
        this.syncSecurityDraft();
        const directory = (await (window as any).fsAPI.selectDirectory()) as string | null;
        if (!directory || this.detail.permission.directories.some((item) => item.path === directory)) return;
        this.detail.permission.directories.push({ path: directory, access: 'read' });
        this.render();
        this.queueStaffUpdate({ permission: this.copyPermission() }, true);
    }

    private syncSecurityDraft(): void {
        if (!this.detail) return;
        const network = this.shadowRoot?.querySelector<HTMLInputElement>('#f-network');
        if (network) this.detail.permission.network_access = network.checked;
        this.shadowRoot?.querySelectorAll<HTMLSelectElement>('[data-dir-access]').forEach((select) => {
            const directory = this.detail!.permission.directories[Number(select.dataset.dirAccess)];
            if (directory) directory.access = select.value as 'read' | 'readwrite';
        });
    }

    private copyPermission(): StaffDetail['permission'] {
        return {
            network_access: this.detail?.permission.network_access ?? true,
            directories: (this.detail?.permission.directories ?? []).map((directory) => ({ ...directory }))
        };
    }

    private queueStaffUpdate(update: StaffUpdateInput, immediate = false): void {
        if (!this.detail) return;
        const staffId = this.detail.id;
        this.failedAutoSaveStaffIds.delete(staffId);
        this.pendingAutoSaves.set(staffId, {
            ...this.pendingAutoSaves.get(staffId),
            ...update
        });
        this.showAutoSaveState('saving', this.tr('agentoffice.autoSaveSaving'), staffId);
        if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
        this.autoSaveTimer = undefined;
        if (immediate) {
            void this.flushAutoSave();
        } else {
            this.autoSaveTimer = setTimeout(() => void this.flushAutoSave(), 500);
        }
    }

    private discardPendingField(staffId: string, field: keyof StaffUpdateInput): void {
        const pending = this.pendingAutoSaves.get(staffId);
        if (!pending || !(field in pending)) return;
        const next = { ...pending };
        delete next[field];
        if (Object.keys(next).length > 0) this.pendingAutoSaves.set(staffId, next);
        else this.pendingAutoSaves.delete(staffId);
    }

    private async flushAutoSave(): Promise<void> {
        if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
        this.autoSaveTimer = undefined;
        if (this.autoSaveRunning) return;
        const pending = [...this.pendingAutoSaves.entries()].find(
            ([staffId]) => !this.failedAutoSaveStaffIds.has(staffId)
        );
        if (!pending) return;
        const [staffId, update] = pending;
        this.pendingAutoSaves.delete(staffId);
        this.autoSaveRunning = true;
        try {
            const saved = await this.call<StaffDetail>('updateStaff', staffId, update);
            const listIndex = this.staffs.findIndex((staff) => staff.id === staffId);
            if (listIndex >= 0) this.staffs[listIndex] = saved;
            this.showAutoSaveState('saved', this.tr('agentoffice.autoSaveSaved'), staffId);
            this.setDetailNotice('', staffId);
        } catch (error) {
            const newer = this.pendingAutoSaves.get(staffId);
            this.pendingAutoSaves.set(staffId, { ...update, ...newer });
            this.failedAutoSaveStaffIds.add(staffId);
            const message = `${this.tr('agentoffice.autoSaveFailed')}: ${this.errorText(error)}`;
            this.showAutoSaveState('error', this.tr('agentoffice.autoSaveFailed'), staffId);
            this.setDetailNotice(message, staffId);
        } finally {
            this.autoSaveRunning = false;
            if ([...this.pendingAutoSaves.keys()].some((id) => !this.failedAutoSaveStaffIds.has(id))) {
                void this.flushAutoSave();
            }
        }
    }

    private showAutoSaveState(state: AutoSaveState, detail: string, staffId: string): void {
        if (this.detail?.id !== staffId) return;
        if (this.autoSaveIndicatorTimer) clearTimeout(this.autoSaveIndicatorTimer);
        this.autoSaveIndicatorTimer = undefined;
        this.autoSaveState = state;
        this.autoSaveDetail = detail;
        const indicator = this.shadowRoot?.querySelector<HTMLElement>('.auto-save-indicator');
        if (indicator) {
            indicator.dataset.state = state;
            indicator.textContent = detail;
        }
        if (state === 'saved') {
            this.autoSaveIndicatorTimer = setTimeout(() => {
                if (this.detail?.id !== staffId || this.autoSaveState !== 'saved') return;
                this.autoSaveState = 'idle';
                this.autoSaveDetail = '';
                const current = this.shadowRoot?.querySelector<HTMLElement>('.auto-save-indicator');
                if (current) {
                    current.dataset.state = 'idle';
                    current.textContent = '';
                }
            }, 1800);
        }
    }

    private setDetailNotice(message: string, staffId: string): void {
        if (this.detail?.id !== staffId) return;
        this.status = message;
        const notice = this.shadowRoot?.querySelector<HTMLElement>('.detail-notice');
        if (!notice) return;
        notice.textContent = message;
        notice.hidden = message.length === 0;
    }

    private async addSkillFromDirectory(): Promise<void> {
        if (!this.detail) return;
        this.skillAddMenuOpen = false;
        this.shadowRoot?.querySelector('.skills-add-menu')?.remove();
        const source = (await (window as any).fsAPI.selectDirectory()) as string | null;
        if (!source) return;
        await this.call('addSkill', this.detail.id, source);
        await this.openDetail(this.detail.id);
    }

    private async addSkillFromZip(): Promise<void> {
        if (!this.detail) return;
        this.skillAddMenuOpen = false;
        this.shadowRoot?.querySelector('.skills-add-menu')?.remove();
        const files = (await (window as any).fsAPI.selectFile()) as string[];
        const source = files.find((item) => item.toLowerCase().endsWith('.zip'));
        if (!source) return;
        await this.call('addSkill', this.detail.id, source);
        await this.openDetail(this.detail.id);
    }

    private async openBatchSkillPicker(): Promise<void> {
        if (!this.detail) return;
        this.skillAddMenuOpen = false;
        this.shadowRoot?.querySelector('.skills-add-menu')?.remove();
        const directory = (await (window as any).fsAPI.selectDirectory()) as string | null;
        if (!directory) return;
        this.batchSkillCandidates = await this.call('scanSkillSources', directory);
        this.selectedBatchSkillPaths = new Set(this.batchSkillCandidates.map((skill) => skill.path));
        this.skillBatchResult = null;
        this.modal = 'batch-skills';
        this.render();
    }

    private async addSelectedBatchSkills(): Promise<void> {
        if (!this.detail || this.selectedBatchSkillPaths.size === 0) return;
        const staffId = this.detail.id;
        this.skillBatchResult = await this.call('addSkillSources', staffId, [...this.selectedBatchSkillPaths]);
        this.selectedBatchSkillPaths.clear();
        await this.openDetail(staffId);
    }

    private async addSkillFromUrl(): Promise<void> {
        if (!this.detail) return;
        const sourceUrl = this.shadowRoot?.querySelector<HTMLInputElement>('#skill-url-input')?.value.trim() ?? '';
        if (!/^https?:\/\//i.test(sourceUrl)) {
            this.setSkillModalError(this.tr('agentoffice.skillUrlInvalid'));
            return;
        }
        try {
            const staffId = this.detail.id;
            await this.call('addSkillFromUrl', staffId, sourceUrl);
            this.modal = null;
            this.skillUrl = '';
            this.skillModalError = '';
            await this.openDetail(staffId);
        } catch (error) {
            this.setSkillModalError(this.errorText(error));
        }
    }

    private setSkillModalError(message: string): void {
        this.skillModalError = message;
        const error = this.shadowRoot?.querySelector<HTMLElement>('#skill-modal-error');
        if (error) error.textContent = message;
    }

    private async openInstalledSkillPicker(): Promise<void> {
        if (!this.detail) return;
        this.skillAddMenuOpen = false;
        this.selectedInstalledSkillIds.clear();
        this.installedSkills = await this.call('listInstalledSkills', this.detail.id);
        this.modal = 'installed-skills';
        this.render();
    }

    private async addSelectedInstalledSkills(): Promise<void> {
        if (!this.detail || this.selectedInstalledSkillIds.size === 0) return;
        const staffId = this.detail.id;
        const result = await this.call<StaffSkillBatchImportResult>('addInstalledSkills', staffId, [
            ...this.selectedInstalledSkillIds
        ]);
        this.selectedInstalledSkillIds.clear();
        this.modal = result.errors.length > 0 ? 'batch-skills' : null;
        this.skillBatchResult = result.errors.length > 0 ? result : null;
        await this.openDetail(staffId);
    }

    private async deleteSkill(name: string): Promise<void> {
        if (!this.detail) return;
        const staffId = this.detail.id;
        await this.call('deleteSkill', staffId, name);
        this.modal = null;
        this.selectedSkill = null;
        await this.openDetail(staffId);
    }

    private async exportStaff(): Promise<void> {
        if (!this.detail) return;
        const result = await (window as any).fsAPI.saveFile({
            title: this.tr('agentoffice.exportZip'),
            defaultPath: `${this.detail.name}.zip`,
            filters: [{ name: 'ZIP', extensions: ['zip'] }]
        });
        if (result?.canceled || !result?.filePath) return;
        await this.call('exportStaff', this.detail.id, result.filePath);
    }

    private async openStaffDirectory(): Promise<void> {
        if (!this.detail) return;
        await this.call('openStaffDirectory', this.detail.id);
    }

    private async performDelete(mode: 'trash' | 'permanent'): Promise<void> {
        if (!this.detail) return;
        const staffId = this.detail.id;
        this.pendingAutoSaves.delete(staffId);
        this.failedAutoSaveStaffIds.delete(staffId);
        await this.call('deleteStaff', staffId, mode);
        this.detail = null;
        this.modal = null;
        await this.reloadStaffs();
    }

    private scrollMessages(): void {
        const element = this.shadowRoot?.querySelector<HTMLElement>('#messages');
        if (element) element.scrollTop = element.scrollHeight;
    }

    private filterStaffRows(): void {
        const query = this.query.trim().toLowerCase();
        this.shadowRoot?.querySelectorAll<HTMLElement>('.staff-row[data-search-text]').forEach((row) => {
            row.hidden = Boolean(query) && !(row.dataset.searchText ?? '').includes(query);
        });
    }

    private bindStaffPreviews(): void {
        const preview = this.shadowRoot?.querySelector<HTMLElement>('#staff-preview');
        if (!preview) return;
        const cancelHide = () => {
            if (!this.previewHideTimer) return;
            clearTimeout(this.previewHideTimer);
            this.previewHideTimer = undefined;
        };
        const hide = () => {
            cancelHide();
            this.previewHideTimer = setTimeout(() => {
                preview.hidden = true;
                this.previewHideTimer = undefined;
            }, 140);
        };
        preview.addEventListener('pointerenter', cancelHide);
        preview.addEventListener('pointerleave', hide);
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-staff-preview]').forEach((trigger) => {
            trigger.addEventListener('pointerenter', () => {
                cancelHide();
                const staff = this.staffs.find((item) => item.id === trigger.dataset.staffPreview);
                if (!staff) return;
                preview.innerHTML = this.staffCardContent(staff);
                preview.style.visibility = 'hidden';
                preview.hidden = false;
                const triggerRect = trigger.getBoundingClientRect();
                const previewRect = preview.getBoundingClientRect();
                const left = Math.max(12, triggerRect.left - previewRect.width - 12);
                const top = Math.min(
                    Math.max(12, triggerRect.top + triggerRect.height / 2 - previewRect.height / 2),
                    window.innerHeight - previewRect.height - 12
                );
                preview.style.left = `${left}px`;
                preview.style.top = `${Math.max(12, top)}px`;
                preview.style.visibility = 'visible';
            });
            trigger.addEventListener('pointerleave', hide);
        });
    }

    private runOperation(operation: () => Promise<void>): void {
        if (this.busy) return;
        this.busy = true;
        this.status = '';
        this.setOperationBusy(true);
        const detailNotice = this.shadowRoot?.querySelector<HTMLElement>('.detail-notice');
        if (detailNotice) {
            detailNotice.textContent = '';
            detailNotice.hidden = true;
        }
        void operation()
            .catch((error) => {
                this.status = `${this.tr('agentoffice.operationFailed')}: ${this.errorText(error)}`;
                const notice = this.shadowRoot?.querySelector<HTMLElement>('.detail-notice');
                if (notice) {
                    notice.textContent = this.status;
                    notice.hidden = false;
                } else {
                    this.render();
                }
            })
            .finally(() => {
                this.busy = false;
                this.setOperationBusy(false);
            });
    }

    private setOperationBusy(busy: boolean): void {
        this.shadowRoot?.querySelector<HTMLElement>('.root')?.classList.toggle('busy', busy);
    }

    private errorText(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private taskStatus(status: string): string {
        const key = `agentoffice.taskStatus.${status}`;
        const translated = this.tr(key);
        return translated === key ? status : translated;
    }
}

customElements.define('agentoffice-entry-widget', AgentOfficeEntryWidget);
