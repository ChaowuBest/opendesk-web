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
 * 本地网络服务对外提供的远程员工管理页面（/manage，仅管理令牌可访问）。
 *
 * 与桌面端"员工管理"详情页对齐，但面向远程场景做了裁剪：
 * - 提供：基本信息（数据概览 + 资料与运行 + 数字员工指令）、Skills 管理（查看/删除）、MCP 管理；
 * - 不提供：安全管理、任务列表、员工启用开关、本地网络服务配置、打开目录/导出/删除等危险操作。
 *
 * 视觉与聊天页同一套设计令牌；页面零第三方依赖。
 * 注意：内容会被 esbuild 与 Vite 共同打包，页面脚本刻意不使用模板字符串与 "${" 序列。
 */
import type { WebPageEmbedOptions } from './chat-page.js';
import { webPageBootstrapScript } from './chat-page.js';

const MANAGE_PAGE_TEMPLATE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#252526" media="(prefers-color-scheme: dark)">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%23df4436'/%3E%3Cpath d='M9 11h14v8h-9l-5 4z' fill='%23fff'/%3E%3C/svg%3E">
<title>OpenDesk</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
[hidden] { display: none !important; }
/* 100% 高度链填满宿主容器（含 iframe）：dvh 视口单位在部分嵌入式 WebView 中不受支持。
   root 固定为视口高度，长内容在页面内部滚动，iframe 层不出现页面级滚动条 */
