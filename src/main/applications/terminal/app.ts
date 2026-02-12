import { BaseToolset } from "../../agents/tool";
import { BaseApplication } from "../base.js";
import { ExecuteCmdTool, ExecuteBashTool, WriteFileTool, ReadFileTool, ExecuteZshTool } from "./tools.js";


export class TerminalApplication extends BaseApplication {
    constructor() {
        super('terminal', '终端');
    }

    async getToolsets(): Promise<BaseToolset[]> {
        const toolset = new BaseToolset('terminal');

        switch (process.platform as string) {
            case 'win32':
                toolset.addTool(new ExecuteCmdTool());
                break;
            case 'openharmony':
                toolset.addTool(new ExecuteZshTool());
                break;
            default:
                toolset.addTool(new ExecuteBashTool());
                break;
        }

        toolset.addTool(new ReadFileTool());
        toolset.addTool(new WriteFileTool());
        return [toolset];
    }
}