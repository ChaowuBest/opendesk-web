import { beforeAll, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

beforeAll(async () => {
    const { window } = parseHTML('<!doctype html><html><body></body></html>');
    Object.assign(globalThis, {
        window,
        document: window.document,
        HTMLElement: window.HTMLElement,
        Event: window.Event,
        customElements: window.customElements
    });
    Object.defineProperty(globalThis, 'navigator', {
        value: { languages: ['en-US'], language: 'en-US' },
        configurable: true
    });
    await import('../../../renderer/components/settingpanel.js');
});

const shells = [
    { kind: 'powershell', path: 'C:/Windows/powershell.exe', sandboxed: false },
    { kind: 'powershell', path: 'C:/Windows/powershell.exe', sandboxed: true },
    { kind: 'bash', path: 'C:/Git/bash.exe', sandboxed: false }
];

function createPanel(config: Record<string, unknown> = {}) {
    const panel = document.createElement('setting-panel') as any;
    panel.currentData = { task_config: config, cli_config: {} };
    panel.supportedShells = shells;
    panel.saveImmediately = jest.fn();
    panel.innerHTML = panel.renderTaskSection();
    panel._bindShellSettingsEvents();
    return panel;
}

test('deduplicates paths and displays the fallback shell with an unchecked sandbox option', () => {
    const panel = createPanel({ shell_path: 'C:/removed.exe', shell_sandboxed: true });
    expect(panel.querySelectorAll('#task-shell-path option')).toHaveLength(2);
    expect(panel.querySelector('#task-shell-path').value).toBe(shells[0].path);
    expect(panel.querySelector('#task-shell-sandboxed').hasAttribute('checked')).toBe(false);
    expect(panel.textContent).not.toContain('sp.task.terminal.');
    expect(panel.querySelectorAll('.sp-section')).toHaveLength(2);
    expect(panel.querySelectorAll('.sp-section-title')[0].textContent).toContain('Harness');
    expect(panel.querySelectorAll('.sp-section-title')[1].textContent).toContain('Terminal');
});

test('saves both path and sandbox flag, then hides sandbox when switching to bash', () => {
    const panel = createPanel();
    const checkbox = panel.querySelector('#task-shell-sandboxed');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    expect(panel.currentData.task_config).toEqual({ shell_path: shells[0].path, shell_sandboxed: true });
    const select = panel.querySelector('#task-shell-path');
    Object.defineProperty(select, 'value', { value: shells[2].path, configurable: true });
    select.dispatchEvent(new Event('change'));
    expect(panel.currentData.task_config).toEqual({ shell_path: shells[2].path, shell_sandboxed: false });
    expect(panel.querySelector('#task-shell-sandboxed')).toBeNull();
    expect(panel.saveImmediately).toHaveBeenCalledTimes(2);
});

test('macOS and Linux pwsh has no sandbox checkbox, and empty discovery disables the select', () => {
    const panel = createPanel();
    panel.supportedShells = [{ kind: 'powershell', path: '/usr/local/bin/pwsh', sandboxed: false }];
    panel.innerHTML = panel.renderTaskSection();
    expect(panel.querySelector('#task-shell-sandboxed')).toBeNull();
    panel.supportedShells = [];
    panel.innerHTML = panel.renderTaskSection();
    expect(panel.querySelector('#task-shell-path').hasAttribute('disabled')).toBe(true);
    expect(panel.querySelector('#task-shell-sandboxed')).toBeNull();
});

test('escapes executable paths in option values and labels', () => {
    const panel = createPanel();
    const path = 'C:/tools/<pwsh>&"/pwsh.exe';
    panel.supportedShells = [{ kind: 'powershell', path, sandboxed: false }];
    panel.innerHTML = panel.renderTaskSection();
    expect(panel.querySelector('#task-shell-path').value).toBe(path);
    expect(panel.querySelector('option').textContent).toBe(`powershell — ${path}`);
    expect(panel.querySelector('pwsh')).toBeNull();
});
