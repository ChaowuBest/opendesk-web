/**
 * Skills 子应用渲染入口：技能列表、刷新、技能目录入口
 * 注：应用在 iframe 中加载，需从父窗口取 skillRegistryAPI
 */
function getSkillRegistryAPI() {
  if (typeof window.skillRegistryAPI !== 'undefined') return window.skillRegistryAPI;
  if (typeof window.parent !== 'undefined' && window.parent !== window && typeof window.parent.skillRegistryAPI !== 'undefined') {
    return window.parent.skillRegistryAPI;
  }
  if (typeof window.top !== 'undefined' && window.top.skillRegistryAPI) return window.top.skillRegistryAPI;
  return null;
}

class SkillsEntryWidget extends HTMLElement {
  constructor() {
    super();
    this.skills = [];
    this.skillsDir = '';
    this.loading = false;
    this.error = null;
    this.attachShadow({ mode: 'open' });
  }

  async connectedCallback() {
    this.render();
    await this.loadSkills();
  }

  async loadSkills() {
    const api = getSkillRegistryAPI();
    if (!api) {
      this.error = '无法连接技能服务（请在主窗口打开应用）';
      this.render();
      return;
    }
    this.loading = true;
    this.error = null;
    this.render();
    try {
      const res = await api.list();
      if (res?.status === 'ok' && Array.isArray(res.data)) {
        this.skills = res.data;
      } else {
        this.skills = [];
      }
      const dirRes = await api.getSkillsDirectory();
      if (dirRes?.status === 'ok' && dirRes.data) this.skillsDir = dirRes.data;
    } catch (e) {
      this.error = e?.message || '加载失败';
      this.skills = [];
    } finally {
      this.loading = false;
      this.render();
    }
  }

  async refresh() {
    const api = getSkillRegistryAPI();
    if (!api) return;
    this.loading = true;
    this.error = null;
    this.render();
    try {
      await api.refresh();
      await this.loadSkills();
    } catch (e) {
      this.error = e?.message || '刷新失败';
      this.render();
    } finally {
      this.loading = false;
      this.render();
    }
  }

  render() {
    const listHtml = this.loading
      ? '<div class="empty loading">加载中…</div>'
      : this.error
        ? `<div class="empty error">${escapeHtml(this.error)}</div>`
        : this.skills.length === 0
          ? `
            <div class="empty-state">
              <p class="empty-title">暂无Skills</p>
              <p class="empty-hint">将技能目录复制到下方路径后点击「刷新」即可显示：</p>
              <code class="skills-dir">${escapeHtml(this.skillsDir || '（获取中…）')}</code>
              <p class="empty-doc">技能格式见 <a href="https://agentskills.io/specification" target="_blank" rel="noopener">Anthropic Agent Skills</a>，示例在应用内置资源中。</p>
            </div>
          `
          : this.skills.map(s => `
            <div class="skill-card">
              <div class="skill-name">${escapeHtml(s.name || s.id || '')}</div>
              ${s.description ? `<div class="skill-desc">${escapeHtml(s.description)}</div>` : ''}
            </div>
          `).join('');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block; height: 100%; overflow: auto; font-size: 14px; box-sizing: border-box;
          padding: 24px 28px 32px 28px;
        }
        .wrap { max-width: 720px; margin: 0 auto; }
        .header {
          display: flex; align-items: center; justify-content: flex-start;
          margin-top: 16px; margin-bottom: 20px; flex-wrap: wrap; gap: 12px;
        }
        h2 { margin: 0; font-size: 18px; font-weight: 600; color: #1f2937; }
        .btn {
          padding: 8px 14px; border-radius: 8px; border: 1px solid #e5e7eb;
          background: #fff; color: #374151; cursor: pointer; font-size: 13px;
          box-shadow: 0 1px 2px rgba(0,0,0,0.04);
        }
        .btn:hover { background: #f8fafc; border-color: #cbd5e1; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
        .btn:disabled { opacity: 0.6; cursor: not-allowed; box-shadow: none; }
        .skill-list { display: flex; flex-direction: column; gap: 12px; }
        .skill-card {
          padding: 16px 18px; border-radius: 12px;
          border: 1px solid #e2e8f0; background: #fff;
          box-shadow: 0 1px 3px rgba(0,0,0,0.05);
          transition: box-shadow 0.2s, border-color 0.2s;
          border-left: 4px solid #6366f1;
        }
        .skill-card:hover {
          box-shadow: 0 4px 12px rgba(99, 102, 241, 0.08);
          border-left-color: #4f46e5;
        }
        .skill-name { font-weight: 600; color: #0f172a; margin-bottom: 6px; font-size: 15px; letter-spacing: -0.01em; }
        .skill-desc { font-size: 13px; color: #64748b; line-height: 1.5; }
        .empty, .empty-state { color: #64748b; padding: 24px 0; text-align: center; }
        .empty.loading { font-style: italic; }
        .empty.error { color: #dc2626; }
        .empty-state { text-align: left; max-width: 480px; margin: 0 auto; padding: 20px 0; }
        .empty-title { font-weight: 600; color: #334155; margin-bottom: 8px; }
        .empty-hint { margin-bottom: 8px; font-size: 13px; }
        .skills-dir {
          display: block; padding: 12px 14px; background: #f1f5f9; border-radius: 10px;
          font-size: 12px; word-break: break-all; margin-bottom: 14px; border: 1px solid #e2e8f0;
        }
        .empty-doc { font-size: 12px; color: #94a3b8; }
        .empty-doc a { color: #6366f1; text-decoration: none; }
        .empty-doc a:hover { text-decoration: underline; }
      </style>
      <div class="wrap">
        <div class="header">
          <h2>Skills</h2>
          <button type="button" class="btn" id="refresh-btn" ${this.loading ? 'disabled' : ''}>${this.loading ? '刷新中…' : '刷新'}</button>
        </div>
        <div class="skill-list">
          ${listHtml}
        </div>
      </div>
    `;
    const btn = this.shadowRoot.getElementById('refresh-btn');
    if (btn) btn.addEventListener('click', () => this.refresh());
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

customElements.define('skills-entry-widget', SkillsEntryWidget);
