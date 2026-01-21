import { BaseToolset } from "../../agents/tool.js";
import { BaseApplication } from "../base.js";
import { ExecuteCmdTool } from "./tools.js";


export class TerminalApplication extends BaseApplication {
    constructor() {
        super('terminal', '终端');
    }

    getToolsets(): BaseToolset[] {
        const toolset = new BaseToolset('terminal');
        toolset.addTool(new ExecuteCmdTool());
        return [toolset];
    }
}