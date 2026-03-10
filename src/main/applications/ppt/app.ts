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

import { BaseToolset } from "../../aikernel/tool";
import { BaseApplication } from "../base";
import { CreatePPTTool, PPTAgent } from "./tools";
import path from "path";
import fs from "fs";
import { z } from "zod";
import PPTWorker from "./worker";


const DEFAULT_SERVICE_URL = 'http://119.8.241.85:59801';

const PPTCreatorConfigSchema = z.object({
    service_url: z.string().default(DEFAULT_SERVICE_URL).describe('PPT制作服务地址'),
});

export class PPTCreatorApplication extends BaseApplication {
    constructor() {
        super('ppt', 'PPT制作');
        this.reloadServiceUrl();
    }

    static getWorkerClass() {
        return PPTWorker;
    }

    static getConfigSchema(): z.ZodObject<any> {
        return PPTCreatorConfigSchema;
    }

    async onConfigChanged(): Promise<void> {
        this.reloadServiceUrl();
    }

    async reloadServiceUrl(): Promise<void> {
        const config = this.getConfig() as z.output<typeof PPTCreatorConfigSchema>;
        const serviceUrl = config?.service_url || DEFAULT_SERVICE_URL;
        PPTAgent.setServiceUrl(serviceUrl);
    }

    async getToolsets(): Promise<BaseToolset[]> {
        const toolset = new BaseToolset('pptcreator');
        const appDataDirectory = this.getDataDirectory();
        toolset.addTool(new CreatePPTTool(appDataDirectory));
        return [toolset];
    }

    getProtocolHandlers() {
        const pptHandler = {
            scheme: 'ppt',
            privileges: { standard: true, secure: true, supportFetchAPI: true },
            handler: async (request: { url: string }) => {
                const appDataDirectory = this.getDataDirectory();
                if (request.url.startsWith('ppt://data/')) {
                    const tokens = request.url.split('data/')[1].split('/');
                    const uid = tokens[0];
                    if (tokens[1] === 'images') {
                        const imagePath = path.join(appDataDirectory, 'data', uid, 'images', tokens[2]);
                        if (fs.existsSync(imagePath)) {
                            return new Response(fs.readFileSync(imagePath), { status: 200 });
                        }
                    }
                    return new Response(null, { status: 200 });
                }
                else if (request.url.startsWith('ppt://metadata/')) {
                    const tokens = request.url.split('metadata/')[1].split('/');
                    const uid = tokens[0];
                    const slides = await this.callWorker('getSlides', uid);
                    return new Response(JSON.stringify(slides), { status: 200 });
                }

                console.error('unsupported ppt url:', request.url);
                return new Response(null, { status: 404 });
            },
        }
        return [ pptHandler ];
    }
}