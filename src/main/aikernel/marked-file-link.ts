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

import fs from 'fs';
import path from 'path';
import { escapeHtml } from '../../common/utils/escape.js';
import type { MarkedExtension, Tokens } from 'marked';

// ── Workspace context ──────────────────────────────────────────────

let _renderWorkspace: string | null = null;

export function setRenderWorkspace(ws: string | null): void {
    _renderWorkspace = ws;
}

export function getRenderWorkspace(): string | null {
    return _renderWorkspace;
}

// ── File path resolution ───────────────────────────────────────────

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Resolve a potentially relative path against the current render workspace.
 * Returns the absolute path if the file exists, otherwise null.
 */
export function resolveFilePath(rawPath: string): string | null {
    if (!rawPath || URL_SCHEME_RE.test(rawPath) || rawPath.startsWith('#')) {
        return null;
    }

    let absPath: string;
    if (path.isAbsolute(rawPath)) {
        absPath = rawPath;
    } else if (_renderWorkspace) {
        absPath = path.resolve(_renderWorkspace, rawPath);
    } else {
        absPath = path.resolve(rawPath);
    }

    try {
        return fs.existsSync(absPath) ? absPath : null;
    } catch {
        return null;
    }
}

// ── Regex for file path detection ──────────────────────────────────

// Characters that should not appear inside a file path token
const EXCLUDED = '\\s`|"\'<>()\\[\\]{};:,!?\\\\';

// Match a potential file path at the start of src:
// - Must contain at least one '/'
// - Must end with a file extension (.ext)
// - Negative lookahead to skip URL schemes (https://, ftp://, etc.)
// - Allows spaces between path segments (e.g. "/Users/My Documents/file.ts")
//   The tokenizer uses progressive shortening to handle false positives from
//   greedy space matching (e.g. "src/a.ts and src/b.ts" -> tries full match
//   first, then shortens by removing space-separated tail segments)
const FILE_PATH_RE = new RegExp(
    `^(?![a-z][a-z0-9+.-]*://)[^${EXCLUDED}]+(?: [^${EXCLUDED}]+)*/[^${EXCLUDED}]*(?: [^${EXCLUDED}]+)*\\.[A-Za-z0-9]+`,
    'i'
);

// Search pattern for start() – finds the first potential file path anywhere in src
const FILE_PATH_SEARCH_RE = new RegExp(
    `[^${EXCLUDED}]+(?: [^${EXCLUDED}]+)*/[^${EXCLUDED}]*(?: [^${EXCLUDED}]+)*\\.[A-Za-z0-9]`
);

// ── Pill HTML ──────────────────────────────────────────────────────

const FILE_ICON_SVG =
    '<svg class="od-file-pill-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor">' +
    '<path d="M9 1.5V5h3.5L9 1.5zM4 1h4v4.5a.5.5 0 0 0 .5.5H13v9a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-13a.5.5 0 0 1 .5-.5z"/>' +
    '</svg>';

function buildPillHTML(filePath: string, label: string): string {
    return (
        `<a class="od-file-pill" data-open-preview="${escapeHtml(filePath)}" title="${escapeHtml(filePath)}">` +
        `${FILE_ICON_SVG}<span class="od-file-pill-name">${escapeHtml(label)}</span></a>`
    );
}

// ── Marked extension ───────────────────────────────────────────────

/**
 * Marked extension that:
 * 1. Auto-detects file paths in plain text and converts them to clickable pills
 * 2. Renders markdown links pointing to real files as pills
 * 3. Renders inline code spans (backticks) whose content is a real file path as pills
 *
 * Requires `setRenderWorkspace()` to be called before parsing for relative path resolution.
 */
export const fileLinkExtension: MarkedExtension = {
    extensions: [
        {
            name: 'fileLink',
            level: 'inline',
            start(src: string): number | undefined {
                const match = src.match(FILE_PATH_SEARCH_RE);
                return match?.index;
            },
            tokenizer(src: string) {
                const match = FILE_PATH_RE.exec(src);
                if (!match) return undefined;

                const rawPath = match[0];

                // Try the full match first, then progressively shorten by
                // removing space-separated tail segments. This handles cases
                // where greedy space matching captures too much, e.g.
                // "src/a.ts and src/b.ts" -> tries full, then "src/a.ts and",
                // then "src/a.ts" (which exists).
                const segments = rawPath.split(' ');
                while (segments.length > 0) {
                    const candidate = segments.join(' ');
                    const absPath = resolveFilePath(candidate);
                    if (absPath) {
                        return {
                            type: 'fileLink',
                            raw: candidate,
                            text: candidate,
                            filePath: absPath,
                            tokens: []
                        };
                    }
                    if (segments.length === 1) break;
                    segments.pop();
                }

                return undefined;
            },
            renderer(token) {
                const filePath = (token as { filePath: string }).filePath;
                return buildPillHTML(filePath, path.basename(filePath));
            }
        }
    ],
    renderer: {
        link(
            this: { parser: { parseInline: (tokens: unknown[]) => string } },
            { href, tokens }: Tokens.Link
        ): string | false {
            // Markdown link hrefs may be URL-encoded (e.g. %20 for space)
            let decodedHref = href;
            try {
                decodedHref = decodeURIComponent(href);
            } catch {
                // ignore malformed URI – use raw href
            }
            const absPath = resolveFilePath(decodedHref);
            if (absPath) {
                const label = this.parser.parseInline(tokens);
                return buildPillHTML(absPath, label || path.basename(absPath));
            }
            return false;
        },
        codespan({ text }: Tokens.Codespan): string | false {
            const absPath = resolveFilePath(text);
            if (absPath) {
                return buildPillHTML(absPath, path.basename(absPath));
            }
            return false;
        }
    }
};
