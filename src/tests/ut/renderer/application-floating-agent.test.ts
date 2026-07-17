import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { enUs } from '../../../locale/en-us.js';
import { zhCn } from '../../../locale/zh-cn.js';

const applicationHtml = readFileSync(new URL('../../../renderer/application.html', import.meta.url), 'utf8');
const { document } = parseHTML(applicationHtml);

describe('application floating agent shell', () => {
    test('keeps an icon_round trigger anchored outside the chat surface', () => {
        const trigger = document.querySelector('#floating-ai-trigger');
        const panel = document.querySelector('#floating-ai-chat-panel');

        expect(trigger).not.toBeNull();
        expect(trigger?.querySelector('img')?.getAttribute('src')).toBe('./images/icon_round.png');
        expect(trigger?.getAttribute('type')).toBe('button');
        expect(panel).not.toBeNull();
        expect(trigger?.parentElement).toBe(document.body);
        expect(panel?.parentElement).toBe(document.body);
        expect(applicationHtml).toContain('right: 4.75rem');
        expect(applicationHtml).toContain('translate-x-8 scale-95 opacity-0');
    });

    test('uses a compact proportional trigger and shorter default panel', () => {
        const triggerImage = document.querySelector('#floating-ai-trigger img');

        expect(applicationHtml).toContain('width: 3rem');
        expect(applicationHtml).toContain('height: 3rem');
        expect(applicationHtml).toContain('height: min(32rem, calc(100vh - 2rem))');
        expect(triggerImage?.classList.contains('w-9')).toBe(true);
        expect(triggerImage?.classList.contains('h-9')).toBe(true);
    });

    test('provides new-task, maximize, and collapse controls', () => {
        expect(document.querySelector('#floating-ai-new-task-button')).not.toBeNull();
        expect(document.querySelector('#floating-ai-chat-panel-maximize-button')).not.toBeNull();
        expect(document.querySelector('#floating-ai-chat-panel-close-button')).not.toBeNull();
        expect(document.querySelector('#floating-ai-task-view-container')).not.toBeNull();
        expect(applicationHtml).toContain(':disabled="isTaskChanging"');
    });

    test('only animates the trigger for a hidden running task', () => {
        const triggerBinding = document.querySelector('#floating-ai-trigger')?.getAttribute(':class');

        expect(triggerBinding).toContain("'is-running': isTaskRunning && !showFloatingChatPanel");
        expect(applicationHtml).toContain('@keyframes floating-agent-running');
        expect(applicationHtml).toContain('@media (prefers-reduced-motion: reduce)');
    });

    test('localizes every new user-facing shell label', () => {
        const keys = [
            'renderer.applicationAgent.title',
            'renderer.applicationAgent.open',
            'renderer.applicationAgent.close',
            'renderer.applicationAgent.newTask',
            'renderer.applicationAgent.maximize',
            'renderer.applicationAgent.restore'
        ];

        for (const key of keys) {
            expect(zhCn[key]).toBeTruthy();
            expect(enUs[key]).toBeTruthy();
        }
        expect(zhCn['renderer.applicationAgent.title']).toBe('OpenDesk');
        expect(enUs['renderer.applicationAgent.title']).toBe('OpenDesk');
    });
});
