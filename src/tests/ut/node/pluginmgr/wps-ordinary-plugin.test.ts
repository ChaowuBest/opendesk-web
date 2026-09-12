import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { getPluginHost } from '../../../../main/applications/pluginmgr/runtime/host.js';
import { getPluginMcpToolsets, getPluginMcpServerStates, disposePluginMcpRuntime } from '../../../../main/applications/pluginmgr/runtime/mcp.js';

const pluginDir = path.resolve('dist/plugins/opendesk-wps-slides');

test('Electron needs no external Node, missing Node fails only non-Electron WPS, and non-Windows setup is skipped', async () => {
    const host = getPluginHost();
    const { default: plugin } = await import(pathToFileURL(path.join(pluginDir, 'index.mjs')).href);
    const executable = Object.getOwnPropertyDescriptor(process, 'execPath')!;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const electron = Object.getOwnPropertyDescriptor(process.versions, 'electron');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wps-electron-setup-'));
    const previousLocalAppData = process.env.LOCALAPPDATA;
    const parentRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
    const pathEntries = Object.entries(process.env).filter(([key]) => key.toLowerCase() === 'path');
    try {
        delete process.versions.electron;
        process.env.LOCALAPPDATA = temp;
        Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
        Object.defineProperty(process, 'execPath', { ...executable, value: 'OpenDesk.exe' });
        for (const [key] of pathEntries) delete process.env[key];
        const entry = await host.activate(plugin, { origin: 'test:missing-node', pluginDir });
        assert.equal(entry.status, 'error');
        assert.match(JSON.stringify(entry.diagnostics), /wps_slides_node_runtime_unavailable/);
        assert.equal(host.listMcpServers().length, 0);
        const control = await host.activate({ id: 'ordinary-control', apiVersion: 1, setup() {} }, { origin: 'test:control' });
        assert.equal(control.status, 'active');
        Object.defineProperty(process.versions, 'electron', { configurable: true, value: '39.0.0' });
        const definitions: any[] = [];
        await plugin.setup({ pluginDir, mcps: { registerServer(definition: any) { definitions.push(definition); } } });
        assert.equal(definitions.length, 1);
        assert.equal(definitions[0].command, 'OpenDesk.exe');
        assert.equal(definitions[0].env.OPENDESK_WPS_MCP_COMMAND, 'OpenDesk.exe');
        assert.equal(definitions[0].env.ELECTRON_RUN_AS_NODE, '1');
        assert.equal(process.env.ELECTRON_RUN_AS_NODE, parentRunAsNode);
        for (const value of ['linux', 'darwin']) {
            Object.defineProperty(process, 'platform', { ...platform, value });
            let called = false;
            await plugin.setup({ mcps: { registerServer() { called = true; } } });
            assert.equal(called, false);
        }
    } finally {
        Object.defineProperty(process, 'execPath', executable);
        Object.defineProperty(process, 'platform', platform);
        if (electron) Object.defineProperty(process.versions, 'electron', electron);
        else delete process.versions.electron;
        if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
        else process.env.LOCALAPPDATA = previousLocalAppData;
        for (const [key, value] of pathEntries) process.env[key] = value;
        await host.dispose();
        await disposePluginMcpRuntime();
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test('ordinary WPS Plugin discovers seven schemas, rejects missing ref, and reloads', {
    skip: process.platform !== 'win32', timeout: 360_000
}, async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wps-ordinary-e2e-'));
    const previous = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = temp;
    const host = getPluginHost();
    const { default: plugin } = await import(pathToFileURL(path.join(pluginDir, 'index.mjs')).href);
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
        await host.deactivate(plugin.id);
        assert.equal((await getPluginMcpServerStates()).length, 0);
        await host.activate(plugin, { origin: 'test:ordinary-wps-reload', pluginDir, configDir: temp });
        assert.equal((await getPluginMcpToolsets())[0].tools.size, 7);
    } finally {
        await host.dispose();
        await disposePluginMcpRuntime();
        if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous;
        const report = path.join(temp, 'evidence.json');
        fs.writeFileSync(report, JSON.stringify(evidence, null, 2));
        console.log(`WPS ordinary evidence: ${report}`);
    }
});
