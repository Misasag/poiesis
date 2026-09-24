import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resultsHeaderText, verificationTableExpanded } = require('../agent-window/lib/browser/results-presentation.js');

const requirement = '作業の記録を残して、あとで振り返れるようにしたいです。';
assert.deepEqual(resultsHeaderText(requirement, 'その理解で進めてください。'), { title: requirement });
assert.deepEqual(resultsHeaderText(requirement, '作業履歴を検索できるようにしてください。'),
    { title: requirement, secondaryTitle: '作業履歴を検索できるようにしてください。' });
assert.deepEqual(resultsHeaderText(requirement, requirement), { title: requirement });
assert.deepEqual(resultsHeaderText(requirement), { title: requirement });

const table = (...rows) => ({ rows });
const row = (status, human = false) => ({ status, human });
assert.equal(verificationTableExpanded(table(row('pass'), row('pass'))), false);
for (const status of ['fail', 'unknown', 'outdated', 'human']) {
    assert.equal(verificationTableExpanded(table(row('pass'), row(status))), true, status);
}
assert.equal(verificationTableExpanded(table(row('pass', true))), true);
assert.equal(verificationTableExpanded(table(row('fail')), false), false);
assert.equal(verificationTableExpanded(table(row('pass')), true), true);
console.log('results-presentation tests passed');
