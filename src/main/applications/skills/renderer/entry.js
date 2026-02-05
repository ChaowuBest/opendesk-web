/**
 * Skills 子应用：与其它应用统一，走 applicationAPI.call（Worker）；仅需弹窗的 pickDirectory/pickZip 走 callMainWorld（主进程 dialog）
 */
function getSkillsAPI() {
  if (typeof window.applicationAPI === 'undefined') return null;
  return {
    list: () => window.applicationAPI.call('list'),
    refresh: () => window.applicationAPI.call('refresh'),
    getSkillsDirectory: () => window.applicationAPI.call('getSkillsDirectory'),
    pickDirectory: () => window.applicationAPI.callMainWorld('pickDirectory'),
    pickZip: () => window.applicationAPI.callMainWorld('pickZip'),
    addFromPath: (sourcePath) => window.applicationAPI.call('addFromPath', sourcePath),
    addFromZip: (zipPath) => window.applicationAPI.call('addFromZip', zipPath),
    addFromUrl: (url) => window.applicationAPI.call('addFromUrl', url),
    delete: (skillId) => window.applicationAPI.call('delete', skillId)
  };
}

class SkillsEntryWidget extends HTMLElement {
  constructor() {
    super();
    this.skills = [];
    this.skillsDir = '';
    this.loading = false;
    this.error = null;
    this.showAddPanel = false;
    this.addUrl = '';
    this.addingFromPath = false;
    this.addingFromZip = false;
    this.addingFromUrl = false;
    this.message = null;
    this.deletingId = null;
    this.attachShadow({ mode: 'open' });
  }

  async connectedCallback() {
    this.render();
    await this.loadSkills();
  }

  async loadSkills() {
    const api = getSkillsAPI();
    if (!api) {
      this.error = '无法连接技能服务（请在主窗口打开应用）';
      this.render();
      return;
    }
    this.loading = true;
    this.error = null;
    this.render();
    try {
      this.skills = await api.list();
      if (!Array.isArray(this.skills)) this.skills = [];
      const dir = await api.getSkillsDirectory();
      if (dir) this.skillsDir = dir;
    } catch (e) {
      this.error = e?.message || '加载失败';
      this.skills = [];
    } finally {
      this.loading = false;
      this.render();
    }
  }

  setMessage(text, isError = false) {
    this.message = { text, isError };
    this.render();
    setTimeout(() => {
      this.message = null;
      this.render();
    }, 4000);
  }

