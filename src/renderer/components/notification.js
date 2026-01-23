const WARNING_ICON = `
<div class="flex-shrink-0 text-orange-500">
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
</div>
`

const INFO_ICON = `
<div class="flex-shrink-0 text-green-500">
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
</div>
`

const ERROR_ICON = `
<div class="flex-shrink-0 text-red-500">
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
</div>
`

const ICON_MAP = {
    'warning': WARNING_ICON,
    'info': INFO_ICON,
    'error': ERROR_ICON
}

class NotificationPanel extends HTMLElement {

    constructor() {
        super();
        /** @type {Map<string, NodeJS.Timeout>} */
        this.closeNotificationTimeouts = new Map();
    }

    connectedCallback() {
        this.render();
        window.notificationAPI.subscribeNotification(this.onNotificationReceived.bind(this)).then(subscriptionId => {
            console.info(`notification subscribed`, subscriptionId);
        });
    }

    onNotificationReceived(type, source, title, message) {
        console.info(`notification received`, type, source, title, message);
        const icon = ICON_MAP[type];
        const notificationId = crypto.randomUUID();
        const notificationHtml = `
        <div
            id="notification-${notificationId}"
            class="group relative overflow-hidden rounded-[22px] bg-white/70 p-4 shadow-[0_10px_30px_-5px_rgba(0,0,0,0.1)] backdrop-blur-xl ring-1 ring-black/5 transition-all duration-300 hover:bg-gray-50"
        >
            <div class="flex gap-3 items-center">
                ${icon}
                <div class="flex-1">
                    <h3 class="text-[14px] font-semibold text-gray-900">${title} <span class="text-xs text-gray-500">(@${source})</span></h3>
                    <p class="text-[13px] leading-tight text-gray-600/90">${message}</p>
                </div>
                <button
                    class="close-notification-btn opacity-0 group-hover:opacity-100 transition-opacity w-8 h-8 flex items-center justify-center rounded-full hover:bg-black/5"
                    data-notification_id="${notificationId}"
                >
                    <i class="fa fa-times text-gray-400"></i>
                </button>
            </div>
        </div>
        `
        this.insertAdjacentHTML('beforeend', notificationHtml);
        const notificationElement = this.querySelector(`#notification-${notificationId}`);
        notificationElement.animate(
            [
                { transform: 'translateX(500px)' },
                { transform: 'translateX(0)' }
            ],
            {
                duration: 500,
                fill: 'forwards',
                easing: 'ease-in-out'
            }
        );

        // 只为新添加的按钮添加事件监听器，避免重复添加
        const closeBtn = notificationElement.querySelector(`.close-notification-btn`);
        closeBtn.addEventListener('click', async () => {
            const notificationId = closeBtn.getAttribute('data-notification_id');
            console.info('close notification btn clicked', notificationId);
            await this.closeNotification(notificationId);
        });

        this.closeNotificationTimeouts.set(notificationId, setTimeout(async () => {
            await this.closeNotification(notificationId);
        }, 5000));
    }

    async closeNotification(notificationId) {
        // 清除自动关闭的timeout（如果存在）
        const timeout = this.closeNotificationTimeouts.get(notificationId);
        if (timeout) {
            this.closeNotificationTimeouts.delete(notificationId);
            clearTimeout(timeout);
        }

        // 查找通知元素
        const notificationElement = this.querySelector(`#notification-${notificationId}`);
        if (!notificationElement) {
            // 如果元素已经不存在，直接返回
            return;
        }

        // 执行关闭动画并移除元素
        try {
            await notificationElement.animate([
                { transform: 'translateX(0)' },
                { transform: 'translateX(500px)' }
            ], {
                duration: 500,
                fill: 'forwards',
                easing: 'ease-in-out'
            }).finished;
            notificationElement.remove();
        } catch (error) {
            // 如果动画失败，直接移除元素
            console.warn('Failed to animate notification close:', error);
            notificationElement.remove();
        }
    }

    render() {
        this.innerHTML = ``;
    }
}

customElements.define('notification-panel', NotificationPanel);