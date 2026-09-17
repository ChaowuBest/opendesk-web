import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import { AgentOfficeRepository } from '../../../../main/applications/agentoffice/repository.js';
import { createStaffPermissionEnforcer } from '../../../../main/applications/agentoffice/permission.js';

function createRepository(): { root: string; repository: AgentOfficeRepository } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentoffice-test-'));
    return { root, repository: new AgentOfficeRepository(root) };
}

test('creates an instance without eagerly creating workspace', (context) => {
    const { root, repository } = createRepository();
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const staff = repository.createStaff({
        name: 'Ada',
        vendor_name: 'OpenDesk',
        title: 'Researcher',
        specialties: ['research']
    });
    assert.equal(staff.name, 'Ada');
    assert.equal(staff.trigger_interval, 'never');
    assert.equal(staff.permission.network_access, true);
    assert.equal(fs.existsSync(repository.workspaceDirectory(staff.id)), false);
    assert.equal(repository.ensureWorkspace(staff.id), repository.workspaceDirectory(staff.id));
    assert.equal(fs.existsSync(repository.workspaceDirectory(staff.id)), true);
    assert.match(fs.readFileSync(path.join(repository.workspaceDirectory(staff.id), 'MEMORY.md'), 'utf8'), /^#/);
});

test('claims configured staff triggers once per interval and resets the clock when humans change it', (context) => {
    const { root, repository } = createRepository();
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const staff = repository.createStaff({
        name: 'Ada',
        vendor_name: 'OpenDesk',
        title: 'Researcher',
        specialties: [],
        trigger_interval: '5m'
    });
    const metadataPath = path.join(repository.protectedDirectory(staff.id), 'metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as { last_triggered_at: string };
    const baseline = new Date(metadata.last_triggered_at).getTime();
    const expectedTrigger = {
        staff_id: staff.id,
        triggered_at: new Date(baseline + 5 * 60 * 1000).toISOString(),
        previous_triggered_at: metadata.last_triggered_at
    };
    const originalReadMessages = repository.readMessages;
    repository.readMessages = () => {
        throw new Error('trigger polling must not read message history');
    };
    context.after(() => {
        repository.readMessages = originalReadMessages;
    });

    assert.deepEqual(repository.claimDueTriggers(new Date(baseline + 4 * 60 * 1000).toISOString()), []);
    assert.deepEqual(repository.claimDueTriggers(expectedTrigger.triggered_at), [expectedTrigger]);
    repository.releaseTriggerClaim(expectedTrigger);
    assert.deepEqual(repository.claimDueTriggers(expectedTrigger.triggered_at), [expectedTrigger]);
    assert.deepEqual(repository.claimDueTriggers(new Date(baseline + 6 * 60 * 1000).toISOString()), []);
    repository.readMessages = originalReadMessages;

    const updated = repository.updateStaff(staff.id, {
        definition: {
            name: staff.name,
            vendor_name: staff.vendor_name,
            title: staff.title,
            specialties: staff.specialties,
            trigger_interval: 'never'
        }
    });
    assert.equal(updated.trigger_interval, 'never');
    assert.deepEqual(repository.claimDueTriggers(new Date(baseline + 24 * 60 * 60 * 1000).toISOString()), []);
});

test('stores the staff model in protected instance metadata and can clear it', (context) => {
    const { root, repository } = createRepository();
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const staff = repository.createStaff({
        name: 'Ada',
        vendor_name: 'OpenDesk',
        title: 'Researcher',
        specialties: []
    });

    const configured = repository.updateStaff(staff.id, { model: 'chat-model' });
    assert.equal(configured.model, 'chat-model');
    assert.equal(
        JSON.parse(fs.readFileSync(path.join(repository.protectedDirectory(staff.id), 'metadata.json'), 'utf8')).model,
        'chat-model'
    );
    assert.equal(
        JSON.parse(fs.readFileSync(path.join(repository.staffDirectory(staff.id), 'staff.json'), 'utf8')).model,
        undefined
    );

    const cleared = repository.updateStaff(staff.id, { model: null });
    assert.equal(cleared.model, undefined);
});

test('staff skill summaries expose Skill Center-style metadata and keep the directory identity', (context) => {
    const { root, repository } = createRepository();
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const staff = repository.createStaff({
        name: 'Ada',
        vendor_name: 'OpenDesk',
        title: 'Researcher',
        specialties: []
    });
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'agentoffice-skill-source-'));
    context.after(() => fs.rmSync(source, { recursive: true, force: true }));
    const skillDirectory = path.join(source, 'research-helper');
    fs.mkdirSync(skillDirectory);
    fs.writeFileSync(
        path.join(skillDirectory, 'SKILL.md'),
        '---\nname: Research Helper\ndescription: Finds and summarizes evidence\nlicense: MIT\n---\n\n# Instructions\n\nCheck sources.\n'
    );

    repository.addSkill(staff.id, skillDirectory);

    assert.deepEqual(repository.listSkills(staff.id), [
        {
            name: 'Research Helper',
            directory_name: 'research-helper',
            path: 'agent/skills/research-helper',
            description: 'Finds and summarizes evidence',
            body: '# Instructions\n\nCheck sources.',
            license: 'MIT',
            compatibility: undefined,
            allowed_tools: undefined
        }
    ]);
});

