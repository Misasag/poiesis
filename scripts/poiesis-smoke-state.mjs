import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export const DURABLE_SESSION_KEY = 'poiesis.agent-window.sessions.global.v1';
export const DURABLE_SESSION_MIGRATION_KEY = 'poiesis.agent-window.sessions.migrated.v1';
export const DURABLE_REQUIREMENTS_KEY = 'poiesis.requirements.sessions.v1';
export const DURABLE_REQUIREMENTS_MIGRATION_KEY = 'poiesis.requirements.migrated.v1';
export const DURABLE_RESULTS_QUESTION_KEY = 'poiesis.results-question.sessions.v1';
export const DURABLE_RESULTS_QUESTION_MIGRATION_KEY = 'poiesis.results-question.migrated.v1';

const STATE_SEGMENT = ['poiesis', 'state-v1'];
const STABLE_MS = 200;
const POLL_MS = 50;

export function durableStateRoot(theiaConfigDir) {
    const configDir = isolatedConfigDir(theiaConfigDir);
    const root = resolve(configDir, ...STATE_SEGMENT);
    assertInside(configDir, root);
    return root;
}

export function durableStatePath(theiaConfigDir, key) {
    assertDurableKey(key);
    const root = durableStateRoot(theiaConfigDir);
    const filePath = resolve(root, `${encodeURIComponent(key)}.json`);
    assertInside(root, filePath);
    return filePath;
}

export function durableValueExists(theiaConfigDir, key) {
    return existsSync(durableStatePath(theiaConfigDir, key));
}

export function readDurableValue(theiaConfigDir, key) {
    const filePath = durableStatePath(theiaConfigDir, key);
    if (!existsSync(filePath)) {
        return undefined;
    }
    const raw = readUtf8(filePath);
    let envelope;
    try {
        envelope = JSON.parse(raw);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Durable state is not valid JSON for ${key}: ${detail}`);
    }
    assertEnvelope(envelope, key);
    return envelope.present ? envelope.value : undefined;
}

export function writeDurableValue(theiaConfigDir, key, value) {
    const filePath = durableStatePath(theiaConfigDir, key);
    mkdirSync(durableStateRoot(theiaConfigDir), { recursive: true });
    const envelope = {
        format: 1,
        key,
        present: value !== undefined,
        ...(value !== undefined ? { value } : {})
    };
    writeFileSync(filePath, JSON.stringify(envelope), 'utf8');
}

export function updateDurableValue(theiaConfigDir, key, mutator) {
    const current = readDurableValue(theiaConfigDir, key);
    const next = mutator(current);
    if (current === undefined && next === undefined) {
        return undefined;
    }
    writeDurableValue(theiaConfigDir, key, next);
    return next;
}

export async function waitForDurableValue(theiaConfigDir, key, predicate, timeoutMs) {
    const deadline = Date.now() + requireTimeout(timeoutMs);
    let lastValue;
    let lastError;
    while (Date.now() < deadline) {
        try {
            lastValue = readDurableValue(theiaConfigDir, key);
            lastError = undefined;
            if (predicate(lastValue)) {
                return lastValue;
            }
        } catch (error) {
            lastError = error;
        }
        await delay(POLL_MS);
    }
    const detail = lastError instanceof Error
        ? lastError.message
        : lastError
            ? String(lastError)
            : summarize(lastValue);
    throw new Error(`Timed out waiting for durable state ${key}: ${detail}`);
}

export async function waitForDurableWritesToSettle(theiaConfigDir, timeoutMs) {
    const deadline = Date.now() + requireTimeout(timeoutMs);
    const root = durableStateRoot(theiaConfigDir);
    let stableSince;
    let snapshot = '';
    while (Date.now() < deadline) {
        if (!existsSync(root)) {
            return;
        }
        const names = readdirSync(root);
        if (names.some(name => name.endsWith('.tmp'))) {
            stableSince = undefined;
            snapshot = '';
            await delay(POLL_MS);
            continue;
        }
        const nextSnapshot = names
            .filter(name => !name.endsWith('.tmp'))
            .sort()
            .map(name => {
                const info = statSync(resolve(root, name));
                return `${name}:${info.size}:${info.mtimeMs}`;
            })
            .join('|');
        if (nextSnapshot === snapshot) {
            if (stableSince !== undefined && Date.now() - stableSince >= STABLE_MS) {
                return;
            }
            stableSince ??= Date.now();
        } else {
            snapshot = nextSnapshot;
            stableSince = Date.now();
        }
        await delay(POLL_MS);
    }
    throw new Error(`Timed out waiting for durable writes to settle in ${root}.`);
}

function isolatedConfigDir(theiaConfigDir) {
    if (typeof theiaConfigDir !== 'string' || theiaConfigDir.trim() === '') {
        throw new Error('Isolated THEIA_CONFIG_DIR is required.');
    }
    const resolved = resolve(theiaConfigDir);
    const normalized = resolved.replaceAll('\\', '/').toLowerCase();
    if (!normalized.includes('/.run/') || !normalized.endsWith('/theia-config')) {
        throw new Error(`Refusing durable I/O outside an isolated test THEIA_CONFIG_DIR: ${resolved}`);
    }
    return resolved;
}

function assertDurableKey(key) {
    if (typeof key !== 'string' || key.trim() === '') {
        throw new Error('Durable state key is required.');
    }
}

function assertEnvelope(envelope, key) {
    if (!envelope || typeof envelope !== 'object'
        || envelope.format !== 1
        || envelope.key !== key
        || typeof envelope.present !== 'boolean') {
        throw new Error(`Invalid durable data envelope for ${key}.`);
    }
}

function assertInside(rootDir, candidate) {
    const root = resolve(rootDir);
    const target = resolve(candidate);
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    const comparableRoot = process.platform === 'win32' ? prefix.toLowerCase() : prefix;
    const comparableTarget = process.platform === 'win32' ? target.toLowerCase() : target;
    const comparableExact = process.platform === 'win32' ? root.toLowerCase() : root;
    if (comparableTarget !== comparableExact && !comparableTarget.startsWith(comparableRoot)) {
        throw new Error(`Refusing path outside isolated durable state directory: ${target}`);
    }
}

function readUtf8(filePath) {
    const raw = readFileSync(filePath, 'utf8');
    return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
}

function requireTimeout(timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('A positive timeout is required for durable state waits.');
    }
    return timeoutMs;
}

function summarize(value) {
    try {
        return JSON.stringify(value).slice(0, 500);
    } catch {
        return String(value);
    }
}

function delay(ms) {
    return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}
