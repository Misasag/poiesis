import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { productionMethods } from './production-methods.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const protocol = require('../agent-window/lib/common/agent-runtime-protocol.js');
const context = require('../agent-window/lib/browser/results-generation-context.js');
const { resolveResultsQuestionSelection } = context;
const settingsSource = readFileSync(new URL('../agent-window/src/browser/agent-window/settings-part.tsx', import.meta.url), 'utf8');
const resultsSource = readFileSync(new URL('../agent-window/src/browser/agent-window/results-part.tsx', import.meta.url), 'utf8');

for (const version of [1, 2, 3, 4, 5, 6, 7]) {
    const host = { state: { resultsCli: 'codex', resultsModel: 'gpt-6-astra', resultsEffort: 'high' } };
    const settings = productionMethods('../agent-window/src/browser/agent-window/settings-part.tsx', 'SettingsPart',
        ['restorePoiesisSettings', 'normalizeEffort', 'normalizeEffortByModel', 'effortKey', 'syncJudgeSelection'],
        { ...protocol, SETTINGS_STORAGE_KEY: 'test-settings' });
    Object.assign(settings, { host, resultsGenerationContext: new context.ResultsGenerationContext(),
        storageService: { async getData() { return { version, resultsCli: 'codex', resultsModel: 'gpt-6-astra', resultsEffort: 'high' }; } },
        requirementClassificationService: {}, update() {} });
    await settings.restorePoiesisSettings();
    assert.equal(host.state.questionSameAsResults, true, `version ${version} defaults to Results AI`);
}

let saved;
const host = { state: { questionSameAsResults: false, questionCli: 'claude', questionModel: 'haiku', questionEffort: 'low',
    resultsCli: 'codex', resultsModel: 'gpt-6-astra', resultsEffort: 'xhigh', agentCli: 'codex', agentModel: '', agentEffort: '',
    judgeSameAsResults: true, judgeCli: 'codex', judgeModel: '', judgeEffort: '', uiFontScale: 'standard',
    effortByModel: { agent: {}, results: {}, judge: {} }, allowExternalResultsResources: false,
    allowCodexAgentNetworkAccess: false, automaticRequirementClassification: true } };
const inherited = { questionSameAsResults: true, questionCli: 'claude', questionModel: 'haiku', questionEffort: 'low',
    resultsCli: 'codex', resultsModel: 'gpt-6-astra', resultsEffort: 'xhigh' };
assert.deepEqual(resolveResultsQuestionSelection(inherited), { providerId: 'codex', model: 'gpt-6-astra', effort: 'xhigh' });
inherited.resultsModel = 'gpt-6-luna';
assert.deepEqual(resolveResultsQuestionSelection(inherited), { providerId: 'codex', model: 'gpt-6-luna', effort: 'xhigh' });
inherited.questionSameAsResults = false;
assert.deepEqual(resolveResultsQuestionSelection({ ...inherited, questionCli: 'claude', questionModel: ' haiku ', questionEffort: 'low' }),
    { providerId: 'claude', model: 'haiku', effort: 'low' });
const settings = productionMethods('../agent-window/src/browser/agent-window/settings-part.tsx', 'SettingsPart',
    ['persistPoiesisSettings', 'syncJudgeSelection'], { ...protocol, SETTINGS_STORAGE_KEY: 'test-settings' });
Object.assign(settings, { host, resultsGenerationContext: new context.ResultsGenerationContext(), storageService: {
    async setData(_key, value) { saved = value; }
} });
settings.persistPoiesisSettings();
assert.equal(saved.version, 8);
assert.equal(saved.questionSameAsResults, false);
const persisted = JSON.parse(JSON.stringify(saved));
assert.equal(persisted.questionCli, 'claude');
assert.equal(persisted.questionModel, 'haiku');
assert.equal(persisted.questionEffort, 'low');
const restoredHost = { state: { resultsCli: 'codex', resultsModel: '', resultsEffort: '' } };
const restored = productionMethods('../agent-window/src/browser/agent-window/settings-part.tsx', 'SettingsPart',
    ['restorePoiesisSettings', 'normalizeEffort', 'normalizeEffortByModel', 'effortKey', 'syncJudgeSelection'],
    { ...protocol, SETTINGS_STORAGE_KEY: 'test-settings' });
Object.assign(restored, { host: restoredHost, resultsGenerationContext: new context.ResultsGenerationContext(),
    storageService: { async getData() { return persisted; } }, requirementClassificationService: {}, update() {} });
await restored.restorePoiesisSettings();
assert.equal(restoredHost.state.questionSameAsResults, false);
assert.equal(restoredHost.state.questionCli, 'claude');
assert.equal(restoredHost.state.questionModel, 'haiku');
assert.equal(restoredHost.state.questionEffort, 'low');
assert.match(resultsSource, /const questionAi = resolveResultsQuestionSelection\(this\.host\.state\)/);
assert.match(resultsSource, /providerId: questionAi\.providerId/);
assert.match(resultsSource, /model: questionAi\.model \|\| undefined/);
assert.match(resultsSource, /effort: questionAi\.effort \|\| undefined/);
// The question radios form their own group so arrow keys never move into the Results AI group.
assert.match(settingsSource, /name=\{selectionRole === 'question' \? 'poiesis-question-cli' : `poiesis-\$\{role\}-cli`\}/);
assert.match(settingsSource, /name='poiesis-question-cli' checked=\{sameAsResults\}/);
// Writing Results needs the skill's scripts, but a question is a read-only one-shot that Grok and pi can answer.
const lifecycle = require('../agent-window/lib/common/cli-detection-lifecycle.js');
const detectionReport = { detections: ['codex', 'claude', 'grok', 'pi'].map(id => ({ id, status: 'found', executableRoles: ['agent', 'results', 'judge'] })) };
for (const id of ['grok', 'pi']) {
    assert.equal(lifecycle.cliRoleAvailability('ready', detectionReport, id, 'results'), 'unsupported');
    assert.equal(lifecycle.cliRoleAvailability('ready', detectionReport, id, 'results', 'question'), 'available');
}
assert.match(settingsSource, /<ModelPicker role='results' purpose='question'/);
console.log('RESULTS_QUESTION_SELECTION_TEST=passed');
