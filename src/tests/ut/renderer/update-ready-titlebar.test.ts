import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const rendererHtml = readFileSync(new URL('../../../renderer/index.html', import.meta.url), 'utf8');
const rendererEntry = readFileSync(new URL('../../../renderer/scripts/index.js', import.meta.url), 'utf8');
const settingPanel = readFileSync(new URL('../../../renderer/components/settingpanel.js', import.meta.url), 'utf8');
const titlebarStyles = readFileSync(new URL('../../../renderer/styles/titlebar.css', import.meta.url), 'utf8');

describe('installed update titlebar entry', () => {
    test('places a hidden, localized update entry immediately before shortcut help', () => {
        expect(rendererHtml).toMatch(/id="update-ready-btn"[\s\S]*?id="shortcut-help-btn"/);
        expect(rendererHtml).toContain('class="window-control-btn update-ready-btn');
        expect(rendererHtml).toContain('hidden');
        expect(rendererHtml).toContain('fa-circle-arrow-down');
        expect(rendererHtml).toContain('class="update-ready-text"');
        expect(rendererEntry).toContain("t('update.available.short')");
        expect(rendererEntry).toContain("querySelector('.update-ready-text')");
        expect(titlebarStyles).toContain('--update-ready-accent: #c24135');
        expect(titlebarStyles).toContain('--update-ready-accent: #f08479');
        expect(titlebarStyles).toContain('color-mix(in srgb, var(--update-ready-accent)');
        expect(titlebarStyles).not.toContain('#2563eb');
    });

    test('shows the titlebar entry only after background installation completed', () => {
        expect(rendererEntry).toContain("updateReadyButton.hidden = state?.status !== 'installed'");
        expect(rendererEntry).toContain('window.updateAPI?.onStateChanged(updateUpdateReadyButton)');
        expect(rendererEntry).not.toContain('promptForReadyUpdate');
        expect(rendererEntry).not.toMatch(/onStateChanged\([^)]*showConfirmModal/);
    });

    test('opens the model settings tab where software update is the first section', () => {
        expect(rendererEntry).toContain("openSettingEditor({ tab: 'models' })");
        expect(rendererHtml).toContain("options && options.tab === 'models'");
        expect(settingPanel).toContain("this.getAttribute('initial-tab')");
        expect(settingPanel).toMatch(
            /id="tab-models"[\s\S]*?\$\{this\.renderUpdateSection\(\)\}[\s\S]*?\$\{this\.renderProvidersSection\(\)\}/
        );
        expect(settingPanel).not.toMatch(
            /renderGeneralSection\(\)[\s\S]*?return `\s*\$\{this\.renderUpdateSection\(\)\}/
        );
        expect(settingPanel).toContain("this.querySelector('#tab-models')?.insertAdjacentHTML('afterbegin', html)");
    });

    test('offers an optional restart without exposing the old install action', () => {
        expect(settingPanel).toContain("state.status === 'installed'");
        expect(settingPanel).toContain('window.updateAPI.restart()');
        expect(settingPanel).not.toContain('window.updateAPI.install()');
        expect(settingPanel).not.toContain("this.updateState?.status === 'ready'");
    });
});