test('batch skill discovery finds nested directories and zip packages without following unrelated files', (context) => {
    const { root, repository } = createRepository();
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentoffice-skill-scan-'));
    context.after(() => fs.rmSync(scanRoot, { recursive: true, force: true }));
    const nestedSkill = path.join(scanRoot, 'group', 'directory-skill');
    fs.mkdirSync(nestedSkill, { recursive: true });
    fs.writeFileSync(path.join(nestedSkill, 'SKILL.md'), '# Directory Skill\n');
    const zipPath = path.join(scanRoot, 'zip-skill.zip');
    const zip = new AdmZip();
    zip.addFile('zip-skill/SKILL.md', Buffer.from('# ZIP Skill\n'));
    zip.writeZip(zipPath);
    fs.writeFileSync(path.join(scanRoot, 'not-a-skill.zip'), 'invalid zip');

    const candidates = repository.scanSkillSources(scanRoot).sort((left, right) => left.name.localeCompare(right.name));

    assert.deepEqual(candidates, [
        { path: nestedSkill, name: 'directory-skill', type: 'directory' },
        { path: zipPath, name: 'zip-skill.zip', type: 'zip' }
    ]);
});

test('a nested ZIP candidate discovered by batch scan can also be installed', (context) => {
    const { root, repository } = createRepository();
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const staff = repository.createStaff({
        name: 'Ada',
        vendor_name: 'OpenDesk',
        title: 'Researcher',
        specialties: []
    });
    const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentoffice-nested-zip-'));
    context.after(() => fs.rmSync(scanRoot, { recursive: true, force: true }));
    const zipPath = path.join(scanRoot, 'nested-skill.zip');
    const zip = new AdmZip();
    zip.addFile('package/content/nested-skill/SKILL.md', Buffer.from('# Nested Skill\n'));
    zip.writeZip(zipPath);

    assert.deepEqual(repository.scanSkillSources(scanRoot), [{ path: zipPath, name: 'nested-skill.zip', type: 'zip' }]);
    assert.deepEqual(repository.addSkill(staff.id, zipPath), {
        name: 'nested-skill',
        path: 'agent/skills/nested-skill'
    });
});

test('stores a cropped PNG portrait from the renderer and can remove it', (context) => {
    const { root, repository } = createRepository();
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const staff = repository.createStaff({
        name: 'Ada',
        vendor_name: 'OpenDesk',
        title: 'Researcher',
        specialties: []
    });
    const pngBytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');

    const updated = repository.updateStaff(staff.id, {
        portrait_data_uri: `data:image/png;base64,${pngBytes.toString('base64')}`
    });
    const portraitPath = path.join(repository.staffDirectory(staff.id), 'agent', 'portrait.png');

    assert.equal(updated.portrait_url, `agentoffice://resource/${staff.id}/portrait`);
    assert.deepEqual(fs.readFileSync(portraitPath), pngBytes);

    const removed = repository.updateStaff(staff.id, { portrait_data_uri: null });
    assert.equal(removed.portrait_url, undefined);
    assert.equal(fs.existsSync(portraitPath), false);
});

