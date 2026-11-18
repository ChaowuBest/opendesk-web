import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentOfficeRepository } from '../../../../main/applications/agentoffice/repository.js';
import AgentOfficeWorker from '../../../../main/applications/agentoffice/worker.js';
import { logger } from '../../../../main/utils/logger.js';
import {
    emptyUsageSummary,
    normalizeStaffLocalService,
    type PresetStaffDefinition
} from '../../../../main/applications/agentoffice/common.js';

const preset: PresetStaffDefinition = {
    key: 'research-v1',
    definition: { name: 'Research', vendor_name: 'OpenDesk', title: 'Analyst', trigger_interval: '5m' },
    agents_md: '# Preset instructions'
};

function fixture(context: TestContext) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentoffice-startup-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return new AgentOfficeRepository(directory);
}

function observeReads(context: TestContext) {
    const files: string[] = [];
    const directories: string[] = [];
    const read = fs.readFileSync;
    const readdir = fs.readdirSync;
    context.mock.method(fs, 'readFileSync', (...args: Parameters<typeof read>) => {
        files.push(String(args[0]));
        return read(...args);
    });
    context.mock.method(fs, 'readdirSync', (...args: Parameters<typeof readdir>) => {
        directories.push(String(args[0]));
        return readdir(...args);
    });
    return { files, directories };
}

test('startup listing reads only definitions and metadata, retaining registration and service fields', (context) => {
    const repository = fixture(context);
    const staff = repository.createStaff(preset.definition, '# User instructions');
    const localService = normalizeStaffLocalService({
        enabled: true,
        port: 9053,
        manage_token: 'manager',
        https: true
    });
    repository.updateStaff(staff.id, { model: 'test-model', local_service: localService });
    const reads = observeReads(context);
    const result = repository.listStaffStartupInfo();
    assert.deepEqual(result, [
        {
            ...preset.definition,
            specialties: [],
            id: staff.id,
            hired_at: staff.hired_at,
            enabled: true,
            model: 'test-model',
            local_service: localService
        }
    ]);
    assert.deepEqual(reads.files.map((file) => path.basename(file)).sort(), ['metadata.json', 'staff.json']);
    assert.deepEqual(reads.directories, [repository.staffsDirectory]);
    assert.equal('message_count' in result[0], false);
    assert.equal('agents_md' in result[0], false);
});

test('installed preset keys skip staff scans and deleted presets remain deleted', (context) => {
    const repository = fixture(context);
    const [staff] = repository.ensurePresetStaffs([preset]);
    repository.deleteStaff(staff.id);
    const reads = observeReads(context);
    assert.deepEqual(repository.ensurePresetStaffs([preset], false), []);
    assert.deepEqual(
        reads.files.map((file) => path.basename(file)),
        ['preset-staffs.json']
    );
    assert.deepEqual(reads.directories, []);
    assert.equal(fs.existsSync(repository.staffDirectory(staff.id)), false);
});

test('preset adoption does not scan history or overwrite user instructions, tasks, and schedule', (context) => {
    const repository = fixture(context);
    const staff = repository.createStaff(preset.definition, '# User-customized instructions');
    repository.updateStaff(staff.id, { enabled: false, model: 'custom-model' });
    const protectedDirectory = repository.protectedDirectory(staff.id);
    const tracked = ['metadata.json', 'tasks.json', 'messages.jsonl'].map((name) =>
        path.join(protectedDirectory, name)
    );
    tracked.push(path.join(repository.staffDirectory(staff.id), 'agent', 'agents.md'));
    const before = tracked.map((file) => fs.readFileSync(file, 'utf8'));
    const reads = observeReads(context);
    const adopted = repository.ensurePresetStaffs([preset], false);
    assert.deepEqual(
        adopted.map((item) => [item.id, item.enabled, item.model]),
        [[staff.id, false, 'custom-model']]
    );
    assert.deepEqual(reads.files.map((file) => path.basename(file)).sort(), ['metadata.json', 'staff.json']);
    assert.deepEqual(reads.directories, [repository.staffsDirectory]);
    assert.deepEqual(
        tracked.map((file) => fs.readFileSync(file, 'utf8')),
        before
    );
});

test('new presets use lightweight creation while the default preset API still returns full details', (context) => {
    const repository = fixture(context);
    const reads = observeReads(context);
    const [staff] = repository.ensurePresetStaffs([preset], false);
    assert.equal(staff.name, preset.definition.name);
    assert.equal(
        reads.files.some((file) => /tasks\.json|messages\.jsonl|agents\.md|mcp\.json|permission\.json/.test(file)),
        false
    );
    assert.equal(
        reads.directories.some((directory) => directory.endsWith('skills')),
        false
    );
    assert.equal(repository.getStaffDetail(staff.id).agents_md, preset.agents_md);
    const [detailed] = repository.ensurePresetStaffs([
        { ...preset, key: 'writer-v1', definition: { ...preset.definition, name: 'Writer' } }
    ]);
    assert.equal(detailed.agents_md, preset.agents_md);
    assert.deepEqual(detailed.tasks, []);
});

