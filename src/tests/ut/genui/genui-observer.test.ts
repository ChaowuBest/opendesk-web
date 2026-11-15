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

import { beforeAll, describe, expect, it } from '@jest/globals';
import { parseHTML } from 'linkedom';

let affectsPlaceholders: typeof import('../../../renderer/genui/index.js').affectsPlaceholders;
let doc: Document;

beforeAll(async () => {
    doc = parseHTML('<!doctype html><html><body><div class="od-genui"><span>x</span></div><p>text</p></body></html>')
        .window.document;
    ({ affectsPlaceholders } = await import('../../../renderer/genui/index.js'));
});

function record(partial: Partial<MutationRecord>): MutationRecord {
    return { addedNodes: [] as unknown as NodeList, target: doc.body, type: 'childList', ...partial } as MutationRecord;
}

describe('affectsPlaceholders', () => {
    it('reacts to inserted placeholders', () => {
        const wrapper = doc.createElement('div');
        wrapper.innerHTML = '<div class="od-genui"></div>';
        expect(affectsPlaceholders([record({ addedNodes: [wrapper] as unknown as NodeList })])).toBe(true);
    });

    it('reacts to attribute or child changes of a placeholder (in-place morph)', () => {
        const placeholder = doc.querySelector('.od-genui')!;
        expect(affectsPlaceholders([record({ type: 'attributes', target: placeholder })])).toBe(true);
        expect(affectsPlaceholders([record({ target: placeholder })])).toBe(true);
    });

    it('ignores unrelated mutations such as streaming text', () => {
        const paragraph = doc.querySelector('p')!;
        const text = doc.createTextNode('more');
        expect(affectsPlaceholders([record({ target: paragraph, addedNodes: [text] as unknown as NodeList })])).toBe(
            false
        );
    });
});