test('installs preset staff once and respects later user deletion', (context) => {
    const { root, repository } = createRepository();
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const presets = [
        {
            key: 'research-v1',
            definition: {
                name: 'Avery',
                vendor_name: 'OpenDesk',
                title: 'Research Analyst',
                specialties: ['Research']
            },
            agents_md: '# Research Analyst'
        },
        {
            key: 'writer-v1',
            definition: {
                name: 'Casey',
                vendor_name: 'OpenDesk',
                title: 'Content Writer',
                specialties: ['Writing']
            },
            agents_md: '# Content Writer'
        }
    ];

    const installed = repository.ensurePresetStaffs(presets);
    assert.equal(installed.length, 2);
    assert.equal(repository.listStaffs().length, 2);
    assert.equal(repository.getStaffDetail(installed[0].id).agents_md, '# Research Analyst');
    assert.equal(repository.ensurePresetStaffs(presets).length, 0);
    assert.equal(repository.listStaffs().length, 2);

    repository.deleteStaff(installed[0].id);
    assert.equal(repository.ensurePresetStaffs(presets).length, 0);
    assert.equal(repository.listStaffs().length, 1);
});

test('history returns chronological pages with query-bound cursors', (context) => {
    const { root, repository } = createRepository();
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const staff = repository.createStaff({
        name: 'Ada',
        vendor_name: 'OpenDesk',
        title: 'Researcher',
        specialties: []
    });
    for (let index = 0; index < 5; index++) {
        repository.appendMessage(staff.id, {
            id: `message-${index}`,
            role: index % 2 === 0 ? 'user' : 'assistant',
            task_id: `task-${index}`,
            created_at: new Date(Date.UTC(2026, 6, index + 1)).toISOString(),
            content: [{ type: 'text', text: `message ${index}` }]
        });
    }

    const first = repository.getHistory(staff.id, { mode: 'recent', limit: 2 });
    assert.deepEqual(
        first.messages.map((message) => message.id),
        ['message-3', 'message-4']
    );
    assert.equal(first.has_more, true);
    const second = repository.getHistory(staff.id, { mode: 'recent', limit: 2, cursor: first.next_cursor });
    assert.deepEqual(
        second.messages.map((message) => message.id),
        ['message-1', 'message-2']
    );
    assert.throws(
        () => repository.getHistory(staff.id, { mode: 'recent', limit: 3, cursor: first.next_cursor }),
        Error
    );
    const forgedPayload = JSON.parse(Buffer.from(first.next_cursor!, 'base64url').toString('utf8')) as {
        offset: number;
    };
    forgedPayload.offset = 0;
    const forgedCursor = Buffer.from(JSON.stringify(forgedPayload), 'utf8').toString('base64url');
    assert.throws(() => repository.getHistory(staff.id, { mode: 'recent', limit: 2, cursor: forgedCursor }), Error);

    const range = repository.getHistory(staff.id, {
        mode: 'time_range',
        start_time: '2026-07-02',
        end_time: '2026-07-04'
    });
    assert.deepEqual(
        range.messages.map((message) => message.id),
        ['message-1', 'message-2', 'message-3']
    );
});

test('export contains definition only and import creates a fresh instance', (context) => {
    const { root, repository } = createRepository();
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const staff = repository.createStaff({
        name: 'Ada',
        vendor_name: 'OpenDesk',
        title: 'Researcher',
        specialties: [],
        trigger_interval: '30m'
    });
    repository.ensureWorkspace(staff.id);
    fs.writeFileSync(path.join(repository.workspaceDirectory(staff.id), 'secret.txt'), 'private');
    const zipPath = path.join(root, 'staff.zip');
    repository.exportStaff(staff.id, zipPath);
    const entries = new AdmZip(zipPath).getEntries().map((entry) => entry.entryName);
    assert.equal(entries.includes('staff.json'), true);
    assert.equal(entries.includes('agent/agents.md'), true);
    assert.equal(
        entries.some((entry) => entry.startsWith('protected/')),
        false
    );
    assert.equal(
        entries.some((entry) => entry.startsWith('workspace/')),
        false
    );
    assert.equal(
        entries.some((entry) => entry.startsWith('resources/')),
        false
    );

    const imported = repository.importStaff(zipPath);
    assert.notEqual(imported.id, staff.id);
    assert.equal(imported.name, staff.name);
    assert.equal(imported.trigger_interval, '30m');
    assert.equal(imported.message_count, 0);
});

