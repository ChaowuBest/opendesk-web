/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You may use this software according to the terms and conditions of the MulanPSL2.
 */

import { describe, expect, test } from '@jest/globals';
import { getContextMenuPalette } from '../../../renderer/utils/context-menu-theme.js';

describe('context menu theme palette', () => {
    test('uses readable dark colors and dark separators', () => {
        const palette = getContextMenuPalette(true);

        expect(palette.background).toContain('37, 37, 38');
        expect(palette.text).toBe('#e5e7eb');
        expect(palette.separator).toContain('255,255,255');
    });

    test('preserves the light context-menu palette', () => {
        const palette = getContextMenuPalette(false);

        expect(palette.background).toContain('255, 255, 255');
        expect(palette.text).toBe('#1f2937');
    });
});
