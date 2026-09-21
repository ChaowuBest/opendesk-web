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

import { showConfirmModal } from '../components/confirmModal.js';
interface BrowserSettingsOptions {
    t: (key: string, params?: Record<string, string | number>) => string;
    getUserAgent: () => string;
    setUserAgent: (value: string) => void;
}
interface Certificate {
    commonName: string;
    issuer: string;
    validFrom?: string;
    validTo?: string;
    fingerprint: string;
}
export class BrowserSettings {
    constructor(private options: BrowserSettingsOptions) {}
    private _t = (key: string, params?: Record<string, string | number>) => this.options.t(key, params);
    private get _cachedUserAgent() {
        return this.options.getUserAgent();
    }
    private set _cachedUserAgent(value: string) {
        this.options.setUserAgent(value);
    }
    public render(container: HTMLElement): void {
        container.innerHTML = `
        <div class="wb-internal-page" style="overflow-y:auto">
            <div class="wb-internal-header">
                <i class="fas fa-gear wb-internal-header-icon"></i>
                <span class="wb-internal-title">${this._t('renderer.browser.settings.title')}</span>
            </div>

            <!-- 密码与自动填充 -->
            <div style="padding:20px 24px;max-width:600px">
                <div style="font-size: var(--fs-xl);font-weight:600;color:var(--od-text);margin-bottom:4px">
                    <i class="fas fa-key" style="margin-right:8px;color:var(--od-text-muted)"></i>${this._t('renderer.browser.settings.passwords')}
                </div>
                <p style="font-size: var(--fs-base);color:var(--od-text-muted);margin:0 0 16px 0">
                    ${this._t('renderer.browser.settings.passwords.desc')}
                </p>
                <div style="background:var(--od-bg-elevated);border:1px solid var(--od-border);border-radius:10px;padding:16px 20px">
                    <div style="display:flex;align-items:center;justify-content:space-between">
                        <div>
                            <div style="font-size: var(--fs-lg);font-weight:500;color:var(--od-text)">${this._t('renderer.browser.settings.autofill')}</div>
                            <div style="font-size: var(--fs-md);color:var(--od-text-muted);margin-top:2px">${this._t('renderer.browser.settings.autofill.desc')}</div>
                        </div>
                        <span style="font-size: var(--fs-md);color:#059669;background:#ecfdf5;padding:2px 10px;border-radius:12px;font-weight:500">${this._t('renderer.browser.settings.enabled')}</span>
                    </div>
                    <button class="wb-bs-btn wb-bs-btn-danger" data-action="bs-clear-autofill" style="margin-top:12px">
                        <i class="fas fa-trash-can"></i> ${this._t('renderer.browser.settings.clearAutofill')}
                    </button>
                </div>
            </div>

            <!-- 证书管理 -->
            <div style="padding:0 24px 20px;max-width:600px">
                <div style="font-size: var(--fs-xl);font-weight:600;color:var(--od-text);margin-bottom:4px">
                    <i class="fas fa-certificate" style="margin-right:8px;color:var(--od-text-muted)"></i>${this._t('renderer.browser.settings.cert.title')}
                </div>
                <p style="font-size: var(--fs-base);color:var(--od-text-muted);margin:0 0 16px 0">
                    ${this._t('renderer.browser.settings.cert.desc')}
                </p>
                <div style="background:var(--od-bg-elevated);border:1px solid var(--od-border);border-radius:10px;padding:16px 20px">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                        <span style="font-size: var(--fs-lg);font-weight:500;color:var(--od-text)">${this._t('renderer.browser.settings.cert.imported')}</span>
                        <button class="wb-bs-btn wb-bs-btn-primary" data-action="bs-import-cert">
                            <i class="fas fa-plus"></i> ${this._t('renderer.browser.settings.cert.import')}
                        </button>
                    </div>
                    <div id="wb-cert-list">
                        <div style="text-align:center;color:var(--od-text-muted);padding:20px 0;font-size: var(--fs-base)">
                            <i class="fas fa-spinner fa-pulse"></i> ${this._t('renderer.browser.settings.cert.loading')}
                        </div>
                    </div>
                    <div style="margin-top:12px;padding:8px 12px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;font-size: var(--fs-md);color:#0369a1">
                        <i class="fas fa-info-circle"></i> ${this._t('renderer.browser.settings.cert.systemHint')}
                    </div>
                </div>
            </div>

            <!-- User Agent -->
            <div style="padding:0 24px 20px;max-width:600px">
                <div style="font-size: var(--fs-xl);font-weight:600;color:var(--od-text);margin-bottom:4px">
                    <i class="fas fa-globe" style="margin-right:8px;color:var(--od-text-muted)"></i>User Agent
                </div>
                <p style="font-size: var(--fs-base);color:var(--od-text-muted);margin:0 0 16px 0">
                    ${this._t('renderer.browser.settings.ua.desc')}
                </p>
                <div style="background:var(--od-bg-elevated);border:1px solid var(--od-border);border-radius:10px;padding:16px 20px">
                    <input
                        id="wb-useragent-input"
                        type="text"
                        placeholder="${this._t('renderer.browser.settings.ua.placeholder')}"
                        value="${this._escapeHtml(this._cachedUserAgent)}"
                        style="width:100%;box-sizing:border-box;padding:8px 12px;border:1px solid #d1d5db;border-radius:6px;font-size: var(--fs-base);font-family:monospace;color:var(--od-text);outline:none"
                    />
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px">
                        <span style="font-size: var(--fs-sm);color:var(--od-text-muted)">
                            <i class="fas fa-info-circle"></i> ${this._t('renderer.browser.settings.ua.hint')}
                        </span>
                        <button class="wb-bs-btn wb-bs-btn-primary" data-action="bs-save-useragent">
                            <i class="fas fa-floppy-disk"></i> ${this._t('renderer.browser.modal.save')}
                        </button>
                    </div>
                </div>
            </div>
        </div>`;

        // Bind actions
        container.querySelectorAll('[data-action]').forEach((el) => {
            el.addEventListener('click', () => {
                const action = (el as HTMLElement).dataset.action;
                void this._handleSettingsAction(action!, container);
            });
        });

        // Load certificates
        this._loadCertificates(container);
    }

