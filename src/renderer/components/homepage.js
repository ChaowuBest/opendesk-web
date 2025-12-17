class HomePage extends HTMLElement {
    constructor() {
        super();
    }

    connectedCallback() {
        this.render();
    }

    render() {
        this.innerHTML = `
        <div class="w-full h-full">
            <h1>Home Page</h1>
        </div>
        `;
    }
}

customElements.define('home-page', HomePage);