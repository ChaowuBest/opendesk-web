import { BaseToolset } from "../../agents/tool";
import { BaseApplication } from "../base";
import { CreatePPTTool } from "./tools";


export class PPTCreatorApplication extends BaseApplication {
    constructor() {
        super('ppt', 'PPT制作');
    }

    getToolsets(): BaseToolset[] {
        const toolset = new BaseToolset('pptcreator');
        toolset.addTool(new CreatePPTTool());
        return [toolset];
    }
}