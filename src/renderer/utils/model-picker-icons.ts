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

export function getModelIconTile(hasVision: boolean): string {
    const cls = hasVision ? 'model-vision' : 'model-chat';
    const svgPath = hasVision
        ? '<path d="M1.5 8S3.5 4.5 8 4.5s6.5 3.5 6.5 3.5-2 3.5-6.5 3.5S1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>'
        : '<path d="M3 5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H6l-3 2.5V5Z"/>';
    return `<span class="agent-icon-tile ${cls}"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${svgPath}</svg></span>`;
}

// --- Reasoning effort SVG icons (scheme 1: energy bars, 4 cells) ---
// 四格能量条：none=全灰+斜线、low=1 格、medium=2 格、high=3 格、max=4 格，
// 默认('')=4 格淡色。

const EFFORT_BAR_X = [1.125, 4.875, 8.625, 12.375];
const EFFORT_BAR_GREEN = '#1F9D66';
const EFFORT_BAR_GREY = '#E7E5E2';

function effortBarRects(filledCount: number): string {
    return EFFORT_BAR_X.map(
        (x, i) =>
            `<rect x="${x}" y="2.5" width="2.5" height="11" rx=".5" fill="${i < filledCount ? EFFORT_BAR_GREEN : EFFORT_BAR_GREY}"/>`
    ).join('');
}

const EFFORT_BAR_SVG: Record<string, string> = {
    '': EFFORT_BAR_X.map(
        (x) => `<rect x="${x}" y="2.5" width="2.5" height="11" rx=".5" fill="${EFFORT_BAR_GREEN}" opacity=".35"/>`
    ).join(''),
    none:
        effortBarRects(0) + '<path d="M1.5 13.5 14.5 2.5" stroke="#8A8580" stroke-width="1.4" stroke-linecap="round"/>',
    low: effortBarRects(1),
    medium: effortBarRects(2),
    high: effortBarRects(3),
    max: effortBarRects(4)
};

export function getEffortIconSVG(effortValue: string): string {
    const paths = EFFORT_BAR_SVG[effortValue] || EFFORT_BAR_SVG[''];
    return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">${paths}</svg>`;
}
