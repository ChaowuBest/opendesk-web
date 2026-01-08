export class ElasticToolbarWidget extends HTMLElement {

    /**
     * @param {Array<{id: string, icon: string, label: string, action: () => void}>} buttons
     */
    constructor(buttons = []) {
        super();
        this.buttons = buttons;
        this.uid = crypto.randomUUID();
    }

    connectedCallback() {
        this.render();
    }

    render() {
        const topButtonsHTML = this.buttons.map(button => `
        <button id='${button.id}-${this.uid}' class="group flex items-center px-2 py-2 rounded-full
                    bg-transparent hover:bg-white/60 hover:shadow-md
                    transition-all duration-500 ease-[cubic-bezier(0.23,1,0.32,1)]
                    text-gray-700 hover:text-blue-600">
            <i class="fa-solid ${button.icon}"></i>
            <span class="max-w-0 overflow-hidden opacity-0
                        group-hover:max-w-[120px] group-hover:opacity-100
                        group-hover:ml-2 transition-all duration-500 ease-in-out
                        whitespace-nowrap font-medium tracking-tight text-sm">
                ${button.label}
            </span>
        </button>
        `
        ).join('');

        let toolbarHTML = `
        <!-- 顶部工具栏 -->
        <header class="h-16 pl-3 pr-16 border-b flex items-center justify-between">
            <div class="flex items-center gap-2 p-1">
                ${topButtonsHTML}
            </div>
        </header>
        `;

        this.innerHTML = toolbarHTML;
        this.buttons.forEach(button => {
            this.querySelector(`#${button.id}-${this.uid}`).addEventListener('click', () => {
                button.action();
            });
        });
    }
}

customElements.define('elastic-toolbar-widget', ElasticToolbarWidget);