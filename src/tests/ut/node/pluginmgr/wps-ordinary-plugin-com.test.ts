import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { getPluginHost } from '../../../../main/applications/pluginmgr/runtime/host.js';
import { getPluginMcpToolsets, getPluginMcpServerStates, disposePluginMcpRuntime } from '../../../../main/applications/pluginmgr/runtime/mcp.js';

const pluginDir = path.resolve('dist/plugins/opendesk-wps-slides');
const real = process.env.WPS_ORDINARY_REAL_E2E === '1';

test('real WPS creates, replays, saves and copies a template through ordinary Plugin MCP', {
    skip: process.platform !== 'win32' || !real, timeout: 360_000
}, async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wps-ordinary-e2e-'));
    const previous = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = temp;
    const host = getPluginHost();
    const { default: plugin } = await import(pathToFileURL(path.join(pluginDir, 'index.mjs')).href);
    const opened = new Set<string>();
    let tools: Map<string, any>;
    const evidence: any[] = [];
    async function call(name: string, args: Record<string, unknown>, success = true) {
        const result = await tools.get(`wps_office__wps_ppt_${name}`).execute(
            name === 'manage_presentations' ? { request: args } : args
        );
        const output = String(result.result);
        const start = output.indexOf('{');
        let data: any;
        if (start >= 0) {
            try { data = JSON.parse(output.slice(start)); } catch { /* Error envelopes may append a second object. */ }
        }
        if (success) {
            assert.equal(result.status, 'success', output);
            assert.ok(data, output);
            assert.ok(!/PPT .* failed|"isError":true/.test(output), output);
        }
        evidence.push({ name, args, output, status: result.status });
        return { data, output };
    }
    try {
        const activated = await host.activate(plugin, { origin: 'test:ordinary-wps', pluginDir, configDir: temp });
        assert.equal(activated.status, 'active', JSON.stringify(activated.diagnostics));
        const sets = await getPluginMcpToolsets();
        tools = sets[0].tools;
        assert.equal(tools.size, 7);
        const states = await getPluginMcpServerStates();
        assert.equal(states.length, 1);
        assert.equal(states[0].providerId, 'pluginMgr');
        assert.equal(states[0].status, 'connected');
        for (const tool of tools.values()) {
            assert.ok(Object.keys(tool.getParameters?.() ?? tool.params).length);
        }
        const missing = await call('manage_presentations', { action: 'create_from_current_template' }, false);
        assert.match(missing.output, /logical_request_ref_required_for_template_creation/);
        if (real) {
            const created = await call('manage_presentations', { action: 'create' });
            const ref = created.data.presentationRef;
            opened.add(ref);
            let captured = (await call('capture_scene', { scope: 'presentation', presentationRef: ref, includeScreenshot: false })).data;
            const logicalRequestRef = randomUUID();
            let firstPlan: any;
            for (let batch = 0; batch < 2; batch++) {
                const snapshot = captured.snapshot ?? captured;
                const overview = captured.overview ?? captured;
                const count = overview.slides?.length ?? 0;
                const editPlan = {
                    planId: randomUUID(), sceneId: snapshot.sceneId,
                    baseSceneVersion: snapshot.sceneVersion,
                    operationDefinitionVersion: snapshot.operationDefinitionVersion ?? 'scene-operation-definitions-v2',
                    operations: [{ operationId: `create-${batch}`, op: 'create_entities', targets: [{ presentationRef: ref }],
                        args: { entities: [{ clientRef: `page-${batch}`, entityClass: 'slide', insertAt: count + 1 }] } }]
                };
                const result = await call('execute_scene_operations', { logicalRequestRef, editPlan });
                assert.equal(result.data.state, 'accepted', result.output);
                if (!batch) {
                    firstPlan = editPlan;
                    const replay = await call('execute_scene_operations', { logicalRequestRef, editPlan: firstPlan });
                    assert.equal(replay.data.replayed, true, replay.output);
                    assert.equal(replay.data.wroteToWps, false);
                }
                captured = (await call('capture_scene', { scope: 'presentation', presentationRef: ref, includeScreenshot: false })).data;
                assert.equal((captured.overview ?? captured).slides.length, count + 1);
            }
            await call('manage_presentations', { action: 'save_as', presentationRef: ref, filePath: path.join(temp, 'template.pptx') });
            const templateHash = () => createHash('sha256').update(fs.readFileSync(path.join(temp, 'template.pptx'))).digest('hex');
            const originalTemplateHash = templateHash();
            const templateRequestRef = randomUUID();
            const working = await call('manage_presentations', { action: 'create_from_current_template', logicalRequestRef: templateRequestRef });
            opened.add(working.data.presentationRef);
            assert.notEqual(working.data.presentationRef, ref);
            const replay = await call('manage_presentations', { action: 'create_from_current_template', logicalRequestRef: templateRequestRef });
            assert.equal(replay.data.presentationRef, working.data.presentationRef);
            for (let batch = 0; batch < 2; batch++) {
                const before = (await call('capture_scene', { scope: 'presentation', presentationRef: working.data.presentationRef, includeScreenshot: false })).data;
                const snapshot = before.snapshot ?? before;
                const count = (before.overview ?? before).slides.length;
                const result = await call('execute_scene_operations', {
                    logicalRequestRef: templateRequestRef,
                    editPlan: {
                        planId: randomUUID(), sceneId: snapshot.sceneId, baseSceneVersion: snapshot.sceneVersion,
                        operationDefinitionVersion: snapshot.operationDefinitionVersion ?? 'scene-operation-definitions-v2',
                        operations: [{ operationId: `template-${batch}`, op: 'create_entities', targets: [{ presentationRef: working.data.presentationRef }],
                            args: { entities: [{ clientRef: `template-page-${batch}`, entityClass: 'slide', insertAt: count + 1 }] } }]
                    }
                });
                assert.equal(result.data.state, 'accepted', result.output);
                const after = (await call('capture_scene', { scope: 'presentation', presentationRef: working.data.presentationRef, includeScreenshot: false })).data;
                assert.equal((after.overview ?? after).slides.length, count + 1);
            }
            assert.equal(templateHash(), originalTemplateHash);
            await call('manage_presentations', { action: 'save_as', presentationRef: working.data.presentationRef, filePath: path.join(temp, 'overwrite.pptx') });
            await call('manage_presentations', { action: 'save_as', presentationRef: working.data.presentationRef, filePath: path.join(temp, 'overwrite.pptx'), overwrite: true });
            await call('manage_presentations', { action: 'close', presentationRef: working.data.presentationRef, discardChanges: true });
            opened.delete(working.data.presentationRef);
            for (const presentationRef of opened) {
                await call('manage_presentations', { action: 'save', presentationRef });
                await call('manage_presentations', { action: 'close', presentationRef });
            }
            opened.clear();
        }
        await host.deactivate(plugin.id);
        assert.equal((await getPluginMcpServerStates()).length, 0);
        await host.activate(plugin, { origin: 'test:ordinary-wps-reload', pluginDir, configDir: temp });
        assert.equal((await getPluginMcpToolsets())[0].tools.size, 7);
    } finally {
        for (const presentationRef of opened) {
            const filePath = path.join(temp, `saved-${randomUUID()}.pptx`);
            await call('manage_presentations', { action: 'save_as', presentationRef, filePath }).then(async () => {
                await call('manage_presentations', { action: 'close', presentationRef });
            }).catch((error) => evidence.push({ cleanupError: String(error), presentationRef }));
        }
        await host.dispose();
        await disposePluginMcpRuntime();
        if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous;
        const report = path.join(temp, 'evidence.json');
        fs.writeFileSync(report, JSON.stringify(evidence, null, 2));
        console.log(`WPS ordinary evidence: ${report}`);
    }
});
