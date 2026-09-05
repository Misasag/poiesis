import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { cliRoleAvailability } = require('../agent-window/lib/common/cli-detection-lifecycle');

// Execute the production methods without loading Theia's browser-only services.
function subject(path, className, names) {
    const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className);
    assert.ok(declaration, `${className} was not found`);
    const members = names.map(name => {
        const member = declaration.members.find(node => node.name?.getText(source) === name);
        assert.ok(member, `${className}.${name} was not found`);
        return member.getText(source);
    });
    const { outputText } = ts.transpileModule(`class Subject { ${members.join('\n')} }\nSubject;`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
    });
    return new (vm.runInNewContext(outputText, { cliRoleAvailability, console: { warn() {} } }))();
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const negativeControl = process.argv.includes('--simulate-capture-after-wait');

for (const phase of ['startup', 'rescan']) {
    for (const action of ['switch', 'edit', 'duplicate', 'delete', 'archive', 'delete-preparation', 'archive-preparation']) {
        const detection = deferred();
        const preparation = deferred();
        const created = [], sent = [];
        const a = { id: 'A', workspaceUri: 'file:///workspace-a', agentDraft: 'A submitted', messages: [] };
        const b = { id: 'B', workspaceUri: 'file:///workspace-b', agentDraft: 'B unsent', messages: [] };
        let selected = a;
        const state = {
            cliDetectionPhase: phase === 'startup' ? 'pending' : 'ready',
            agentCli: 'claude', agentModel: phase === 'startup' ? '' : 'fable', agentEffort: '',
            resultsCli: 'grok', resultsModel: 'grok-4.5', resultsEffort: 'medium',
            providerPreparationErrors: new Map()
        };
        const report = { detections: [{ id: 'claude', status: 'found', defaultModel: 'fable', executableRoles: ['agent', 'results'] }] };
        const host = { state };
        const provider = {
            async createSession(options) {
                created.push(options);
                await preparation.promise;
                return { id: 'runtime-A', ...options };
            },
            async sendMessage(id, message) { sent.push({ id, ...message }); }
        };
        const settings = subject('../agent-window/src/browser/agent-window/settings-part.tsx', 'SettingsPart', [
            'cliDetectionLoading', 'cliDetectionCompletion', 'refreshCliDetection', 'waitForCurrentCliDetection', 'performCliDetection'
        ]);
        Object.assign(settings, {
            host, agentRuntimeServer: { detectClis: () => detection.promise }, update() {},
            roleModel: role => state[`${role}Model`], effortFor: () => '',
            resultsGenerationContext: {}, persistPoiesisSettings() {}
        });
        host.waitForCurrentCliDetection = () => settings.waitForCurrentCliDetection();
        const store = subject('../agent-window/src/browser/agent-window/session-store.ts', 'SessionStore', ['ensureProviderSession']);
        Object.assign(store, { host, agentProvider: provider, update() {}, persistWindowState: () => Promise.resolve() });
        host.sessions = {
            sessions: [a, b], sessionsInitialization: Promise.resolve(),
            selectedSession: () => selected, runningTask: () => undefined,
            titleForSession: content => content, persistWindowState: () => Promise.resolve(),
            ensureProviderSession: store.ensureProviderSession.bind(store)
        };
        const agent = subject('../agent-window/src/browser/agent-window/agent-part.tsx', 'AgentPart', [
            'pendingSends', 'sendAgentMessage', 'sendPreparedAgentMessage'
        ]);
        Object.assign(agent, {
            host, agentProvider: provider, update() {},
            requirementForSend: session => ({ requirementId: `requirement-${session.id}`, requirementChoice: 'default' }),
            recordPreSpawnFailure() { throw new Error('Unexpected provider preparation failure'); }
        });
        if (negativeControl) {
            const capture = agent.sendAgentMessage.bind(agent);
            agent.sendAgentMessage = async () => { await host.waitForCurrentCliDetection(); return capture(); };
        }
        const scan = settings.refreshCliDetection();
        assert.equal(settings.refreshCliDetection(), scan, 'Rescans must share the in-flight completion');
        const sending = agent.sendAgentMessage();
        await flush();
        assert.equal(created.length, 0, 'Provider creation escaped detection/settings completion');
        assert.equal(sent.length, 0);
        if (action === 'switch') selected = b;
        if (action === 'edit') a.agentDraft = 'A next draft';
        if (action === 'delete') host.sessions.sessions = [b];
        if (action === 'archive') a.archived = true;
        if (action === 'duplicate') {
            a.agentDraft = 'A next draft';
            await agent.sendAgentMessage();
        }
        detection.resolve(report);
        await scan;
        await flush();
        if (action === 'delete-preparation') host.sessions.sessions = [b];
        if (action === 'archive-preparation') a.archived = true;
        if (action === 'duplicate') await agent.sendAgentMessage();
        preparation.resolve();
        await sending;
        if (action.startsWith('delete') || action.startsWith('archive')) {
            assert.equal(sent.length, 0, 'A removed chat must not start work');
        } else {
            assert.equal(created.length, 1);
            assert.equal(created[0].model, 'fable', 'CLI configuration must use the completed model selection');
            assert.equal(sent.length, 1, 'A duplicate Send must not create another run');
            assert.equal(sent[0].ownerSessionId, 'A', 'Send changed its destination during detection');
            assert.equal(sent[0].content, 'A submitted', 'Send consumed text edited after submission');
            assert.equal(sent[0].workspaceUri, a.workspaceUri);
            assert.equal(b.agentDraft, 'B unsent', 'Another chat lost its unsent draft');
            if (action === 'edit' || action === 'duplicate') assert.equal(a.agentDraft, 'A next draft');
        }
        assert.equal(agent.pendingSends.size, 0, 'Send preparation lock must be released');
    }
}
console.log('AGENT_SEND_DETECTION_TEST=passed cases=14');
