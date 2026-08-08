import { describe, expect, test } from '@jest/globals';
import { BaseApplication } from '../../../main/applications/base.js';
import { ApplicationRegistry } from '../../../main/applications/registry.js';

class DeferredApplication extends BaseApplication {
    loadCount = 0;
    private readonly waitUntilReleased: Promise<void>;

    constructor(waitUntilReleased: Promise<void>) {
        super('deferred-test', false);
        this.waitUntilReleased = waitUntilReleased;
    }

    getName(): string {
        return 'Deferred Test';
    }

    async ensureLoaded(): Promise<void> {
        this.loadCount += 1;
        await this.waitUntilReleased;
    }
}

describe('ApplicationRegistry full loading barrier', () => {
    test('shares one loading promise across concurrent and later callers', async () => {
        const originalApplications = ApplicationRegistry.applications;
        const originalPromise = (ApplicationRegistry as any).fullyLoadedPromise;
        let release: (() => void) | undefined;
        const waitUntilReleased = new Promise<void>((resolve) => {
            release = resolve;
        });
        const application = new DeferredApplication(waitUntilReleased);

        try {
            ApplicationRegistry.applications = new Map([[application.bundleName, application]]);
            (ApplicationRegistry as any).fullyLoadedPromise = undefined;

            const first = ApplicationRegistry.ensureFullyLoaded();
            const second = ApplicationRegistry.ensureFullyLoaded();

            expect(second).toBe(first);
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(application.loadCount).toBe(1);

            release?.();
            await first;

            expect(ApplicationRegistry.ensureFullyLoaded()).toBe(first);
            expect(application.loadCount).toBe(1);
        } finally {
            release?.();
            ApplicationRegistry.applications = originalApplications;
            (ApplicationRegistry as any).fullyLoadedPromise = originalPromise;
        }
    });
});
