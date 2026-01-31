import { BaseToolset } from "../../agents/tool";
import { BaseApplication, BaseGUIConfig } from "../base.js";
import { ExecuteCmdTool, ExecuteBashTool, WriteFileTool, ReadFileTool } from "./tools.js";


export class TerminalApplication extends BaseApplication {
    constructor() {
        super('terminal', '终端');
    }

    async getToolsets(): Promise<BaseToolset[]> {
        const toolset = new BaseToolset('terminal');
        if (process.platform === 'win32') {
            toolset.addTool(new ExecuteCmdTool());
        } else {
            toolset.addTool(new ExecuteBashTool());
        }

        toolset.addTool(new ReadFileTool());
        toolset.addTool(new WriteFileTool());
        return [toolset];
    }
}