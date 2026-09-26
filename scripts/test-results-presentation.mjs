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
const agentPart = await readFile('agent-window/src/browser/agent-window/agent-part.tsx', 'utf8');
const resultsCss = await readFile('agent-window/src/browser/style/results.css', 'utf8');
assert.match(resultsCss, /\.poiesis-results__encoding-damage strong \{\s*color: #[0-9a-f]{6};/,
    'The damaged-file heading sits on a light notice and must not inherit the light chrome text color.');
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
// The app no longer reads the document's opening (R9), so it shows no opening-count warning.
assert.ok(!resultsPart.includes('本文の確認状況を見直してください'));
assert.ok(canvas.includes('this.renderEncodingDamageNotice(encodingTask, Boolean(session?.archived))'),
    'The app-owned Results notice must appear in the Results canvas.');
assert.ok(resultsPart.includes('作業前の内容に戻す') && resultsPart.includes('作業の後に変更されているため戻せませんでした'));
assert.ok(resultsPart.includes("outcome?.skippedReasons[item.path] === 'changed-after-task'")
    && resultsPart.includes('このファイルは戻せませんでした'),
    'Unavailable files must not be described as changes made after the Task.');
assert.ok(resultsPart.includes('別の作業が実行中です。終わってから戻せます。')
    && resultsPart.includes('disabled={pending || busy}')
    && resultsPart.includes('文字の状態を確認できなかったファイル')
    && agentPart.includes('作業前の内容に戻したファイル'),
    'Damage, restore, busy and inspection states must be visible as text.');
assert.ok(agentPart.includes('`文字が壊れたファイル ${remainingDamageCount}件: ${chipNames}`')
    && agentPart.includes("chipPaths.slice(0, 2).join('、')")
    && agentPart.includes("title={chipPaths.join('\\n')}"),
    'The damaged-file chip next to the task must name the files, not only count them.');
assert.ok(agentPart.includes("this.host.selectResultsTask(task!.id); this.host.selectTab('results');"),
    'The damaged-file chip must open its Task in Results.');
assert(toolbar.includes("['fail', 'unknown', 'outdated']") && toolbar.includes('counts[status] > 0')
    && toolbar.includes('VERIFICATION_LABELS[status]') && toolbar.includes('counts[status]}件')
    && toolbar.includes('poiesis-results__status-badge poiesis-results__status-badge--${status}'),
    'Only nonzero verification statuses must appear as text badges in the fixed toolbar.');
assert(!toolbar.includes('onClick={event => this.toggleResultsAuxiliary') || toolbar.indexOf('counts[status]') < toolbar.indexOf('onClick={event => this.toggleResultsAuxiliary'),
    'Verification badges must not be clickable controls.');
const documentHtml = resultsPart.slice(resultsPart.indexOf('protected resultsDocumentHtml('), resultsPart.indexOf('public handleResultsFrameMessage('));
assert(documentHtml.includes('resultsFrameHtml(html, this.host.themePreferenceService.effectiveMode, this.host.state.allowExternalResultsResources)'),
    'The Results panel must hand the skill document to the shared frame builder with the theme and the owner external-resource setting.');
// R9: the frame adds only policy, theme tokens and scrollbar styling; the document owns its own layout.
const richContent = await readFile('agent-window/src/browser/results-rich-content.ts', 'utf8');
const frame = richContent.slice(richContent.indexOf('export function resultsFrameHtml('), richContent.indexOf('export class ResultsFrameRetryGate'));
assert(frame.includes('if (!allowExternalResources) {') && frame.includes('doc.head.prepend(policy);')
    && frame.includes('doc.head.append(style);') && frame.indexOf('doc.head.prepend(policy);') < frame.indexOf('doc.head.append(style);'),
    'The CSP must open <head> only when external resources are off, and the base style must close <head>.');
const baseStyle = richContent.slice(richContent.indexOf('export const RESULTS_RICH_STYLE = `'), richContent.indexOf('/** Add only frame policy'));
const selectors = [...baseStyle.matchAll(/^([^\n{}]+)\{/gm)].map(match => match[1].trim());
assert(selectors.length > 0 && selectors.every(selector => selector.split(',').every(part => /^(?::root(?:\[data-theme="dark"\])?|::-webkit-scrollbar(?:-[a-z]+)?(?::hover)?)$/.test(part.trim()))),
    `The base style may only set theme tokens and scrollbars, not document elements: ${selectors.join(' | ')}`);
console.log('results-presentation tests passed');
