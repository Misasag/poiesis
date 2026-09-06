import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    CliModelDiscoveryService,
    CodexModelListClient,
    GrokModelListClient,
    parseGrokModelsOutput
} = require('../agent-window/lib/node/cli-model-discovery.js');
const { CliProviderRegistry } = require('../agent-window/lib/node/cli-provider-registry.js');

class FakeChild extends EventEmitter {
    constructor(handleRequest) {
        super();
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        this.killed = 0;
        this.requests = [];
        this.stdin = new Writable({
            write: (chunk, _encoding, callback) => {
                try {
                    const request = JSON.parse(chunk.toString('utf8'));
                    this.requests.push(request);
                    handleRequest(request, this);
                    callback();
                } catch (error) {
                    callback(error);
                }
            }
        });
    }

    respond(message) {
        this.stdout.write(`${JSON.stringify(message)}\n`);
    }

    kill() {
        this.killed += 1;
        return true;
    }
}

const protocolChild = new FakeChild((request, child) => {
    if (request.method === 'initialize') {
        child.respond({ jsonrpc: '2.0', id: request.id, result: { serverInfo: { name: 'codex' } } });
    } else if (request.method === 'model/list' && !request.params.cursor) {
        child.respond({
            jsonrpc: '2.0',
            id: request.id,
            result: {
                data: [
                    {
                        model: 'gpt-6-astra', displayName: 'GPT-6-Astra', hidden: false,
                        isDefault: true, defaultReasoningEffort: 'medium',
                        supportedReasoningEfforts: [
                            { reasoningEffort: 'low', description: 'Fast' },
                            { reasoningEffort: 'medium', description: 'Balanced' },
                            { reasoningEffort: 'ultra', description: 'Longest' },
                            { reasoningEffort: 'injected', description: 'Invalid' }
                        ],
                        inputModalities: ['text', 'image']
                    },
                    { model: 'hidden-model', displayName: 'Hidden', hidden: true }
                ],
                nextCursor: 'page-2'
            }
        });
    } else if (request.method === 'model/list' && request.params.cursor === 'page-2') {
        child.respond({
            jsonrpc: '2.0',
            id: request.id,
            result: {
                data: [
                    { model: 'gpt-6-astra', displayName: 'Duplicate', hidden: false },
                    {
                        model: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', hidden: false,
                        defaultReasoningEffort: 'high',
                        supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Deep' }],
                        inputModalities: ['text']
                    }
                ],
                nextCursor: null
            }
        });
    }
});
const protocolClient = new CodexModelListClient({ timeoutMs: 1_000, spawn: () => protocolChild });
const protocolModels = await protocolClient.listModels('C:\\Tools\\codex.exe');
assert.deepEqual(protocolModels.map(model => model.id), ['gpt-6-astra', 'gpt-5.6-luna'],
    'Hidden and duplicate model entries must not reach the picker.');
assert.deepEqual(protocolModels[0].supportedReasoningEfforts, ['low', 'medium', 'ultra']);
assert.equal(protocolModels[0].isCatalogDefault, true);
assert.equal(protocolModels[0].defaultReasoningEffort, 'medium');
assert.deepEqual(protocolModels[0].inputModalities, ['text', 'image']);
assert.deepEqual(protocolChild.requests.map(request => request.method), [
    'initialize', 'initialized', 'model/list', 'model/list'
]);
assert.deepEqual(protocolChild.requests[2].params, { limit: 100, includeHidden: false });
assert.deepEqual(protocolChild.requests[3].params, { limit: 100, includeHidden: false, cursor: 'page-2' });
assert.equal(protocolChild.killed, 1, 'The app-server process must be cleaned up after success.');

for (const scenario of [
    {
        name: 'malformed output',
        handle: (request, child) => child.stdout.write('{not-json}\n'),
        message: /malformed JSON/
    },
    {
        name: 'null envelope',
        handle: (_request, child) => child.stdout.write('null\n'),
        message: /invalid response envelope/
    },
    {
        name: 'array envelope',
        handle: (_request, child) => child.stdout.write('[]\n'),
        message: /invalid response envelope/
    },
    {
        name: 'protocol error',
        handle: (request, child) => child.respond({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'private detail' } }),
        message: /protocol error \(-32000\)/
    },
    {
        name: 'oversized output',
        handle: (request, child) => child.stdout.write(Buffer.alloc(1_048_577, 0x61)),
        message: /response line exceeded/
    }
]) {
    const child = new FakeChild(scenario.handle);
    const client = new CodexModelListClient({ timeoutMs: 1_000, spawn: () => child });
    await assert.rejects(client.listModels('fake-codex'), scenario.message, scenario.name);
    assert.equal(child.killed, 1, `${scenario.name} must clean up the process.`);
}