html, body { height: 100%; }
.root {
    height: 100%;
    overflow-y: auto;
    background: var(--page);
    color: var(--ink);
    font-family: system-ui, -apple-system, 'Segoe UI', 'HarmonyOS Sans', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    font-size: 13px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    color-scheme: light dark;
}
:root {
    --page: #eeedeb;
    --surface: #ffffff;
    --muted-surface: #fafafa;
    --ink: #1c1917;
    --ink2: #4a4642;
    --ink3: #79736d;
    --line: #e7e5e2;
    --line-soft: #f0efec;
    --accent: #df4436;
    --accent-ink: #bb352a;
    --accent-soft: #fdeeec;
    --blue: #4267b2;
    --bubble: #f4f3f1;
    --green: #238257;
    --green-soft: #e7f3ee;
}
@media (prefers-color-scheme: dark) {
    :root {
        color-scheme: dark;
        --page: #1b1b1c;
        --surface: #252526;
        --muted-surface: #22201e;
        --ink: #efedea;
        --ink2: #d5d1cb;
        --ink3: #aaa49e;
        --line: #3b3835;
        --line-soft: #33302d;
        --accent: #e8563f;
        --accent-ink: #ff9a89;
        --accent-soft: #422c29;
        --blue: #96b5ec;
        --bubble: #33302d;
        --green: #4fbf8f;
        --green-soft: #1f332b;
    }
}
button, input, select, textarea { font: inherit; color: inherit; }
button { border: 0; cursor: pointer; background: transparent; }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
    outline: 2px solid rgba(223, 68, 54, 0.55);
    outline-offset: 2px;
}
input, select, textarea {
    width: 100%;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 9px;
    padding: 9px 12px;
    font-size: 12px;
    color: var(--ink);
    outline: none;
    transition: border-color 0.15s;
}
input:focus, select:focus, textarea:focus { border-color: var(--accent); }
.manage-shell { max-width: 880px; margin: 0 auto; padding: 0 28px 48px; }
.manage-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 24px 0 15px;
}
.manage-avatar {
    width: 44px;
    height: 44px;
    border-radius: 13px;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-weight: 500;
    font-size: 14px;
    overflow: hidden;
}
.manage-avatar img { width: 100%; height: 100%; border-radius: inherit; object-fit: cover; display: block; }
.av-g1 { background: linear-gradient(135deg, #5b7fbe, #4267b2); }
.av-g2 { background: linear-gradient(135deg, #3d9d74, #238257); }
.av-g3 { background: linear-gradient(135deg, #c08a2e, #996718); }
.av-g4 { background: linear-gradient(135deg, #e8563f, #bb352a); }
@media (prefers-color-scheme: dark) {
    .av-g1 { background: linear-gradient(135deg, #96b5ec, #5f7fc0); }
    .av-g2 { background: linear-gradient(135deg, #67c99b, #3d8f68); }
    .av-g3 { background: linear-gradient(135deg, #dbb068, #a97e35); }
    .av-g4 { background: linear-gradient(135deg, #e8563f, #c2452f); }
}
.manage-who { flex: 1; min-width: 0; }
.manage-name {
    font-size: 22px;
    font-weight: 500;
    letter-spacing: -0.5px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}
.pill {
    padding: 3px 9px;
    border-radius: 7px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-size: 10px;
    font-weight: 500;
}
.manage-sub {
    margin-top: 6px;
    font-size: 10px;
    color: var(--ink3);
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
}
.status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--line); flex: none; }
.status-dot.on { background: var(--green); }
.powered {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 9px;
    padding: 7px 10px;
    font-size: 11px;
    color: var(--ink3);
}
.powered .powered-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--blue); flex: none; }
.manage-tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--line-soft);
    margin-bottom: 20px;
}
.manage-tab {
    padding: 9px 12px;
    font-size: 13px;
    color: var(--ink3);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
}
.manage-tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 500; }
.section-label { font-size: 12px; color: var(--ink3); margin: 22px 0 12px; }
.stats {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    background: var(--surface);
    border: 1px solid var(--line-soft);
    border-radius: 13px;
    padding: 16px 18px;
}
.stat b { display: block; font-size: 22px; font-weight: 600; letter-spacing: -0.4px; }
.stat span { display: block; margin-top: 3px; font-size: 11px; color: var(--ink3); }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 17px 20px; }
.field { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.field.full { grid-column: 1 / -1; }
.field label { font-size: 12px; color: var(--ink2); }
.field .sub { font-size: 11px; color: var(--ink3); }
.field.invalid input { border-color: var(--accent); }
.field-error { font-size: 11px; color: var(--accent-ink); }
textarea { min-height: 150px; resize: vertical; line-height: 1.7; }
textarea.code { min-height: 260px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.save-bar { display: flex; align-items: center; gap: 12px; margin-top: 18px; }
.btn-primary {
    display: inline-flex;
    align-items: center;
    padding: 8px 16px;
    border-radius: 8px;
    background: var(--accent);
    color: #fff;
    font-size: 13px;
    font-weight: 500;
}
.btn-primary:disabled { opacity: 0.5; cursor: default; }
.btn-secondary {
    display: inline-flex;
    align-items: center;
    padding: 6px 11px;
    border: 1px solid var(--line);
    border-radius: 7px;
    background: var(--surface);
    color: var(--ink);
    font-size: 11px;
}
.btn-secondary:hover { background: var(--bubble); }
.btn-danger { color: var(--accent-ink); }
.btn-danger:hover { background: var(--accent-soft); }
.save-status { font-size: 12px; color: var(--ink3); }
.save-status.ok { color: var(--green); }
.save-status.error { color: var(--accent-ink); }
.skill-list { display: flex; flex-direction: column; gap: 10px; }
.skills-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
}
.skills-toolbar .section-label { margin: 22px 0 12px; }
.skills-add-anchor { position: relative; }
.skills-add-menu {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    z-index: 40;
    width: 272px;
    padding: 6px;
    border: 1px solid var(--line);
    border-radius: 11px;
    background: var(--surface);
    box-shadow: 0 12px 40px rgba(28, 25, 23, 0.18);
}
.skill-menu-item {
    width: 100%;
    padding: 9px 10px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    border-radius: 8px;
    background: transparent;
    text-align: left;
    color: var(--ink);
}
.skill-menu-item:hover { background: var(--bubble); }
.skill-menu-item b { font-size: 12px; font-weight: 500; }
.skill-menu-item span { font-size: 11px; color: var(--ink3); }
.skill-url-form { display: flex; flex-direction: column; gap: 8px; padding: 6px; }
.skill-url-actions { display: flex; justify-content: flex-end; gap: 8px; }
.skill-row {
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--surface);
    border: 1px solid var(--line-soft);
    border-radius: 11px;
    padding: 12px 14px;
}
.skill-icon {
    width: 34px;
    height: 34px;
    border-radius: 9px;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    background: var(--accent-soft);
    color: var(--accent-ink);
}
.skill-copy { flex: 1; min-width: 0; }
.skill-copy b { display: block; font-size: 13px; }
.skill-copy .dir { font-size: 10px; color: var(--ink3); }
.skill-copy .desc {
    margin-top: 3px;
    font-size: 11px;
    color: var(--ink2);
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
}
.empty {
    padding: 42px 14px;
    text-align: center;
    color: var(--ink3);
    font-size: 12px;
}
.notice { color: var(--accent-ink); font-size: 12px; margin: 10px 0; }
.toast {
    position: fixed;
    left: 50%;
    bottom: 28px;
    transform: translateX(-50%) translateY(8px);
    background: var(--ink);
    color: var(--surface);
    padding: 9px 16px;
    border-radius: 9px;
    font-size: 12px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.18s, transform 0.18s;
    z-index: 60;
}
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.toast.error { background: var(--accent); color: #fff; }
@media (max-width: 760px) {
    .manage-shell { padding: 0 16px 40px; }
    .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .form-grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<div class="root" id="manage-app">
    <div class="manage-shell">
        <header class="manage-head">
            <span class="manage-avatar av-g1" id="manage-avatar"></span>
            <div class="manage-who">
                <h1 class="manage-name" id="manage-name"></h1>
                <div class="manage-sub"><span class="status-dot" id="manage-status-dot"></span><span id="manage-status"></span></div>
            </div>
            <span class="powered"><span class="powered-dot"></span><span id="manage-badge"></span></span>
        </header>
        <nav class="manage-tabs" id="manage-tabs"></nav>
        <main id="manage-content"><div class="empty" id="manage-loading"></div></main>
    </div>
    <div class="toast" id="manage-toast"></div>
</div>
<script>
(function () {
    'use strict';
    var bootstrap = window.__OD_WEB__ || {};
    // 未允许 iframe 集成时：被嵌入的页面立即渲染明确的禁止提示并停止初始化，
    // 避免访客只看到浏览器默认的"拒绝连接"占位页
    if (!bootstrap.allowIframeEmbedding && window.self !== window.top) {
        renderIframeBlocked(bootstrap.iframeBlockedMessage);
        return;
    }

    function renderIframeBlocked(message) {
        document.title = 'OpenDesk';
        var root = document.querySelector('.root');
        if (root) root.textContent = '';
        var box = document.createElement('div');
        box.style.cssText = 'min-height:100%;display:grid;place-items:center;padding:32px;box-sizing:border-box;';
        var text = document.createElement('p');
        text.style.cssText =
            'max-width:26em;text-align:center;line-height:1.7;font-size:14px;color:#4a4642;' +
            "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;";
        text.textContent = message || 'This page cannot be embedded in an iframe.';
        box.appendChild(text);
        // body 有确定的 height:100%，百分比 min-height 只有挂在这里才能撑满
        (document.body || root).appendChild(box);
    }

    var state = {
        strings: {},
        locale: 'en-US',
        staff: null,
        skills: [],
        models: { default_model: '', models: [] },
        tab: 'basic',
        urlToken: '',
        busy: false,
        /** 基本信息表单有未保存修改时，SSE 同步不覆盖表单内容 */
        dirty: false
    };
    var TRIGGER_ORDER = ['5m', '10m', '15m', '30m', '1h', 'never'];
    var SKILL_COLORS = [
        ['#fdeeec', '#bb352a'],
        ['#e7f3ee', '#238257'],
        ['#eef1f8', '#4267b2'],
        ['#faf3e6', '#996718']
    ];

    function $(id) { return document.getElementById(id); }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function tr(key) { return state.strings[key] || key; }

    function apiUrl(path) {
        if (!state.urlToken) return path;
        return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(state.urlToken);
    }

    function fetchJson(url, options) {
        return fetch(apiUrl(url), options).then(function (response) {
            if (!response.ok) {
                return response.json().catch(function () { return null; }).then(function (data) {
                    var error = new Error((data && data.error) || response.statusText || 'request failed');
                    throw error;
                });
            }
            return response.json();
        });
    }

    function gradientIndex(name) {
        var hash = 0;
        for (var i = 0; i < name.length; i++) hash = (hash * 131 + name.charCodeAt(i)) >>> 0;
        hash = ((hash ^ (hash >>> 13)) * 0x5bd1e995) >>> 0;
        hash = (hash ^ (hash >>> 15)) >>> 0;
        return hash % 4;
    }

    function formatTokens(value) {
        if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
        if (value >= 1000) return (value / 1000).toFixed(1) + 'k';
        return String(value);
    }

    function formatDate(iso) {
        var date = new Date(iso);
        if (isNaN(date.getTime())) return '';
        try { return date.toLocaleDateString(state.locale); } catch (e) { return date.toLocaleDateString(); }
    }

    var toastTimer;
    function showToast(text, isError) {
        var toast = $('manage-toast');
        toast.textContent = text;
        toast.classList.toggle('error', Boolean(isError));
        toast.classList.add('show');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 1800);
    }

    function setBusy(busy) {
        state.busy = busy;
        Array.prototype.forEach.call(document.querySelectorAll('[data-submit]'), function (button) {
            button.disabled = busy;
        });
    }

    function renderHeader() {
        var staff = state.staff;
        document.title = staff.name || document.title;
        var avatar = $('manage-avatar');
        avatar.className = 'manage-avatar av-g' + (gradientIndex(staff.name || 'AI') + 1);
        avatar.textContent = '';
        if (staff.portrait) {
            var img = document.createElement('img');
            img.src = apiUrl(staff.portrait);
            img.alt = '';
            avatar.appendChild(img);
        } else {
            avatar.textContent = (staff.name || 'A').slice(0, 1).toUpperCase();
        }
        var name = $('manage-name');
        name.textContent = '';
        name.appendChild(document.createTextNode(staff.name || ''));
        if (staff.specialties && staff.specialties[0]) {
            name.appendChild(el('span', 'pill', staff.specialties[0]));
        }
        $('manage-status-dot').className = 'status-dot' + (staff.enabled ? ' on' : '');
        var parts = [staff.enabled ? tr('enabled') : tr('disabled'), staff.title || '', staff.vendor_name || ''];
        $('manage-status').textContent = parts.filter(function (part) { return part; }).join(' · ');
        $('manage-badge').textContent = tr('poweredBy') + ' · ' + tr('manageBadge');
    }

    function renderTabs() {
        var tabs = $('manage-tabs');
        tabs.textContent = '';
        [['basic', 'tabBasic'], ['skills', 'tabSkills'], ['mcp', 'tabMcp']].forEach(function (pair) {
            var button = el('button', 'manage-tab' + (state.tab === pair[0] ? ' active' : ''), tr(pair[1]));
            button.type = 'button';
            button.addEventListener('click', function () {
                state.tab = pair[0];
                renderTabs();
                renderContent();
            });
            tabs.appendChild(button);
        });
    }

    function statItem(value, label) {
        var stat = el('div', 'stat');
        stat.appendChild(el('b', null, value));
        stat.appendChild(el('span', null, label));
        return stat;
    }

    function field(labelText, control, subText, full) {
        var wrap = el('div', 'field' + (full ? ' full' : ''));
        wrap.appendChild(el('label', null, labelText));
        wrap.appendChild(control);
        if (subText) wrap.appendChild(el('div', 'sub', subText));
        return wrap;
    }

    function renderStats(parent) {
        parent.appendChild(el('h3', 'section-label', tr('statsSection')));
        var stats = el('div', 'stats');
        stats.appendChild(statItem(String(state.staff.message_count || 0), tr('messagesStat')));
        stats.appendChild(statItem(String(state.staff.task_count || 0), tr('tasksStat')));
        stats.appendChild(statItem(formatTokens(state.staff.total_tokens || 0), tr('tokensStat')));
        stats.appendChild(statItem(formatDate(state.staff.hired_at), tr('hiredAt')));
        parent.appendChild(stats);
    }

    function selectOption(value, text, selected) {
        var option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        if (selected) option.selected = true;
        return option;
    }

    function renderBasic(parent) {
        var staff = state.staff;
        renderStats(parent);
        parent.appendChild(el('h3', 'section-label', tr('profileSection')));
        var grid = el('div', 'form-grid');

        var nameInput = el('input');
        nameInput.id = 'f-name';
        nameInput.value = staff.name || '';
        grid.appendChild(field(tr('nameLabel'), nameInput, null, false));

        var vendorInput = el('input');
        vendorInput.id = 'f-vendor';
        vendorInput.value = staff.vendor_name || '';
        grid.appendChild(field(tr('vendorLabel'), vendorInput, null, false));

        var titleInput = el('input');
        titleInput.id = 'f-title';
        titleInput.value = staff.title || '';
        grid.appendChild(field(tr('titleLabel'), titleInput, null, false));

        var specialtiesInput = el('input');
        specialtiesInput.id = 'f-specialties';
        specialtiesInput.value = (staff.specialties || []).join(', ');
        grid.appendChild(field(tr('specialtiesLabel'), specialtiesInput, null, false));

        var triggerSelect = el('select');
        triggerSelect.id = 'f-trigger';
        TRIGGER_ORDER.forEach(function (value) {
            triggerSelect.appendChild(selectOption(value, (state.strings.triggers || {})[value] || value, (staff.trigger_interval || 'never') === value));
        });
        grid.appendChild(field(tr('triggerIntervalLabel'), triggerSelect, tr('triggerIntervalHint'), false));

        var modelSelect = el('select');
        modelSelect.id = 'f-model';
        var defaultLabel = tr('modelGlobalDefault');
        if (state.models.default_model) defaultLabel = defaultLabel + ' (' + state.models.default_model + ')';
        modelSelect.appendChild(selectOption('', defaultLabel, !staff.model));
        (state.models.models || []).forEach(function (model) {
            modelSelect.appendChild(selectOption(model.alias, model.alias + ' · ' + model.provider_name + ' / ' + model.model_name, staff.model === model.alias));
        });
        if (staff.model && !Array.prototype.some.call(modelSelect.options, function (option) { return option.value === staff.model; })) {
            modelSelect.appendChild(selectOption(staff.model, staff.model, true));
        }
        grid.appendChild(field(tr('modelLabel'), modelSelect, tr('modelHint'), false));

        var agentsArea = el('textarea');
        agentsArea.id = 'f-agents';
        agentsArea.value = staff.agents_md || '';
        grid.appendChild(field(tr('instructionsLabel'), agentsArea, null, true));

        parent.appendChild(grid);

        // 表单有未保存修改时，SSE 同步不得覆盖正在编辑的内容
        [nameInput, vendorInput, titleInput, specialtiesInput, triggerSelect, modelSelect, agentsArea].forEach(
            function (control) {
                control.addEventListener('input', function () { state.dirty = true; });
                control.addEventListener('change', function () { state.dirty = true; });
            }
        );

        var saveBar = el('div', 'save-bar');
        var saveButton = el('button', 'btn-primary', tr('save'));
        saveButton.type = 'button';
        saveButton.setAttribute('data-submit', '1');
        var saveStatus = el('span', 'save-status');
        saveStatus.id = 'basic-status';
        saveBar.appendChild(saveButton);
        saveBar.appendChild(saveStatus);
        parent.appendChild(saveBar);

        saveButton.addEventListener('click', function () {
            var invalid = false;
            [nameInput, vendorInput, titleInput].forEach(function (input) {
                var missing = !input.value.trim();
                input.closest('.field').classList.toggle('invalid', missing);
                if (missing) invalid = true;
            });
            if (invalid) {
                saveStatus.className = 'save-status error';
                saveStatus.textContent = tr('fieldRequired');
                return;
            }
            saveStatus.className = 'save-status';
            saveStatus.textContent = '';
            setBusy(true);
            saveProfile({
                definition: {
                    name: nameInput.value.trim(),
                    vendor_name: vendorInput.value.trim(),
                    title: titleInput.value.trim(),
                    specialties: specialtiesInput.value.split(',').map(function (item) { return item.trim(); }).filter(Boolean),
                    trigger_interval: triggerSelect.value
                },
                agents_md: agentsArea.value
            }).then(function (data) {
                state.dirty = false;
                applyOverview(data);
                saveStatus.className = 'save-status ok';
                saveStatus.textContent = tr('saved');
                showToast(tr('saved'));
            }).catch(function (error) {
                saveStatus.className = 'save-status error';
                saveStatus.textContent = error.message || tr('operationFailed');
            }).then(function () { setBusy(false); });
        });
    }

    function menuItem(title, hintText, onClick) {
        var item = el('button', 'skill-menu-item');
        item.type = 'button';
        item.appendChild(el('b', null, title));
        if (hintText) item.appendChild(el('span', null, hintText));
        item.addEventListener('click', onClick);
        return item;
    }

    function closeSkillAddMenu() {
        var menu = $('skill-add-menu');
        if (menu) menu.hidden = true;
    }

    function postJson(path, payload) {
        return fetchJson(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
        });
    }

    function uploadSkillZip(file) {
        if (state.busy) return;
        var reader = new FileReader();
        reader.onload = function () {
            setBusy(true);
            postJson('/api/manage/skills/upload', { data: String(reader.result) })
                .then(function (data) {
                    applyOverview(data);
                    showToast(tr('saved'));
                })
                .catch(function (error) {
                    showToast(error.message || tr('operationFailed'), true);
                })
                .then(function () { setBusy(false); });
        };
        reader.readAsDataURL(file);
    }

    function addSkillFromUrl(sourceUrl, errorSlot) {
        if (state.busy) return;
        setBusy(true);
        postJson('/api/manage/skills/url', { url: sourceUrl })
            .then(function (data) {
                applyOverview(data);
                closeSkillAddMenu();
                showToast(tr('saved'));
            })
            .catch(function (error) {
                if (errorSlot) errorSlot.textContent = error.message || tr('operationFailed');
                else showToast(error.message || tr('operationFailed'), true);
            })
            .then(function () { setBusy(false); });
    }

    function renderSkills(parent) {
        var toolbar = el('div', 'skills-toolbar');
        toolbar.appendChild(el('h3', 'section-label inline', tr('tabSkills') + ' · ' + state.skills.length));

        var anchor = el('div', 'skills-add-anchor');
        var addBtn = el('button', 'btn-secondary', tr('addSkill'));
        addBtn.type = 'button';
        addBtn.id = 'skill-add-btn';

        var menu = el('div', 'skills-add-menu');
        menu.id = 'skill-add-menu';
        menu.hidden = true;
        var items = el('div', 'skill-menu-items');
        var urlForm = el('div', 'skill-url-form');
        urlForm.hidden = true;

        // 从 ZIP 添加：远程浏览器选择本地 zip 上传，服务端解包校验
        var zipInput = document.createElement('input');
        zipInput.type = 'file';
        zipInput.accept = '.zip';
        zipInput.hidden = true;
        zipInput.addEventListener('change', function () {
            var file = zipInput.files && zipInput.files[0];
            zipInput.value = '';
            closeSkillAddMenu();
            if (file) uploadSkillZip(file);
        });
        anchor.appendChild(zipInput);
        items.appendChild(
            menuItem(tr('addSkillFromZip'), tr('addSkillFromZipHint'), function () {
                closeSkillAddMenu();
                zipInput.click();
            })
        );

        // 从 URL 添加：服务端代下载 zip 并安装
        var urlInput = el('input');
        urlInput.type = 'url';
        urlInput.placeholder = 'https://example.com/skill.zip';
        var urlError = el('div', 'field-error');
        var urlActions = el('div', 'skill-url-actions');
        var confirm = el('button', 'btn-primary', tr('save'));
        confirm.type = 'button';
        confirm.addEventListener('click', function () {
            urlError.textContent = '';
            addSkillFromUrl(urlInput.value.trim(), urlError);
        });
        var cancel = el('button', 'btn-secondary', tr('cancel'));
        cancel.type = 'button';
        cancel.addEventListener('click', function () {
            urlInput.value = '';
            urlError.textContent = '';
            urlForm.hidden = true;
            items.hidden = false;
        });
        urlActions.appendChild(cancel);
        urlActions.appendChild(confirm);
        urlForm.appendChild(urlInput);
        urlForm.appendChild(urlError);
        urlForm.appendChild(urlActions);
        items.appendChild(
            menuItem(tr('addSkillFromUrl'), null, function () {
                items.hidden = true;
                urlForm.hidden = false;
                urlInput.focus();
            })
        );

        menu.appendChild(items);
        menu.appendChild(urlForm);
        addBtn.addEventListener('click', function () {
            menu.hidden = !menu.hidden;
            if (!menu.hidden) {
                urlInput.value = '';
                urlError.textContent = '';
                urlForm.hidden = true;
                items.hidden = false;
            }
        });

        anchor.appendChild(addBtn);
        anchor.appendChild(menu);
        toolbar.appendChild(anchor);
        parent.appendChild(toolbar);

        if (!state.skills.length) {
            parent.appendChild(el('div', 'empty', tr('noSkills')));
            return;
        }
        var list = el('div', 'skill-list');
        state.skills.forEach(function (skill) {
            var row = el('div', 'skill-row');
            var color = SKILL_COLORS[gradientIndex(skill.directory_name || skill.name || 's')];
            var icon = el('span', 'skill-icon', (skill.name || skill.directory_name || 'S').slice(0, 1).toUpperCase());
            icon.style.background = color[0];
            icon.style.color = color[1];
            row.appendChild(icon);
            var copy = el('div', 'skill-copy');
            copy.appendChild(el('b', null, skill.name || ''));
            copy.appendChild(el('span', 'dir', skill.directory_name || ''));
            if (skill.description) copy.appendChild(el('div', 'desc', skill.description));
            row.appendChild(copy);
            var remove = el('button', 'btn-secondary btn-danger', tr('delete'));
            remove.type = 'button';
            remove.setAttribute('data-submit', '1');
            remove.addEventListener('click', function () {
                if (state.busy) return;
                setBusy(true);
                fetchJson(apiUrl('/api/manage/skills/' + encodeURIComponent(skill.directory_name || skill.name)), {
                    method: 'DELETE'
                })
                    .then(function (data) {
                        applyOverview(data);
                        showToast(tr('saved'));
                    })
                    .catch(function (error) {
                        showToast(error.message || tr('operationFailed'), true);
                    })
                    .then(function () { setBusy(false); });
            });
            row.appendChild(remove);
            list.appendChild(row);
        });
        parent.appendChild(list);
    }

    function renderMcp(parent) {
        parent.appendChild(el('h3', 'section-label', tr('tabMcp')));
        var grid = el('div', 'form-grid');
        var mcpArea = el('textarea', 'code');
        mcpArea.id = 'f-mcp';
        mcpArea.value = JSON.stringify(state.staff.mcp || { servers: [] }, null, 4);
        var mcpField = field(tr('mcpJsonHint'), mcpArea, null, true);
        var mcpError = el('div', 'field-error');
        mcpField.appendChild(mcpError);
        grid.appendChild(mcpField);
        parent.appendChild(grid);

        var saveBar = el('div', 'save-bar');
        var saveButton = el('button', 'btn-primary', tr('save'));
        saveButton.type = 'button';
        saveButton.setAttribute('data-submit', '1');
        saveBar.appendChild(saveButton);
        parent.appendChild(saveBar);

        saveButton.addEventListener('click', function () {
            mcpError.textContent = '';
            var parsed;
            try {
                parsed = JSON.parse(mcpArea.value);
            } catch (e) {
                mcpError.textContent = tr('mcpInvalidJson');
                return;
            }
            if (!parsed || !Array.isArray(parsed.servers)) {
                mcpError.textContent = tr('mcpServersArray');
                return;
            }
            setBusy(true);
            saveProfile({ mcp: parsed }).then(function (data) {
                applyOverview(data);
                showToast(tr('saved'));
            }).catch(function (error) {
                mcpError.textContent = error.message || tr('operationFailed');
            }).then(function () { setBusy(false); });
        });
    }

    function renderContent() {
        var content = $('manage-content');
        content.textContent = '';
        if (!state.staff) return;
        if (state.tab === 'skills') renderSkills(content);
        else if (state.tab === 'mcp') renderMcp(content);
        else renderBasic(content);
    }

    function applyOverview(data) {
        state.staff = data.staff;
        state.skills = data.skills || [];
        state.models = data.models || { default_model: '', models: [] };
        state.strings = data.strings || state.strings;
        state.locale = data.locale || state.locale;
        renderHeader();
        renderContent();
    }

    function loadOverview() {
        return fetchJson('/api/manage/staff').then(function (data) {
            state.staff = data.staff;
            state.skills = data.skills || [];
            state.models = data.models || { default_model: '', models: [] };
            state.strings = data.strings || state.strings;
            state.locale = data.locale || state.locale;
        });
    }

    /** SSE 变更信号到达后重新拉取概览；正在编辑基本信息表单时不覆盖表单内容 */
    function refreshFromServer() {
        loadOverview()
            .then(function () {
                renderHeader();
                if (!(state.tab === 'basic' && state.dirty)) renderContent();
            })
            .catch(function () {});
    }

    function connectEvents() {
        if (typeof EventSource === 'undefined') return;
        var source = new EventSource(apiUrl('/api/manage/events'));
        source.addEventListener('changed', function () {
            refreshFromServer();
        });
    }

    function saveProfile(payload) {
        return fetchJson('/api/manage/staff', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
        });
    }

    function initialize() {
        var params = new URLSearchParams(window.location.search);
        state.urlToken = params.get('token') || '';
        $('manage-loading').textContent = tr('loading');
        loadOverview().then(function () {
            renderHeader();
            renderTabs();
            renderContent();
        }).catch(function (error) {
            var content = $('manage-content');
            content.textContent = '';
            content.appendChild(el('div', 'notice', error.message || 'load failed'));
        });
        connectEvents();
        // 点击添加菜单外部时收起
        document.addEventListener('mousedown', function (event) {
            var menu = $('skill-add-menu');
            var button = $('skill-add-btn');
            if (!menu || menu.hidden) return;
            var target = event.target;
            if ((button && (target === button || button.contains(target))) || menu.contains(target)) return;
            menu.hidden = true;
        });
    }

    initialize();
})();
</script>
</body>
</html>`;

/**
 * 生成远程员工管理页面 HTML。embed 提供 iframe 集成开关与禁止嵌入时的本地化提示文案。
 */
export function managePageHtml(embed?: WebPageEmbedOptions): string {
    return MANAGE_PAGE_TEMPLATE.replace('<body>', '<body>' + webPageBootstrapScript(embed));
}
