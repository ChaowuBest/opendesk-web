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
        expect(applicationHtml).toContain('right: 5.75rem');
        expect(applicationHtml).toContain('translate-x-8 scale-95 opacity-0');
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
    });
});
