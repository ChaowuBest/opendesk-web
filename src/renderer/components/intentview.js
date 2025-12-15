class IntentView extends HTMLElement {
}

class IntentListView extends HTMLElement {
    constructor() {
        super();
        /** @type {IntentInstance[]} */
        this.intents = [];
    }

    connectedCallback() {
        this.render();
        window.floatWindowAPI.subscribeIntentsUpdate((intents) => {
            this.intents = intents;
            this.render();
        });
    }

    render() {
        this.innerHTML = 'abc';
        if (this.intents.length === 0) {
            this.innerHTML = '<loading-view/>';
            return;
        }

        let intent_items = '';
        for (let intent of this.intents) {
            intent_items += `
            <div class="flex items-center rounded-xl p-4 hover:bg-gray-50 cursor-pointer transition-colors">
                <!-- 左侧图标 -->
                <div class="flex-shrink-0 w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center mr-3">

                </div>

                <!-- 中间内容 -->
                <div class="flex-1 min-w-0">
                    <h3 class="text-sm font-medium text-gray-900 truncate">${intent.name}</h3>
                    <p class="text-sm text-gray-500 truncate">${intent.reasoning}</p>
                </div>

                <!-- 右侧箭头 -->
                <div class="flex-shrink-0 ml-2">
                    <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                    </svg>
                </div>
            </div>
            `;
        }

        this.innerHTML = `
        <div class="w-full mx-auto bg-white rounded-xl shadow-sm">
            <!-- 列表容器 -->
            <div class="divide-y divide-gray-100">
                ${intent_items}
            </div>
        </div>
        `;
    }
}

customElements.define('intent-view', IntentView);
customElements.define('intent-list-view', IntentListView);