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

class LogView extends HTMLElement {
    constructor() {
        super();
        this._interval = null;
    }

    connectedCallback() {
        this.render();
        this._interval = setInterval(() => {
            this.reload();
        }, 1000);
    }

    disconnectedCallback() {
        clearInterval(this._interval);
    }

    reload() {
        window.settingAPI.getLogContent().then(content => {
            this.querySelector('#log-content').innerHTML = content;
        })
    }

    render() {
        this.innerHTML = `
        <div class="w-full h-full p-4 bg-blue-950">
            <pre id="log-content" class="w-full text-xs overflow-y-auto" style="display: block; height: 100%;">
            </pre>
        </div>
        `
    }
}

customElements.define('log-view', LogView);