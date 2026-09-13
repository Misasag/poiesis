import assert from 'node:assert/strict';
import { ThemePreferenceService } from '../agent-window/lib/browser/theme-preference-service.js';

class FakeMediaQuery {
    constructor(matches = false) {
        this.matches = matches;
        this.listeners = new Set();
    }

    addEventListener(type, listener) {
        assert.equal(type, 'change');
        this.listeners.add(listener);
    }

    removeEventListener(type, listener) {
        assert.equal(type, 'change');
        this.listeners.delete(listener);
    }

    setMatches(matches) {
        this.matches = matches;
        for (const listener of this.listeners) {
            listener({ matches });
        }
    }
}

class FakeThemeService {
    constructor() {
        this.current = { id: 'light', type: 'light' };
        this.initialized = Promise.resolve();
        this.listeners = new Set();
        this.applications = [];
    }

    getCurrentTheme() {
        return this.current;
    }

    setCurrentTheme(id, persist) {
        const oldTheme = this.current;
        this.current = { id, type: id };
        this.applications.push({ id, persist });
        for (const listener of this.listeners) {
            listener({ newTheme: this.current, oldTheme });
        }
    }

    onDidColorThemeChange(listener) {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }
}

class FakeStorage {
    constructor(value) {
        this.value = value;
        this.writes = [];
    }

    async getData() {
        return this.value;
    }

    async setData(key, value) {
        this.writes.push({ key, value });
    }
}

const preferenceService = { ready: Promise.resolve() };
const applicationState = { reachedState: async state => assert.equal(state, 'ready') };

{
    let resolvePreferences;
    const preferences = { ready: new Promise(resolve => { resolvePreferences = resolve; }) };
    installDom(new FakeMediaQuery(false));
    const theme = new FakeThemeService();
    const service = new ThemePreferenceService(theme, preferences, new FakeStorage({ version: 1, preference: 'light' }), applicationState);
    const restored = new Promise(resolve => service.onDidChange(resolve));
    // Theia awaits early contribution hooks before starting preference providers.
    const startup = (async () => {
        await service.initialize?.();
        await service.configure?.();
        await service.onStart();
        resolvePreferences();
        await restored;
    })();
    let timeout;
    try {
        await Promise.race([startup, new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Theme restoration blocked frontend startup')), 1000);
        })]);
        assert.equal(theme.current.id, 'light');
    } finally {
        clearTimeout(timeout);
        service.dispose();
    }
}

function installDom(media) {
    const documentElement = { dataset: {}, style: {} };
    globalThis.document = { documentElement };
    globalThis.window = { matchMedia: query => {
        assert.equal(query, '(prefers-color-scheme: dark)');
        return media;
    } };
    return documentElement;
}

async function create(value, systemDark = false) {
    const media = new FakeMediaQuery(systemDark);
    const root = installDom(media);
    const theme = new FakeThemeService();
    const storage = new FakeStorage(value);
    const service = new ThemePreferenceService(theme, preferenceService, storage, applicationState);
    await service.restoreTheme();
    return { media, root, service, storage, theme };
}

{
    const restored = await create({ version: 1, preference: 'light' }, true);
    assert.equal(restored.service.preference, 'light');
    assert.equal(restored.service.effectiveMode, 'light');
    assert.equal(restored.theme.current.id, 'light');
    assert.equal(restored.root.dataset.poiesisThemePreference, 'light');
    assert.equal(restored.root.dataset.poiesisColorMode, 'light');
    restored.service.dispose();
}

for (const malformed of [undefined, 'light', { version: 0, preference: 'light' }, { version: 1, preference: 'sepia' }]) {
    const restored = await create(malformed);
    assert.equal(restored.service.preference, 'dark', 'Malformed and legacy values must retain the historical dark default');
    assert.equal(restored.theme.current.id, 'dark');
    restored.service.dispose();
}

{
    const system = await create({ version: 1, preference: 'system' }, false);
    assert.equal(system.theme.current.id, 'light');
    system.media.setMatches(true);
    assert.equal(system.theme.current.id, 'dark', 'System mode must follow a live dark-scheme change');
    system.service.setPreference('light');
    const applications = system.theme.applications.length;
    system.media.setMatches(false);
    system.media.setMatches(true);
    assert.equal(system.theme.applications.length, applications, 'OS changes must not override an explicit choice');
    assert.deepEqual(system.storage.writes.at(-1), {
        key: 'poiesis.theme-preference.v1',
        value: { version: 1, preference: 'light' }
    });
    system.service.dispose();
    assert.equal(system.media.listeners.size, 0, 'Disposal must remove the media-query subscription');
    assert.equal(system.theme.listeners.size, 0, 'Disposal must remove the Theia theme subscription');
}

{
    let resolveRestore;
    const pendingRestore = new Promise(resolve => { resolveRestore = resolve; });
    const media = new FakeMediaQuery(false);
    installDom(media);
    const theme = new FakeThemeService();
    const storage = new FakeStorage(undefined);
    storage.getData = () => pendingRestore;
    const service = new ThemePreferenceService(theme, preferenceService, storage, applicationState);
    const initializing = service.restoreTheme();
    service.setPreference('light');
    theme.setCurrentTheme('dark', false);
    resolveRestore({ version: 1, preference: 'system' });
    await initializing;
    assert.equal(service.preference, 'light', 'A late restore must not overwrite an immediate user choice');
    assert.equal(theme.current.id, 'light', 'Startup theme initialization must not undo an immediate user choice');
    service.dispose();
}

console.log('Theme preference behavior verified.');
