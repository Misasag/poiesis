import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { appInput, command, fixture, root, runFolder, skill, writeCase, prepare, render } from './helper.mjs';

const htmlPath = resolve(runFolder, 'results.html');
const preparedPath = resolve(runFolder, 'prepared.json');
const s6Names = { count: '数える', refresh: '読み直す', key: '今日の日付ごとの作業回数',
  stateTitle: '回数が増える時', flowTitle: '表示を読み直す時', dataTitle: '保存の形', raceTitle: '2つのタブと日付の境目で起きうること',
  stateSentence: '主役の線と、ほかの線を見ます。', nonMain: '数えない', stateValues: { work: '作業中', break: '休憩中' },
  stateEvents: { 619: '時間切れ', 631: '休憩の終了', 697: '画面の操作', 714: 'キーの操作' },
  entries: { 659: '250msごとに確認', 670: 'ボタンで操作', 701: 'キーで操作', 719: 'タブに戻る',
    393: 'ページを開く', 726: '別のタブで保存', 727: '1秒ごとに確認', 694: '画面のボタン' },
  conditions: { 613: '作業の終了時だけ' },
  origins: { 469: '表示の対象になる日付', 475: '終了予定時刻の日付' },
  keyParts: { 0: '現地の日付' }, states: { 441: 'このタブの手元の数' },
  dataSentence: '保存の部品と、読み書きの行を見ます。',
  raceSentence: '1〜4の順番と、保存結果4・本来5を見ます。' };
