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

export type { RegistrySkill, SearchResult, SearchOptions, RegistryFilterDef } from './base.js';
export { SkillRegistryBase } from './base.js';

import { type SearchOptions, type SearchResult, type SkillRegistryBase } from './base.js';
import { ClawHubRegistry } from './clawhub.js';
import { MatrixRegistry } from './matrix.js';
import { ModelScopeRegistry } from './modelscope.js';
import { SkillHubRegistry } from './skillhub.js';
import { Skill0Registry } from './skill0.js';
import { SkillsMPRegistry } from './skillsmp.js';

export { ClawHubRegistry } from './clawhub.js';
export { MatrixRegistry } from './matrix.js';
export { ModelScopeRegistry } from './modelscope.js';
export { SkillHubRegistry } from './skillhub.js';
export { Skill0Registry } from './skill0.js';
export { SkillsMPRegistry } from './skillsmp.js';

const clawhub = new ClawHubRegistry();
const matrix = new MatrixRegistry();
const modelscope = new ModelScopeRegistry();
const skillhub = new SkillHubRegistry();
const skill0 = new Skill0Registry();
const skillsmp = new SkillsMPRegistry();

export const allRegistries: SkillRegistryBase[] = [matrix, clawhub, modelscope, skillhub, skill0, skillsmp];

export function getRegistry(id: string): SkillRegistryBase | undefined {
    return allRegistries.find((r) => r.id === id);
}

export async function searchRegistry(registryId: string, opts: SearchOptions = {}): Promise<SearchResult> {
    const registry = getRegistry(registryId);
    if (!registry) throw new Error(`未知 Registry: ${registryId}`);
    return registry.search(opts);
}

export function getRegistriesInfo(): {
    id: string;
    label: string;
    icon: string;
    slogan: string;
    filters: import('./base.js').RegistryFilterDef[];
}[] {
    return allRegistries
        .filter((r) => ['matrix', 'clawhub', 'skillhub', 'modelscope'].includes(r.id))
        .map((r) => ({ id: r.id, label: r.label, icon: r.icon, slogan: r.slogan, filters: r.filters }));
}

export function getInstallMethod(installUrl: string): string {
    if (!installUrl || typeof installUrl !== 'string') return 'zip';
    for (const reg of allRegistries) {
        if (reg.matchesInstallUrl(installUrl)) return reg.id;
    }
    if (installUrl.includes('github.com') && installUrl.includes('/tree/')) return 'github';
    if (/github\.com\/[^/]+\/[^/]+/.test(installUrl)) return 'github';
    return 'zip';
}

export function parseInstallUrl(installUrl: string): { slug: string; version?: string } | null {
    if (!installUrl || typeof installUrl !== 'string') return null;
    for (const reg of allRegistries) {
        if (reg.matchesInstallUrl(installUrl)) {
            return reg.parseInstallUrl(installUrl);
        }
    }
    return null;
}
