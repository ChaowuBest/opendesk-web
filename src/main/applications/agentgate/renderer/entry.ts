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

const BASE_URL = (typeof process !== 'undefined' && process.env?.AGENT_GATE_URL) || 'http://127.0.0.1:9100';
const DASHBOARD_URL = `${BASE_URL}/dashboard/`;
const HEALTH_URL = `${BASE_URL}/api/v1/health`;

const OFFLINE_HTML = `
<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;
    background:#FAFAFA;color:#8E8E93;font-family:-apple-system,BlinkMacSystemFont,sans-serif;
    -webkit-font-smoothing:antialiased;padding:40px;text-align:center;">
  <img src="data:image/png;base64,
iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAADDklEQVR4nO3ZzU0rQRREYYIiGVIhQXLyxshISJbBMNMz3ef+nJFqCbpd9em9BS8vk7/L5XI145m9z2kfXVS30Ht/fXQJBsJAP9hAEOgHGhAC/SgDIqAfY0AE9CMMiIA+3oAI6KMNiIA+1oAI6CMNjIA+0IAA6OMMjIA+zIAA6KMMjIA+yAjAUADoYwyMgD7ECMAIwAjACMAsBkAfYWAE9AFGAEYARgBbD36/hg/dUWkA0RHQ3QhAAPUBREVAdyIAAQhAAE0ARENAdyEAAfQDEAUB3YEABCAAATQFQCOg3y4AAQiAQkC/WQACEIAABIAgoN8qAAEIgEJAv1EAAugLYOU/8x2ACGAwrx9vAugK4Db+dwTQDMD9+M8Q0B0JYDGARwR0RwJYPP4jArojAQDj3yOgOxIAOL4AigHYO74AGgJ4/Bm6IwGA4wugCIDR8QVQAMCR8QWQHMDR8QUgALwjAYDjCyApgLPGFwAEYM9AM8cXADT+yFBbxx/5vXRXbQAcHWvG+AIAx98z2qzxMyFIAWDGeLPHz4IgJYCt/28/G3HV+AKYMP4ZCFYCiI4gLYBRBKvHF8Ck8UchrB4/OoKwAPYWHHn8yAjKADiKYPb4Apg8/lEEKwBERFAOwAiCVeMLYMH4IwhWAoiGIBSAs4uOOH40BKUB/IeAGl8Ai8b/CwE5fiQELQA8IqCHF8Di8e8R0KNHQ4ADoAeIEAE0T1sAdPGRIoDmaQeALjxi2gCgi44cATRPeQB0wRkigOYpC4AuNlPKAaALzZhSAMQQZ3QcgBD44UMAEIJ/DWwLge46JIDqGOhOUwGoBIHuMDWAzBDozkoByASB7qg0gKgY6C6GO7x99BGZIdBvPzx+BQAEBPqtAoAg0G8TAICBfoMAIAj0zQKAINA3LgfQDcEzCPRN2PgdAXSPAJrnBwAR9Mmv4wugT54CEEH9/Dm+AOrnXwAiqJtN44ugZnaNL4JaGRpfBDVyaHwR5M4p44sgZ04dXwS5MmV8IcTP9OGFEDPLh//to0voFnrvzR9dVPbM3ucTSN+XE799pLwAAAAASUVORK5CYII="
    width="96" height="96" style="margin-bottom:16px;flex-shrink:0;" alt="AgentGate"/>
  <h2 style="font-size:18px;font-weight:600;color:#1d1d1f;margin:0 0 8px;">AgentGate 服务未运行</h2>
  <p style="font-size:14px;margin:0 0 24px;line-height:1.6;text-align:left;max-width:400px;">
    请先安装并启动 AgentGate + AgentMoss 服务：<br/><br/>
    <code style="display:block;background:#F2F2F7;padding:10px 14px;border-radius:8px;
      font-size:12px;color:#1d1d1f;text-align:left;line-height:1.8;">
      pip install agent-gate-sec agent-moss<br/>
      agent-moss server &mdash;port 9090 &amp;<br/>
      agent-gate server &mdash;port 9100
    </code>
    <br/>
    <span style="font-size:12px;color:#8E8E93;">
      启动后点击下方按钮重新连接，或设置环境变量<br/>
      <code style="background:#F2F2F7;padding:1px 6px;border-radius:4px;">AGENT_GATE_URL</code>
      指定自定义地址。
    </span>
    <br/><br/>
    <span style="font-size:11px;color:#C7C7CC;">AgentGate v0.2.1 + AgentMoss v0.2.1</span>
  </p>
  <button id="agentgate-retry-btn"
    style="padding:8px 20px;border-radius:10px;border:none;background:#007AFF;color:#fff;
    font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,122,255,0.3);">
    重新检测
  </button>
</div>`;

