import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);
const tools = new URL('../../../main/applications/calendar/tools.ts', import.meta.url).href;
for (const [date, start, end] of [
    ['2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
    ['2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z']
]) {
    test(`Calendar all-day add/edit uses consecutive local midnights across DST on ${date}`, async () => {
        const profile = await mkdtemp(path.join(os.tmpdir(), 'calendar-all-day-tools-'));
        try {
            const script = `
                import { AddCalendarItemTool, EditCalendarItemTool } from ${JSON.stringify(tools)};
                const writes=[];
                const app={callWorker:async(method,...args)=>{const value=method==='addCalendarItem'?args[0]:args[1];writes.push(value);return {status:'ok',data:{uid:'local_fixture',...value}};}};
                const results=[];
                results.push(await new AddCalendarItemTool(app).execute({subject:'All day',dateString:${JSON.stringify(date)},startTime:'00:00',endTime:'00:00',isAllDay:true}));
                results.push(await new EditCalendarItemTool(app).execute({itemId:'local_fixture',dateString:${JSON.stringify(date)},isAllDay:true}));
                results.push(await new EditCalendarItemTool(app).execute({itemId:'local_fixture',dateString:${JSON.stringify(date)},startTime:'00:00',endTime:'00:00',isAllDay:true}));
                console.log('ALL_DAY_RESULT '+JSON.stringify({statuses:results.map(result=>result.status),writes}));
            `;
            const { stdout } = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
                cwd: process.cwd(),
                env: { ...process.env, TZ: 'America/New_York', OPENDESK_CONFIG_DIRECTORY: profile },
                timeout: 15_000
            });
            const result = JSON.parse(
                stdout
                    .split('\n')
                    .find((line) => line.startsWith('ALL_DAY_RESULT '))!
                    .slice('ALL_DAY_RESULT '.length)
            );
            assert.deepEqual(result.statuses, ['success', 'success', 'success']);
            assert.equal(result.writes.length, 3);
            for (const write of result.writes) {
                assert.equal(write.startTime, Date.parse(start));
                assert.equal(write.endTime, Date.parse(end));
                assert.equal(write.isAllDay, true);
            }
        } finally {
            await rm(profile, { recursive: true, force: true });
        }
    });
}
