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

import type { AgentFlowDetail } from '../common.js';

export function parseFlowMentions(text: string | undefined, flow: AgentFlowDetail): string[] {
    const source = text ?? '';
    const markers = [...source.matchAll(/(?:^|[\s(（[【])@/gu)].map((match) => (match.index ?? 0) + match[0].length);
    const knownNames = [...flow.members.map((member) => (member.missing ? undefined : member.name)).filter(Boolean)]
        .filter((name, index, names): name is string => Boolean(name) && names.indexOf(name) === index)
        .sort((left, right) => right.length - left.length);
    const tokens = markers.map((start) => {
        const remainder = source.slice(start);
        const matched = knownNames.find((name) => {
            if (!remainder.startsWith(name)) return false;
            const boundary = remainder.slice(name.length, name.length + 1);
            return !boundary || /[\s,，。.!！?？:：;；、)）\]】]/u.test(boundary);
        });
        return matched ?? remainder.split(/[\s@,，。.!！?？:：;；、)）\]】]/u, 1)[0];
    });
    const memberMatches = tokens.map((token) =>
        flow.members.filter((member) => !member.missing && member.name === token)
    );
    // Mentions carry business meaning only; unknown and ambiguous names retain their original text.
    return [...new Set(memberMatches.flatMap((matches) => (matches.length === 1 ? [matches[0].staffId] : [])))];
}
