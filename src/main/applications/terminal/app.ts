import { BaseToolset } from "../../agents/tool.js";
import { BaseApplication } from "../base.js";
import { ExecuteCmdTool, ExecuteBashTool } from "./tools.js";


export class TerminalApplication extends BaseApplication {
    constructor() {
        super('terminal', '终端');
    }

    getToolsets(): BaseToolset[] {
        const toolset = new BaseToolset('terminal');
        if (process.platform === 'win32') {
            toolset.addTool(new ExecuteCmdTool());
        } else {
            toolset.addTool(new ExecuteBashTool());
        }
        return [toolset];
    }
}