  async refresh() {
    const api = getSkillsAPI();
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

  toggleAddPanel() {
    this.showAddPanel = !this.showAddPanel;
    this.addUrl = '';
    this.message = null;
    this.render();
  }

  async addFromLocal() {
    const api = getSkillsAPI();
    if (!api?.pickDirectory || !api?.addFromPath) return;
    this.addingFromPath = true;
    this.render();
    try {
      const path = await api.pickDirectory();
      if (!path) {
        this.addingFromPath = false;
        this.render();
        return;
      }
      const addRes = await api.addFromPath(path);
      this.setMessage(`已添加技能：${addRes?.name ?? ''}`);
      this.showAddPanel = false;
      await this.loadSkills();
    } catch (e) {
      this.setMessage(e?.message || '添加失败', true);
    } finally {
      this.addingFromPath = false;
      this.render();
    }
  }

  async addFromZip() {
    const api = getSkillsAPI();
    if (!api?.pickZip || !api?.addFromZip) return;
    this.addingFromZip = true;
    this.render();
    try {
      const zipPath = await api.pickZip();
      if (!zipPath) {
        this.addingFromZip = false;
        this.render();
        return;
      }
      const addRes = await api.addFromZip(zipPath);
      this.setMessage(`已添加技能：${addRes?.name ?? ''}`);
      this.showAddPanel = false;
      await this.loadSkills();
    } catch (e) {
      this.setMessage(e?.message || '添加失败', true);
    } finally {
      this.addingFromZip = false;
      this.render();
    }
  }

  async addFromUrl() {
    const api = getSkillsAPI();
    if (!api?.addFromUrl || !this.addUrl.trim()) {
      this.setMessage('请输入技能包 URL（zip 格式）', true);
      return;
    }
    this.addingFromUrl = true;
    this.render();
    try {
      const addRes = await api.addFromUrl(this.addUrl.trim());
      this.setMessage(`已添加技能：${addRes?.name ?? ''}`);
      this.showAddPanel = false;
      this.addUrl = '';
      await this.loadSkills();
    } catch (e) {
      this.setMessage(e?.message || '添加失败', true);
    } finally {
      this.addingFromUrl = false;
      this.render();
    }
  }

  async deleteSkill(skillId) {
    const api = getSkillsAPI();
    if (!api?.delete) return;
    if (!confirm(`确定要删除技能「${skillId}」吗？`)) return;
    this.deletingId = skillId;
    this.render();
    try {
      await api.delete(skillId);
      this.setMessage('已删除');
      await this.loadSkills();
    } catch (e) {
      this.setMessage(e?.message || '删除失败', true);
    } finally {
      this.deletingId = null;
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
              <p class="empty-title">暂无技能</p>
              <p class="empty-hint">点击「添加」从本地目录、zip 压缩包或 URL 添加技能，或将技能目录复制到下方路径后点击「刷新」：</p>
              <code class="skills-dir">${escapeHtml(this.skillsDir || '（获取中…）')}</code>
              <p class="empty-doc">技能格式见 <a href="https://agentskills.io/specification" target="_blank" rel="noopener">Anthropic Agent Skills</a>。</p>
            </div>
          `
          : this.skills.map(s => `
            <div class="skill-card" data-skill-id="${escapeHtml(s.id)}">
              <div class="skill-body">
                <div class="skill-name">${escapeHtml(s.name || s.id || '')}</div>
                ${s.description ? `<div class="skill-desc">${escapeHtml(s.description)}</div>` : ''}
              </div>
              <button type="button" class="btn btn-danger btn-sm" data-delete="${escapeHtml(s.id)}" ${this.deletingId === s.id ? 'disabled' : ''}>${this.deletingId === s.id ? '删除中…' : '删除'}</button>
            </div>
          `).join('');

    const msgHtml = this.message
      ? `<div class="message ${this.message.isError ? 'error' : 'success'}">${escapeHtml(this.message.text)}</div>`
      : '';

    const addPanelHtml = this.showAddPanel ? `
      <div class="add-panel">
        <div class="add-panel-header">
          <span>添加技能</span>
          <button type="button" class="btn btn-ghost" id="add-panel-close">关闭</button>
        </div>
        <div class="add-section">
          <label>从本地添加</label>
          <p class="add-hint">选择包含 SKILL.md 的技能目录，或选择 .zip 技能压缩包</p>
          <div class="add-local-row">
            <button type="button" class="btn" id="add-from-path-btn" ${this.addingFromPath ? 'disabled' : ''}>${this.addingFromPath ? '选择中…' : '选择目录'}</button>
            <button type="button" class="btn" id="add-from-zip-btn" ${this.addingFromZip ? 'disabled' : ''}>${this.addingFromZip ? '添加中…' : '选择 zip'}</button>
          </div>
        </div>
        <div class="add-section">
          <label>从 URL 添加</label>
          <p class="add-hint">输入技能包 zip 的 URL</p>
          <div class="add-url-row">
            <input type="url" class="add-url-input" id="add-url-input" placeholder="https://..." value="${escapeHtml(this.addUrl)}" ${this.addingFromUrl ? 'disabled' : ''} />
            <button type="button" class="btn" id="add-from-url-btn" ${this.addingFromUrl ? 'disabled' : ''}>${this.addingFromUrl ? '下载中…' : '下载并添加'}</button>
          </div>
        </div>
      </div>
    ` : '';

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: flex; flex-direction: column; height: 100%; font-size: 14px; box-sizing: border-box;
          overflow: hidden;
        }
        .head {
          flex-shrink: 0; padding: 24px 28px 20px 28px; border-bottom: 1px solid #e2e8f0; background: #fff;
        }
        .head .header {
          display: flex; align-items: center; justify-content: flex-start;
          flex-wrap: wrap; gap: 12px;
        }
        .scroll-area {
          flex: 1; min-height: 0; overflow: auto; padding: 20px 28px 32px 28px;
        }
        .scroll-wrap { max-width: 720px; margin: 0 auto; }
        h2 { margin: 0; font-size: 18px; font-weight: 600; color: #1f2937; }
        .btn {
          padding: 8px 14px; border-radius: 8px; border: 1px solid #e5e7eb;
          background: #fff; color: #374151; cursor: pointer; font-size: 13px;
          box-shadow: 0 1px 2px rgba(0,0,0,0.04);
        }
        .btn:hover { background: #f8fafc; border-color: #cbd5e1; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
        .btn:disabled { opacity: 0.6; cursor: not-allowed; box-shadow: none; }
        .btn-ghost { border-color: transparent; background: transparent; box-shadow: none; }
        .btn-ghost:hover { background: #f1f5f9; }
        .btn-sm { padding: 6px 10px; font-size: 12px; }
        .btn-danger { color: #dc2626; border-color: #fecaca; }
        .btn-danger:hover { background: #fef2f2; border-color: #f87171; }
        .skill-list { display: flex; flex-direction: column; gap: 12px; }
        .skill-card {
          display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
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
        .skill-body { flex: 1; min-width: 0; }
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
        .message { padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; }
        .message.success { background: #ecfdf5; color: #059669; border: 1px solid #a7f3d0; }
        .message.error { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
        .add-panel {
          border: 1px solid #e2e8f0; border-radius: 12px; background: #f8fafc; padding: 16px 18px; margin-bottom: 20px;
        }
        .add-panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; font-weight: 600; color: #334155; }
        .add-section { margin-bottom: 14px; }
        .add-section:last-child { margin-bottom: 0; }
        .add-section label { display: block; font-size: 13px; color: #475569; margin-bottom: 4px; }
        .add-hint { font-size: 12px; color: #94a3b8; margin-bottom: 8px; }
        .add-local-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        .add-url-row { display: flex; gap: 8px; align-items: center; }
        .add-url-input { flex: 1; padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 13px; }
        .add-url-input:focus { outline: none; border-color: #6366f1; }
      </style>
      <div class="head">
        <div class="header">
          <h2>Skills</h2>
          <button type="button" class="btn" id="refresh-btn" ${this.loading ? 'disabled' : ''}>${this.loading ? '刷新中…' : '刷新'}</button>
          <button type="button" class="btn" id="add-btn" ${this.loading ? 'disabled' : ''}>添加</button>
        </div>
      </div>
      <div class="scroll-area">
        <div class="scroll-wrap">
          ${msgHtml}
          ${addPanelHtml}
          <div class="skill-list">
            ${listHtml}
          </div>
        </div>
      </div>
    `;

    this.shadowRoot.getElementById('refresh-btn')?.addEventListener('click', () => this.refresh());
    this.shadowRoot.getElementById('add-btn')?.addEventListener('click', () => this.toggleAddPanel());
    this.shadowRoot.getElementById('add-panel-close')?.addEventListener('click', () => this.toggleAddPanel());
    this.shadowRoot.getElementById('add-from-path-btn')?.addEventListener('click', () => this.addFromLocal());
    this.shadowRoot.getElementById('add-from-zip-btn')?.addEventListener('click', () => this.addFromZip());
    this.shadowRoot.getElementById('add-from-url-btn')?.addEventListener('click', () => this.addFromUrl());
    const urlInput = this.shadowRoot.getElementById('add-url-input');
    if (urlInput) {
      urlInput.value = this.addUrl;
      urlInput.addEventListener('input', (e) => { this.addUrl = e.target.value; });
    }
    this.shadowRoot.querySelectorAll('[data-delete]').forEach(el => {
      el.addEventListener('click', () => this.deleteSkill(el.getAttribute('data-delete')));
    });
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

customElements.define('skills-entry-widget', SkillsEntryWidget);
