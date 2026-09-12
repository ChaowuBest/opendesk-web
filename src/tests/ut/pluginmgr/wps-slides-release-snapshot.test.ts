import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
const WPS_SLIDES_SCENE_TOOL_NAMES = [
    'wps_ppt_capture_scene', 'wps_ppt_get_scene_overview', 'wps_ppt_query_scene',
    'wps_ppt_continue_scene_query', 'wps_ppt_submit_semantic_overlay',
    'wps_ppt_execute_scene_operations', 'wps_ppt_manage_presentations'
];

const RELEASE_ARCHIVE_PATH = path.resolve(
    process.cwd(),
    'resources/plugins/opendesk-wps-slides/opendesk-wps-slides.zip'
);
const BASELINE_PATH = path.resolve(process.cwd(), 'src/tests/resources/wps-slides-target-b-baseline.json');

function normalizedSha256(content: string): string {
    return createHash('sha256').update(content.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function releaseSkill(): string {
    const entry = new AdmZip(RELEASE_ARCHIVE_PATH).getEntry('skills/opendesk-wps-slides/SKILL.md');
    if (!entry) throw new Error('packaged WPS Skill is missing');
    return entry.getData().toString('utf8');
}

describe('WPS Slides Target B plugin snapshot', () => {
    test('is supplied by the builtin plugin with the approved semantic baseline', () => {
        const skill = releaseSkill();
        const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as {
            upstreamCanonicalSha256: string;
            releaseSnapshotSha256: string;
            sceneSchemaVersions: string[];
            operationDefinitionVersion: string;
            approvedSemanticDifferences: string[];
        };

        expect(baseline.upstreamCanonicalSha256).toHaveLength(64);
        expect(normalizedSha256(skill)).toBe(baseline.releaseSnapshotSha256);
        expect(baseline.sceneSchemaVersions).toEqual(['scene-v2', 'presentation-scene-v1']);
        expect(baseline.operationDefinitionVersion).toBe('scene-operation-definitions-v2');
        expect(baseline.approvedSemanticDifferences).toContain('whole-deck-template-layout-reuse');
    });

    test('preserves all seven tools and the complete canonical target rules', () => {
        const skill = releaseSkill();

        for (const toolName of WPS_SLIDES_SCENE_TOOL_NAMES) expect(skill).toContain(toolName);
        expect(skill).toContain('operationTargetTemplates');
        expect(skill).toContain('directRoleTargets');
        expect(skill).toContain('operationTargets');
        expect(skill).toContain('`editPlan.operations[*].targets` is always an array');
        expect(skill).toContain('Never assign a target object directly to `targets`');
        expect(skill).toContain('treat all of its slides as candidate layouts');
        expect(skill).toContain('`create_from_current_template` with this request\'s `logicalRequestRef`');
        expect(skill).toContain('duplicate the appropriate exact source slide with its advertised `sourceSlideRef`');
        expect(skill).toContain('Do not delete all candidate template slides and replace them with rebuilt pages');
        expect(skill).toContain('Only this authority-bound Slide v2 Scene may advertise `delete_entities` targets');
        expect(skill).toContain('never submit a child `nodeId` against the presentation Scene');
        expect(skill).toContain('do not silently split it into per-slide transactions');
        expect(skill).toContain('always use `view="overview"` and `depth=0`');
        expect(skill).toContain('`taskPlanId` identifies the logical task');
        expect(skill).toContain('`editPlan.planId` identifies one atomic Scene transaction');
        expect(skill).toContain('under the unchanged plan may reuse `taskPlanId` alone');
    });

    test('preserves the three approved old Prompt behaviors', () => {
        const skill = releaseSkill();

        expect(skill).toContain('do not let the unavailable later measurement block an earlier operation');
        expect(skill).toContain('account for every user clause before writing');
        expect(skill).toContain(
            'Do not repeat coordinates, internal IDs, operation parameters, QA fields, or receipt details'
        );
        expect(skill).toContain(
            'Do not expose receipt state names, `wroteToWps`, rollback flags, assertion names, measured bounds'
        );
        expect(skill).toContain(
            'Do not mention Scene v2, tool names, captures, queries, receipts, readback, verification'
        );
        expect(skill).toContain('Never infer or estimate a transaction count for the final response.');
        expect(skill).toContain('do not repeat list/capture calls');
        expect(skill).toContain('do not use terminal or file tools to diagnose or bypass it');
    });

    test('does not package runtime authority or machine-local state', () => {
        const skill = releaseSkill();

        expect(skill).not.toMatch(/logicalRequestRef\s*[:=]/);
        expect(skill).not.toMatch(/authorizationRef\s*[:=]/);
        expect(skill).not.toMatch(/templateRef\s*[:=]/);
        expect(skill).not.toContain('D:\\');
        expect(skill).not.toContain('WPS_PPT_SCENE_DIR=');
    });
});
