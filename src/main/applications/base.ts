/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import {
    BaseApplication,
    BaseWorker,
    setOpenDeskAppHost,
    type CliOption,
    type EventDecl,
    type ProtocolHandlerConfig,
    type OpenDeskAppManifest,
    type OpenDeskAppPackageManifest
} from '../../../packages/appsdk/src/index.js';
import { Setting, getAppDirectory } from '../utils/setting.js';
import { logger } from '../utils/logger.js';

setOpenDeskAppHost({
    getConfig(bundleName: string): unknown {
        return Setting.getInstance().data.applications[bundleName];
    },
    setConfig(bundleName: string, config: unknown, schema: z.ZodObject<any>): void {
        schema.parse(config);
        const setting = Setting.getInstance();
        setting.data.applications[bundleName] = config;
        setting.save();
    },
    getDataDirectory(bundleName: string): string {
        const dataDirectory = path.join(getAppDirectory(), 'apps', bundleName);
        if (!fs.existsSync(dataDirectory)) {
            fs.mkdirSync(dataDirectory, { recursive: true });
        }
        return dataDirectory;
    },
    logInfo(message: string): void {
        logger.info(message);
    },
    logWarn(message: string): void {
        logger.warn(message);
    }
});

export {
    BaseApplication,
    BaseWorker,
    type CliOption,
    type EventDecl,
    type ProtocolHandlerConfig,
    type OpenDeskAppManifest,
    type OpenDeskAppPackageManifest
};