const TABS_HTML = `
<div style="display:flex;flex-direction:column;height:100%;">
  <div style="display:flex;align-items:flex-end;border-bottom:1px solid #F0F0F0;background:#fff;flex-shrink:0;padding:30px 0 0 0;-webkit-app-region:no-drag;">
    <div class="ag-tab active" data-tab="dashboard" style="display:flex;align-items:center;padding:8px 20px 6px;font-size:13px;font-weight:600;color:#007AFF;cursor:pointer;border-bottom:2px solid #007AFF;user-select:none;">Dashboard</div>
    <div class="ag-tab" data-tab="config" style="display:flex;align-items:center;padding:8px 20px 6px;font-size:13px;color:#8E8E93;cursor:pointer;border-bottom:2px solid transparent;user-select:none;">配置</div>
  </div>
  <div id="ag-panel-dashboard" style="flex:1;overflow:auto;"></div>
  <div id="ag-panel-config" style="flex:1;overflow:auto;display:none;padding:20px;"></div>
</div>`;

const CONFIG_HTML = `
<div style="border-bottom:2px solid #E5E5EA;padding-bottom:10px;margin-bottom:16px;">
  <span style="display:inline-block;background:#F2F2F7;padding:4px 12px;border-radius:4px;font-size:14px;font-weight:700;color:#48484A;">AgentMoss · 安全分析引擎</span>
</div>
<h3 style="margin-bottom:16px;font-size:15px;">LLM 深度分析</h3>
<label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:14px;">
  <input type="checkbox" id="ag-enable-llm" checked style="width:16px;height:16px;">
  启用 LLM 语义分析（Layer 3）
</label>
<div style="display:flex;gap:12px;margin-bottom:20px;">
  <label style="flex:1;font-size:13px;color:#8E8E93;">
    分析模型
    <select id="ag-llm-model" style="display:block;margin-top:4px;width:100%;padding:6px 10px;border:1px solid #F0F0F0;border-radius:6px;font-size:13px;">
      <option value="">默认模型</option>
    </select>
  </label>
  <label style="width:120px;font-size:13px;color:#8E8E93;">
    超时(秒)
    <input id="ag-llm-timeout" type="number" min="10" max="600" value="300" style="display:block;margin-top:4px;width:100%;padding:6px 10px;border:1px solid #F0F0F0;border-radius:6px;font-size:13px;">
  </label>
</div>

<h3 style="margin-bottom:12px;font-size:15px;">安全拦截策略</h3>
<div style="margin-bottom:20px;">
  <label style="font-size:13px;color:#8E8E93;">
    拦截程度
    <select id="ag-security-level" style="display:block;margin-top:4px;width:100%;padding:6px 10px;border:1px solid #F0F0F0;border-radius:6px;font-size:13px;">
      <option value="low">低 — 仅弹窗提醒，不拦截</option>
      <option value="medium" selected>中 — 高风险拦截，低风险提示 override（推荐）</option>
      <option value="high">高 — 所有 deny 一律直接拦截</option>
    </select>
  </label>
  <div id="ag-security-desc" style="margin-top:6px;font-size:12px;color:#8E8E93;line-height:1.5;"></div>
</div>

<h3 style="margin-bottom:16px;font-size:15px;">自定义安全规则</h3>
<div id="ag-rules-list" style="margin-bottom:12px;"></div>
<button id="ag-add-rule" style="padding:6px 14px;border-radius:6px;border:1px dashed #007AFF;background:none;color:#007AFF;font-size:13px;cursor:pointer;">+ 添加规则</button>
<div id="ag-new-rule-form" style="display:none;margin-top:12px;padding:12px;background:#F5F5F7;border-radius:8px;">
  <input id="ag-rule-pattern" placeholder="正则匹配模式, 如 rm -rf /" style="width:100%;padding:6px 8px;border:1px solid #F0F0F0;border-radius:4px;font-size:12px;margin-bottom:8px;">
  <div style="display:flex;gap:8px;">
    <select id="ag-rule-action" style="flex:1;padding:6px 8px;border:1px solid #F0F0F0;border-radius:4px;font-size:12px;"><option value="Deny">Deny</option><option value="Allow">Allow</option></select>
    <select id="ag-rule-severity" style="flex:1;padding:6px 8px;border:1px solid #F0F0F0;border-radius:4px;font-size:12px;"><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select>
    <button id="ag-rule-save" style="padding:6px 16px;background:#007AFF;color:#fff;border:none;border-radius:4px;font-size:12px;cursor:pointer;">确认</button>
    <button id="ag-rule-cancel" style="padding:6px 16px;background:none;color:#007AFF;border:none;font-size:12px;cursor:pointer;">取消</button>
  </div>
</div>

<div style="border-bottom:2px solid #E5E5EA;padding-bottom:10px;margin-top:24px;margin-bottom:16px;">
  <span style="display:inline-block;background:#F2F2F7;padding:4px 12px;border-radius:4px;font-size:14px;font-weight:700;color:#48484A;">AgentGate · 数据网关服务</span>
</div>
<h3 style="margin-bottom:16px;font-size:15px;">数据库路径</h3>
<div style="font-size:13px;">
  <input id="ag-db-path" readonly style="width:100%;padding:6px 8px;border:1px solid #F0F0F0;border-radius:6px;font-size:12px;background:#F5F5F7;color:#8E8E93;margin-bottom:8px;">
  <div style="display:flex;gap:8px;">
    <button id="ag-db-edit" style="padding:4px 12px;border:1px solid #007AFF;border-radius:4px;background:none;color:#007AFF;font-size:12px;cursor:pointer;">修改</button>
    <button id="ag-db-confirm" style="display:none;padding:4px 12px;border:1px solid #FF3B30;border-radius:4px;background:none;color:#FF3B30;font-size:12px;cursor:pointer;">确认生效</button>
    <button id="ag-db-cancel" style="display:none;padding:4px 12px;border:none;border-radius:4px;background:none;color:#8E8E93;font-size:12px;cursor:pointer;">取消</button>
  </div>
  <div id="ag-db-confirm-msg" style="display:none;margin-top:8px;padding:8px 12px;background:rgba(255,59,48,.08);border:1px solid rgba(255,59,48,.2);border-radius:6px;font-size:12px;color:#FF3B30;">
    修改数据库路径将重启 AgentGate 服务。请确认路径正确。
  </div>
</div>

<div style="border-top:2px solid #E5E5EA;padding-top:16px;margin-top:24px;"></div>
<h3 style="margin-bottom:16px;font-size:15px;">服务状态</h3>
<div style="font-size:13px;color:#8E8E93;">
  <div style="display:flex;"><span style="display:inline-block;width:90px;">AgentMoss</span><span id="ag-moss-status" style="color:#34C759;">● 运行中</span><span style="margin-left:8px;font-size:12px;" id="ag-moss-addr">127.0.0.1:9090</span></div>
  <div style="display:flex;margin-top:4px;"><span style="display:inline-block;width:90px;">AgentGate</span><span id="ag-gate-status" style="color:#34C759;">● 运行中</span><span style="margin-left:8px;font-size:12px;" id="ag-gate-addr">127.0.0.1:9100</span></div>
</div>
`;