    private async _handleSettingsAction(action: string, container: HTMLElement): Promise<void> {
        const registryAPI = (window as any).applicationRegistryAPI;
        if (!registryAPI?.callMainWorld) return;

        switch (action) {
            case 'bs-clear-autofill': {
                const confirmed = await showConfirmModal({
                    icon: 'fa-key',
                    iconBg: '#FEF2F2',
                    iconColor: '#DC2626',
                    title: this._t('renderer.browser.settings.clearAutofill.confirmTitle'),
                    message: this._t('renderer.browser.settings.clearAutofill.confirmMessage'),
                    confirmText: this._t('renderer.browser.modal.clear'),
                    cancelText: this._t('renderer.browser.modal.cancel'),
                    danger: true
                });
                if (!confirmed) return;
                const result = await registryAPI.callMainWorld('browser', 'clearAutofillData');
                await showConfirmModal({
                    icon: result?.success ? 'fa-circle-check' : 'fa-circle-exclamation',
                    iconBg: result?.success ? '#ECFDF5' : '#FEF2F2',
                    iconColor: result?.success ? '#059669' : '#DC2626',
                    title: result?.success
                        ? this._t('renderer.browser.modal.actionSuccess')
                        : this._t('renderer.browser.modal.actionFailed'),
                    message: result?.message || this._t('renderer.browser.modal.unknownResult'),
                    confirmText: this._t('renderer.browser.modal.acknowledge'),
                    cancelText: null
                });
                break;
            }
            case 'bs-import-cert': {
                await this._importCertificate(container);
                break;
            }
            case 'bs-save-useragent': {
                const inputEl = container.querySelector('#wb-useragent-input') as HTMLInputElement;
                const value = inputEl?.value ?? '';
                await registryAPI.callMainWorld('browser', 'setConfig', { userAgent: value });
                this._cachedUserAgent = value;
                await showConfirmModal({
                    icon: 'fa-circle-check',
                    iconBg: '#ECFDF5',
                    iconColor: '#059669',
                    title: this._t('renderer.browser.settings.ua.saved.title'),
                    message: this._t('renderer.browser.settings.ua.saved.message'),
                    confirmText: this._t('renderer.browser.modal.acknowledge'),
                    cancelText: null
                });
                break;
            }
        }
    }

