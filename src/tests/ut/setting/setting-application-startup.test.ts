import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

const calendarConfig = {
    dataSources: { systemCalendar: { enabled: true, defaultCalendarId: '1' } }
};

describe('application settings survive loading before application registration', () => {
    let directory: string;
    const disk = () => JSON.parse(fs.readFileSync(path.join(directory, 'setting.json'), 'utf8'));
    const write = (data: object) => fs.writeFileSync(path.join(directory, 'setting.json'), JSON.stringify(data));

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-setting-startup-'));
        setCustomOpendeskDirectory(directory);
        Setting.clearCache();
    });

    afterEach(() => {
        Setting.clearCache();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test('a cold JSON load keeps configurations for not-yet-registered and unavailable applications', () => {
        const applications = {
            'startup-calendar': calendarConfig,
            'optional-user-application': { custom: { nested: [1, 'keep', false] } }
        };
        write({ applications });

        expect(Setting.getInstance().getData().applications).toEqual(applications);
        expect(disk().applications).toEqual(applications);
    });

    test('an early global settings save preserves application selections through another cold load', () => {
        const applications = { 'startup-before-register': calendarConfig, 'optional-plugin': { enabled: true } };
        write({ applications });
        const setting = Setting.getInstance();
        const initial = setting.getData();
        setting.setData({ ...initial, gui_config: { ...initial.gui_config, scale_factor: 1.2 } });

        expect(disk().applications).toEqual(applications);
        Setting.clearCache();
        expect(Setting.getInstance().getData().applications).toEqual(applications);
        expect(Setting.getInstance().getData().gui_config.scale_factor).toBe(1.2);
    });

    test('a load-time model-reference cleanup cannot erase pending application configurations', () => {
        const applications = {
            'startup-normalization-calendar': calendarConfig,
            'temporarily-unavailable': { value: 7 }
        };
        write({ default_model: 'removed-model', applications });

        expect(Setting.getInstance().getData().default_model).toBe('');
        expect(disk().default_model).toBe('');
        expect(disk().applications).toEqual(applications);
        expect(Setting.getInstance().getData().applications).toEqual(applications);
    });

    test('late registration validates its own configuration and keeps unrelated application data', () => {
        class PendingApplication {
            bundleName = 'startup-late-registered';
            static getConfigSchema() {
                return z.object({
                    dataSources: z.object({
                        systemCalendar: z.object({ enabled: z.boolean(), defaultCalendarId: z.string() })
                    })
                });
            }
        }
        const application = new PendingApplication();
        const applications = { [application.bundleName]: calendarConfig, 'other-host-app': { keep: 'settings' } };
        write({ applications });
        const early = Setting.getInstance();
        early.updateAndSave((draft) => {
            draft.gui_config.scale_factor = 1.1;
        });
        Setting.registerApplicationSettings(application as any, () => undefined);
        Setting.clearCache();

        const setting = Setting.getInstance();
        expect(setting.getApplicationConfig(application.bundleName)).toEqual(calendarConfig);
        expect(setting.getApplicationConfig('other-host-app')).toEqual({ keep: 'settings' });
        const applicationsSchema = Setting.getSettingJSONSchema().properties?.applications as any;
        expect(applicationsSchema.additionalProperties).not.toBe(false);
        expect(
            applicationsSchema.properties[application.bundleName].properties.dataSources.properties.systemCalendar
                .properties.defaultCalendarId.type
        ).toBe('string');
        const invalid = {
            ...setting.getData(),
            applications: {
                ...setting.getData().applications,
                [application.bundleName]: {
                    dataSources: { systemCalendar: { enabled: true, defaultCalendarId: 1 } }
                }
            }
        };
        expect(() => setting.setData(invalid)).toThrow();
        expect(() => Setting.updateInstanceData(invalid)).toThrow();
        expect(setting.getApplicationConfig(application.bundleName)).toEqual(calendarConfig);
        expect(disk().applications).toEqual(applications);
    });
});
