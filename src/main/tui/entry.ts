import { TUI, Text, Editor } from "@mariozechner/pi-tui";
import { defaultEditorTheme } from './theme';
import { LOGO } from './banner';
import { CenteredText } from './components/texts';
import { VerticalLayout } from './components/layout';
import { OpenDeskTerminal } from './terminal';
import { TaskView } from "./components/taskview";
import { TaskManagerState, TaskUpdateChunk } from "../states/tasks";
import { GlobalState } from "../states/global";


export class OpenDeskTUI {

    private taskManagerState: TaskManagerState;

    private tui: TUI = new TUI(new OpenDeskTerminal());
    private taskView: TaskView;
    private statusBar: Text;

    constructor() {
        this.taskManagerState = GlobalState.getInstance().taskManagerState;
        this.taskView = new TaskView(this.tui);
    }

    start() {
        const mainLayout = new VerticalLayout();
        const editor = new Editor(this.tui, defaultEditorTheme);
        this.statusBar = new Text("");

        this.tui.addChild(mainLayout);
        mainLayout.addChild(new CenteredText(LOGO.substring(1)));
        mainLayout.addChild(this.taskView);
        mainLayout.addChild(editor);
        mainLayout.addChild(this.statusBar);
        mainLayout.setSpacing(1);
        mainLayout.setPadding(1);

        editor.onChange = (text) => {
            this.statusBar.setText(`Status: Editing (${text.length} characters)`);
        };
        editor.onSubmit = async (text) => {
            if (text.trim() === '/exit') {
                this.tui.stop(); // 恢复光标与终端状态后再退出，避免退出后光标不闪烁
                process.exit(0);
            } else {
                if (this.taskView.taskState === undefined) {
                    this.taskView.taskState = this.taskManagerState.createTask();
                }

                await this.taskView.communicate(text);
            }
        };

        this.tui.setFocus(editor);
        this.tui.start();
    }

}
