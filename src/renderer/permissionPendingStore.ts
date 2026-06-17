export interface PendingPermissionRequest<TData = unknown> {
    requestId: string;
    data: TData;
}

export type PermissionRequestCallback<TData = unknown> = (requestId: string, data: TData) => void;
export type PermissionDismissCallback = (requestId: string) => void;

export class PermissionPendingStore<TData = unknown> {
    private pendingRequests = new Map<string, TData>();
    private requestCallbacks = new Set<PermissionRequestCallback<TData>>();
    private dismissCallbacks = new Set<PermissionDismissCallback>();

    receiveRequest(requestId: string, data: TData): void {
        this.pendingRequests.set(requestId, data);
        for (const callback of this.requestCallbacks) {
            callback(requestId, data);
        }
    }

    receiveDismiss(requestId: string): void {
        this.pendingRequests.delete(requestId);
        for (const callback of this.dismissCallbacks) {
            callback(requestId);
        }
    }

    respond(requestId: string): void {
        this.pendingRequests.delete(requestId);
    }

    onRequest(callback: PermissionRequestCallback<TData>): void {
        this.requestCallbacks.add(callback);
        for (const [requestId, data] of this.pendingRequests) {
            callback(requestId, data);
        }
    }

    offRequest(callback: PermissionRequestCallback<TData>): void {
        this.requestCallbacks.delete(callback);
    }

    onDismiss(callback: PermissionDismissCallback): void {
        this.dismissCallbacks.add(callback);
    }

    offDismiss(callback: PermissionDismissCallback): void {
        this.dismissCallbacks.delete(callback);
    }

    getPendingRequests(): PendingPermissionRequest<TData>[] {
        return Array.from(this.pendingRequests, ([requestId, data]) => ({ requestId, data }));
    }
}
