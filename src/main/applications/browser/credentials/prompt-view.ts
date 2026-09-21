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

interface CredentialPromptOptions {
    id: string;
    guestId: number;
    buttonCSS: string;
    question: string;
    action: string;
    cancel: string;
    close: string;
    oldLabel: string;
    newLabel: string;
    reveal: string;
    oldPassword?: string;
    newPassword?: string;
}

/** Serialized into the trusted host renderer; keep all runtime dependencies inside this function. */
export function renderCredentialPrompt(options: CredentialPromptOptions): Promise<boolean> {
    for (const previous of document.querySelectorAll('[data-opendesk-credential-prompt]')) {
        previous.dispatchEvent(new Event('opendesk-credential-dismiss'));
    }
    // Task previews can live in nested shadow roots and share a host with other browser panels.
    const findGuest = (scope: Document | ShadowRoot): HTMLElement | undefined => {
        for (const element of scope.querySelectorAll<HTMLElement & { getWebContentsId?: () => number }>('*')) {
            if (element.tagName === 'WEBVIEW') {
                try {
                    if (element.getWebContentsId?.() === options.guestId) return element;
                } catch {
                    // An unrelated tab may not have attached its guest yet.
                }
            }
            if (element.shadowRoot) {
                const found = findGuest(element.shadowRoot);
                if (found) return found;
            }
        }
        return undefined;
    };
    const guest = findGuest(document);
    const toolbar = guest?.closest('.bw, .wb')?.querySelector<HTMLElement>('.bw-toolbar, .wb-toolbar');
    if (!guest || !toolbar) return Promise.resolve(false);
    return new Promise((resolve) => {
        const host = document.createElement('div');
        host.id = options.id;
        host.setAttribute('data-opendesk-credential-prompt', '');
        host.style.cssText = 'position:fixed;z-index:2147483647;-webkit-app-region:no-drag;';
        const root = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = `
            :host{font-family:var(--font-sans);font-size:var(--fs-base);color:var(--od-text);line-height:1.5}
            *{box-sizing:border-box}
            section{padding:16px;background:var(--od-bg-elevated);border:1px solid var(--od-border-strong);border-radius:0;box-shadow:0 8px 24px #0003;max-height:var(--credential-prompt-max-height);overflow:auto}
            header{display:flex;align-items:center;justify-content:space-between;gap:12px}
            h2{font-size:var(--fs-lg);font-weight:600;line-height:1.5;margin:0}
            ${options.buttonCSS}
            button{line-height:1.5}
            button:focus-visible,input:focus-visible{outline:2px solid var(--mc-accent);outline-offset:2px}
            .close{padding:0;width:26px;height:26px;border:0;background:transparent;color:var(--od-text-muted);font:inherit;font-size:var(--fs-lg);cursor:pointer}.close:hover{background:var(--od-bg-subtle)}
            nav{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:16px}
            nav label{margin-right:auto;white-space:nowrap}
            nav .od-confirm-btn{height:28px;padding:0 14px}
            dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 12px;margin:16px 0 12px}
            dt{color:var(--od-text-muted)}dd{margin:0;overflow-wrap:anywhere;font-family:var(--font-mono)}
            label{display:flex;align-items:center;gap:6px;font-size:var(--fs-md);color:var(--od-text-muted);cursor:pointer}input{margin:0;accent-color:var(--mc-accent)}
        `;
        const section = document.createElement('section');
        section.setAttribute('role', 'dialog');
        section.setAttribute('aria-modal', 'false');
        section.setAttribute('aria-label', options.question);
        const header = document.createElement('header');
        const title = document.createElement('h2');
        title.textContent = options.question;
        let settled = false;
        let frame = 0;
        const roots = new Set<Document | ShadowRoot>();
        const resize = new ResizeObserver(() => schedulePosition());
        const mutation = new MutationObserver(() => schedulePosition());
        const finish = (accepted: boolean) => {
            if (settled) return;
            settled = true;
            cancelAnimationFrame(frame);
            resize.disconnect();
            mutation.disconnect();
            window.removeEventListener('resize', schedulePosition);
            for (const scope of roots) scope.removeEventListener('scroll', schedulePosition, true);
            host.remove();
            resolve(accepted);
        };
        host.addEventListener('opendesk-credential-dismiss', () => finish(false), { once: true });
        const button = (label: string, accepted: boolean) => {
            const control = document.createElement('button');
            control.type = 'button';
            control.className = 'od-confirm-btn od-confirm-btn-cancel';
            control.textContent = label;
            control.addEventListener('click', (event) => {
                if (event.isTrusted) finish(accepted);
            });
            return control;
        };
        const close = button('×', false);
        close.className = 'close';
        close.setAttribute('aria-label', options.close);
        header.append(title, close);
        section.append(header);
        const actions = document.createElement('nav');
        if (options.oldPassword !== undefined) {
            const list = document.createElement('dl');
            const values: Array<{ field: HTMLElement; value: string }> = [];
            for (const [label, value, id] of [
                [options.oldLabel, options.oldPassword, 'old'],
                [options.newLabel, options.newPassword ?? '', 'new']
            ]) {
                const term = document.createElement('dt');
                term.textContent = label;
                const field = document.createElement('dd');
                field.id = id;
                field.textContent = '••••••••';
                values.push({ field, value });
                list.append(term, field);
            }
            const reveal = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.addEventListener('change', () => {
                for (const { field, value } of values) field.textContent = checkbox.checked ? value : '••••••••';
            });
            reveal.append(checkbox, document.createTextNode(options.reveal));
            section.append(list);
            actions.append(reveal);
        }
        const save = button(options.action, true);
        save.className = 'od-confirm-btn od-confirm-btn-primary';
        actions.append(button(options.cancel, false), save);
        section.append(actions);
        section.addEventListener('keydown', (event) => {
            if (event.isTrusted && event.key === 'Escape') {
                event.stopPropagation();
                finish(false);
            }
        });
        section.addEventListener('click', (event) => event.stopPropagation());
        root.append(style, section);
        document.body.append(host);
        const position = () => {
            frame = 0;
            if (settled) return;
            const bounds = toolbar.getBoundingClientRect();
            if (!guest.isConnected || !guest.getClientRects().length || !bounds.width || !bounds.height) {
                finish(false);
                return;
            }
            const top = bounds.bottom;
            const right = Math.min(bounds.right, innerWidth);
            host.style.top = `${top}px`;
            host.style.right = `${innerWidth - right}px`;
            host.style.width = `${Math.max(0, Math.min(360, right - Math.max(bounds.left, 0)))}px`;
            host.style.setProperty('--credential-prompt-max-height', `${Math.max(0, innerHeight - top)}px`);
        };
        function schedulePosition() {
            if (!settled && !frame) frame = requestAnimationFrame(position);
        }
        // Observe layout changes only while the prompt is open, including position-only changes
        // when a task pane enters preview/fullscreen; no periodic layout polling.
        for (let node: Node | null = toolbar; node; ) {
            mutation.observe(node, { attributes: true, childList: true });
            if (node instanceof Element) resize.observe(node);
            if (node instanceof ShadowRoot || node instanceof Document) {
                roots.add(node);
                node.addEventListener('scroll', schedulePosition, true);
            }
            node = node instanceof ShadowRoot ? node.host : node.parentNode;
        }
        // Tab switches hide the guest without moving the shared toolbar.
        resize.observe(guest);
        window.addEventListener('resize', schedulePosition);
        position();
        // Deliberately leave focus in the login page; submission Enter must not accept this prompt.
    });
}
