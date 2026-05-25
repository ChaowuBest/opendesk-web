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
  <div style="display:flex;border-bottom:1px solid #F0F0F0;background:#fff;flex-shrink:0;height:42px;">
    <div class="ag-tab active" data-tab="dashboard" style="display:flex;align-items:center;padding:0 20px;font-size:13px;font-weight:600;color:#007AFF;cursor:pointer;border-bottom:2px solid #007AFF;user-select:none;">Dashboard</div>
    <div class="ag-tab" data-tab="config" style="display:flex;align-items:center;padding:0 20px;font-size:13px;color:#8E8E93;cursor:pointer;border-bottom:2px solid transparent;user-select:none;">配置</div>
  </div>
  <div id="ag-panel-dashboard" style="flex:1;overflow:hidden;"></div>
  <div id="ag-panel-config" style="flex:1;overflow:auto;display:none;padding:20px;"></div>
</div>`;

const CONFIG_HTML = `
<h3 style="margin-bottom:16px;font-size:15px;">LLM 深度分析</h3>
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

<h3 style="margin-bottom:16px;font-size:15px;">自定义安全规则</h3>
<div id="ag-rules-list" style="margin-bottom:12px;"></div>
<button id="ag-add-rule" style="padding:6px 14px;border-radius:6px;border:1px dashed #007AFF;background:none;color:#007AFF;font-size:13px;cursor:pointer;">+ 添加规则</button>

<h3 style="margin:24px 0 16px;font-size:15px;">服务状态</h3>
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

        // Dashboard panel — fetch and inject HTML directly (avoids iframe openLink interception)
        const dashPanel = this.querySelector('#ag-panel-dashboard');
        if (dashPanel) {
            this._loadDashboard(dashPanel as HTMLElement);
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
                    (r) => `
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

                // Tab switching inside dashboard
                panel.querySelectorAll('.tab').forEach((tab) => {
                    tab.addEventListener('click', () => {
                        panel.querySelectorAll('.tab').forEach((t) => {
                            (t as HTMLElement).className = 'tab';
                        });
                        (tab as HTMLElement).className = 'tab active';
                        const target = (tab as HTMLElement).dataset.panel;
                        ['calls', 'agents', 'timeline'].forEach((id) => {
                            const el = panel.querySelector('#' + id + '-panel') as HTMLElement;
                            if (el) el.style.display = id === target ? '' : 'none';
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
                            riskLegend.innerHTML = `<span><span class="risk-dot" style="background:var(--red)"></span>C ${levels.critical}</span><span><span class="risk-dot" style="background:var(--orange)"></span>H ${levels.high}</span><span><span class="risk-dot" style="background:var(--yellow)"></span>M ${levels.medium}</span><span><span class="risk-dot" style="background:var(--muted)"></span>L ${levels.low}</span>`;

                        // Recent calls
                        const tbody = panel.querySelector('#recent-table');
                        if (tbody) {
                            tbody.innerHTML = arr
                                .slice(0, 20)
                                .map(
                                    (x: any) => `<tr>
                                <td style="white-space:nowrap">${(x.called_at || '').substring(11, 19)}</td>
                                <td>${x.agent_type || '-'}</td>
                                <td style="max-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${x.session_id || '-'}</td>
                                <td><code style="max-width:120px">${x.command || x.action_detail || '-'}</code></td>
                                <td><span class="badge ${x.decision === 'Allow' ? 'badge-allow' : 'badge-deny'}">${x.decision}</span></td>
                                <td style="color:${x.risk_level === 'critical' ? 'var(--red)' : x.risk_level === 'high' ? 'var(--orange)' : x.risk_level === 'medium' ? 'var(--yellow)' : 'var(--muted)'}">${x.risk_level || '-'}</td>
                                <td>${Math.round(x.analysis_duration_ms || 0)}ms</td>
                                <td style="max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${x.reason || '-'}</td>
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
