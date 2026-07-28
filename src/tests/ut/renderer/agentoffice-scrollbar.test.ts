import fs from 'fs';
import { describe, expect, test } from '@jest/globals';

const source = fs
    .readFileSync(new URL('../../../main/applications/agentoffice/renderer/style.css', import.meta.url), 'utf8')
    .replace(/\s+/g, '');

describe('AgentOffice scrollbar specification', () => {
    test('primary chat, list, and detail surfaces use the 4px primary scrollbar', () => {
        const primarySelector = ':is(.messages,.staff-list,.management,.detail-content)::-webkit-scrollbar';

        expect(source).toContain(`${primarySelector}{width:4px;height:4px;}`);
        expect(source).toContain('background:rgba(0,0,0,0.12)');
        expect(source).toContain('background:rgba(0,0,0,0.22)');
    });

    test('compact modals, Skill lists, markdown overflow, and text areas are covered', () => {
        for (const selector of [
            '.modal-body',
            '.detail-nav',
            '.installed-skill-list',
            '.message-markdown pre',
            '.message-markdown table',
            '.composer-textarea',
            '.field textarea'
        ]) {
            expect(source).toContain(selector.replace(/\s+/g, ''));
        }
        expect(source).toContain('border-radius:2px;background:#d1d5db');
    });

    test('dark mode uses the specified semi-transparent white thumb and hover colors', () => {
        expect(source).toContain(
            ":host([data-theme='dark']):is(.messages,.staff-list,.management,.detail-content,.modal-body"
        );
        expect(source).toContain('background:rgba(255,255,255,0.18)!important');
        expect(source).toContain('background:rgba(255,255,255,0.28)!important');
    });
});
