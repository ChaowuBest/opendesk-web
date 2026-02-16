import { TUI, Text, Editor, Box, Component } from "@mariozechner/pi-tui";
import { defaultEditorTheme } from './theme';
import { LOGO } from './banner';
import { CenteredText } from './components/texts';
import { VerticalLayout } from './components/layout';
import { OpenDeskTerminal } from './terminal';
import { TaskView } from "./components/taskview";
import { TaskManagerState, TaskUpdateChunk } from "../states/tasks";
import { GlobalState } from "../states/global";
import { AgentInputArea } from "./components/input";
import { ApplicationRegistry } from "../applications/registry";


export class OpenDeskTUI {

    private taskManagerState: TaskManagerState;

    private tui: TUI;
    private container: VerticalLayout = new VerticalLayout({
        spacing: 1,
        padding: { left: 1, right: 1 }
    });
    private taskView: TaskView;
    private inputArea: AgentInputArea;

    constructor() {
        this.taskManagerState = GlobalState.getInstance().taskManagerState;

        const terminal = new OpenDeskTerminal();
        terminal.onResize((cols, rows) => {
            this.container.setMinLines(rows);
            this.tui.requestRender(true);
        });

        this.tui = new TUI(terminal);
        this.taskView = new TaskView(this.tui);
        this.inputArea = new AgentInputArea(this.tui);

        this.tui.addChild(this.container);
        this.container.addChild(new CenteredText(LOGO.substring(1)));
        this.container.addChild(this.taskView);
        this.container.addChild(this.inputArea)
        this.container.setMinLines(this.tui.terminal.rows);
        this.container.setVerticalAlign("center");

        this.inputArea.onSubmit(this.onRequestSubmit.bind(this));
    }

    async onRequestSubmit(request: string) {
        if (request.trim() === '/exit') {
            try {
                this.tui.stop();
            } catch { /* 忽略 TUI 清理错误，确保后续退出逻辑能执行 */ }

            // 先终止 Worker 线程，避免其 ref 句柄阻止 process.exit 在 Windows 上生效
            const worker = ApplicationRegistry.globalWorker;
            if (worker) {
                await worker.terminate();
            }

            process.exit(0);
        } else {
            if (this.taskView.taskState === undefined) {
                this.taskView.taskState = this.taskManagerState.createTask();
            }

            await this.taskView.communicate(request).finally(() => {
                this.inputArea.setStatus('idle');
            });
        }
    }

    start() {
        this.tui.start();
        this.tui.setFocus(this.inputArea.input);
    }

}