    private async _loadCertificates(container: HTMLElement): Promise<void> {
        const certListEl = container.querySelector('#wb-cert-list') as HTMLElement;
        if (!certListEl) return;

        const registryAPI = (window as any).applicationRegistryAPI;
        if (!registryAPI?.callMainWorld) {
            certListEl.innerHTML =
                '<div style="text-align:center;color:var(--od-text-muted);padding:20px 0;font-size: var(--fs-base)">' +
                this._t('renderer.browser.settings.cert.unsupported') +
                '</div>';
            return;
        }

        try {
            const result = await registryAPI.callMainWorld('browser', 'getBrowserCertificates');
            const certs: Certificate[] = Array.isArray(result) ? result : [];

            if (certs.length === 0) {
                certListEl.innerHTML =
                    '<div style="text-align:center;color:var(--od-text-muted);padding:20px 0;font-size: var(--fs-base)">' +
                    this._t('renderer.browser.settings.cert.none') +
                    '</div>';
                return;
            }

            certListEl.innerHTML = certs
                .map(
                    (cert) => `
                <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;margin:4px 0;border-radius:6px;background:var(--od-bg-subtle);border:1px solid var(--od-border)">
                    <i class="fas fa-certificate" style="color:var(--chat-accent);font-size: var(--fs-xl);flex-shrink:0"></i>
                    <div style="flex:1;min-width:0">
                        <div style="font-size: var(--fs-base);font-weight:500;color:var(--od-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._escapeHtml(cert.commonName)}</div>
                        <div style="font-size: var(--fs-sm);color:var(--od-text-muted)">${this._t('renderer.browser.settings.cert.issuer')}${this._escapeHtml(cert.issuer)}</div>
                        <div style="font-size: var(--fs-sm);color:var(--od-text-muted)">${this._t('renderer.browser.settings.cert.validity')}${cert.validFrom?.split('T')[0] || ''} ~ ${cert.validTo?.split('T')[0] || ''}</div>
                    </div>
                    <button class="wb-bs-btn wb-bs-btn-danger" data-action="bs-delete-cert" data-fingerprint="${cert.fingerprint}" style="font-size: var(--fs-sm);padding:4px 10px">
                        <i class="fas fa-xmark"></i>
                    </button>
                </div>`
                )
                .join('');

            // Re-bind delete buttons
            certListEl.querySelectorAll('[data-action="bs-delete-cert"]').forEach((el) => {
                el.addEventListener('click', async () => {
                    const fingerprint = (el as HTMLElement).dataset.fingerprint;
                    if (!fingerprint) return;
                    const confirmed = await showConfirmModal({
                        icon: 'fa-certificate',
                        iconBg: '#FEF2F2',
                        iconColor: '#DC2626',
                        title: this._t('renderer.browser.settings.cert.deleteTitle'),
                        message: this._t('renderer.browser.settings.cert.deleteMessage'),
                        confirmText: this._t('renderer.browser.modal.delete'),
                        cancelText: this._t('renderer.browser.modal.cancel'),
                        danger: true
                    });
                    if (!confirmed) return;
                    const registryAPI = (window as any).applicationRegistryAPI;
                    const result = await registryAPI.callMainWorld('browser', 'removeBrowserCertificate', fingerprint);
                    if (result?.success) {
                        this._loadCertificates(container);
                    }
                    await showConfirmModal({
                        icon: result?.success ? 'fa-circle-check' : 'fa-circle-exclamation',
                        iconBg: result?.success ? '#ECFDF5' : '#FEF2F2',
                        iconColor: result?.success ? '#059669' : '#DC2626',
                        title: this._t('renderer.browser.modal.opDone'),
                        message: result?.message || this._t('renderer.browser.modal.unknownResult'),
                        confirmText: this._t('renderer.browser.modal.acknowledge'),
                        cancelText: null
                    });
                });
            });
        } catch {
            certListEl.innerHTML =
                '<div style="text-align:center;color:#ef4444;padding:20px 0;font-size: var(--fs-base)">' +
                this._t('renderer.browser.settings.cert.loadFailed') +
                '</div>';
        }
    }

    private async _importCertificate(container: HTMLElement): Promise<void> {
        // 使用 FileReader 通过 input[type=file] 选择证书文件
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.pem,.crt,.cer,.cert,application/x-pem-file,application/x-x509-ca-cert';
        input.style.display = 'none';
        document.body.appendChild(input);

        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) {
                document.body.removeChild(input);
                return;
            }

            try {
                const pemText = await file.text();
                const registryAPI = (window as any).applicationRegistryAPI;
                if (!registryAPI?.callMainWorld) {
                    await showConfirmModal({
                        icon: 'fa-circle-exclamation',
                        iconBg: '#FEF2F2',
                        iconColor: '#DC2626',
                        title: this._t('renderer.browser.settings.cert.importFailed'),
                        message: this._t('renderer.browser.settings.cert.importUnsupported'),
                        confirmText: this._t('renderer.browser.modal.acknowledge'),
                        cancelText: null
                    });
                    return;
                }

                const result = await registryAPI.callMainWorld('browser', 'importBrowserCertificate', pemText);
                await showConfirmModal({
                    icon: result?.success ? 'fa-circle-check' : 'fa-circle-exclamation',
                    iconBg: result?.success ? '#ECFDF5' : '#FEF2F2',
                    iconColor: result?.success ? '#059669' : '#DC2626',
                    title: result?.success
                        ? this._t('renderer.browser.settings.cert.importSuccess')
                        : this._t('renderer.browser.settings.cert.importFailed'),
                    message: result?.message || this._t('renderer.browser.modal.unknownResult'),
                    confirmText: this._t('renderer.browser.modal.acknowledge'),
                    cancelText: null
                });

                if (result?.success) {
                    this._loadCertificates(container);
                }
            } catch (err: any) {
                await showConfirmModal({
                    icon: 'fa-circle-exclamation',
                    iconBg: '#FEF2F2',
                    iconColor: '#DC2626',
                    title: this._t('renderer.browser.settings.cert.importFailed'),
                    message: err?.message || this._t('renderer.browser.settings.cert.readFailed'),
                    confirmText: this._t('renderer.browser.modal.acknowledge'),
                    cancelText: null
                });
            }

            document.body.removeChild(input);
        };

        input.click();
    }

    private _escapeHtml(str: string): string {
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
}
