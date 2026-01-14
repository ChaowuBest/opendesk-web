class SynchronizerEntryWidget extends HTMLElement {
    constructor() {
        super();
    }

    connectedCallback() {
        this.render();
    }

    render() {
        this.innerHTML = `
        <div class="w-full h-full flex flex-col bg-gradient-to-br from-slate-50 via-white to-slate-100">
            <header class="pl-6 pr-16 py-4 flex items-center justify-between border-b bg-white/80 backdrop-blur">
                <div>
                    <p class="text-xs uppercase tracking-wide text-gray-400">Synchronizer</p>
                    <h1 class="text-2xl font-semibold text-gray-800">同步</h1>
                </div>
            </header>
            <div class="flex flex-col items-center justify-center mt-12">
                <button id="outlook-sync-btn"
                    class="px-6 py-3 bg-blue-600 text-white rounded-full shadow hover:bg-blue-700 transition-all text-lg font-medium flex items-center space-x-2">
                    <i class="fas fa-sync-alt"></i>
                    <span>同步 Outlook</span>
                </button>
                <div id="outlook-sync-status" class="mt-4 text-gray-600 text-sm"></div>
            </div>
        </div>
        `
        const btn = this.querySelector('#outlook-sync-btn');
        const statusDiv = this.querySelector('#outlook-sync-status');
        btn?.addEventListener('click', async () => {
            btn.disabled = true;
            btn.classList.add('opacity-60');
            statusDiv.textContent = '正在同步...';
            window.applicationAPI.sendMessageToApplication('synchronize');
        });
    }
}

customElements.define('synchronizer-entry-widget', SynchronizerEntryWidget);