for (const scenario of [
    { name: 'stdin EPIPE', emit: child => child.stdin.emit('error', new Error('EPIPE')), message: /could not be written/ },
    { name: 'stdout stream error', emit: child => child.stdout.emit('error', new Error('stream')), message: /output stream failed/ },
    { name: 'stderr stream error', emit: child => child.stderr.emit('error', new Error('stream')), message: /diagnostic stream failed/ }
]) {
    const child = new FakeChild((_request, subject) => scenario.emit(subject));
    await assert.rejects(
        new CodexModelListClient({ timeoutMs: 1_000, spawn: () => child }).listModels('fake-codex'),
        scenario.message,
        scenario.name
    );
    assert.equal(child.killed, 1, `${scenario.name} must clean up the process.`);
}

const timeoutChild = new FakeChild(() => undefined);
await assert.rejects(
    new CodexModelListClient({ timeoutMs: 100, spawn: () => timeoutChild }).listModels('fake-codex'),
    /timed out/
);
assert.ok(timeoutChild.killed >= 1, 'A timed-out app-server process must be killed.');

await assert.rejects(
    new CodexModelListClient({ spawn: () => { throw new Error('startup failed'); } }).listModels('fake-codex'),
    /startup failed/,
    'A synchronous process startup error must reject model discovery.'
);

const repeatedCursorChild = new FakeChild((request, child) => {
    if (request.method === 'initialize') {
        child.respond({ jsonrpc: '2.0', id: request.id, result: {} });
    } else if (request.method === 'model/list') {
        child.respond({ jsonrpc: '2.0', id: request.id, result: { data: [], nextCursor: 'same-cursor' } });
    }
});
await assert.rejects(
    new CodexModelListClient({ timeoutMs: 1_000, spawn: () => repeatedCursorChild }).listModels('fake-codex'),
    /repeated a pagination cursor/
);
assert.equal(repeatedCursorChild.killed, 1);

let hangingCleanupCalls = 0;
const hangingCleanupChild = new FakeChild((request, child) => {
    if (request.method === 'initialize') {
        child.respond({ jsonrpc: '2.0', id: request.id, result: {} });
    } else if (request.method === 'model/list') {
        child.respond({ jsonrpc: '2.0', id: request.id, result: { data: [{ model: 'bounded-cleanup' }] } });
    }
});
const cleanupStartedAt = Date.now();
const hangingCleanupModels = await new CodexModelListClient({
    timeoutMs: 1_000,
    cleanupTimeoutMs: 50,
    spawn: () => hangingCleanupChild,
    cleanup: () => {
        hangingCleanupCalls += 1;
        return new Promise(() => undefined);
    }
}).listModels('fake-codex');
assert.deepEqual(hangingCleanupModels.map(model => model.id), ['bounded-cleanup']);
assert.equal(hangingCleanupCalls, 1, 'Timeout and finally must share one cleanup task.');
assert.equal(hangingCleanupChild.killed, 1, 'A hanging cleanup helper must fall back to direct process termination.');
assert.ok(Date.now() - cleanupStartedAt < 500, 'A hanging cleanup helper must remain bounded.');

let boundedSpawnCalls = 0;
const boundedClient = new CodexModelListClient({
    timeoutMs: 1_000,
    cleanupTimeoutMs: 50,
    cleanup: () => new Promise(() => undefined),
    spawn: () => {
        boundedSpawnCalls += 1;
        return new FakeChild((request, child) => {
            if (request.method === 'initialize') {
                child.respond({ jsonrpc: '2.0', id: request.id, result: {} });
            } else if (request.method === 'model/list') {
                child.respond({ jsonrpc: '2.0', id: request.id, result: { data: [{ model: `bounded-${boundedSpawnCalls}` }] } });
            }
        });
    }
});
const boundedService = new CliModelDiscoveryService(boundedClient);
const boundedInput = { providerId: 'codex', command: 'bounded-codex', version: '1', fallbackModels: [] };
await boundedService.discover({ ...boundedInput, refresh: true });
await boundedService.discover({ ...boundedInput, refresh: true });
assert.equal(boundedSpawnCalls, 2, 'A bounded cleanup must eventually clear the service in-flight entry.');