test('staff permission enforcer denies protected and unconfigured paths', async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentoffice-permission-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    const resources = path.join(root, 'resources');
    const protectedDirectory = path.join(root, 'protected');
    const external = path.join(root, 'external');
    const enforcer = await createStaffPermissionEnforcer({
        workspace,
        resourcesDirectory: resources,
        protectedDirectory,
        permission: { directories: [{ path: external, access: 'read' }], network_access: false }
    });
    assert.equal(
        (await enforcer.check({ resourceType: 'file', action: 'write', resourcePath: path.join(workspace, 'a') }))
            .effect,
        'allow'
    );
    assert.equal(
        (await enforcer.check({ resourceType: 'file', action: 'write', resourcePath: path.join(external, 'a') }))
            .effect,
        'deny'
    );
    assert.equal(
        (
            await enforcer.check({
                resourceType: 'file',
                action: 'read',
                resourcePath: path.join(protectedDirectory, 'messages.jsonl')
            })
        ).effect,
        'deny'
    );
    assert.equal(
        (await enforcer.check({ resourceType: 'network', action: 'access', resourcePath: 'https://example.com' }))
            .effect,
        'deny'
    );
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(protectedDirectory, { recursive: true });
    const protectedLink = path.join(workspace, 'protected-link');
    fs.symlinkSync(protectedDirectory, protectedLink, 'dir');
    assert.equal(
        (
            await enforcer.check({
                resourceType: 'file',
                action: 'read',
                resourcePath: path.join(protectedLink, 'messages.jsonl')
            })
        ).effect,
        'deny'
    );
});

test('deletes history messages and individual content parts with resource cleanup', (context) => {
    const { root, repository } = createRepository();
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const staff = repository.createStaff({
        name: 'Ada',
        vendor_name: 'OpenDesk',
        title: 'Researcher',
        specialties: []
    });

    const attachment = path.join(root, 'incoming', 'shot.png');
    fs.mkdirSync(path.dirname(attachment), { recursive: true });
    fs.writeFileSync(attachment, 'png-bytes');
    const prepared = repository.prepareUserMessage(staff.id, 'task-1', '看图', [
        { path: attachment, name: 'shot.png' }
    ]);
    repository.appendMessage(staff.id, prepared.message);
    const resourcePart = prepared.message.content.find((part) => part.type === 'resource');
    assert.ok(resourcePart && resourcePart.type === 'resource');
    const resourceFile = path.join(repository.staffDirectory(staff.id), resourcePart.path);
    assert.equal(fs.existsSync(resourceFile), true);

    assert.throws(() => repository.deleteMessagePart(staff.id, prepared.message.id, 9), /分块序号无效|part index/);

    // 单独删除图片分块：文本保留、资源文件同步清理
    repository.deleteMessagePart(staff.id, prepared.message.id, 1);
    const stored = repository.readMessages(staff.id);
    assert.equal(stored.length, 1);
    assert.deepEqual(
        stored[0].content.map((part) => part.type),
        ['text']
    );
    assert.equal(fs.existsSync(resourceFile), false);

    // 删除唯一的文本分块 → 整条消息一并移除
    repository.deleteMessagePart(staff.id, prepared.message.id, 0);
    assert.equal(repository.readMessages(staff.id).length, 0);

    // 整条删除与不存在的消息
    repository.appendMessage(staff.id, prepared.message);
    repository.deleteMessage(staff.id, prepared.message.id);
    assert.equal(repository.readMessages(staff.id).length, 0);
    assert.throws(() => repository.deleteMessage(staff.id, prepared.message.id), /消息不存在|Message not found/);
});
