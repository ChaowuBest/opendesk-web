import { registerDeadloopHarness } from './chat/deadloop.js';

let initialized = false;

export function initializeHarnesses(): void {
    if (initialized) return;
    initialized = true;

    registerDeadloopHarness();
}