class AgentGateEntryWidget extends HTMLElement {
    connectedCallback() {
        this.style.cssText = 'display:block;width:100%;height:100%;overflow:hidden;';
        this._connect();
    }

    async _connect(retryCount: number = 0) {
        // 不立即显示离线页，先尝试连接
        if (retryCount === 0 && this.querySelector('#ag-panel-dashboard')) return; // already connected
        try {
            const resp = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
            if (resp.ok) {
                this._showApp();
                return;
            }
        } catch {
            /* service not ready yet */
        }

        // 显示离线页并自动重试
        if (retryCount === 0) this.innerHTML = OFFLINE_HTML;
        const retryBtn = this.querySelector('#agentgate-retry-btn');
        if (retryBtn && retryCount === 0) {
            retryBtn.addEventListener('click', () => this._connect(0));
        }

        const MAX_RETRY = 10;
        const retryDelay = retryCount === 0 ? 500 : 1500;
        if (retryCount < MAX_RETRY) {
            const r = retryCount + 1;
            const msg = this.querySelector('h2');
            if (msg) msg.textContent = `AgentGate 服务启动中... (${r}/${MAX_RETRY})`;
            setTimeout(() => this._connect(r), retryDelay);
        }
    }

    _showApp() {
        this.innerHTML = TABS_HTML;

        // Dashboard panel
        const dashPanel = this.querySelector('#ag-panel-dashboard');
        if (dashPanel) this._loadDashboard(dashPanel as HTMLElement);

        // Config panel
        const configPanel = this.querySelector('#ag-panel-config');
        if (configPanel) {
            configPanel.innerHTML = CONFIG_HTML;
            this._initConfigPanel();
        }

        // Tab hover effect + switching
        this.querySelectorAll('.ag-tab').forEach((tab) => {
            const el = tab as HTMLElement;
            el.style.cursor = 'pointer';
            el.addEventListener('mouseenter', () => {
                el.style.background = '#F5F5F7';
            });
            el.addEventListener('mouseleave', () => {
                el.style.background = 'transparent';
            });
        });
        this.querySelectorAll('.ag-tab').forEach((tab) => {
            tab.addEventListener('click', () => {
                const target = (tab as HTMLElement).dataset.tab;
                this.querySelectorAll('.ag-tab').forEach((t) => {
                    (t as HTMLElement).style.color = '#8E8E93';
                    (t as HTMLElement).style.borderBottomColor = 'transparent';
                });
                (tab as HTMLElement).style.color = '#007AFF';
                (tab as HTMLElement).style.borderBottomColor = '#007AFF';

                const dashEl = this.querySelector('#ag-panel-dashboard') as HTMLElement;
                const confEl = this.querySelector('#ag-panel-config') as HTMLElement;
                if (target === 'dashboard') {
                    if (dashEl) dashEl.style.display = '';
                    if (confEl) confEl.style.display = 'none';
                } else {
                    if (dashEl) dashEl.style.display = 'none';
                    if (confEl) confEl.style.display = '';
                    // Reload models when switching to config tab
                    this._loadModels();
                }
            });
        });
    }

