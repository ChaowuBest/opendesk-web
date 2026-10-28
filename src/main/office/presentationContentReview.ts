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

import { runPresentationProgram } from '@bitclub.ai/opendesk-office/presentation-automation';

export interface PresentationContentReview {
    passed: boolean;
    complete: boolean;
    slideCount?: number;
    expectedSlideCount?: number;
    slides: Array<{ page: number; texts: string[] }>;
    findings: Array<{ code: string; page?: number; targetPage?: number; title?: string }>;
}

const normalize = (text: string): string =>
    text
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, '');

/** Checks observable content consistency, not factual correctness or visual quality. */
export async function reviewPresentationContent(
    bytes: Uint8Array,
    expectedSlideCount?: number
): Promise<PresentationContentReview> {
    const snapshot = await runPresentationProgram({
        startFrom: 'current',
        currentBytes: bytes,
        program: "return deck.inspect({ level: 'elements' });"
    });
    if (!snapshot.ok) throw new Error('Presentation content inspection failed');
    const deck = snapshot.value as {
        size: { width: number };
        slides: Array<{ elements: Array<{ text?: string; box?: { x: number; y: number; w: number; h: number } }> }>;
    };
    const slides = deck.slides.map((slide, index) => ({
        page: index + 1,
        texts: slide.elements.flatMap((element) => (element.text?.trim() ? [element.text] : []))
    }));
    const findings: PresentationContentReview['findings'] = [];
    if (expectedSlideCount !== undefined && expectedSlideCount !== slides.length) {
        findings.push({ code: 'SLIDE_COUNT_MISMATCH' });
    }
    deck.slides.forEach((slide, index) => {
        // Only recognize explicit contents headings and aligned right-hand page references.
        // Numeric statistics on ordinary slides and footer folios are not contents entries.
        if (
            !slides[index]!.texts.some((text) =>
                /^(目录|contents|tableofcontents|目录contents|contents目录)$/.test(normalize(text))
            )
        )
            return;
        const entries = slide.elements.flatMap((element) => {
            if (!element.text?.trim() || !element.box) return [];
            return [{ text: element.text.trim(), box: element.box }];
        });
        for (const entry of entries) {
            if (!/^\d{1,4}$/.test(entry.text) || entry.box.x < deck.size.width * 0.65) continue;
            const title = entries
                .filter(
                    (candidate) =>
                        candidate.box.x < entry.box.x &&
                        !/^\d+$/.test(candidate.text) &&
                        Math.abs(candidate.box.y + candidate.box.h / 2 - (entry.box.y + entry.box.h / 2)) <
                            Math.max(candidate.box.h, entry.box.h) * 0.6
                )
                .sort((a, b) => b.box.x - a.box.x)[0]?.text;
            if (!title) continue;
            const targetPage = Number(entry.text);
            if (targetPage < 1 || targetPage > slides.length) {
                findings.push({ code: 'CONTENTS_PAGE_OUT_OF_RANGE', page: index + 1, targetPage, title });
            } else if (!slides[targetPage - 1]!.texts.some((text) => normalize(text).includes(normalize(title)))) {
                findings.push({ code: 'CONTENTS_TITLE_MISMATCH', page: index + 1, targetPage, title });
            }
        }
    });
    return {
        passed: findings.length === 0,
        complete: true,
        slideCount: slides.length,
        expectedSlideCount,
        slides,
        findings
    };
}
