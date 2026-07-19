/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You may use this software according to the terms and conditions of the MulanPSL2.
 */

export interface ContextMenuPalette {
    background: string;
    border: string;
    shadow: string;
    text: string;
    secondary: string;
    separator: string;
}

export function getContextMenuPalette(dark: boolean): ContextMenuPalette {
    return dark
        ? {
              background: 'rgba(37, 37, 38, 0.94)',
              border: 'rgba(255, 255, 255, 0.14)',
              shadow: '0 12px 40px -8px rgba(0,0,0,0.55), 0 0 0 0.5px rgba(255,255,255,0.06)',
              text: '#e5e7eb',
              secondary: '#a1a1aa',
              separator: 'rgba(255,255,255,0.12)'
          }
        : {
              background: 'rgba(255, 255, 255, 0.88)',
              border: 'rgba(0, 0, 0, 0.08)',
              shadow: '0 12px 40px -8px rgba(0,0,0,0.15), 0 0 0 0.5px rgba(0,0,0,0.04), inset 0 0.5px 0 rgba(255,255,255,0.5)',
              text: '#1f2937',
              secondary: '#6b7280',
              separator: 'rgba(0,0,0,0.08)'
          };
}