    async _initConfigPanel() {
        // Hover effects for all buttons in config panel
        const configPanel = this.querySelector('#ag-panel-config') as HTMLElement;
        if (configPanel) {
            const applyHover = (btn: HTMLElement) => {
                btn.style.cursor = 'pointer';
                const origBg = btn.style.background;
                const origBorder = btn.style.border;
                btn.addEventListener('mouseenter', () => {
                    btn.style.background = origBg === 'none' || !origBg ? '#F5F5F7' : '#005EC4';
                });
                btn.addEventListener('mouseleave', () => {
                    btn.style.background = origBg || 'none';
                });
            };
            configPanel.querySelectorAll('button').forEach((b) => applyHover(b as HTMLElement));
            // Also handle dynamically added rule delete buttons later
            (this as any)._applyButtonHover = applyHover;
        }

        await this._loadModels();

        // Add rule button
        const addBtn = this.querySelector('#ag-add-rule');
        const form = this.querySelector('#ag-new-rule-form') as HTMLElement;
        if (addBtn && form) {
            addBtn.addEventListener('click', () => {
                form.style.display = form.style.display === 'none' ? '' : 'none';
            });
        }

        // Cancel
        const cancelBtn = this.querySelector('#ag-rule-cancel');
        if (cancelBtn && form) {
            cancelBtn.addEventListener('click', () => {
                form.style.display = 'none';
            });
        }

        // Save rule
        const saveBtn = this.querySelector('#ag-rule-save');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                const pattern = (this.querySelector('#ag-rule-pattern') as HTMLInputElement)?.value;
                const action = (this.querySelector('#ag-rule-action') as HTMLSelectElement)?.value;
                const severity = (this.querySelector('#ag-rule-severity') as HTMLSelectElement)?.value;
                if (!pattern) return;
                this._addRule(pattern, action, severity);
                if (form) form.style.display = 'none';
                (this.querySelector('#ag-rule-pattern') as HTMLInputElement).value = '';
            });
        }

        // Enable LLM checkbox — save on change
        const enableLLM = this.querySelector('#ag-enable-llm') as HTMLInputElement;
        if (enableLLM) {
            enableLLM.addEventListener('change', () => {
                try {
                    (window as any).applicationAPI?.callMainWorld('setEnableLLM', enableLLM.checked);
                } catch {}
            });
        }

        // LLM timeout input — save on blur
        const timeoutInput = this.querySelector('#ag-llm-timeout') as HTMLInputElement;
        if (timeoutInput) {
            timeoutInput.addEventListener('blur', () => {
                const v = parseInt(timeoutInput.value, 10);
                if (v >= 10 && v <= 600) {
                    try {
                        (window as any).applicationAPI?.callMainWorld('setLLMTimeout', v);
                    } catch {}
                }
            });
        }

        // Security level dropdown — save on change + show description
        const secLevel = this.querySelector('#ag-security-level') as HTMLSelectElement;
        const secDesc = this.querySelector('#ag-security-desc') as HTMLElement;
        const descMap: Record<string, string> = {
            low: '所有 deny 仅弹窗提醒，不会阻止命令执行。适用于宽松安全策略。',
            medium: '高风险(high/critical)直接拦截；低中风险拦截并提示 override 方式（推荐）。',
            high: '所有 deny 一律直接拦截，不提供 override。适用于严格安全环境。'
        };
        const updateSecDesc = (v: string) => {
            if (secDesc) secDesc.textContent = descMap[v] || '';
        };

        // Load current security level
        try {
            const api = (window as any).applicationAPI;
            if (api?.callMainWorld && secLevel) {
                const level = await api.callMainWorld('getSecurityLevel');
                if (level && ['low', 'medium', 'high'].includes(level)) {
                    secLevel.value = level;
                    updateSecDesc(level);
                } else {
                    updateSecDesc('medium');
                }
            }
        } catch {}

        if (secLevel) {
            secLevel.addEventListener('change', () => {
                const v = secLevel.value;
                updateSecDesc(v);
                try {
                    (window as any).applicationAPI?.callMainWorld('setSecurityLevel', v);
                } catch {}
            });
        }

        // DB path controls
        const dbInput = this.querySelector('#ag-db-path') as HTMLInputElement;
        const dbEdit = this.querySelector('#ag-db-edit') as HTMLElement;
        const dbConfirm = this.querySelector('#ag-db-confirm') as HTMLElement;
        const dbCancel = this.querySelector('#ag-db-cancel') as HTMLElement;
        const dbMsg = this.querySelector('#ag-db-confirm-msg') as HTMLElement;

        // Show current path
        try {
            const api = (window as any).applicationAPI;
            if (api?.callMainWorld) {
                const dbPath = await api.callMainWorld('getDbPath');
                if (dbInput) dbInput.value = dbPath || '';
            }
        } catch {}

        if (dbEdit) {
            dbEdit.addEventListener('click', () => {
                if (dbInput) (dbInput as HTMLInputElement).removeAttribute('readonly');
                if (dbInput) dbInput.style.background = '';
                if (dbInput) dbInput.style.color = '';
                dbEdit.style.display = 'none';
                if (dbConfirm) dbConfirm.style.display = '';
                if (dbCancel) dbCancel.style.display = '';
                if (dbMsg) dbMsg.style.display = '';
            });
        }

        if (dbCancel) {
            dbCancel.addEventListener('click', async () => {
                try {
                    const api = (window as any).applicationAPI;
                    if (api?.callMainWorld) {
                        const dbPath = await api.callMainWorld('getDbPath');
                        if (dbInput) dbInput.value = dbPath || '';
                    }
                } catch {}
                if (dbInput) (dbInput as HTMLInputElement).setAttribute('readonly', 'true');
                if (dbInput) dbInput.style.background = '#F5F5F7';
                if (dbInput) dbInput.style.color = '#8E8E93';
                dbEdit.style.display = '';
                if (dbConfirm) dbConfirm.style.display = 'none';
                if (dbCancel) dbCancel.style.display = 'none';
                if (dbMsg) dbMsg.style.display = 'none';
            });
        }

        if (dbConfirm) {
            dbConfirm.addEventListener('click', async () => {
                const newPath = (dbInput as HTMLInputElement)?.value?.trim();
                if (!newPath) return;
                try {
                    const api = (window as any).applicationAPI;
                    if (api?.callMainWorld) {
                        await api.callMainWorld('setDbPath', newPath);
                    }
                } catch {}
                if (dbInput) (dbInput as HTMLInputElement).setAttribute('readonly', 'true');
                if (dbInput) dbInput.style.background = '#F5F5F7';
                if (dbInput) dbInput.style.color = '#8E8E93';
                dbEdit.style.display = '';
                if (dbConfirm) dbConfirm.style.display = 'none';
                if (dbCancel) dbCancel.style.display = 'none';
                if (dbMsg) dbMsg.style.display = 'none';
            });
        }

        // Render existing rules from config
        this._renderRules();
    }

    async _loadModels() {
        const select = this.querySelector('#ag-llm-model') as HTMLSelectElement;
        if (!select) return;
        try {
            const models: { alias: string; name: string }[] =
                (await (window as any).applicationAPI?.callMainWorld('getModels')) || [];
            select.innerHTML = '<option value="">默认模型</option>';
            models.forEach((m) => {
                const opt = document.createElement('option');
                opt.value = m.alias;
                opt.textContent = `${m.alias} (${m.name})`;
                select.appendChild(opt);
            });
        } catch {
            /* ignore */
        }
    }

    async _addRule(pattern: string, action: string, severity: string) {
        const rules = await this._getRules();
        rules.push({ pattern, action, severity: severity as any });
        await this._saveRules(rules);
        this._renderRules(rules);
    }

    async _removeRule(index: number) {
        const rules = await this._getRules();
        rules.splice(index, 1);
        await this._saveRules(rules);
        this._renderRules(rules);
    }

    async _getRules(): Promise<{ pattern: string; action: string; severity: string }[]> {
        try {
            const api = (window as any).applicationAPI;
            if (api?.callMainWorld) {
                return (await api.callMainWorld('getCustomRules')) || [];
            }
        } catch {}
        try {
            return JSON.parse(localStorage.getItem('ag_custom_rules') || '[]');
        } catch {
            return [];
        }
    }

    async _saveRules(rules: { pattern: string; action: string; severity: string }[]) {
        try {
            const api = (window as any).applicationAPI;
            if (api?.callMainWorld) {
                await api.callMainWorld('saveCustomRules', rules);
                return;
            }
        } catch {}
        localStorage.setItem('ag_custom_rules', JSON.stringify(rules));
    }

    async _renderRules(rules?: { pattern: string; action: string; severity: string }[]) {
        const rulesList = this.querySelector('#ag-rules-list');
        if (!rulesList) return;
        if (!rules) rules = await this._getRules();
        rulesList.innerHTML = rules
            .map(
                (r, i) => `
              <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #F0F0F0;font-size:13px;">
                <code style="flex:1;background:#F5F5F7;padding:2px 6px;border-radius:4px;">${r.pattern}</code>
                <span style="display:inline-block;width:56px;text-align:center;padding:1px 0;border-radius:10px;font-size:11px;font-weight:600;background:${r.action === 'Deny' ? 'rgba(255,59,48,.12)' : 'rgba(52,199,89,.12)'};color:${r.action === 'Deny' ? '#FF3B30' : '#34C759'}">${r.action}</span>
                <span style="display:inline-block;width:56px;text-align:center;color:#FF9500;font-size:11px;">${r.severity}</span>
                <button style="border:none;background:none;color:#8E8E93;cursor:pointer;font-size:14px;">✕</button>
              </div>
            `
            )
            .join('');
        // Wire up delete buttons
        rulesList.querySelectorAll('button').forEach((btn, i) => {
            btn.addEventListener('click', () => this._removeRule(i));
            if ((this as any)._applyButtonHover) (this as any)._applyButtonHover(btn);
        });
    }

    async _loadDashboard(panel: HTMLElement) {
        panel.innerHTML =
            '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#8E8E93;font-size:14px;">加载中...</div>';
        try {
            const resp = await fetch(DASHBOARD_URL);
            if (resp.ok) {
                const html = await resp.text();
                panel.innerHTML = html;

                // Update clock every second
                const clock = panel.querySelector('#clock');
                if (clock) {
                    const tick = () => {
                        clock.textContent = new Date().toLocaleString('zh-CN');
                    };
                    tick();
                    setInterval(tick, 1000);
                }

                // Tab hover effect + switching inside dashboard
                panel.querySelectorAll('.tab').forEach((tab) => {
                    const el = tab as HTMLElement;
                    el.style.cursor = 'pointer';
                    el.addEventListener('mouseenter', () => {
                        el.style.background = '#F5F5F7';
                    });
                    el.addEventListener('mouseleave', () => {
                        el.style.background = 'transparent';
                    });
                });
                panel.querySelectorAll('.tab').forEach((tab) => {
                    tab.addEventListener('click', () => {
                        panel.querySelectorAll('.tab').forEach((t) => {
                            (t as HTMLElement).className = 'tab';
                        });
                        (tab as HTMLElement).className = 'tab active';
                        const target = (tab as HTMLElement).dataset.panel;
                        ['calls', 'agents', 'timeline'].forEach((id) => {
                            const el = panel.querySelector('#' + id + '-panel') as HTMLElement;
                            if (el) el.style.display = id === target ? 'block' : 'none';
                        });
                    });
                });

                // Fetch stats periodically
                const refresh = async () => {
                    try {
                        const [tcResp, agentsResp, tlResp] = await Promise.all([
                            fetch(`${BASE_URL}/api/v1/tool_calls?limit=200`),
                            fetch(`${BASE_URL}/api/v1/agents`),
                            fetch(`${BASE_URL}/api/v1/timeline?minutes=60`)
                        ]);
                        const arr = await tcResp.json().then((r: any) => (Array.isArray(r) ? r : []));
                        const agents = await agentsResp.json().then((r: any) => (Array.isArray(r) ? r : []));
                        const timeline = await tlResp.json().then((r: any) => (Array.isArray(r) ? r : []));

                        const allow = arr.filter((x: any) => x.decision === 'Allow').length;
                        const deny = arr.filter((x: any) => x.decision === 'Deny').length;
                        const sessions = new Set(arr.map((x: any) => x.session_id)).size;

                        const setText = (id: string, v: string) => {
                            const el = panel.querySelector('#' + id);
                            if (el) el.textContent = v;
                        };
                        setText('stat-agents', String(agents.length));
                        setText('stat-total', String(arr.length));
                        setText('stat-sessions', String(sessions));
                        setText('stat-allow', String(allow));
                        setText('stat-deny', String(deny));
                        const avgLat =
                            arr.length > 0
                                ? Math.round(
                                      arr.reduce((s: number, x: any) => s + (x.analysis_duration_ms || 0), 0) /
                                          arr.length
                                  )
                                : 0;
                        setText('stat-latency', avgLat + 'ms');

                        // Risk
                        const levels: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
                        arr.forEach((x: any) => {
                            const l = x.risk_level;
                            if (l in levels) levels[l]++;
                        });
                        const totalRisk = levels.critical + levels.high + levels.medium + levels.low || 1;
                        const riskBar = panel.querySelector('#risk-bar');
                        const riskLegend = panel.querySelector('#risk-legend');
                        if (riskBar)
                            riskBar.innerHTML = `<div style="width:${(levels.critical / totalRisk) * 100}%;background:var(--red)"></div><div style="width:${(levels.high / totalRisk) * 100}%;background:var(--orange)"></div><div style="width:${(levels.medium / totalRisk) * 100}%;background:var(--yellow)"></div><div style="width:${(levels.low / totalRisk) * 100}%;background:var(--muted)"></div>`;
                        if (riskLegend)
                            riskLegend.innerHTML = `<span><span class="risk-dot" style="background:var(--red)"></span>Critical ${levels.critical}</span><span><span class="risk-dot" style="background:var(--orange)"></span>High ${levels.high}</span><span><span class="risk-dot" style="background:var(--yellow)"></span>Medium ${levels.medium}</span><span><span class="risk-dot" style="background:var(--muted)"></span>Low ${levels.low}</span>`;

                        // Recent calls
                        const tbody = panel.querySelector('#recent-table');
                        if (tbody) {
                            tbody.innerHTML = arr
                                .slice(0, 20)
                                .map(
                                    (x: any) => `<tr>
                                <td>${x.called_at ? new Date(x.called_at + 'Z').toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-'}</td>
                                <td>${x.agent_type || '-'}</td>
                                <td>${x.session_id || '-'}</td>
                                <td><code>${x.command || x.action_detail || '-'}</code></td>
                                <td><span class="badge ${x.decision === 'Allow' ? 'badge-allow' : 'badge-deny'}">${x.decision}</span></td>
                                <td style="color:${x.risk_level === 'critical' ? 'var(--red)' : x.risk_level === 'high' ? 'var(--orange)' : x.risk_level === 'medium' ? 'var(--yellow)' : 'var(--muted)'}">${x.risk_level || '-'}</td>
                                <td>${Math.round(x.analysis_duration_ms || 0)}ms</td>
                                <td>${x.reason || '-'}</td>
                            </tr>`
                                )
                                .join('');
                        }

                        // Agents table
                        const at = panel.querySelector('#agents-table');
                        if (at)
                            at.innerHTML = agents
                                .map(
                                    (a: any) =>
                                        `<tr><td>${a.agent_type}</td><td>${a.hostname}</td><td>${a.session_count}</td><td>${a.call_count}</td></tr>`
                                )
                                .join('');

                        // Timeline
                        const tt = panel.querySelector('#timeline-table');
                        if (tt)
                            tt.innerHTML = timeline
                                .map(
                                    (t: any) =>
                                        `<tr><td>${t.time}</td><td style="color:var(--green)">${t.allow}</td><td style="color:var(--red)">${t.deny}</td></tr>`
                                )
                                .join('');
                    } catch {
                        /* ignore */
                    }
                };
                refresh();
                setInterval(refresh, 10000);
            } else {
                panel.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#8E8E93;">Dashboard 加载失败 (${resp.status})</div>`;
            }
        } catch {
            panel.innerHTML =
                '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#8E8E93;">Dashboard 无法连接</div>';
        }
    }
}

customElements.define('agentgate-entry-widget', AgentGateEntryWidget);