assert.deepEqual(
    parseGrokModelsOutput([
        'Account status: signed in',
        'Available models:',
        '  * grok-4.6 (default)',
        '  - grok-4.5',
        '  - grok-4.5',
        'Default model: grok-4.6',
        '  - outside-section'
    ].join('\n')),
    [
        { id: 'grok-4.6', label: 'grok-4.6', isCatalogDefault: true },
        { id: 'grok-4.5', label: 'grok-4.5' }
    ],
    'Grok discovery must parse only documented rows in the Available models section.'
);
assert.throws(() => parseGrokModelsOutput('Available models:\n * malformed\nDefault model: grok-4.6'), /invalid model list/);

const grokChild = new FakeChild(() => undefined);
const grokClient = new GrokModelListClient({
    timeoutMs: 1_000,
    spawn: () => {
        queueMicrotask(() => {
            grokChild.stderr.write('private startup status');
            grokChild.stdout.write('Available models:\n  * grok-4.6 (default)\n  - grok-4.5\nDefault model: grok-4.6\n');
            grokChild.emit('close', 0);
        });
        return grokChild;
    }
});
assert.deepEqual((await grokClient.listModels('fake-grok')).map(model => model.id), ['grok-4.6', 'grok-4.5']);
assert.equal(grokChild.killed, 1);
const grokTimeoutChild = new FakeChild(() => undefined);
await assert.rejects(
    new GrokModelListClient({ timeoutMs: 100, spawn: () => grokTimeoutChild }).listModels('fake-grok'),
    /timed out/
);
assert.equal(grokTimeoutChild.killed, 1, 'A stalled Grok model list must be terminated.');
const oversizedGrokChild = new FakeChild(() => undefined);
await assert.rejects(
    new GrokModelListClient({
        timeoutMs: 1_000,
        spawn: () => {
            queueMicrotask(() => oversizedGrokChild.stdout.write(Buffer.alloc(256 * 1_024 + 1, 0x61)));
            return oversizedGrokChild;
        }
    }).listModels('fake-grok'),
    /exceeded the safe limit/
);
assert.equal(oversizedGrokChild.killed, 1, 'Oversized Grok output must be terminated.');
const grokService = new CliModelDiscoveryService(
    { async listModels() { throw new Error('Codex client must not handle Grok.'); } },
    60_000,
    { async listModels(command) {
        assert.equal(command, 'fake-grok');
        return [{ id: 'grok-4.6', label: 'grok-4.6', isCatalogDefault: true }];
    } }
);
const liveGrok = await grokService.discover({
    providerId: 'grok', command: 'fake-grok', version: '1.0.5', fallbackModels: []
});
assert.equal(liveGrok.source, 'live');
assert.deepEqual(liveGrok.models.map(model => model.id), ['', 'grok-4.6'],
    'Grok discovery must preserve a separate blank CLI-configured default choice.');

let resolveLive;
let clientCalls = 0;
const liveModels = [{ id: 'live-model', label: 'Live Model', supportedReasoningEfforts: ['max'] }];
const cacheClient = {
    listModels() {
        clientCalls += 1;
        return new Promise(resolve => resolveLive = resolve);
    }
};
const service = new CliModelDiscoveryService(cacheClient, 60_000);
const discoveryInput = {
    providerId: 'codex', command: 'fake-codex', fallbackModels: [{ id: '', label: '既定' }, { id: 'fallback', label: 'Fallback' }]
};
const first = service.discover(discoveryInput);
const duplicate = service.discover({ ...discoveryInput, refresh: true });
assert.equal(first, duplicate, 'Concurrent discovery calls must share one in-flight request.');
assert.equal(clientCalls, 1);
resolveLive(liveModels);
const live = await first;
assert.equal(live.source, 'live');
assert.deepEqual(live.models.map(model => model.id), ['', 'live-model']);
const cached = await service.discover(discoveryInput);
assert.equal(cached.source, 'cached');
assert.equal(clientCalls, 1, 'A fresh cache entry must avoid another process.');

