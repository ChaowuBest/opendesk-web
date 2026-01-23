import { BaseWorker } from "../base";
import * as pty from '@lydell/node-pty';


class TerminalWorker extends BaseWorker {
    currentTerminalInstance: pty.IPty | null = null;

    constructor(appDataDirectory: string) {
        super('terminal', appDataDirectory);
    }

    async initialize() {
        super.initialize();
    }

    async startTerminalInstance() {
        if (this.currentTerminalInstance) {
            return;
        }

        this.currentTerminalInstance = pty.spawn(process.platform === 'win32' ? 'cmd.exe' : 'bash', [], {
            name: 'xterm-color',
            cols: 80,
            rows: 30,
            cwd: process.cwd(),
            env: process.env,
        });
        this.currentTerminalInstance.onData(data => {
            this.emitEvent(`feedPtyData`, data);
        });
    }

    async resizeTerminalInstance(cols: number, rows: number) {
        if (!this.currentTerminalInstance) {
            throw new Error('Terminal instance not found');
        }

        this.currentTerminalInstance.resize(cols, rows);
    }

    async feedUserData(data: string) {
        this.currentTerminalInstance?.write(data);
    }
}

export default TerminalWorker;