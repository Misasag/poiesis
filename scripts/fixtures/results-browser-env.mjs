import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require.extensions['.css'] = () => undefined;

class ElementStub {
    constructor() {
        this.classList = { add() {}, remove() {} };
        this.style = {};
        this.dataset = {};
        this.children = [];
    }
    matches() { return false; }
    setAttribute() {}
    appendChild(child) { this.children.push(child); return child; }
    addEventListener() {}
    removeEventListener() {}
}
for (const name of ['Element', 'HTMLElement', 'DragEvent', 'MouseEvent', 'KeyboardEvent', 'Event', 'CustomEvent', 'FocusEvent']) {
    globalThis[name] = ElementStub;
}
globalThis.document = {
    createElement: () => new ElementStub(),
    body: new ElementStub(),
    documentElement: new ElementStub(),
    addEventListener() {},
    removeEventListener() {},
    queryCommandSupported: () => false
};
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { platform: 'Win32', userAgent: 'node' }
});
require('@theia/core/lib/browser/frontend-application-config-provider').FrontendApplicationConfigProvider.set({});