test('startup listing keeps disabled fallback and ignores corrupt definitions or metadata', (context) => {
    const repository = fixture(context);
    const missing = repository.createStaff({ ...preset.definition, name: 'Missing metadata' });
    fs.unlinkSync(path.join(repository.protectedDirectory(missing.id), 'metadata.json'));
    const badDefinition = repository.createStaff({ ...preset.definition, name: 'Bad definition' });
    fs.writeFileSync(path.join(repository.staffDirectory(badDefinition.id), 'staff.json'), '{}');
    const badMetadata = repository.createStaff({ ...preset.definition, name: 'Bad metadata' });
    fs.writeFileSync(path.join(repository.protectedDirectory(badMetadata.id), 'metadata.json'), '{');
    fs.mkdirSync(path.join(repository.staffsDirectory, 'not-a-staff-id'));
    const list = repository.listStaffStartupInfo();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, missing.id);
    assert.equal(list[0].enabled, false);
    assert.equal(list[0].hired_at, new Date(0).toISOString());
});

test('full list/detail retain message, task, skill and usage statistics after startup reads', (context) => {
    const repository = fixture(context);
    const staff = repository.createStaff(preset.definition, '# Complete prompt');
    const protectedDirectory = repository.protectedDirectory(staff.id);
    const usage = { ...emptyUsageSummary(), total_tokens: 12, request_count: 1 };
    fs.writeFileSync(
        path.join(protectedDirectory, 'tasks.json'),
        JSON.stringify([
            {
                task_id: 'running-task',
                message_ids: ['message-1'],
                status: 'running',
                source: 'scheduled',
                created_at: staff.hired_at,
                updated_at: staff.hired_at,
                usage_summary: usage
            }
        ])
    );
    fs.writeFileSync(
        path.join(protectedDirectory, 'messages.jsonl'),
        JSON.stringify({
            id: 'message-1',
            role: 'user',
            task_id: 'running-task',
            created_at: staff.hired_at,
            content: [{ type: 'text', text: 'test message' }]
        }) + '\n'
    );
    const skillDirectory = path.join(repository.staffDirectory(staff.id), 'agent', 'skills', 'research');
    fs.mkdirSync(skillDirectory);
    fs.writeFileSync(
        path.join(skillDirectory, 'SKILL.md'),
        '---\nname: research\ndescription: Research fixture\n---\nResearch.'
    );
    const before = repository.getStaffDetail(staff.id);
    repository.listStaffStartupInfo();
    repository.ensurePresetStaffs([preset], false);
    assert.deepEqual(repository.getStaffDetail(staff.id), before);
    const [listItem] = repository.listStaffs();
    assert.equal(listItem.message_count, 1);
    assert.equal(listItem.task_count, 1);
    assert.equal(listItem.skill_count, 1);
    assert.equal(listItem.active_task_id, 'running-task');
    assert.deepEqual(listItem.usage_summary, usage);
    const due = repository.claimDueTriggers(new Date(Date.parse(staff.hired_at) + 300_000).toISOString());
    assert.equal(due.length, 1);
    assert.equal(due[0].staff_id, staff.id);
    assert.deepEqual(repository.claimDueTriggers(due[0].triggered_at), []);
});

test('worker initialization uses lightweight presets, retaining deletion across restarts and full UI APIs', async (context) => {
    const repository = fixture(context);
    const worker = new AgentOfficeWorker('agentoffice', repository.appDataDirectory);
    const reads = observeReads(context);
    await worker.initialize();
    assert.equal(
        reads.files.some((file) => /tasks\.json|messages\.jsonl|agents\.md|mcp\.json|permission\.json/.test(file)),
        false
    );
    const initial = (await worker.handleMessage('listStaffStartupInfo')) as Array<{ id: string }>;
    assert.equal(initial.length, 3);
    repository.deleteStaff(initial[0].id);
    reads.files.length = 0;
    reads.directories.length = 0;
    const restarted = new AgentOfficeWorker('agentoffice', repository.appDataDirectory);
    await restarted.initialize();
    assert.deepEqual(
        reads.files.map((file) => path.basename(file)),
        ['preset-staffs.json']
    );
    assert.deepEqual(reads.directories, []);
    assert.equal(restarted.listStaffStartupInfo().length, 2);
    assert.equal(restarted.listStaffs().length, 2);
    assert.equal(typeof restarted.getStaffDetail(initial[1].id).agents_md, 'string');
});

test('optional timing transport failure cannot fail worker initialization or preset creation', async (context) => {
    const repository = fixture(context);
    const worker = new AgentOfficeWorker('agentoffice', repository.appDataDirectory);
    context.mock.method(logger, 'info', () => {
        throw new Error('diagnostic transport unavailable');
    });
    await assert.doesNotReject(worker.initialize());
    assert.equal(worker.listStaffStartupInfo().length, 3);
});
