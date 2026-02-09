function getPathFromFile(file) {
  if (!file) return null;
  const path = window.fsAPI.getFilePath(file);
  return path ? String(path).replace(/\\/g, '/') : null;
}

/**
 * Skills 子应用：与其它应用统一，走 applicationAPI.call（Worker）
 */
function getSkillsAPI() {
  if (typeof window.applicationAPI === 'undefined') return null;
  return {
    list: () => window.applicationAPI.call('list'),
    refresh: () => window.applicationAPI.call('refresh'),
    getSkillsDirectory: () => window.applicationAPI.call('getSkillsDirectory'),
    addFromPath: (sourcePath) => window.applicationAPI.call('addFromPath', sourcePath),
    addFromZip: (zipPath, skillRelPath) => window.applicationAPI.call('addFromZip', zipPath, skillRelPath),
    addFromUrl: (url) => window.applicationAPI.call('addFromUrl', url),
    delete: (skillId) => window.applicationAPI.call('delete', skillId),
    searchRegistry: (registryId, query, page, limit) =>
      window.applicationAPI.call('searchRegistry', registryId, query, page, limit),
    installFromRegistry: (installUrl) => window.applicationAPI.call('installFromRegistry', installUrl)
  };
}

class SkillsEntryWidget extends HTMLElement {
  constructor() {
    super();
    this.skills = [];
    this.skillsDir = '';
    this.loading = false;
    this.error = null;
    this.showAddPanel = true;
    this.addUrl = '';
    this.addingFromPath = false;
    this.addingFromZip = false;
    this.addingFromUrl = false;
    this.message = null;
    this.deletingId = null;
    this.registrySelected = 'skill0';
    this.registryQuery = '';
    this.registryResults = [];
    this.registryPage = 1;
    this.registryTotal = 0;
    this.registrySearching = false;
    this.registryHasSearched = false;
    this.registryMessage = null;
    this.installingRegistryId = null;
    this.clawhubSlug = '';
    this.installingClawhubSlug = false;
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
    this.render();
  }

