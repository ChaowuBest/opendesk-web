import { parseHTML } from 'linkedom';
import { captureSidebarScrollState, restoreSidebarScrollState } from '../../../renderer/sidebarScrollState.js';

describe('sidebar scroll state', () => {
    test('restores the task groups, running list and each expanded group body after rendering', () => {
        const { document } = parseHTML(`
            <div id="sidebar">
                <div class="sb-running-list"></div>
                <div class="sb-task-groups">
                    <details class="sb-task-group" data-group-id="today" open>
                        <div class="sb-task-group-body"></div>
                    </details>
                    <details class="sb-task-group" data-group-id="earlier">
                        <div class="sb-task-group-body"></div>
                    </details>
                </div>
            </div>
        `);
        const sidebar = document.querySelector('#sidebar')!;
        const runningList = sidebar.querySelector<HTMLElement>('.sb-running-list')!;
        const taskGroups = sidebar.querySelector<HTMLElement>('.sb-task-groups')!;
        const bodies = sidebar.querySelectorAll<HTMLElement>('.sb-task-group-body');
        runningList.scrollTop = 24;
        taskGroups.scrollTop = 48;
        bodies[0].scrollTop = 160;
        bodies[1].scrollTop = 80;

        const state = captureSidebarScrollState(sidebar);
        taskGroups.innerHTML = `
            <details class="sb-task-group" data-group-id="today" open>
                <div class="sb-task-group-body"></div>
            </details>
            <details class="sb-task-group" data-group-id="earlier">
                <div class="sb-task-group-body"></div>
            </details>
        `;
        runningList.scrollTop = 0;
        taskGroups.scrollTop = 0;

        restoreSidebarScrollState(sidebar, state);

        expect(runningList.scrollTop).toBe(24);
        expect(taskGroups.scrollTop).toBe(48);
        expect(
            sidebar.querySelector<HTMLElement>('.sb-task-group[data-group-id="today"] .sb-task-group-body')!.scrollTop
        ).toBe(160);
        expect(
            sidebar.querySelector<HTMLElement>('.sb-task-group[data-group-id="earlier"] .sb-task-group-body')!.scrollTop
        ).toBe(80);
    });
});
