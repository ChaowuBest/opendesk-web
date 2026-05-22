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

const BASE_URL = process.env.AGENT_GATE_URL || 'http://127.0.0.1:9100';
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

class AgentGateEntryWidget extends HTMLElement {
    connectedCallback() {
        this.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;overflow:hidden;';
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
                this._showDashboard();
            }
        } catch {
            // service unreachable, keep showing offline message
        }
    }

    _showDashboard() {
        this.innerHTML = '';
        const iframe = document.createElement('iframe');
        iframe.src = DASHBOARD_URL;
        iframe.style.cssText = 'width:100%;height:100%;border:none;';
        this.appendChild(iframe);
    }
}

customElements.define('agentgate-entry-widget', AgentGateEntryWidget);
