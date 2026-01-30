/**
 * 本地技能子应用渲染入口：技能列表与刷新
 */
class SkillsEntryWidget extends HTMLElement {
  constructor() {
    super();
    this.skills = [];
    this.attachShadow({ mode: 'open' });
  }

  async connectedCallback() {
    this.render();
    await this.loadSkills();
  }

  async loadSkills() {
    if (typeof window.skillRegistryAPI === 'undefined') return;
    try {
      const res = await window.skillRegistryAPI.list();
      if (res?.status === 'ok' && Array.isArray(res.data)) {
        this.skills = res.data;
        this.render();
      }
    } catch (e) {
      console.warn('skills load error', e);
    }
  }

  async refresh() {
    if (typeof window.skillRegistryAPI === 'undefined') return;
    try {
      await window.skillRegistryAPI.refresh();
      await this.loadSkills();
    } catch (e) {
      console.warn('skills refresh error', e);
    }
  }

  render() {
    const list = this.skills.length
      ? this.skills.map(s => `<li>${escapeHtml(s.name || s.id || '')}</li>`).join('')
      : '<li class="empty">暂无本地技能</li>';
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; padding: 8px; font-size: 14px; }
        h3 { margin: 0 0 8px 0; font-size: 14px; }
        ul { margin: 0; padding-left: 20px; }
        .empty { color: #888; }
        button { margin-top: 8px; }
      </style>
      <h3>本地技能</h3>
      <ul>${list}</ul>
      <button type="button">刷新</button>
    `;
    const btn = this.shadowRoot.querySelector('button');
    if (btn) btn.addEventListener('click', () => this.refresh());
  }
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

customElements.define('skills-entry-widget', SkillsEntryWidget);