const chosenTests = [
  ['only completed work increments; pause, reset and mode changes do not'],
  ['work spanning local midnight belongs to the completion date', "a delayed tick after midnight records the actual deadline's date"],
  ["reload restores today's total and the next local date starts at zero"],
  ['invalid saved counts are ignored without breaking work completion',
    'blocked storage retains counts in memory, including failed writes to existing data'],
  ["another tab's saved completion appears and is preserved on the next completion"]
];
const makeDraft = () => {
  const draft = JSON.parse(readFileSync(resolve(fixture, 'draft.json'), 'utf8'));
  draft.edges = [];
  draft.concerns = [];
  draft.viewNames = structuredClone(s6Names);
  draft.mapCaption = '4つの入口が画面の部品に集まり、①の条件のときだけ値が増えます。';
  draft.interpretations = [draft.interpretations[0], draft.interpretations[1],
    draft.interpretations[3], draft.interpretations[2], draft.interpretations[4]];
  draft.interpretations.forEach((row, index) => {
    delete row.evidence;
    row.line = [613, 475, 727, 480, 726][index];
    row.tests = chosenTests[index];
    row.why = row.decision;
  });
  draft.interpretations[4].unrequested = true;
  return draft;
};
const finishDraft = (draft, prepared) => {
  const updated = structuredClone(draft);
  updated.interpretations[2].nodeId = prepared.map.nodes.find(node => node.kind === 'entry' && node.line === 727)?.id;
  updated.nodes.push({ id: updated.interpretations[2].nodeId, title: updated.viewNames.entries[727],
    caption: '表示する日を確かめます。', hunkIds: [] });
  delete updated.interpretations[3].nodeId;
  updated.interpretations[3].edgeId = prepared.map.edges.find(edge => edge.access === 'write' && edge.line === 479)?.id;
  return updated;
};
const withDraft = draft => { writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(draft), 'utf8'); return render(); };
const describe = (prepared, html) => {
  const nodeLine = id => prepared.map.nodes.find(node => node.id === id)?.line;
  const values = prepared.views.stateMachine?.states.map(item => item.value) ?? [];
  const section = html.match(/<section class="ex-view[^>]*data-view="structure"[\s\S]*?<\/section>/)?.[0] ?? '';
  const cardLines = [...section.matchAll(/class="ex-view-card[^\"]*" data-part="([^\"]+)"/g)].map(match => nodeLine(match[1]));
  const links = [...section.matchAll(/class="ex-view-link [^"]+" data-evidence="(\d+)" data-from="([^"]+)" data-to="([^"]+)" data-verb="([^"]+)"/g)]
    .map(match => [Number(match[1]), nodeLine(match[2]), nodeLine(match[3]), match[4]]);
  const badges = [...html.matchAll(/data-badge-part="([^"]+)"[^>]*>([①②③④⑤]+)/g)]
    .map(match => [nodeLine(match[1]), match[2]]).sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  const edgeLine = id => prepared.map.edges.find(edge => edge.id === id)?.line;
  const edgeBadges = [...html.matchAll(/data-badge-edge="([^"]+)"[^>]*>([①②③④⑤]+)/g)]
    .map(match => [edgeLine(match[1]), match[2]]);
  const testCounts = [...html.matchAll(/<tr><td>[①②③④⑤]<\/td><td class="ex-ai-text">[\s\S]*?<\/td><td>([\s\S]*?)<\/td><\/tr>/g)]
    .map(match => (match[1].match(/検査「/g) ?? []).length);
  return {
    selected: prepared.views.selected,
    groups: prepared.views.groups.map(group => [group.kind, group.entries.map(entry => entry.line)]),
    parts: cardLines, links, badges, edgeBadges, testCounts,
    state: prepared.views.stateMachine ? { states: prepared.views.stateMachine.states.map(item => item.line),
      transitions: prepared.views.stateMachine.transitions.map(item => [item.line,
        item.from.map(value => values.indexOf(value)), item.to.map(value => values.indexOf(value)), item.main,
        item.entries.map(entry => entry.line)]) } : null,
    steps: prepared.views.steps.map(item => [item.kind, item.line, item.number]),
    boundary: prepared.views.boundary ? [prepared.views.boundary.writeOriginLine,
      prepared.views.boundary.displayOriginLine, prepared.views.boundary.entryLine] : null,
    storageFailure: prepared.views.keys.map(item => [item.facts.readCatchLine, item.facts.saveCatchLine]),
    omissions: prepared.views.omissions.map(item => [item.kind, item.line]),
    diagramKinds: [...html.matchAll(/<section class="ex-view[^>]*data-view="([^"]+)"/g)].map(match => match[1]),
    badgeStates: [(html.match(/class="ex-view-badge[^\"]*ex-view-badge-unverified/g) ?? []).length,
      (html.match(/class="ex-view-addition"/g) ?? []).length,
      (html.match(/class="ex-view-concern"/g) ?? []).length],
    dataSites: prepared.views.keys.map(key => [key.writers.map(value => Number(value.match(/\d+$/)?.[0])),
      key.readers.map(value => Number(value.match(/\d+$/)?.[0]))]),
    racePoints: [...html.matchAll(/class="ex-view-race-row" data-point="(\d+)" data-evidence="(\d+)"/g)]
      .map(match => [Number(match[1]), Number(match[2])])
  };
};

const run = command(process.execPath, ['--test', '--test-reporter=tap', 'tests/daily-count.test.cjs'], { cwd: fixture });
assert.equal(run.status, 0, run.stderr);
const input = appInput(fixture);
input.verification.rows = [{ label: '作業回数の自動テスト', status: 'pass', detail: '8件成功', image: '' }];
input.executionEvidence = `command: node --test --test-reporter=tap tests/daily-count.test.cjs\nexit code: 0\n${run.stdout}`;
const initialDraft = makeDraft();
writeCase(input, JSON.stringify(initialDraft));
assert.equal(prepare().body.ok, true);
const prepared = JSON.parse(readFileSync(preparedPath, 'utf8'));
const draft = finishDraft(initialDraft, prepared);
writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(draft), 'utf8');
assert.deepEqual(prepared.views.selected, { S: true, D: true, T: true, C: true, M: true });
assert.equal(prepared.views.tests.length, 8);
assert.equal(render().body.ok, true);
const html = readFileSync(htmlPath, 'utf8');
const base = describe(prepared, html);
assert.deepEqual(base.groups.map(group => group[1].length), [4, 4]);
assert.deepEqual(base.diagramKinds, ['state', 'structure', 'data', 'race']);
assert.deepEqual(base.state.states, [432, 432]);
assert.deepEqual(base.state.transitions.map(item => item.slice(0, 4)), [
  [619, [0], [1], true], [631, [1], [0], false],
  [697, [0, 1], [0, 1], false], [714, [0, 1], [1, 0], false]
]);
assert.deepEqual(base.steps, [['date', 475, '1'], ['read', 476, '2'], ['write', 479, '3'], ['display', 483, '4']]);
assert.deepEqual(base.boundary, [475, 469, 719]);
assert.deepEqual(base.storageFailure, [[461, 480]]);
assert.deepEqual(base.omissions.filter(item => item[0] === 'folded').length, 2);
assert(base.edgeBadges.some(item => item[0] === 479 && item[1] === '④'));
assert.deepEqual(base.parts, [473, 458, 468, 385]);
assert.deepEqual(base.links, [[483, 473, 468, '呼ぶ'], [458, 458, 468, '読む']]);
assert.deepEqual(base.testCounts, [1, 2, 1, 2, 1]);
assert.deepEqual(base.racePoints, [[1, 458], [2, 458], [3, 479], [4, 479]]);
assert.equal((html.match(/node --test --test-reporter=tap tests\/daily-count\.test\.cjs：終了コード0/g) ?? []).length, 1);
assert(!/<\w+[^>]*\son[a-z]+\s*=/i.test(html));
assert(!/(?:src|href)="https?:/i.test(html));
assert(!/<img[^>]+src="(?!data:)/i.test(html));

const missingTest = structuredClone(draft);
missingTest.interpretations[0].tests = ['記録にない検査'];
assert.equal(withDraft(missingTest).body.ok, false);
const missingImage = structuredClone(draft);
missingImage.interpretations[0].image = '記録にない画像.png';
assert.equal(withDraft(missingImage).body.ok, false);
const wrongLine = structuredClone(draft);
wrongLine.interpretations[0].line = 475;
assert.equal(withDraft(wrongLine).body.ok, false);
const missingName = structuredClone(draft);
delete missingName.viewNames.entries[726];
assert.equal(withDraft(missingName).body.ok, false);
const reordered = structuredClone(draft);
[reordered.interpretations[0], reordered.interpretations[4]] = [reordered.interpretations[4], reordered.interpretations[0]];
assert.equal(withDraft(reordered).body.ok, true);
const reorderedHtml = readFileSync(htmlPath, 'utf8');
const entryId = prepared.map.nodes.find(node => node.kind === 'entry' && node.line === 726).id;
const finishId = prepared.map.nodes.find(node => node.kind === 'function' && node.line === 609).id;
assert.match(reorderedHtml, new RegExp(`data-badge-part="${entryId}"[^>]*>①`));
assert.match(reorderedHtml, new RegExp(`data-badge-part="${finishId}"[^>]*>⑤`));

const renamePairs = [
  [/\brecordCompletedWork\b/g, 'stampEvent'], [/\brenderDailyCount\b/g, 'paintMeter'],
  [/\bgetDailyCount\b/g, 'loadMeter'], [/\bgetLocalDay\b/g, 'formatBucket'],
  [/\bdailyCounts\b/g, 'cacheByBucket'], [/\bdeadline\b/g, 'finishAt'],
  [/\bcurrentMode\b/g, 'activeMode'], [/\bdailyCountElement\b/g, 'meterElement'],
  [/\bfinish\b/g, 'closeInterval'], [/\btick\b/g, 'pulseClock'],
  [/\bDAILY_COUNT_PREFIX\b/g, 'LEDGER_PREFIX'], [/pomodoro-completed-work:/g, 'local-ledger:'],
  [/\bdaily-count(?!\.test)\b/g, 'meter-value'], [/\btoggle\b/g, 'switcher'],
  [/\bbreak-mode\b/g, 'rest-mode'], [/\bwork-mode\b/g, 'focus-mode']
];
const rename = text => renamePairs.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
const renamedWorkspace = resolve(root, 'out/results-skill-renamed-workspace');
mkdirSync(resolve(renamedWorkspace, 'tests'), { recursive: true });
for (const name of ['index.html', 'README.md']) writeFileSync(resolve(renamedWorkspace, name),
  rename(readFileSync(resolve(fixture, name), 'utf8')), 'utf8');
const renamedTest = rename(readFileSync(resolve(fixture, 'tests/daily-count.test.cjs'), 'utf8'))
  .replaceAll('test("', 'test("renamed ');
writeFileSync(resolve(renamedWorkspace, 'tests/daily-count.test.cjs'), renamedTest, 'utf8');
const renamedRun = command(process.execPath, ['--test', '--test-reporter=tap', 'tests/daily-count.test.cjs'], { cwd: renamedWorkspace });
assert.equal(renamedRun.status, 0, renamedRun.stdout + renamedRun.stderr);
const renamedDiff = rename(readFileSync(resolve(fixture, 'diff.patch'), 'utf8')).replaceAll('test("', 'test("renamed ');
const renamedInput = appInput(renamedWorkspace, renamedDiff);
renamedInput.executionEvidence = `command: node --test --test-reporter=tap tests/daily-count.test.cjs\nexit code: 0\n${renamedRun.stdout}`;
writeCase(renamedInput, JSON.stringify(draft));
assert.equal(prepare().body.ok, true);
const renamedPrepared = JSON.parse(readFileSync(preparedPath, 'utf8'));
const ids = new Map(prepared.map.nodes.map(old => {
  const current = renamedPrepared.map.nodes.find(node => node.file === old.file && node.kind === old.kind &&
    node.line === old.line && node.end === old.end);
  return [old.id, current?.id];
}));
const hunkIds = new Map(prepared.hunks.map((hunk, index) => [hunk.id, renamedPrepared.hunks[index]?.id]));
const renamedDraft = structuredClone(draft);
for (const node of renamedDraft.nodes) { node.id = ids.get(node.id); node.hunkIds = node.hunkIds.map(id => hunkIds.get(id)); }
for (const row of renamedDraft.interpretations) {
  row.nodeId = ids.get(row.nodeId);
  if (row.edgeId) {
    const original = prepared.map.edges.find(edge => edge.id === row.edgeId);
    row.edgeId = renamedPrepared.map.edges.find(edge => edge.access === original.access && edge.line === original.line &&
      edge.from === ids.get(original.from) && edge.to === ids.get(original.to))?.id;
  }
  row.tests = row.tests.map(name => `renamed ${rename(name)}`);
}
renamedDraft.viewNames.stateValues = Object.fromEntries(Object.entries(renamedDraft.viewNames.stateValues)
  .map(([value, label]) => [rename(value), label]));
for (const row of renamedDraft.offMap) row.hunkIds = row.hunkIds.map(id => hunkIds.get(id));
assert(renamedDraft.nodes.every(node => node.id && node.hunkIds.every(Boolean)));
assert.equal(withDraft(renamedDraft).body.ok, true);
const renamedHtml = readFileSync(htmlPath, 'utf8');
const renamed = describe(renamedPrepared, renamedHtml);
assert.deepEqual(renamed, base, 'Renaming source and test identifiers preserves every derived diagram property.');

const forbidden = [/'finish'/, /"finish"/, /'tick'/, /"tick"/, 'renderDailyCount', 'recordCompletedWork',
  'getDailyCount', 'getLocalDay', 'dailyCounts', 'deadline', 'pomodoro', 'break-mode', 'blockWrite',
  'storageChanged', 'app.complete', '#toggle', '250ms', '1000ms', 'タイマー', '今日', '終了予定時刻', '0時', '回数'];
const sourceFiles = directory => readdirSync(directory, { withFileTypes: true }).flatMap(item =>
  item.isDirectory() ? item.name === 'vendor' ? [] : sourceFiles(resolve(directory, item.name)) : [resolve(directory, item.name)]);
const found = [];
for (const file of [...sourceFiles(resolve(skill, 'scripts')), ...sourceFiles(resolve(skill, 'assets'))]) {
  const text = readFileSync(file, 'utf8');
  for (const term of forbidden) if (typeof term === 'string' ? text.includes(term) : term.test(text))
    found.push(`${relative(skill, file)}: ${term}`);
}
assert.deepEqual(found, [], `Skill scripts or assets contain case-specific names: ${found.join(', ')}`);
console.log('Results skill generic views: renamed source, test evidence, badges, and forbidden names passed.');
export { prepared as baselinePrepared, draft as baselineDraft, input as baselineInput, s6Names };
