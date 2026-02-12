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
 * PPT 应用入口：定义 ppt-entry-widget，点击主页/侧栏的 PPT 按钮后展示写死路径的幻灯片。
 */
import './pptcontainer';

const PPT_DEMO_ID = '0123';

class PPTEntryWidget extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <div class="w-full h-full overflow-auto p-2 flex items-start justify-center">
        <ppt-container class="block w-full max-w-4xl" data-id="${PPT_DEMO_ID}"></ppt-container>
      </div>
    `;
  }
}

if (!customElements.get('ppt-entry-widget')) {
  customElements.define('ppt-entry-widget', PPTEntryWidget);
}
