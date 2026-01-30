import { BaseToolset } from "../../agents/tool";
import { BaseApplication } from "../base";
import { CreatePPTTool } from "./tools";
import path from "path";
import fs from "fs";


export class PPTCreatorApplication extends BaseApplication {
    constructor() {
        super('ppt', 'PPT制作');
    }

    async getToolsets(): Promise<BaseToolset[]> {
        const toolset = new BaseToolset('pptcreator');
        const appDataDirectory = await this.getDataDirectory();
        toolset.addTool(new CreatePPTTool(appDataDirectory));
        return [toolset];
    }

    getProtocolHandlers() {
        const pptHandler = {
            scheme: 'ppt',
            privileges: { standard: true, secure: true, supportFetchAPI: true },
            handler: async (request: { url: string }) => {
                const appDataDirectory = await this.getDataDirectory();
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