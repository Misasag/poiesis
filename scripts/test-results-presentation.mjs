import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { resultsHeaderText, taskDisplayTitle } = require('../agent-window/lib/browser/results-presentation.js');

const requirement = '作業の記録を残して、あとで振り返れるようにしたいです。';
// A follow-up that only approves a proposal is labelled by the work it started, not by the reply.
const approval = '承認します。実装してください。';
assert.equal(taskDisplayTitle({ title: approval, requirementClassification: { taskTitle: '作業履歴の検索機能の実装' } }),
    '作業履歴の検索機能の実装');
assert.deepEqual(resultsHeaderText(requirement, taskDisplayTitle({ title: approval, requirementClassification: { taskTitle: '作業履歴の検索機能の実装' } })),
    { title: requirement, secondaryTitle: '作業履歴の検索機能の実装' });
assert.equal(taskDisplayTitle({ title: approval }), approval, 'Without a classifier title the request text stays the label');
assert.equal(taskDisplayTitle({ title: approval, requirementClassification: { taskTitle: '  ' } }), approval);
assert.deepEqual(resultsHeaderText(requirement, 'その理解で進めてください。'), { title: requirement });
assert.deepEqual(resultsHeaderText(requirement, '作業履歴を検索できるようにしてください。'),
    { title: requirement, secondaryTitle: '作業履歴を検索できるようにしてください。' });
assert.deepEqual(resultsHeaderText(requirement, requirement), { title: requirement });
assert.deepEqual(resultsHeaderText(requirement), { title: requirement });

const resultsPart = await readFile('agent-window/src/browser/agent-window/results-part.tsx', 'utf8');
const canvas = resultsPart.slice(resultsPart.indexOf("className='poiesis-results__canvas'"), resultsPart.indexOf('this.renderImageViewer()'));
const details = resultsPart.slice(resultsPart.indexOf('protected renderResultsDetails('), resultsPart.indexOf('protected renderResultsAuxiliaryHeader('));
const verification = resultsPart.slice(resultsPart.indexOf('protected renderVerificationTable('), resultsPart.indexOf('protected resultsActionStatus('));
const toolbar = resultsPart.slice(resultsPart.indexOf('protected renderResultsToolbar('), resultsPart.indexOf('protected renderVerificationTable('));
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
assert(toolbar.includes("['fail', 'unknown', 'outdated']") && toolbar.includes('counts[status] > 0')
    && toolbar.includes('VERIFICATION_LABELS[status]') && toolbar.includes('counts[status]}件')
    && toolbar.includes('poiesis-results__status-badge poiesis-results__status-badge--${status}'),
    'Only nonzero verification statuses must appear as text badges in the fixed toolbar.');
assert(!toolbar.includes('onClick={event => this.toggleResultsAuxiliary') || toolbar.indexOf('counts[status]') < toolbar.indexOf('onClick={event => this.toggleResultsAuxiliary'),
    'Verification badges must not be clickable controls.');
const documentHtml = resultsPart.slice(resultsPart.indexOf('protected resultsDocumentHtml('), resultsPart.indexOf('public handleResultsFrameMessage('));
assert(documentHtml.includes('sanitized.replace(headOpen, match => policy ? `${match}\\n  ${policy}` : match)')
    && documentHtml.includes('.replace(headClose, match => `  ${baseStyle}\\n${match}`)'),
    'The CSP must open <head> before any AI head content while the base style closes <head> to win the cascade.');
console.log('results-presentation tests passed');
