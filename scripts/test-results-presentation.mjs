import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { resultsHeaderText } = require('../agent-window/lib/browser/results-presentation.js');

const requirement = '作業の記録を残して、あとで振り返れるようにしたいです。';
assert.deepEqual(resultsHeaderText(requirement, 'その理解で進めてください。'), { title: requirement });
assert.deepEqual(resultsHeaderText(requirement, '作業履歴を検索できるようにしてください。'),
    { title: requirement, secondaryTitle: '作業履歴を検索できるようにしてください。' });
assert.deepEqual(resultsHeaderText(requirement, requirement), { title: requirement });
assert.deepEqual(resultsHeaderText(requirement), { title: requirement });

const resultsPart = await readFile('agent-window/src/browser/agent-window/results-part.tsx', 'utf8');
const canvas = resultsPart.slice(resultsPart.indexOf("className='poiesis-results__canvas'"), resultsPart.indexOf('this.renderImageViewer()'));
const details = resultsPart.slice(resultsPart.indexOf('protected renderResultsDetails('), resultsPart.indexOf('protected renderResultsAuxiliaryHeader('));
const verification = resultsPart.slice(resultsPart.indexOf('protected renderVerificationTable('), resultsPart.indexOf('protected resultsActionStatus('));
assert.ok(!canvas.includes('this.renderVerificationTable('), 'The reading canvas must not contain the verification table');
assert.ok(details.indexOf('this.renderVerificationTable(buildVerificationTable(tasks, changeSet))')
    > details.indexOf("this.renderResultsAuxiliaryHeader('詳細'")
    && details.indexOf('this.renderVerificationTable(buildVerificationTable(tasks, changeSet))') < details.indexOf("<dl className='poiesis-results__details-list'>"),
'The verification table must be visible at the top of Details');
assert.ok(verification.includes("<section className='poiesis-results__verification'")
    && verification.includes("<h3 className='poiesis-results__verification-heading'>")
    && verification.includes('<tbody>{table.rows.map((row, index) => <tr key={index} data-status={row.status}>')
    && !verification.includes('<details'), 'The detail table must be a noncollapsible section with status rows');
assert.ok(resultsPart.includes('詳細の確認記録を参照してください。'));
console.log('results-presentation tests passed');
