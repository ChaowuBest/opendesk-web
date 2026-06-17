/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import type { CompatibilityReport } from './metadata.js';

export interface AnalyzeSkillExport {
    skill: {
        id: string;
        name: string;
        description: string;
        body?: string;
        source?: string;
        license?: string;
        compatibility?: string;
        metadata?: unknown;
        allowedTools?: unknown;
        resources?: {
            references: string[];
            scripts: string[];
            assets: string[];
        };
    };
    meta?: {
        dependencies?: unknown;
        testCases?: unknown[];
        _compatibilityReport?: unknown;
    };
    analysisReport?: CompatibilityReport;
    error?: string;
}

export function generateAnalyzeExportPage(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>技能中心 · 分析与优化</title>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<style>
:root {
    --bg: #fff; --text: #1d1d1f; --text-secondary: #999; --text-tertiary: #bbb;
    --border: rgba(0,0,0,0.06); --border-light: rgba(0,0,0,0.04); --border-input: rgba(0,0,0,0.08);
    --bg-hover: #FAFAFA;
    --blue: #5B8DEF; --blue-light: #8BB8F0; --blue-bg: #EBF3FE;
    --green: #4CAF6E; --green-bg: #E7F6EA;
    --red: #E06060; --red-bg: #FDE9E9;
    --yellow: #D4A028; --yellow-bg: #FFF7E0;
    --code-bg: #f5f5f5;
    --font: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif;
    --font-mono: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
}
*, *::before, *::after { box-sizing: border-box; }
body { margin:0; padding:0; font-family:var(--font); font-size:13px; color:var(--text); background:var(--bg); height:100vh; overflow:hidden; -webkit-font-smoothing:antialiased; }

.analyze-filter-bar { display:flex; align-items:center; gap:10px; padding:0 24px 12px; flex-shrink:0; }
.search-input-wrap { flex:1; min-width:0; position:relative; }
.search-input { width:100%; padding:8px 34px 8px 14px; border:1px solid var(--border-input); border-radius:9px; background:#FAFAFA; font-size:13px; font-family:inherit; outline:none; transition:all 0.2s; color:var(--text); }
.search-input:focus { border-color:var(--blue-light); box-shadow:0 0 0 3px rgba(90,140,240,0.08); background:#fff; }
.search-input::placeholder { color:var(--text-tertiary); }
.search-clear { position:absolute; right:8px; top:50%; transform:translateY(-50%); width:18px; height:18px; border-radius:50%; background:rgba(0,0,0,0.06); border:none; color:rgba(0,0,0,0.35); font-size:11px; line-height:1; cursor:pointer; display:none; align-items:center; justify-content:center; transition:all 0.15s; }
.search-clear.visible { display:flex; }
.search-clear:hover { background:rgba(0,0,0,0.1); color:rgba(0,0,0,0.55); }
.analyze-scroll-area { flex:1; overflow-y:auto; padding:0 24px 60px; }
.analyze-list { display:flex; flex-direction:column; gap:3px; }
.analyze-row { display:flex; align-items:center; gap:10px; padding:9px 12px; border-radius:9px; border:1px solid transparent; background:#fff; transition:all 0.15s; cursor:pointer; }
.analyze-row:hover { background:var(--bg-hover); border-color:var(--border-light); }
.analyze-row-icon { width:32px; height:32px; border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:700; flex-shrink:0; }
.analyze-row-info { flex:1; min-width:0; }
.analyze-row-name { font-size:13px; font-weight:600; color:var(--text); line-height:1.3; }
.analyze-row-desc { font-size:11px; color:var(--text-secondary); margin-top:1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.analyze-row-actions { display:flex; align-items:center; gap:4px; flex-shrink:0; margin-left:8px; }
.analyze-row-btn { height:26px; border-radius:6px; padding:0 10px; border:1px solid var(--border-input); background:#fff; font-size:12px; font-weight:500; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; transition:all 0.15s; color:#555; font-family:inherit; white-space:nowrap; }
.analyze-row-btn:hover { background:#f5f5f5; border-color:rgba(0,0,0,0.12); color:#333; }
.analyze-row-action { font-size:13px; flex-shrink:0; }
.analyze-row-none { color:#ccc; font-size:11px; }

.analyze-pagination { display:flex; align-items:center; justify-content:space-between; margin-top:14px; padding-top:12px; border-top:1px solid var(--border-light); }
.analyze-pagination-info { font-size:12px; color:var(--text-secondary); }
.analyze-pagination-controls { display:flex; align-items:center; gap:8px; }
.analyze-pagination-controls select { padding:5px 8px; border-radius:6px; border:1px solid rgba(0,0,0,0.1); background:#fff; font-size:12px; font-family:inherit; color:#333; outline:none; }
.page-btn { padding:5px 11px; border-radius:6px; border:1px solid var(--border-input); background:#fff; color:#555; font-size:12px; cursor:pointer; font-family:inherit; transition:all 0.15s; }
.page-btn:hover:not(:disabled) { background:#f8f8f8; }
.page-btn:disabled { opacity:0.3; cursor:not-allowed; }
.page-num { font-size:12px; color:#555; min-width:60px; text-align:center; }

.analyze-empty { display:flex; flex-direction:column; align-items:center; padding:40px 20px; color:var(--text-secondary); }
.analyze-empty .empty-icon { font-size:32px; margin-bottom:10px; opacity:0.4; }
.analyze-empty .empty-title { font-size:14px; font-weight:600; color:var(--text); margin-bottom:4px; }
.analyze-empty .empty-hint { font-size:12px; color:var(--text-secondary); }

.analyze-modal-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.18); z-index:10001; align-items:center; justify-content:center; backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px); animation:fade-in 0.15s ease; }
.analyze-modal-overlay.visible { display:flex; }
@keyframes fade-in { from{opacity:0;} to{opacity:1;} }
.analyze-modal-dialog { background:#fff; border-radius:16px; width:620px; max-width:90%; max-height:75vh; box-shadow:0 24px 80px -16px rgba(0,0,0,0.2); animation:dialog-in 0.2s ease-out; display:flex; flex-direction:column; overflow:hidden; }
@keyframes dialog-in { from{opacity:0; transform:scale(0.96) translateY(8px);} to{opacity:1; transform:scale(1) translateY(0);} }
.analyze-modal-header { display:flex; align-items:center; justify-content:space-between; padding:18px 20px; border-bottom:1px solid var(--border); flex-shrink:0; }
.analyze-modal-header h3 { margin:0; font-size:15px; font-weight:600; color:var(--text); }
.analyze-modal-close { width:28px; height:28px; border-radius:50%; border:none; background:rgba(0,0,0,0.04); font-size:16px; color:var(--text-secondary); cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.15s; }
.analyze-modal-close:hover { background:rgba(0,0,0,0.08); color:#555; }
.analyze-modal-body { padding:20px; overflow-y:auto; flex:1 1 auto; min-height:0; }
.analyze-modal-section-title { font-size:14px; font-weight:600; color:var(--text); margin-bottom:14px; }
.analyze-modal-subsection { margin-bottom:16px; }
.analyze-modal-subsection-title { font-size:12px; font-weight:600; color:#86868B; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px; }
.analyze-modal-table { width:100%; border-collapse:collapse; font-size:12px; }
.analyze-modal-table th { text-align:left; padding:6px 10px; color:var(--text-secondary); font-weight:500; border-bottom:1px solid var(--border-light); }
.analyze-modal-table td { padding:7px 10px; border-bottom:1px solid rgba(0,0,0,0.03); color:#333; }
.analyze-modal-table code { font-family:var(--font-mono); font-size:11px; background:var(--code-bg); padding:2px 5px; border-radius:4px; }
.analyze-modal-empty { text-align:center; padding:24px; color:var(--text-secondary); font-size:13px; }

.accordion-item { border:1px solid rgba(0,0,0,0.05); border-radius:10px; margin-bottom:6px; overflow:hidden; background:#fff; transition:box-shadow 0.15s; }
.accordion-item:hover { box-shadow:0 1px 4px rgba(0,0,0,0.04); }
.accordion-header { display:flex; align-items:center; gap:8px; padding:10px 14px; cursor:pointer; user-select:none; transition:background 0.1s; }
.accordion-header:hover { background:var(--bg-hover); }
.accordion-arrow { font-size:10px; color:var(--text-secondary); transition:transform 0.2s ease; flex-shrink:0; width:12px; text-align:center; }
.accordion-index { font-size:11px; font-weight:600; color:var(--blue); background:var(--blue-bg); padding:2px 7px; border-radius:4px; flex-shrink:0; }
.accordion-title { font-size:13px; font-weight:500; color:var(--text); flex:1; min-width:0; }
.accordion-body { padding:4px 14px 14px; border-top:1px solid rgba(0,0,0,0.03); animation:accordion-in 0.18s ease-out; }
@keyframes accordion-in { from{opacity:0; transform:translateY(-4px);} to{opacity:1; transform:translateY(0);} }
.accordion-field { margin-bottom:10px; }
.accordion-field:last-child { margin-bottom:0; }
.accordion-field .label { display:block; font-size:11px; font-weight:600; color:#86868B; text-transform:uppercase; letter-spacing:0.4px; margin-bottom:4px; }
.accordion-field-error .label { color:var(--red); }
.accordion-markdown { font-size:13px; color:#333; line-height:1.6; }
.accordion-markdown p { margin:0 0 6px; }
.accordion-markdown p:last-child { margin-bottom:0; }
.accordion-markdown code { font-family:var(--font-mono); font-size:12px; background:var(--code-bg); padding:1px 4px; border-radius:3px; }
.accordion-markdown pre { background:#f8f8f8; border-radius:6px; padding:10px; overflow-x:auto; font-size:12px; line-height:1.5; }
.analyze-modal-testcase-status { font-size:11px; font-weight:500; padding:2px 8px; border-radius:4px; flex-shrink:0; }
.status-pending { background:var(--yellow-bg); color:var(--yellow); }
.status-passed { background:var(--green-bg); color:var(--green); }
.status-failed { background:var(--red-bg); color:var(--red); }
.status-skipped { background:#f5f5f5; color:var(--text-secondary); }
.testcase-failure-category { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:8px; }
.testcase-failure-category-label { font-size:11px; font-weight:500; color:#86868B; }
.testcase-failure-category-chip { display:inline-flex; align-items:center; min-height:20px; padding:2px 8px; border-radius:4px; background:#FFF5F5; border:1px solid rgba(224,96,96,0.18); color:#B84C4C; font-size:11px; font-weight:500; }

.detail-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.18); z-index:10000; align-items:center; justify-content:center; backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); animation:fade-in 0.15s ease; }
.detail-overlay.visible { display:flex; }
.detail-dialog { background:#fff; border-radius:18px; padding:0; width:680px; max-width:94%; max-height:80vh; overflow:hidden; box-shadow:0 24px 80px -16px rgba(0,0,0,0.22); animation:dialog-in 0.2s ease-out; display:flex; flex-direction:column; }
.detail-header { display:flex; align-items:center; gap:14px; padding:20px 24px 16px; border-bottom:1px solid #F0F0F0; flex-shrink:0; }
.detail-icon { width:48px; height:48px; border-radius:13px; display:flex; align-items:center; justify-content:center; font-size:22px; font-weight:700; flex-shrink:0; }
.detail-header-info { flex:1; min-width:0; }
.detail-name { font-size:17px; font-weight:700; color:#1d1d1f; margin-bottom:2px; }
.detail-id { font-size:12px; color:#999; }
.detail-close { width:28px; height:28px; border-radius:50%; border:none; background:#F5F5F5; color:#999; font-size:16px; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:background 0.12s; flex-shrink:0; }
.detail-close:hover { background:#EBEBEB; color:#555; }
.detail-body { flex:1; overflow-y:auto; padding:20px 24px 24px; }
.detail-section { margin-bottom:16px; }
.detail-section:last-child { margin-bottom:0; }
.detail-section-label { font-size:11px; font-weight:600; color:#999; text-transform:uppercase; letter-spacing:.04em; margin-bottom:6px; }
.detail-desc { font-size:13px; color:#1d1d1f; line-height:1.6; }
.detail-body-content { background:#fff; border-radius:10px; padding:16px 20px; max-height:320px; overflow-y:auto; border:1px solid #F0F0F0; font-size:13px; line-height:1.6; }
.detail-meta-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.detail-meta-item { padding:8px 12px; background:#FAFAFA; border-radius:8px; font-size:12px; color:#555; min-width:0; }
.detail-meta-item .meta-label { font-size:10px; color:#999; text-transform:uppercase; letter-spacing:.03em; margin-bottom:2px; }
.detail-meta-item .meta-value { font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.detail-resources { display:flex; flex-wrap:wrap; gap:6px; }
.detail-resource-tag { display:inline-flex; align-items:center; max-width:100%; padding:3px 8px; border-radius:4px; background:#F5F5F5; color:#555; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.detail-actions { display:flex; gap:8px; flex-wrap:wrap; }
.analyze-modal-error-box { display:flex; gap:12px; padding:16px; background:#FFF5F5; border:1px solid rgba(224,96,96,0.2); border-radius:10px; }
.analyze-modal-error-icon { font-size:20px; flex-shrink:0; }
.analyze-modal-error-msg { font-size:13px; color:#333; line-height:1.6; word-break:break-all; }
</style>
</head>
<body>
    <div class="analyze-filter-bar">
        <div class="search-input-wrap">
            <input type="text" class="search-input" id="searchInput" placeholder="搜索技能名称或描述...">
            <button class="search-clear" id="searchClear">✕</button>
        </div>
    </div>
    <div class="analyze-scroll-area" id="scrollArea">
        <div class="analyze-list-wrap">
            <div class="analyze-list" id="analyzeList"></div>
            <div class="analyze-pagination" id="pagination"></div>
        </div>
    </div>
<div class="analyze-modal-overlay" id="modalOverlay">
    <div class="analyze-modal-dialog" id="modalDialog">
        <div class="analyze-modal-header">
            <h3 id="modalTitle">—</h3>
            <button type="button" class="analyze-modal-close" id="modalClose">×</button>
        </div>
        <div class="analyze-modal-body" id="modalBody"></div>
    </div>
</div>
<div class="detail-overlay" id="detailOverlay">
    <div class="detail-dialog">
        <div class="detail-header">
            <div class="detail-icon" id="detailIcon"></div>
            <div class="detail-header-info">
                <div class="detail-name" id="detailName"></div>
                <div class="detail-id" id="detailId"></div>
            </div>
            <button type="button" class="detail-close" id="detailClose">×</button>
        </div>
        <div class="detail-body" id="detailBody"></div>
    </div>
</div>
<script>var RAW_REPORTS = []; var EXPORTED_SKILLS = [];</script>
<script src="data.js"></script>
<script>
var PASTEL_COLORS = [{bg:'#EBF3FE',text:'#5B8DEF'},{bg:'#FEF1E6',text:'#E8935A'},{bg:'#E7F6EA',text:'#4CAF6E'},{bg:'#F2E8FD',text:'#9B6DD7'},{bg:'#FDE9E9',text:'#E06060'},{bg:'#E5F7F4',text:'#3DB49E'},{bg:'#FFF7E0',text:'#D4A028'},{bg:'#FBE5EE',text:'#D45D8A'}];
var TEST_FAILURE_REASON_CATEGORY_LABELS = {misconfigured:'未正确配置',dependency_runtime:'依赖与运行时问题',input_data:'输入数据问题',external_service:'外部服务问题',skill_implementation:'技能实现问题'};
var STATUS_LABELS = {pending:'⏳ 待测试',passed:'✅ 通过',failed:'❌ 失败',skipped:'⏭️ 跳过'};

function analysisReportToMeta(r){var cp=r.checkpoints||[];var tcs=cp.map(function(c){var s=c.status==='pass'?'passed':c.status==='fail'?'failed':'skipped';return{index:parseInt(c.id.replace('cp-',''),10)||0,title:c.name,prompt:'[兼容性报告] 验证检查点: '+c.name,expectedResult:'检查点通过 (status=pass)',status:s,actualResult:c.status==='pass'?c.evidence:void 0,error:c.status==='fail'?c.evidence:void 0,failureReasonCategory:c.status==='fail'?'skill_implementation':void 0}});var d=r.dependencies;var deps=d?{binaries:(d.bins||[]).filter(function(b){return b.name}).map(function(b){return{name:b.name,description:b.notes||'',installHint:b.status==='missing'?'需要安装':void 0}}),envVars:(d.env||[]).filter(function(e){return e.name}).map(function(e){return{name:e.name,required:e.status==='not_set',description:e.notes||''}})}:void 0;return{_compatibilityReport:{skill:r.skill,run:r.run,classification:r.classification,dependencies:d,capabilities:r.capabilities,substitutions:r.substitutions,summary:r.summary},testCases:tcs,dependencies:deps}}

var allSkills=[],results={},detailsById={};
function addSkillRecord(skill,meta,report,error){
var id=skill.id||skill.name||(report&&report.skill&&(report.skill.testedName||report.skill.requestedName))||'?';
var name=skill.name||id,desc=skill.description||'';
var existing=detailsById[id]||{};
detailsById[id]=Object.assign({},existing,skill,{id:id,name:name,description:desc});
if(!allSkills.some(function(s){return s.id===id})){allSkills.push({id:id,name:name,description:desc})}
var cur=results[id]||{};
if(error)cur.error=error;
var converted=report?analysisReportToMeta(report):null;
if(converted&&converted._compatibilityReport)cur._compatibilityReport=converted._compatibilityReport;
if(meta&&meta._compatibilityReport)cur._compatibilityReport=meta._compatibilityReport;
if(converted&&converted.dependencies)cur.dependencies=converted.dependencies;
if(meta&&meta.dependencies)cur.dependencies=meta.dependencies;
if(converted&&converted.testCases&&converted.testCases.length)cur.testCases=converted.testCases;
if(meta&&meta.testCases&&meta.testCases.length)cur.testCases=meta.testCases;
results[id]=cur;
}
if(Array.isArray(EXPORTED_SKILLS)&&EXPORTED_SKILLS.length){EXPORTED_SKILLS.forEach(function(item){item=item||{};addSkillRecord(item.skill||{},item.meta||{},item.analysisReport,item.error)})}
else{RAW_REPORTS.forEach(function(r){var id=r.skill.testedName||r.skill.requestedName||'?';addSkillRecord({id:id,name:id,description:r.skill.description||''},{},r)})}

var state={page:1,pageSize:10,searchQuery:''};
var testCaseMarked=new marked.Marked();testCaseMarked.use({renderer:{html:function(t){return escHtml(t.raw||t.text||'')}}});
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function renderMarkdown(c){return c?testCaseMarked.parse(c):''}
function getSkillColor(n){var h=0;for(var i=0;i<n.length;i++)h=((h<<5)-h+n.charCodeAt(i))|0;return PASTEL_COLORS[Math.abs(h)%PASTEL_COLORS.length]}
function getSkillInitial(n){return(n||'?').substring(0,2).toUpperCase()}
function getTestCaseStats(sr){if(!sr||!sr.testCases||!sr.testCases.length)return'';var t=sr.testCases;return' (共'+t.length+'条，'+t.filter(function(x){return x.status==='passed'}).length+'通过，'+t.filter(function(x){return x.status==='failed'}).length+'失败)'}
function getFilteredSkills(){var q=state.searchQuery;return q?allSkills.filter(function(s){return s.name.toLowerCase().indexOf(q)>=0||(s.description||'').toLowerCase().indexOf(q)>=0}):allSkills}

function render(){var filtered=getFilteredSkills();var tp=Math.ceil(filtered.length/state.pageSize)||1;if(state.page>tp)state.page=1;var start=(state.page-1)*state.pageSize;var ps=filtered.slice(start,start+state.pageSize);var el=document.getElementById('analyzeList');
if(!ps.length){el.innerHTML='<div class="analyze-empty"><div class="empty-icon">🔍</div><div class="empty-title">未找到匹配的技能</div><div class="empty-hint">换个关键词试试</div></div>'}
else{el.innerHTML=ps.map(function(s){var c=getSkillColor(s.name),sr=results[s.id],hd=sr&&sr.dependencies&&(((sr.dependencies.envVars||[]).length>0)||((sr.dependencies.binaries||[]).length>0)),ht=sr&&sr.testCases&&sr.testCases.length>0,ab='';
if(sr&&sr.error)ab='<button class="analyze-row-btn analyze-row-error-btn" data-view-error="'+escHtml(s.id)+'">查看错误</button>';
else if(sr){if(hd)ab+='<button class="analyze-row-btn" data-view-deps="'+escHtml(s.id)+'">依赖项</button>';if(ht)ab+='<button class="analyze-row-btn" data-view-tests="'+escHtml(s.id)+'">测试用例'+escHtml(getTestCaseStats(sr))+'</button>';if(!hd&&!ht)ab='<span class="analyze-row-action analyze-row-none">—</span>'}
else ab='<span class="analyze-row-action analyze-row-none">—</span>';
return'<div class="analyze-row" data-analyze-skill="'+escHtml(s.id)+'"><span class="analyze-row-icon" style="background:'+c.bg+';color:'+c.text+'">'+escHtml(getSkillInitial(s.name))+'</span><div class="analyze-row-info"><div class="analyze-row-name">'+escHtml(s.name)+'</div>'+(s.description?'<div class="analyze-row-desc">'+escHtml(s.description)+'</div>':'')+'</div><span class="analyze-row-actions">'+ab+'</span></div>'}).join('')}
var pag=document.getElementById('pagination');
if(!filtered.length){pag.innerHTML=''}else{pag.innerHTML='<div class="analyze-pagination-info">共 '+filtered.length+' 个技能</div><div class="analyze-pagination-controls"><span style="font-size:12px;color:#999">每页</span><select id="pageSizeSelect">'+[10,20,30,50].map(function(n){return'<option value="'+n+'"'+(state.pageSize===n?' selected':'')+'>'+n+'</option>'}).join('')+'</select><button class="page-btn" id="prevPageBtn"'+(state.page<=1?' disabled':'')+'>上一页</button><span class="page-num">'+state.page+' / '+tp+'</span><button class="page-btn" id="nextPageBtn"'+(state.page>=tp?' disabled':'')+'>下一页</button></div>';
document.getElementById('pageSizeSelect').onchange=function(e){state.pageSize=parseInt(e.target.value,10);state.page=1;render()}
document.getElementById('prevPageBtn').onclick=function(){if(state.page>1){state.page--;render()}}
document.getElementById('nextPageBtn').onclick=function(){if(state.page<tp){state.page++;render()}}}
}

document.getElementById('analyzeList').addEventListener('click',function(e){var btn=e.target.closest('button');if(btn){var sid;if(btn.hasAttribute('data-view-deps')){sid=btn.getAttribute('data-view-deps');showDepsModal(sid)}else if(btn.hasAttribute('data-view-tests')){sid=btn.getAttribute('data-view-tests');showTestCasesModal(sid)}else if(btn.hasAttribute('data-view-error')){sid=btn.getAttribute('data-view-error');showErrorModal(sid)}e.stopPropagation();return}var row=e.target.closest('.analyze-row');if(!row)return;var id=row.getAttribute('data-analyze-skill');showSkillDetailModal(id)})
document.getElementById('searchInput').addEventListener('input',function(){state.searchQuery=this.value.trim().toLowerCase();state.page=1;document.getElementById('searchClear').classList.toggle('visible',!!state.searchQuery);render()})
document.getElementById('searchClear').addEventListener('click',function(){document.getElementById('searchInput').value='';state.searchQuery='';state.page=1;this.classList.remove('visible');render()})

var modalOverlay=document.getElementById('modalOverlay'),modalTitle=document.getElementById('modalTitle'),modalBody=document.getElementById('modalBody');
function openModal(t,c){modalTitle.textContent=t;modalBody.innerHTML=c;modalOverlay.classList.add('visible');modalBody.querySelectorAll('[data-accordion-toggle]').forEach(function(h){h.onclick=function(e){e.stopPropagation();var idx=h.getAttribute('data-accordion-toggle');var b=modalBody.querySelector('[data-accordion-body="'+idx+'"]');var a=h.querySelector('.accordion-arrow');if(b){var o=b.style.display!=='none';b.style.display=o?'none':'block';if(a)a.style.transform=o?'rotate(0deg)':'rotate(90deg)'}}})}
function closeModal(){modalOverlay.classList.remove('visible')}
document.getElementById('modalClose').addEventListener('click',closeModal)
modalOverlay.addEventListener('click',function(e){if(e.target===modalOverlay)closeModal()})

function showDepsModal(sid){var sr=results[sid];if(!sr||!sr.dependencies)return;var d=sr.dependencies,sk=allSkills.find(function(s){return s.id===sid}),sn=(sk&&sk.name)||sid,h='<div class="analyze-modal-section"><div class="analyze-modal-section-title">'+escHtml(sn)+' 的依赖项</div>';
if(d.envVars&&d.envVars.length){h+='<div class="analyze-modal-subsection"><div class="analyze-modal-subsection-title">环境变量</div><table class="analyze-modal-table"><thead><tr><th>名称</th><th>必需</th><th>说明</th></tr></thead><tbody>';d.envVars.forEach(function(ev){h+='<tr><td><code>'+escHtml(ev.name)+'</code></td><td>'+(ev.required?'✅':'❌')+'</td><td>'+escHtml(ev.description||'—')+'</td></tr>'});h+='</tbody></table></div>'}
if(d.binaries&&d.binaries.length){h+='<div class="analyze-modal-subsection"><div class="analyze-modal-subsection-title">系统命令</div><table class="analyze-modal-table"><thead><tr><th>命令</th><th>说明</th></tr></thead><tbody>';d.binaries.forEach(function(b){h+='<tr><td><code>'+escHtml(b.name)+'</code></td><td>'+escHtml(b.description||'—')+'</td></tr>'});h+='</tbody></table></div>'}
if((!d.envVars||!d.envVars.length)&&(!d.binaries||!d.binaries.length))h+='<div class="analyze-modal-empty">未检测到依赖项</div>';h+='</div>';openModal('依赖项',h)}

function showErrorModal(sid){var sr=results[sid];if(!sr||!sr.error)return;var sk=allSkills.find(function(s){return s.id===sid}),sn=(sk&&sk.name)||sid;openModal('错误详情','<div class="analyze-modal-section"><div class="analyze-modal-section-title">'+escHtml(sn)+' - 分析错误</div><div class="analyze-modal-error-box"><div class="analyze-modal-error-icon">⚠️</div><div class="analyze-modal-error-msg">'+escHtml(sr.error)+'</div></div></div>')}

function showTestCasesModal(sid){var sr=results[sid];if(!sr||!sr.testCases)return;var tcs=sr.testCases,sk=allSkills.find(function(s){return s.id===sid}),sn=(sk&&sk.name)||sid,h='<div class="analyze-modal-section"><div class="analyze-modal-section-title">'+escHtml(sn)+' 的测试用例（共 '+tcs.length+' 条）</div>';
tcs.forEach(function(tc){var ph=renderMarkdown(tc.prompt),eh=renderMarkdown(tc.expectedResult),ah=tc.actualResult?renderMarkdown(tc.actualResult):'',errh=tc.error?renderMarkdown(tc.error):'',frc=tc.failureReasonCategory,frl=frc?(TEST_FAILURE_REASON_CATEGORY_LABELS[frc]||frc):'',frh=frl?'<div class="testcase-failure-category"><span class="testcase-failure-category-label">失败分类</span><span class="testcase-failure-category-chip">'+escHtml(frl)+'</span></div>':'',fdh=(errh||frh)?'<div class="accordion-field accordion-field-error"><span class="label">错误</span>'+frh+(errh?'<div class="accordion-markdown">'+errh+'</div>':'')+'</div>':'';
h+='<div class="accordion-item"><div class="accordion-header" data-accordion-toggle="'+escHtml(String(tc.index))+'"><span class="accordion-arrow">▶</span><span class="accordion-index">#'+tc.index+'</span><span class="accordion-title">'+escHtml(tc.title)+'</span><span class="analyze-modal-testcase-status status-'+tc.status+'">'+(STATUS_LABELS[tc.status]||tc.status)+'</span></div><div class="accordion-body" data-accordion-body="'+escHtml(String(tc.index))+'" style="display:none"><div class="accordion-field"><span class="label">测试 Prompt</span><div class="accordion-markdown">'+ph+'</div></div><div class="accordion-field"><span class="label">预期结果</span><div class="accordion-markdown">'+eh+'</div></div>'+(ah?'<div class="accordion-field"><span class="label">实际结果</span><div class="accordion-markdown">'+ah+'</div></div>':'')+fdh+'</div></div>'})
h+='</div>';openModal('测试用例',h)}

var detailOverlay=document.getElementById('detailOverlay'),detailBody=document.getElementById('detailBody');
function metaItem(label,value){return value?'<div class="detail-meta-item"><div class="meta-label">'+escHtml(label)+'</div><div class="meta-value">'+escHtml(value)+'</div></div>':''}
function listTags(items,prefix){items=items||[];return items.map(function(v){return '<span class="detail-resource-tag">'+prefix+' '+escHtml(v)+'</span>'}).join('')}
function showSkillDetailModal(sid){
var detail=detailsById[sid]||{},sr=results[sid]||{},sn=detail.name||sid,sd=detail.description||'',c=getSkillColor(sn),icon=document.getElementById('detailIcon');
icon.style.background=c.bg;icon.style.color=c.text;icon.textContent=getSkillInitial(sn);
document.getElementById('detailName').textContent=sn;document.getElementById('detailId').textContent=sid;
var h='<div class="detail-section"><div class="detail-section-label">简介</div><div class="detail-desc">'+(sd?escHtml(sd):'暂无描述')+'</div></div>';
if(detail.body)h+='<div class="detail-section"><div class="detail-section-label">技能内容</div><div class="detail-body-content">'+renderMarkdown(detail.body)+'</div></div>';
var metaHtml='';
metaHtml+=metaItem('来源',detail.source);
metaHtml+=metaItem('许可证',detail.license);
metaHtml+=metaItem('兼容性',detail.compatibility);
if(detail.allowedTools&&detail.allowedTools.length)metaHtml+=metaItem('允许工具',detail.allowedTools.join(', '));
if(metaHtml)h+='<div class="detail-section"><div class="detail-section-label">元信息</div><div class="detail-meta-grid">'+metaHtml+'</div></div>';
var res=detail.resources||{},resHtml=listTags(res.references,'📄')+listTags(res.scripts,'📜')+listTags(res.assets,'🖼');
if(resHtml)h+='<div class="detail-section"><div class="detail-section-label">资源</div><div class="detail-resources">'+resHtml+'</div></div>';
var actions='';if(sr.dependencies)actions+='<button type="button" class="analyze-row-btn" data-detail-deps="'+escHtml(sid)+'">依赖项</button>';if(sr.testCases&&sr.testCases.length)actions+='<button type="button" class="analyze-row-btn" data-detail-tests="'+escHtml(sid)+'">测试用例（共 '+sr.testCases.length+' 条）</button>';if(actions)h+='<div class="detail-section"><div class="detail-section-label">操作</div><div class="detail-actions">'+actions+'</div></div>';
detailBody.innerHTML=h;detailOverlay.classList.add('visible');
}
function closeDetail(){detailOverlay.classList.remove('visible')}
document.getElementById('detailClose').addEventListener('click',closeDetail)
detailOverlay.addEventListener('click',function(e){if(e.target===detailOverlay)closeDetail()})
detailBody.addEventListener('click',function(e){var deps=e.target.closest('[data-detail-deps]'),tests=e.target.closest('[data-detail-tests]');if(deps){showDepsModal(deps.getAttribute('data-detail-deps'));return}if(tests){showTestCasesModal(tests.getAttribute('data-detail-tests'))}})
document.addEventListener('keydown',function(e){if(e.key==='Escape'){if(modalOverlay.classList.contains('visible'))closeModal();else if(detailOverlay.classList.contains('visible'))closeDetail()}})

render();
</script>
</body>
</html>`;
}

export function generateAnalyzeExportDataJs(exportedSkills: AnalyzeSkillExport[]): string {
    const lines: string[] = [];
    lines.push('// Auto-generated from OpenDesk 分析与优化 export');
    lines.push('// Contains ' + exportedSkills.length + ' skills');
    lines.push('var EXPORTED_SKILLS = typeof EXPORTED_SKILLS === "undefined" ? [] : EXPORTED_SKILLS;');
    lines.push('');
    for (const item of exportedSkills) {
        lines.push('EXPORTED_SKILLS.push(' + JSON.stringify(cleanAnalyzeSkillExport(item)) + ');');
        lines.push('');
    }
    return lines.join('\n');
}

function cleanAnalyzeSkillExport(item: AnalyzeSkillExport): AnalyzeSkillExport {
    const clone = JSON.parse(JSON.stringify(item)) as AnalyzeSkillExport;
    cleanAnalysisReport(clone.analysisReport);
    cleanAnalysisReport((clone.meta?._compatibilityReport ?? undefined) as CompatibilityReport | undefined);
    return clone;
}

function cleanAnalysisReport(report: CompatibilityReport | undefined): void {
    if (!report) return;
    if (report.skill?.path) report.skill.path = '[omitted]';
    const classification = report.classification as
        | (CompatibilityReport['classification'] & { installAttempts?: Array<Record<string, unknown>> })
        | undefined;
    if (classification?.installAttempts) {
        for (const attempt of classification.installAttempts) {
            if (attempt.source) attempt.source = '[omitted]';
            if (attempt.zip_path) attempt.zip_path = '[omitted]';
            if (attempt.command) attempt.command = '[omitted]';
        }
    }
}
