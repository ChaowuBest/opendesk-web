import fs from 'fs';
import { describe, expect, test } from '@jest/globals';

/**
 * 深色主题下测评页的 segmented control 必须和技能中心保持同一套外观：
 * 之前测评把选中项写成了 #333333，和轨道色一样，选中态几乎不可见。
 */

const benchmarkCss = read('../../../main/applications/benchmark/renderer/style.css');
const skillCss = read('../../../main/applications/skillmgr/renderer/entry.js');

function read(relativePath: string): string {
    return fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function normalize(css: string): string {
    return css.replace(/\s+/g, '').replace(/'/g, '"');
}

function declarations(css: string, selector: string): Record<string, string> {
    const source = normalize(css);
    const start = source.indexOf(`${selector}{`);
    if (start < 0) {
        return {};
    }
    const bodyStart = start + selector.length + 1;
    const end = source.indexOf('}', bodyStart);
    const body = source.slice(bodyStart, end);
    const result: Record<string, string> = {};
    for (const entry of body.split(';')) {
        const split = entry.indexOf(':');
        if (split > 0) {
            result[entry.slice(0, split)] = entry.slice(split + 1);
        }
    }
    return result;
}

const DARK_TRACK = ':host([data-theme="dark"]).seg-control';
const DARK_ITEM = ':host([data-theme="dark"]).seg-item';
const DARK_ACTIVE = ':host([data-theme="dark"]).seg-item.active';

describe('benchmark segmented control 外观与技能中心统一', () => {
    test('深色轨道、未选中文字、选中项配色与技能中心一致', () => {
        const pairs: Array<[string, string]> = [
            [DARK_TRACK, 'background'],
            [DARK_ITEM, 'color'],
            [DARK_ACTIVE, 'background'],
            [DARK_ACTIVE, 'color']
        ];

        for (const [selector, property] of pairs) {
            const actual = declarations(benchmarkCss, selector)[property];
            const expected = declarations(skillCss, selector)[property];
            expect(expected).toBeTruthy();
            expect(actual).toBe(expected);
        }
    });

    test('深色选中项与轨道有可辨识的色差，且保留选中阴影', () => {
        const track = declarations(benchmarkCss, DARK_TRACK).background;
        const active = declarations(benchmarkCss, DARK_ACTIVE);
        const skillTrack = declarations(skillCss, DARK_TRACK).background;
        const skillActive = declarations(skillCss, DARK_ACTIVE);

        expect(active.background).not.toBe(track);
        expect(active.background).not.toBe(skillTrack);
        expect(active['box-shadow']).toBe(skillActive['box-shadow']);
    });
});