  async searchRegistry() {
    const api = getSkillsAPI();
    if (!api?.searchRegistry) {
      this.registryMessage = { text: '无法连接技能服务，请确认应用已加载', isError: true };
      this.render();
      return;
    }
    this.registrySearching = true;
    this.registryMessage = null;
    this.registryResults = [];
    this.render();
    const timeoutMs = 20000;
    const searchPromise = api.searchRegistry(this.registrySelected, this.registryQuery, 1, 20);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('搜索超时，请检查网络或稍后重试')), timeoutMs);
    });
    try {
      const res = await Promise.race([searchPromise, timeoutPromise]);
      this.registryResults = res?.skills ?? [];
      this.registryTotal = res?.total ?? this.registryResults.length;
      this.registryPage = 1;
      if (res?.error) {
        this.registryMessage = { text: res.error, isError: true };
      } else if (res?.message) {
        this.registryMessage = { text: res.message, isError: false };
      }
    } catch (e) {
      const msg = e?.message || '搜索失败';
      this.registryMessage = { text: msg, isError: true };
      this.registryResults = [];
    } finally {
      this.registrySearching = false;
      this.registryHasSearched = true;
      this.render();
    }
  }

  async installFromClawHubSlug() {
    const api = getSkillsAPI();
    const slug = (this.clawhubSlug || '').trim();
    if (!api?.installFromRegistry || !slug) return;
    this.installingClawhubSlug = true;
    this.render();
    try {
      const installUrl = slug.startsWith('clawhub:') ? slug : `clawhub:${slug}`;
      const addRes = await api.installFromRegistry(installUrl);
      this.setMessage(`已添加技能：${addRes?.name ?? ''}`);
      this.clawhubSlug = '';
      await this.loadSkills();
    } catch (e) {
      this.setMessage(e?.message || '安装失败', true);
    } finally {
      this.installingClawhubSlug = false;
      this.render();
    }
  }

  async installFromRegistry(installUrl, skillId) {
    const api = getSkillsAPI();
    if (!installUrl || !api?.installFromRegistry) return;
    this.installingRegistryId = skillId;
    this.render();
    try {
      const addRes = await api.installFromRegistry(installUrl);
      this.setMessage(`已添加技能：${addRes?.name ?? ''}`);
      await this.loadSkills();
    } catch (e) {
      this.setMessage(e?.message || '安装失败', true);
    } finally {
      this.installingRegistryId = null;
      this.render();
    }
  }

  async onPathPicked(file) {
    const filePath = getPathFromFile(file);
    if (!filePath) return;
    // 目录选择器返回的是目录内某个文件的路径，需改为目录路径（主进程要求传目录）
    const dirPath = filePath.replace(/[/\\][^/\\]*$/, '');
    if (!dirPath) return;
    const api = getSkillsAPI();
    if (!api?.addFromPath) return;
    this.addingFromPath = true;
    this.render();
    try {
      const addRes = await api.addFromPath(dirPath);
      this.setMessage(`已添加技能：${addRes?.name ?? ''}`);
      await this.loadSkills();
    } catch (e) {
      this.setMessage(e?.message || '添加失败', true);
    } finally {
      this.addingFromPath = false;
      this.render();
    }
  }

  async onZipPicked(file) {
    const path = getPathFromFile(file);
    if (!path) return;
    const api = getSkillsAPI();
    if (!api?.addFromZip) return;
    this.addingFromZip = true;
    this.render();
    try {
      const addRes = await api.addFromZip(path);
      this.setMessage(`已添加技能：${addRes?.name ?? ''}`);
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

    const addPanelHtml = `
      <div class="add-panel ${this.showAddPanel ? '' : 'add-panel-collapsed'}">
        <div class="add-panel-header">
          <span>添加技能</span>
          <button type="button" class="btn btn-ghost btn-icon" id="add-panel-toggle" title="${this.showAddPanel ? '收起' : '展开'}">${this.showAddPanel ? '◀' : '▶'}</button>
        </div>
        <div class="add-panel-body">
          <div class="add-section">
            <label>从本地添加</label>
            <p class="add-hint">选择包含 SKILL.md 的技能目录，或选择 .zip 技能压缩包</p>
            <div class="add-local-row">
              <label class="btn btn-file ${this.addingFromPath ? 'disabled' : ''}">
                <input type="file" id="add-from-path-input" webkitdirectory directory ${this.addingFromPath ? 'disabled' : ''} />
                <span>${this.addingFromPath ? '添加中…' : '选择目录'}</span>
              </label>
              <label class="btn btn-file ${this.addingFromZip ? 'disabled' : ''}">
                <input type="file" id="add-from-zip-input" accept=".zip" ${this.addingFromZip ? 'disabled' : ''} />
                <span>${this.addingFromZip ? '添加中…' : '选择 zip'}</span>
              </label>
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
          <div class="add-section registry-section">
            <label>从 Registry 搜索</label>
            <p class="add-hint">${this.registrySelected === 'clawhub' ? 'ClawHub：按 slug 安装，需已安装 clawhub CLI（npm i -g clawhub）' : '搜索 skill0、SkillsMP 等平台的技能'}</p>
            <div class="registry-row">
              <select class="registry-select" id="registry-select">
                <option value="skill0" ${this.registrySelected === 'skill0' ? 'selected' : ''}>skill0.io</option>
                <option value="skillsmp" ${this.registrySelected === 'skillsmp' ? 'selected' : ''}>SkillsMP</option>
                <option value="clawhub" ${this.registrySelected === 'clawhub' ? 'selected' : ''}>ClawHub</option>
              </select>
              ${this.registrySelected === 'clawhub'
                ? `<input type="text" class="registry-search-input" id="clawhub-slug-input" placeholder="输入技能 slug，如 my-skill 或 my-skill@1.2.3" value="${escapeHtml(this.clawhubSlug)}" ${this.installingClawhubSlug ? 'disabled' : ''} />
                  <button type="button" class="btn" id="clawhub-slug-install-btn" ${this.installingClawhubSlug || !this.clawhubSlug.trim() ? 'disabled' : ''}>${this.installingClawhubSlug ? '安装中…' : '安装'}</button>`
                : `<input type="text" class="registry-search-input" id="registry-search-input" placeholder="输入关键词搜索…" value="${escapeHtml(this.registryQuery)}" ${this.registrySearching ? 'disabled' : ''} />
                  <button type="button" class="btn" id="registry-search-btn" ${this.registrySearching ? 'disabled' : ''}>${this.registrySearching ? '搜索中…' : '搜索'}</button>`
              }
            </div>
            ${this.registrySelected === 'skillsmp' ? '<p class="registry-msg registry-hint">使用 SkillsMP 需在「设置」→ 应用配置 → Skills 中填写 SkillsMP API Key，保存后搜索即可生效。</p>' : ''}
            ${this.registryMessage ? `<p class="registry-msg ${this.registryMessage.isError ? 'error' : ''}">${escapeHtml(this.registryMessage.text)}</p>` : ''}
            ${this.registrySelected !== 'clawhub' && this.registryHasSearched && !this.registrySearching ? `
              <div class="registry-results">
                <p class="registry-count">共 ${this.registryTotal} 个结果${this.registryResults.length === 0 ? '，可换个关键词试试' : ''}</p>
                ${this.registryResults.length > 0 ? this.registryResults.map(s => `
                  <div class="registry-card">
                    <div class="registry-card-body">
                      <div class="registry-card-name">${escapeHtml(s.name || s.id || '')} ${s.author ? `<span class="registry-author">@${escapeHtml(s.author)}</span>` : ''}</div>
                      ${s.description ? `<div class="registry-card-desc">${escapeHtml(s.description)}</div>` : ''}
                      ${s.stars ? `<span class="registry-stars">★ ${s.stars}</span>` : ''}
                    </div>
                    <button type="button" class="btn btn-sm registry-install-btn" data-install-url="${escapeHtml(s.installUrl || '')}" data-skill-id="${escapeHtml(s.id || '')}" ${!s.canInstall || this.installingRegistryId === s.id ? 'disabled' : ''}>${this.installingRegistryId === s.id ? '安装中…' : s.canInstall ? '安装' : '不可安装'}</button>
                  </div>
                `).join('') : ''}
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    `;

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
        .body-wrap {
          flex: 1; min-height: 0; display: flex; overflow: hidden;
        }
        .add-panel {
          flex-shrink: 0; width: 320px; min-width: 280px; max-width: 380px;
          display: flex; flex-direction: column; border-right: 1px solid #e2e8f0; background: #f8fafc;
          transition: width 0.2s ease, min-width 0.2s ease;
        }
        .add-panel.add-panel-collapsed {
          width: 48px; min-width: 48px; max-width: 48px;
        }
        .add-panel.add-panel-collapsed .add-panel-header span,
        .add-panel.add-panel-collapsed .add-panel-body { display: none; }
        .add-panel.add-panel-collapsed .add-panel-header { justify-content: center; padding: 12px 8px; }
        .add-panel-header {
          flex-shrink: 0; display: flex; justify-content: space-between; align-items: center;
          padding: 16px 18px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0; background: #fff;
        }
        .btn-icon { padding: 6px 10px; min-width: 32px; }
        .add-panel-body {
          flex: 1; min-height: 0; overflow-y: auto; padding: 16px 18px;
        }
        .main-area {
          flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden;
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
        .btn-file { position: relative; display: inline-block; cursor: pointer; }
        .btn-file.disabled { opacity: 0.6; cursor: not-allowed; }
        .btn-file input[type=file] { position: absolute; left: 0; top: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; font-size: 0; }
        .btn-file.disabled input[type=file] { cursor: not-allowed; }
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
        .add-section { margin-bottom: 14px; }
        .add-section:last-child { margin-bottom: 0; }
        .add-section label { display: block; font-size: 13px; color: #475569; margin-bottom: 4px; }
        .add-hint { font-size: 12px; color: #94a3b8; margin-bottom: 8px; }
        .add-local-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        .add-url-row { display: flex; gap: 8px; align-items: center; }
        .add-url-input { flex: 1; min-width: 0; padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 13px; }
        .add-url-input:focus { outline: none; border-color: #6366f1; }
        .registry-section { border-top: 1px solid #e2e8f0; padding-top: 14px; margin-top: 14px; }
        .registry-row { display: flex; gap: 8px; align-items: center; flex-wrap: nowrap; margin-bottom: 10px; min-width: 0; }
        .registry-select { padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 13px; min-width: 90px; flex-shrink: 0; }
        .registry-search-input { flex: 1; min-width: 0; max-width: 100%; padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 13px; box-sizing: border-box; }
        .registry-search-input:focus { outline: none; border-color: #6366f1; }
        .registry-row .btn { flex-shrink: 0; }
        .registry-msg { font-size: 12px; color: #64748b; margin: 8px 0; }
        .registry-msg.error { color: #dc2626; }
        .registry-results { width: 100%; min-width: 0; max-height: 280px; overflow-y: auto; margin-top: 12px; box-sizing: border-box; }
        .registry-count { font-size: 12px; color: #64748b; margin-bottom: 10px; }
        .registry-card {
          display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;
          padding: 12px 14px; margin-bottom: 8px; border-radius: 10px;
          border: 1px solid #e2e8f0; background: #fff;
        }
        .registry-card-body { flex: 1; min-width: 0; }
        .registry-card-name { font-weight: 600; color: #334155; font-size: 13px; margin-bottom: 4px; }
        .registry-author { font-weight: 400; color: #94a3b8; font-size: 12px; }
        .registry-card-desc { font-size: 12px; color: #64748b; line-height: 1.45; max-height: 2.9em; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
        .registry-stars { font-size: 11px; color: #f59e0b; margin-top: 4px; display: inline-block; }
        .registry-install-btn { flex-shrink: 0; }
      </style>
      <div class="head">
        <div class="header">
          <h2>Skills</h2>
          <button type="button" class="btn" id="refresh-btn" ${this.loading ? 'disabled' : ''}>${this.loading ? '刷新中…' : '刷新'}</button>
        </div>
      </div>
      <div class="body-wrap">
        ${addPanelHtml}
        <div class="main-area">
          <div class="scroll-area">
            <div class="scroll-wrap">
              ${msgHtml}
              <div class="skill-list">
                ${listHtml}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    this.shadowRoot.getElementById('refresh-btn')?.addEventListener('click', () => this.refresh());
    this.shadowRoot.getElementById('add-panel-toggle')?.addEventListener('click', () => this.toggleAddPanel());
    const pathInput = this.shadowRoot.getElementById('add-from-path-input');
    if (pathInput) {
      pathInput.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (file) this.onPathPicked(file);
        e.target.value = '';
      });
    }
    const zipInput = this.shadowRoot.getElementById('add-from-zip-input');
    if (zipInput) {
      zipInput.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (file) this.onZipPicked(file);
        e.target.value = '';
      });
    }
    this.shadowRoot.getElementById('add-from-url-btn')?.addEventListener('click', () => this.addFromUrl());
    const urlInput = this.shadowRoot.getElementById('add-url-input');
    if (urlInput) {
      urlInput.value = this.addUrl;
      urlInput.addEventListener('input', (e) => { this.addUrl = e.target.value; });
    }
    const regSelect = this.shadowRoot.getElementById('registry-select');
    if (regSelect) regSelect.addEventListener('change', (e) => {
      this.registrySelected = e.target.value;
      // 切换 registry（如 skill0.io / SkillsMP）时清空下方搜索结果
      this.registryResults = [];
      this.registryTotal = 0;
      this.registryHasSearched = false;
      this.registryMessage = null;
      this.registryPage = 1;
      this.render();
    });
    const regSearchInput = this.shadowRoot.getElementById('registry-search-input');
    if (regSearchInput) {
      regSearchInput.value = this.registryQuery;
      regSearchInput.addEventListener('input', (e) => { this.registryQuery = e.target.value; });
      regSearchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.searchRegistry(); });
    }
    this.shadowRoot.getElementById('registry-search-btn')?.addEventListener('click', () => this.searchRegistry());
    const clawhubSlugInput = this.shadowRoot.getElementById('clawhub-slug-input');
    if (clawhubSlugInput) {
      clawhubSlugInput.value = this.clawhubSlug;
      clawhubSlugInput.addEventListener('input', (e) => {
        this.clawhubSlug = e.target.value;
        const btn = this.shadowRoot.getElementById('clawhub-slug-install-btn');
        if (btn) btn.disabled = !this.clawhubSlug.trim() || this.installingClawhubSlug;
      });
      clawhubSlugInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.installFromClawHubSlug(); });
    }
    this.shadowRoot.getElementById('clawhub-slug-install-btn')?.addEventListener('click', () => this.installFromClawHubSlug());
    this.shadowRoot.querySelectorAll('.registry-install-btn').forEach(el => {
      const installUrl = el.getAttribute('data-install-url');
      const skillId = el.getAttribute('data-skill-id');
      if (installUrl && el.getAttribute('disabled') !== 'disabled') {
        el.addEventListener('click', () => this.installFromRegistry(installUrl, skillId));
      }
    });
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
