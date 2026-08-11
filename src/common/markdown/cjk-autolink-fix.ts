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

import type { MarkedExtension, Tokens } from 'marked';

/**
 * CJK punctuation that should terminate an autolink URL.
 *
 * Do not include CJK letters or ideographs here: those are legal in IRI paths
 * and query values. The selected ranges cover CJK and fullwidth punctuation
 * such as 。，、！？：；（）《》【】.
 */
const CJK_BOUNDARY_RE = /[\u3000-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]/;

/**
 * Marked extension that fixes GFM autolink incorrectly including trailing CJK text.
 *
 * marked's `url` tokenizer uses `[^\s<]*` which greedily consumes CJK characters
 * that follow a URL without whitespace. The `_backpedal` regex only strips ASCII
 * punctuation, leaving CJK punctuation and ideographs in the URL — producing
 * invalid hrefs like `https://example.com%E3%80%82%E9%9C%80%E8%A6%81...` that
 * cause grey-screen crashes when clicked in Electron.
 *
 * This extension overrides the `url` tokenizer to truncate the matched URL at
 * the first CJK punctuation character, so `https://example.com。这是中文` produces a link
 * to `https://example.com` followed by plain text `。这是中文`.
 */
export const cjkAutolinkFix: MarkedExtension = {
    tokenizer: {
        url(src: string): Tokens.Link | undefined {
            const match = this.rules.inline.url.exec(src);
            if (!match) return undefined;

            let text: string;
            let href: string;

            if (match[2] === '@') {
                // Email autolink — no CJK truncation needed
                text = match[0];
                href = 'mailto:' + text;
            } else {
                // Truncate at the first CJK punctuation character *before* backpedal,
                // so that any trailing ASCII punctuation after the CJK text
                // is properly stripped by the backpedal in the next step.
                const cjkIndex = match[0].search(CJK_BOUNDARY_RE);
                if (cjkIndex > 0) {
                    match[0] = match[0].slice(0, cjkIndex);
                }

                // Apply marked's default backpedal to strip trailing ASCII punctuation
                let prev: string;
                do {
                    prev = match[0];
                    match[0] = this.rules.inline._backpedal.exec(match[0])?.[0] ?? '';
                } while (prev !== match[0]);

                text = match[0];
                href = match[1] === 'www.' ? 'http://' + match[0] : match[0];
            }

            return {
                type: 'link',
                raw: match[0],
                text,
                href,
                tokens: [{ type: 'text', raw: text, text }]
            };
        }
    }
};
