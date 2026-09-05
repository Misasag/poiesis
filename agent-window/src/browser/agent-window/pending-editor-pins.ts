export interface PendingEditorPinRequest {
    isActive(): boolean;
    dispose(): void;
}

export class PendingEditorPins {
    protected readonly requests = new Map<string, Set<symbol>>();

    has(uri: string): boolean {
        return Boolean(this.requests.get(uri)?.size);
    }

    begin(uri: string): PendingEditorPinRequest {
        const token = Symbol(uri);
        const existing = this.requests.get(uri);
        if (existing) {
            existing.add(token);
        } else {
            this.requests.set(uri, new Set([token]));
        }
        let disposed = false;
        return {
            isActive: () => this.requests.get(uri)?.has(token) === true,
            dispose: () => {
                if (disposed) {
                    return;
                }
                disposed = true;
                const current = this.requests.get(uri);
                if (!current?.delete(token)) {
                    return;
                }
                if (current.size === 0) {
                    this.requests.delete(uri);
                }
            }
        };
    }

    clear(): void {
        this.requests.clear();
    }
}
