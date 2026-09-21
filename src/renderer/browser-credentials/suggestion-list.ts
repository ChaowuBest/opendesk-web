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

export interface CredentialSuggestions {
    host: HTMLElement;
    handleKey(event: KeyboardEvent): boolean;
    destroy(): void;
}

/** Page-local UI only: the caller owns credential requests and form filling. */
export function showCredentialSuggestions(
    target: HTMLInputElement,
    list: { usernames: string[]; label: string },
    onSelect: (username: string) => void
): CredentialSuggestions {
    const host = document.createElement('div');
    host.setAttribute('data-opendesk-credentials', '');
    const rect = target.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 240), window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const below = window.innerHeight - rect.bottom - 8;
    const above = Math.max(0, rect.top - 8);
    const height = Math.min(240, Math.max(below, above));
    const top =
        below >= Math.min(240, 40 + list.usernames.length * 38) || below >= above
            ? rect.bottom + 4
            : Math.max(8, rect.top - Math.min(height, 40 + list.usernames.length * 38) - 4);
    host.style.cssText = `all:initial;position:fixed;z-index:2147483647;left:${left}px;top:${top}px;width:${width}px;`;
    const root = host.attachShadow({ mode: 'closed' });
    // Constructed stylesheets keep site CSP from stripping the isolated dropdown's layout.
    const style = new CSSStyleSheet();
    style.replaceSync(`:host{color-scheme:light}section{font:14px system-ui,sans-serif;background:#fff;color:#202124;border:1px solid #dadce0;border-radius:8px;box-shadow:0 4px 14px #0003;overflow:auto;max-height:${height}px}
        header{padding:10px 12px;font-size:12px;color:#657080}button{display:block;box-sizing:border-box;width:100%;min-height:38px;border:0;background:transparent;text-align:left;padding:9px 12px;color:inherit;font:inherit;cursor:pointer;overflow-wrap:anywhere}
        button:hover,button[aria-selected=true]{background:#e8f0fe}`);
    const section = document.createElement('section');
    section.setAttribute('role', 'listbox');
    section.setAttribute('aria-label', list.label);
    const heading = document.createElement('header');
    heading.textContent = list.label;
    section.append(heading);
    const buttons: HTMLButtonElement[] = [];
    for (const username of list.usernames) {
        const button = document.createElement('button');
        button.type = 'button';
        button.tabIndex = -1;
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', 'false');
        button.textContent = username;
        button.addEventListener('pointerdown', (event) => event.preventDefault());
        button.addEventListener('click', (event) => {
            if (event.isTrusted) onSelect(username);
        });
        buttons.push(button);
        section.append(button);
    }
    root.adoptedStyleSheets = [style];
    root.append(section);
    document.documentElement.append(host);
    let active = -1;
    return {
        host,
        destroy: () => host.remove(),
        handleKey(event) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                active =
                    (active + (event.key === 'ArrowDown' ? 1 : active < 0 ? 0 : -1) + buttons.length) % buttons.length;
                buttons.forEach((button, index) => button.setAttribute('aria-selected', String(index === active)));
                buttons[active].scrollIntoView({ block: 'nearest' });
                return true;
            }
            if (event.key === 'Enter' && active >= 0) {
                event.preventDefault();
                event.stopPropagation();
                onSelect(list.usernames[active]);
                return true;
            }
            return false;
        }
    };
}
