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
  <p style="font-size:14px;margin:0 0 24px;line-height:1.6;text-align:left;max-width:360px;">
    请先安装并启动 AgentGate 和 AgentMoss 服务：<br/><br/>
    <code style="display:block;background:#F2F2F7;padding:10px 14px;border-radius:8px;
      font-size:12px;color:#1d1d1f;text-align:left;line-height:1.8;">
      pip install agent-gate-sec agent-moss<br/>
      agent-moss server &amp;<br/>
      agent-gate server &mdash;port 9100
    </code>
    <br/>
    <span style="font-size:12px;color:#8E8E93;">
      启动后点击下方按钮重新连接，或设置环境变量<br/>
      <code style="background:#F2F2F7;padding:1px 6px;border-radius:4px;">AGENT_GATE_URL</code>
      指定自定义地址。
    </span>
  </p>
  <button id="agentgate-retry-btn"
    style="padding:8px 20px;border-radius:10px;border:none;background:#007AFF;color:#fff;
    font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,122,255,0.3);">
    重新检测
  </button>
</div>`;

const TABS_HTML = `
<div style="display:flex;flex-direction:column;height:100%;">
  <div style="display:flex;border-bottom:1px solid #F0F0F0;background:#fff;flex-shrink:0;">
    <button class="ag-tab active" data-tab="dashboard" style="padding:10px 20px;border:none;background:none;font-size:13px;font-weight:600;color:#007AFF;cursor:pointer;border-bottom:2px solid #007AFF;">📊 Dashboard</button>
    <button class="ag-tab" data-tab="config" style="padding:10px 20px;border:none;background:none;font-size:13px;color:#8E8E93;cursor:pointer;border-bottom:2px solid transparent;">⚙️ 配置</button>
  </div>
  <div id="ag-panel-dashboard" style="flex:1;overflow:hidden;"></div>
  <div id="ag-panel-config" style="flex:1;overflow:auto;display:none;padding:20px;"></div>
</div>`;

const CONFIG_HTML = `
<h3 style="margin-bottom:16px;font-size:15px;">🔬 LLM 深度分析</h3>
<label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:14px;">
  <input type="checkbox" id="ag-enable-llm" checked style="width:16px;height:16px;">
  启用 LLM 语义分析（Layer 3）
</label>
<label style="display:block;margin-bottom:20px;font-size:13px;color:#8E8E93;">
  分析模型
  <select id="ag-llm-model" style="display:block;margin-top:4px;width:100%;padding:6px 10px;border:1px solid #F0F0F0;border-radius:6px;font-size:13px;">
    <option value="">默认模型</option>
  </select>
</label>

<h3 style="margin-bottom:16px;font-size:15px;">📋 自定义安全规则</h3>
<div id="ag-rules-list" style="margin-bottom:12px;"></div>
<button id="ag-add-rule" style="padding:6px 14px;border-radius:6px;border:1px dashed #007AFF;background:none;color:#007AFF;font-size:13px;cursor:pointer;">+ 添加规则</button>

<h3 style="margin:24px 0 16px;font-size:15px;">📡 服务状态</h3>
<div style="font-size:13px;color:#8E8E93;">
  <div>AgentMoss: <span id="ag-moss-status" style="color:#34C759;">● 运行中</span> (127.0.0.1:9090)</div>
  <div>AgentGate: <span id="ag-gate-status" style="color:#34C759;">● 运行中</span> (127.0.0.1:9100)</div>
</div>
`;

class AgentGateEntryWidget extends HTMLElement {
    connectedCallback() {
        this.style.cssText = 'display:block;width:100%;height:100%;overflow:hidden;';
        this._connect();
    }

    async _connect() {
        this.innerHTML = OFFLINE_HTML;
        const retryBtn = this.querySelector('#agentgate-retry-btn');
        if (retryBtn) {
            retryBtn.addEventListener('click', () => this._connect());
        }

        try {
            const resp = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) });
            if (resp.ok) {
                this._showApp();
            }
        } catch {
            // keep offline message
        }
    }

    _showApp() {
        this.innerHTML = TABS_HTML;

        // Dashboard panel
        const dashPanel = this.querySelector('#ag-panel-dashboard');
        if (dashPanel) {
            const iframe = document.createElement('iframe');
            iframe.src = DASHBOARD_URL;
            iframe.style.cssText = 'width:100%;height:100%;border:none;';
            dashPanel.appendChild(iframe);
        }

        // Config panel
        const configPanel = this.querySelector('#ag-panel-config');
        if (configPanel) {
            configPanel.innerHTML = CONFIG_HTML;
        }

        // Tab switching
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
                }
            });
        });

        // Render sample rules
        const rulesList = this.querySelector('#ag-rules-list');
        if (rulesList) {
            const sampleRules = [
                { pattern: 'rm -rf /*', action: 'Deny', severity: 'critical' },
                { pattern: 'curl | bash', action: 'Deny', severity: 'high' }
            ];
            rulesList.innerHTML = sampleRules
                .map(
                    (r, i) => `
              <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #F0F0F0;font-size:13px;">
                <code style="flex:1;background:#F5F5F7;padding:2px 6px;border-radius:4px;">${r.pattern}</code>
                <span style="background:${r.action === 'Deny' ? 'rgba(255,59,48,.12)' : 'rgba(52,199,89,.12)'};color:${r.action === 'Deny' ? '#FF3B30' : '#34C759'};padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600;">${r.action}</span>
                <span style="color:#FF9500;font-size:11px;">${r.severity}</span>
                <button style="border:none;background:none;color:#8E8E93;cursor:pointer;">✕</button>
              </div>
            `
                )
                .join('');
        }
    }
}

customElements.define('agentgate-entry-widget', AgentGateEntryWidget);
