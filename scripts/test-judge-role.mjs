import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { productionMethods } from './production-methods.mjs';

const require = createRequire(import.meta.url);
const { ResultsGenerationContext } = require('../agent-window/lib/browser/results-generation-context.js');
const { ResultsAssertionServerImpl } = require('../agent-window/lib/node/results-assertion-server.js');
const { RequirementClassificationServerImpl } = require('../agent-window/lib/node/requirement-classification-server.js');
const { CliProviderRegistry } = require('../agent-window/lib/node/cli-provider-registry.js');
const { knownCliDefinitions } = require('../agent-window/lib/node/known-cli-registry.js');
const classifier = require('../agent-window/lib/browser/requirement-classifier.js');
const assertions = require('../agent-window/lib/browser/results-assertions.js');
const evidence = require('../agent-window/lib/browser/results-evidence.js');
const normalizer = require('../agent-window/lib/browser/results-document-normalizer.js');
const protocol = require('../agent-window/lib/common/agent-runtime-protocol.js');
const { taskProducesResult } = require('../agent-window/lib/common/task-outcome.js');

const context = new ResultsGenerationContext();
Object.assign(context, { providerId: 'codex', model: 'gpt-6-astra', effort: 'xhigh' });
for (const version of [1, 2, 3, 4, 5, 6, 7, 8]) {
    for (const same of [true, false]) {
        let saved;
        const old = { version, preferredCli: 'claude', agentCli: 'grok', agentModel: 'grok-4.5',
            resultsCli: 'codex', resultsModel: 'gpt-6-astra', resultsEffort: 'xhigh', agentEffort: 'low',
            judgeSameAsResults: same, judgeCli: 'claude', judgeModel: 'haiku', judgeEffort: 'low',
            effortByModel: { results: { 'codex:gpt-6-astra': 'xhigh' } }, automaticRequirementClassification: false,
            allowCodexAgentNetworkAccess: same };
        const settings = productionMethods('../agent-window/src/browser/agent-window/settings-part.tsx', 'SettingsPart', [
            'restorePoiesisSettings', 'normalizeEffort', 'normalizeEffortByModel', 'effortKey',
            'syncJudgeSelection', 'persistPoiesisSettings', 'setRoleCli', 'setRoleProviderModel', 'setRoleEffort',
            'roleModel', 'effortFor'
        ], { ...protocol, SETTINGS_STORAGE_KEY: 'test-settings' });
        Object.assign(settings, { host: { state: {} }, resultsGenerationContext: context,
            storageService: { async getData() { return old; }, async setData(_key, value) { saved = value; } },
            requirementClassificationService: {}, update() {} });
        await settings.restorePoiesisSettings();
        assert.equal(settings.host.state.judgeSameAsResults, version < 6 || same);
        assert.equal(context.judge.providerId, version >= 6 && !same ? 'claude' : version === 1 ? 'claude' : 'codex');
        assert.equal(settings.host.state.resultsEffort, version >= 5 ? 'xhigh' : '');
        assert.equal(settings.host.state.allowCodexAgentNetworkAccess, version >= 7 && same);
        settings.persistPoiesisSettings();
        assert.equal(saved.version, 8);
        assert.equal(saved.allowCodexAgentNetworkAccess, version >= 7 && same);
        assert.equal(saved.judgeSameAsResults, version < 6 || same);
        const roundTrip = JSON.parse(JSON.stringify(saved));
        settings.storageService.getData = async () => roundTrip;
        await settings.restorePoiesisSettings();
        assert.equal(context.judge.providerId, version >= 6 && !same ? 'claude' : version === 1 ? 'claude' : 'codex');
        assert.equal(settings.host.state.allowCodexAgentNetworkAccess, version >= 7 && same);
        settings.setRoleCli('judge', 'grok');
        assert.equal(context.judge.providerId, 'grok');
        assert.equal(saved.judgeSameAsResults, false);
    }
}

for (const definition of knownCliDefinitions().filter(item => item.id !== 'gemini')) {
    const registry = new CliProviderRegistry({ recordedReport: { detections: [{ ...definition, status: 'found', path: 'fake' }] } },
        { assertEffortSupported() {} });
    assert.equal((await registry.resolve('judge', definition.id)).role, 'judge');
}

for (const explicit of [false, true]) {
    Object.assign(context, { providerId: 'codex', model: 'gpt-6-astra', effort: 'xhigh',
        judgeSelection: explicit ? { providerId: 'claude', model: 'haiku', effort: 'low' } : undefined });
    const resolved = [];
    const registry = { async resolve(...args) { resolved.push(args); throw new Error('Test stops at provider resolution'); } };
    const assertionServer = new ResultsAssertionServerImpl(registry);
    const requirementServer = new RequirementClassificationServerImpl(registry);
    const skill = productionMethods('../agent-window/src/browser/results-skill.ts', 'AiResultsSkill', ['assertCandidate'], {
        ...assertions, ...evidence, ...normalizer, ResultsGenerationCancelledError: class extends Error {}
    });
    Object.assign(skill, { context, assertionServer, normalizeAndValidate: html => html, throwIfCancelled() {} });
    await skill.assertCandidate('<html><body><h2>成果</h2></body></html>', { task: { title: 'Task' }, changeSet: { files: [] } },
        [{ text: '条件', skillId: 'test' }], { taskId: 'judge-test', workspaceUri: 'file:///workspace',
            providerId: context.providerId, model: context.model, effort: context.effort }, '{}', []);
    const tasks = [{ id: 'first', startedAt: '2026-01-01', requirementId: 'r' },
        { id: 'next', startedAt: '2026-01-02', requirementId: 'r' }].map(task => ({ ...task,
        title: 'Request', request: 'Request', status: 'completed', workspaceUri: 'file:///workspace',
        requirementChoice: 'default', changeSet: { files: ['a.ts'], diff: '+a' } }));
    const service = productionMethods('../agent-window/src/browser/requirement-classification-service.ts',
        'RequirementClassificationService', ['classify', 'suggestTitle'], {
            ...classifier, ...assertions, taskProducesResult, isLocalWorkspace: () => true
        });
    Object.assign(service, { enabled: true, classifyingTaskIds: new Set(), suggestingTitleTaskIds: new Set(),
        server: requirementServer, resultsContext: context, record() {},
        taskService: { get: id => tasks.find(task => task.id === id), recordCliCall() {} },
        requirementService: { get: () => ({ id: 'r', title: 'Request', titleSource: 'task', taskIds: ['first', 'next'] }), rename() {} } });
    await service.classify('next');
    await service.suggestTitle('first');
    assert.equal(resolved.length, 3, 'All three judge purposes must reach provider resolution');
    for (const args of resolved) {
        assert.deepEqual(args, ['judge', context.judge.providerId, context.judge.model, context.judge.effort]);
    }
    if (!explicit) {
        context.model = 'gpt-6-luna';
        assert.equal(context.judge.model, 'gpt-6-luna', 'Inherited selection must follow later Results changes');
    }
}
console.log('JUDGE_ROLE_AND_SETTINGS_MIGRATION_TEST=passed');
