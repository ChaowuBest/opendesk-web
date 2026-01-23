import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

class TerminalEntry extends HTMLElement {
    constructor() {
        super();
    }

    connectedCallback() {
        window.applicationAPI.call('startTerminalInstance').then(() => {
            this.render();
        }).catch(error => {
            console.error('failed to start terminal instance', error);
        });
    }

    render() {
        this.innerHTML = `
        <div class="w-full h-full p-2">
            <div class="w-full h-full p-3 rounded-xl border border-gray-200 bg-black">
                <div id="terminal-container" class="w-full h-full"></div>
            </div>
        </div>
        `;

        var term = new Terminal({
            fontFamily: 'Menlo, "Maple Mono", Consolas, "Lucida Console", monospace',
            fontSize: 14,
            theme: {
                background: '#000',
                foreground: '#fff',
                cursor: '#fff',
                cursorAccent: '#fff',
                selection: '#fff',
                selectionBackground: '#fff',
            },
        });
        const termContainer = this.querySelector('#terminal-container');
        const fitAddon = new FitAddon();

        term.open(termContainer);
        term.loadAddon(fitAddon);
        term.onData(data => {
            window.applicationAPI.call('feedUserData', data);
        });

        window.applicationAPI.subscribe('feedPtyData', data => {
            term.write(data);
        });
        window.addEventListener('resize', () => {
            fitAddon.fit();
            console.info('terminal resized', term.cols, term.rows);
            window.applicationAPI.call('resizeTerminalInstance', term.cols, term.rows);
        });
    }
}

customElements.define('terminal-entry-widget', TerminalEntry);