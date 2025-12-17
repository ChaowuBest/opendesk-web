class LogView extends HTMLElement {
    constructor() {
        super();
        this._interval = null;
    }

    connectedCallback() {
        this.render();
        this._interval = setInterval(() => {
            this.reload();
        }, 1000);
    }

    disconnectedCallback() {
        clearInterval(this._interval);
    }

    reload() {
        window.settingAPI.getLogContent().then(content => {
            this.querySelector('#log-content').innerHTML = content;
        })
    }

    render() {
        this.innerHTML = `
        <div class="w-full h-full p-2">
            <pre id="log-content" class="w-full h-full text-xs"></pre>
        </div>
        `
    }
}

customElements.define('log-view', LogView);