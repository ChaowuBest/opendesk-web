/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You may use this software according to the terms and conditions of the MulanPSL2.
 */

import fs from 'fs';
import { describe, expect, test } from '@jest/globals';

const source = fs.readFileSync(
    new URL('../../../main/applications/agentoffice/renderer/entry.ts', import.meta.url),
    'utf8'
);

describe('AgentOffice scrollbar specification', () => {
    test('primary chat, list, and detail surfaces use the 4px primary scrollbar', () => {
        const primarySelector = ':is(.messages,.staff-list,.management,.detail-content)::-webkit-scrollbar';

        expect(source).toContain(`${primarySelector} { width:4px; height:4px; }`);
        expect(source).toContain('background:rgba(0,0,0,.12)');
        expect(source).toContain('background:rgba(0,0,0,.22)');
    });

    test('compact modals, Skill lists, markdown overflow, and text areas are covered', () => {
        for (const selector of [
            '.modal-body',
            '.detail-nav',
            '.installed-skill-list',
            '.message-markdown pre',
            '.message-markdown table',
            '.compose-row textarea',
            '.field textarea'
        ]) {
            expect(source).toContain(selector);
        }
        expect(source).toContain('border-radius:2px; background:#d1d5db');
    });

    test('dark mode uses the specified semi-transparent white thumb and hover colors', () => {
        expect(source).toContain(
            ":host([data-theme='dark']) :is(.messages,.staff-list,.management,.detail-content,.modal-body"
        );
        expect(source).toContain('background:rgba(255,255,255,.18) !important');
        expect(source).toContain('background:rgba(255,255,255,.28) !important');
    });
});