cacheClient.listModels = async () => {
    clientCalls += 1;
    throw new Error('transient private failure');
};
const stale = await service.discover({ ...discoveryInput, refresh: true });
assert.equal(stale.source, 'cached');
assert.deepEqual(stale.models.map(model => model.id), ['', 'live-model']);
assert.match(stale.error, /前回取得/);
assert.ok(!stale.error.includes('private'), 'Raw process errors must not cross the RPC boundary.');

const changedExecutable = await service.discover({
    ...discoveryInput,
    command: 'different-codex',
    refresh: true
});
assert.equal(changedExecutable.source, 'fallback',
    'A changed executable identity must not reuse a previous command\'s last-good catalog.');
const changedVersion = await service.discover({
    ...discoveryInput,
    version: 'different-version',
    refresh: true
});
assert.equal(changedVersion.source, 'fallback',
    'A changed CLI version must not reuse a previous version\'s last-good catalog.');

const fallback = await service.discover({
    providerId: 'claude', command: 'fake-claude', fallbackModels: [{ id: '', label: '既定' }, { id: 'sonnet', label: 'sonnet' }]
});
assert.equal(fallback.source, 'fallback');
assert.deepEqual(fallback.models.map(model => model.id), ['', 'sonnet']);
const startupFallback = await new CliModelDiscoveryService({
    async listModels() { throw new Error('startup private failure'); }
}).discover({
    providerId: 'codex', command: 'fake-codex', fallbackModels: [{ id: '', label: '既定' }, { id: 'fallback', label: 'Fallback' }]
});
assert.equal(startupFallback.source, 'fallback');
assert.match(startupFallback.error, /同梱/);
assert.ok(!startupFallback.error.includes('private'));
const failed = await service.discover({ providerId: 'gemini', fallbackModels: [] });
assert.equal(failed.source, 'failed');

let inFlightResolve;
let identityCalls = 0;
const identityService = new CliModelDiscoveryService({
    listModels(command) {
        identityCalls += 1;
        if (command === 'first-codex') {
            return new Promise(resolve => inFlightResolve = resolve);
        }
        return Promise.resolve([{ id: 'second-live', label: 'Second Live' }]);
    }
});
const firstIdentity = identityService.discover({
    providerId: 'codex', command: 'first-codex', version: '1', fallbackModels: []
});
const secondIdentity = identityService.discover({
    providerId: 'codex', command: 'second-codex', version: '1', fallbackModels: []
});
assert.notEqual(firstIdentity, secondIdentity, 'Different executable identities must not share an in-flight request.');
assert.equal((await secondIdentity).models[1].id, 'second-live');
inFlightResolve([{ id: 'first-live', label: 'First Live' }]);
await firstIdentity;
assert.equal(identityCalls, 2);

const capabilityService = new CliModelDiscoveryService({
    async listModels() {
        return [{
            id: 'gpt-6-astra', label: 'GPT-6-Astra',
            supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
        }];
    }
});
const capabilityInput = {
    providerId: 'codex', command: 'capability-codex', version: '0.153.4', fallbackModels: []
};
await capabilityService.discover(capabilityInput);
for (const role of ['agent', 'results']) {
    const registry = new CliProviderRegistry({
        recordedReport: {
            detections: [{
                id: 'codex', name: 'Codex', status: 'found', path: capabilityInput.command,
                version: capabilityInput.version, executableRoles: ['agent', 'results']
            }]
        }
    }, capabilityService);
    await assert.rejects(
        registry.resolve(role, 'codex', 'gpt-6-astra', 'minimal'),
        /既定.*対応する値/,
        `A saved unsupported effort must stop ${role} before its caller can spawn a CLI.`
    );
    const supported = await registry.resolve(role, 'codex', 'gpt-6-astra', 'ultra');
    assert.equal(supported.model, 'gpt-6-astra', `Supported ultra must pass for ${role}.`);
}
capabilityService.assertEffortSupported({
    ...capabilityInput, model: 'unknown-custom', effort: 'minimal'
});
capabilityService.assertEffortSupported({
    ...capabilityInput, model: '', effort: 'minimal'
});

console.log('MODEL_DISCOVERY_TEST=passed');
