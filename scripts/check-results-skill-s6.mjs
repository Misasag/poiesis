import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { appInput, command, fixture, root, runFolder, writeCase, prepare, render } from './fixtures/results-skill/helper.mjs';

const workspace = process.argv[2];
if (!workspace) throw new Error('S6 の作業場所を指定してください。');
const realWorkspace = resolve(workspace);
const require = createRequire(resolve(root, 'package.json'));
const puppeteer = require('puppeteer-core');
const out = resolve(root, 'out');
mkdirSync(out, { recursive: true });
const tracked = command('git', ['-C', realWorkspace, 'diff', 'HEAD', '--no-ext-diff', '--no-color', '-U3', '--', 'index.html', 'README.md']);
assert.equal(tracked.status, 0);
const added = command('git', ['-C', realWorkspace, 'diff', '--no-index', '--no-color', '-U3', '--', '/dev/null', resolve(realWorkspace, 'tests/daily-count.test.cjs')]);
assert.equal(added.status, 1);
const diff = tracked.stdout + added.stdout
  .replace(/^diff --git .*$/m, 'diff --git a/tests/daily-count.test.cjs b/tests/daily-count.test.cjs')
  .replace(/^\+\+\+ .*$/m, '+++ b/tests/daily-count.test.cjs');
const tests = command(process.execPath, ['--test', '--test-reporter=tap', 'tests/daily-count.test.cjs'], { cwd: realWorkspace });
assert.equal(tests.status, 0, tests.stdout + tests.stderr);
assert.match(tests.stdout, /# pass 8/);
const documentWorkspace = resolve(out, 'results-skill-s6-document-workspace');
mkdirSync(resolve(documentWorkspace, 'tests'), { recursive: true });
for (const name of ['index.html', 'README.md', 'tests/daily-count.test.cjs'])
  copyFileSync(resolve(realWorkspace, name), resolve(documentWorkspace, name));
for (const name of ['s6-screen.png', 's6-screen-one.png', 's6-screen-reloaded.png'])
  copyFileSync(resolve(fixture, 'r10-d', name), resolve(documentWorkspace, name));
for (const name of ['s6-before-card.png', 's6-after-card.png'])
  copyFileSync(resolve(fixture, 'target', name), resolve(documentWorkspace, name));
const input = appInput(documentWorkspace, diff);
input.images = [
  { path: 's6-screen.png', label: '今日の作業回数：0回' },
  { path: 's6-screen-one.png', label: '今日の作業回数：1回' },
  { path: 's6-screen-reloaded.png', label: '今日の作業回数：再読み込み後1回' }
];
input.hookMaterial = '使用できる画像: s6-before-card.png、s6-after-card.png。変更前と変更後は同じ条件（1920px の作業画面）で撮影。';
input.verification.rows = [{ label: '作業回数の自動テスト', status: 'pass', detail: '8件すべて成功しました。', image: '' }];
input.verification.counts.pass = 1;
input.verification.total = 1;
input.verification.summary = '作業回数の自動テストを実行しました。';
input.executionEvidence = `command: node --test --test-reporter=tap tests/daily-count.test.cjs\nexit code: 0\n${tests.stdout}`;
const draft = JSON.parse(readFileSync(resolve(fixture, 'draft.json'), 'utf8'));
draft.viewNames = { count: '数える', refresh: '読み直す', key: '今日の日付ごとの作業回数',
  stateTitle: '回数が増える時', flowTitle: '表示を読み直す時', dataTitle: '保存の形',
  raceTitle: '2つのタブと日付の境目で起きうること',
  stateSentence: '太い線だけが回数を足す処理を通り、ほかの切り替えでは増えません。',
  nonMain: '数えない',
  stateValues: { work: '作業中', break: '休憩中' },
  stateEvents: { 619: '時間切れ', 631: '時間切れ', 697: 'モードのボタン', 714: '矢印キー' },
  entries: { 659: '250msごとに確認', 670: 'ボタンで操作', 701: 'キーで操作', 719: 'タブに戻る',
    393: 'ページを開く', 726: '別のタブで保存', 727: '1秒ごとに確認', 694: 'モードのボタン' },
  conditions: { 613: '作業の終了時だけ' },
  origins: { 469: '表示の対象になる日付', 475: '終了予定時刻の日付' },
  keyParts: { 0: '現地の日付' }, states: { 441: 'このタブの手元の数' },
  dataSentence: '「ブラウザの保存」のキーと、「回数を読み出す」の458行、「回数を1足して保存」の479行を見ます。',
  raceSentence: '1〜4の順番と、保存結果4・本来5を見ます。' };
draft.mapCaption = '4つの入口が「画面の数字を読み直す」に集まり、①の条件で回数が増えます。';
draft.interpretations = [draft.interpretations[0], draft.interpretations[1], draft.interpretations[3],
  draft.interpretations[2], draft.interpretations[4]];
draft.concerns = [];
draft.edges = [];
draft.screenImage = 's6-screen.png';
draft.images = [
  { path: 's6-before-card.png', caption: '変更前の作業画面を同じ条件で撮影しました。', role: 'before', screen: '作業画面' },
  { path: 's6-after-card.png', caption: '変更後の作業画面を同じ条件で撮影しました。', role: 'after', screen: '作業画面' }
];
for (const row of draft.interpretations) delete row.evidence;
for (const [row, line, testsForRow] of draft.interpretations.map((row, i) => [row,
  [613, 475, 727, 480, 726][i], [
    ['only completed work increments; pause, reset and mode changes do not'],
    ['work spanning local midnight belongs to the completion date', "a delayed tick after midnight records the actual deadline's date"],
    ["reload restores today's total and the next local date starts at zero"],
    ['invalid saved counts are ignored without breaking work completion',
      'blocked storage retains counts in memory, including failed writes to existing data'],
    ["another tab's saved completion appears and is preserved on the next completion"]
  ][i]])) { row.line = line; row.tests = testsForRow; row.why = [
    '休憩へ移る入口が複数あるため、数える条件を限定しました。',
    '日付の境目をまたぐ場合に、記録する日の基準が必要です。',
    '開いたまま日付が変わる場合にも、表示する値を切り替えます。',
    '保存が使えない場合にも、作業中の値を扱えるようにしました。',
    'ほかのタブの変更を表示に反映するため、通知を受けます。'
  ][draft.interpretations.indexOf(row)]; }
draft.interpretations[4].unrequested = true;
draft.interpretations[2].image = 's6-screen-reloaded.png';
writeCase(input, JSON.stringify(draft));
const prep = prepare();
assert.equal(prep.status, 0);
assert.equal(prep.body.ok, true);
const preparedForDraft = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
draft.interpretations[2].nodeId = preparedForDraft.map.nodes.find(node => node.kind === 'entry' && node.line === 727)?.id;
draft.nodes.push({ id: draft.interpretations[2].nodeId, title: '1秒ごとに確認',
  caption: '一定の間隔で画面を読み直します。', hunkIds: [] });
delete draft.interpretations[3].nodeId;
draft.interpretations[3].edgeId = preparedForDraft.views.structure.writeEdgeId;
writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(draft), 'utf8');
const made = render();
assert.equal(made.status, 0);
assert.equal(made.body.ok, true, JSON.stringify(made.body.reasons));
assert.equal(made.body.unassignedHunks, 0);
const prepared = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
const gt = JSON.parse(readFileSync(resolve(fixture, 'r10-d/gt-s6.json'), 'utf8'));
const views = prepared.views, machine = views.stateMachine, key = views.keys[0];
assert.deepEqual(views.selected, { S: true, D: true, T: true, C: true, M: true });
assert.deepEqual(made.body.views, views.selected);
assert.deepEqual(machine.states.map(item => item.value), ['work', 'break']);
assert.deepEqual(machine.transitions.map(item => [item.line, item.from, item.to, item.main]), [
  [619, ['work'], ['break'], true], [631, ['break'], ['work'], false],
  [697, ['work', 'break'], ['work', 'break'], false],
  [714, ['work', 'break'], ['break', 'work'], false]
]);
assert.deepEqual(views.steps.map(item => [item.number, item.kind, item.line]), [
  ['1', 'date', 475], ['2', 'read', 476], ['3', 'write', 479], ['4', 'display', 483]
]);
assert.deepEqual([views.boundary.writeOriginLine, views.boundary.displayOriginLine], [475, 469]);
assert.deepEqual([views.boundary.previousDate, views.boundary.completedDate], ['2026-09-25', '2026-09-26']);
assert.deepEqual([key.facts.readCatchLine, key.facts.saveCatchLine], [461, 480]);
assert.equal(views.omissions.filter(item => item.kind === 'folded').length, 2);
assert.deepEqual(key.writers, gt.changedKey.writers.map(name => `${name} 479`));
assert.deepEqual(key.readers, gt.changedKey.readers.map(name => `${name} 458`));
assert.deepEqual(views.groups.find(group => group.kind === 'count').entries.map(item => item.entry), gt.rmwEntries);
assert.equal(views.groups.find(group => group.kind === 'refresh').entries.length, 4);
assert.equal(views.race.entries.length, 4);
assert(views.race.entries.every(item => item.path.includes('@')));
const html = readFileSync(resolve(runFolder, 'results.html'), 'utf8');
const section = kind => html.match(new RegExp(`<section class="ex-view[^>]*data-view="${kind}"[\\s\\S]*?<\\/section>`))?.[0] ?? '';
for (const kind of ['state', 'structure', 'data', 'race']) assert(section(kind), kind);
assert(html.indexOf('class="ex-lead') < html.indexOf('class="ex-request') &&
  html.indexOf('class="ex-request') < html.indexOf('class="ex-screen-comparison') &&
  html.indexOf('class="ex-screen-comparison') < html.indexOf('<div class="ex-view-legend ex-view-main-legend') &&
  html.indexOf('<h2>図1　') < html.indexOf('<h2>図2　') &&
  html.indexOf('<h2>図2　') < html.indexOf('<h2>図3　') &&
  html.indexOf('<h2>図3　') < html.indexOf('<h2>図4　'));
assert.match(html, /<h2>図1　回数が増える時<\/h2>/);
assert.match(html, /<h2>図2　表示を読み直す時<\/h2>/);
assert.match(html, /<h2>図3　保存の形<\/h2>/);
assert.match(html, /<h2>図4　2つのタブと日付の境目で起きうること（実行では未確認）<\/h2>/);
for (const expected of ['s6-before-card.png', 's6-after-card.png'])
  assert(html.includes(`data-poiesis-image="${expected}"`));
assert.equal(input.images.some(item => /s6-(before|after)-card/.test(item.path)), false);
assert.equal((html.match(/data-poiesis-image="s6-before-card\.png"/g) ?? []).length, 1);
assert.equal((html.match(/data-poiesis-image="s6-after-card\.png"/g) ?? []).length, 1);
assert.match(section('state'), /data-transition-line="619"[^>]+data-main="true"/);
for (const line of [631, 697, 714]) assert(section('state').includes(`data-transition-line="${line}"`));
for (const line of [475, 476, 479, 483]) assert(section('structure').includes(`data-evidence="${line}"`));
assert(section('structure').includes('選ぶと図3 保存の形'));
assert(section('structure').includes('ex-view-link-read'));
assert(section('structure').includes('ex-view-link-call'));
assert(section('data').includes('data-key-dates="2026-09-25,2026-09-26"'));
assert(section('data').includes('古い日は消さない'));
assert(section('data').includes('data-read-catch="461" data-write-catch="480"'));
assert(section('data').includes('data-write-origin="475" data-display-origin="469"'));
assert(section('race').includes('ex-view-race-window'));
assert(section('race').includes('ex-view-date-boundary'));
assert(section('race').includes('起こしうる入口と経路'));
assert.deepEqual([...section('race').matchAll(/data-point="(\d+)" data-evidence="(\d+)"/g)]
  .map(match => [match[1], match[2]]), [['1', '458'], ['2', '458'], ['3', '479'], ['4', '479']]);
assert(section('structure').includes('class="ex-view-concern" href="#ex-race-view"'));
assert(section('structure').includes('data-entry-line="393" data-action-line="728"'));
assert(section('structure').includes('ex-view-entry ex-status-modified" data-entry-line="719"'));
assert(section('race').includes('ex-view-date-timeline'));
assert.equal((section('race').match(/class="ex-view-date-lane-line"/g) ?? []).length, 2);
assert.equal((section('race').match(/class="ex-view-date-flow-line/g) ?? []).length, 2);
assert.equal((section('race').match(/class="ex-view-date-event/g) ?? []).length, 4);
assert(!section('race').includes('境目より前の終了予定'));
assert(section('race').includes(draft.viewNames.origins[475]));
assert(section('race').includes(draft.viewNames.origins[469]));
for (const label of ['依頼にない追加', '確かめていない', '懸念（並行の図）']) assert(html.includes(label));
assert(html.includes('data-badge-edge="' + views.structure.writeEdgeId + '"'));
assert(html.includes('ex-view-addition'));
assert.match(html, /③[\s\S]*reload restores today&#39;s total and the next local date starts at zero/);
assert.match(html, /検査は AI が選び、実行の記録で成功を確かめたもの/);
assert.match(html, /差分の抜粋/);
assert(!html.includes('<h2>依頼文</h2>'));
assert(!/<\w+[^>]*\son[a-z]+\s*=/i.test(html));
for (const title of [...html.matchAll(/<h2>図\d+　([^<]+)<\/h2>/g)].map(match => match[1]))
  assert(!/(?:か。|ですか|ますか|[?？])$/.test(title));
const csp = `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'`;
const themeStyle = `:root{--results-bg:#fff;--results-fg:#1d2925;--results-muted:#57645e;--results-border:#d4ddd7;--results-accent:#17804b;--results-font-sans:Arial,sans-serif;--results-font-mono:Consolas,monospace}`;
const srcdoc = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${themeStyle}</style>`)
  .replace('<html lang="ja">', '<html lang="ja" data-theme="light">');
let browser;
try {
  browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'], timeout: 30000 });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.setContent('<!doctype html><html><body style="margin:0"><script>window.received=[];window.addEventListener("message",event=>window.received.push(event.data))</script></body></html>');
  await page.evaluate(value => { const frame = document.createElement('iframe');
    frame.style.cssText = 'width:1688px;height:1000px;border:0'; frame.setAttribute('sandbox', 'allow-scripts');
    frame.srcdoc = value; document.body.append(frame); }, srcdoc);
  const iframe = await page.waitForSelector('iframe'), frame = await iframe.contentFrame();
  await frame.waitForSelector('[data-view="state"]');
  await frame.waitForFunction(() => [...document.querySelectorAll('.ex-view-link path')]
    .every(path => Boolean(path.getAttribute('d'))));
  const fontAudit = () => frame.evaluate(() => [...document.querySelectorAll(
    '.ex-view strong,.ex-view small,.ex-view a,.ex-view p,.ex-view span,.ex-view th,.ex-view td,.ex-view figcaption,.ex-view text,.ex-view li')]
    .filter(item => { const rect = item.getBoundingClientRect(), style = getComputedStyle(item);
      return rect.width > 0 && rect.height > 0 && style.visibility === 'visible' && style.display !== 'none'; })
    .map(item => ({ size: parseFloat(getComputedStyle(item).fontSize), tag: item.tagName, text: item.textContent.slice(0, 25) }))
    .sort((a, b) => a.size - b.size).slice(0, 5));
  const initialFonts = await fontAudit();
  assert(initialFonts[0]?.size >= 12, JSON.stringify(initialFonts));
  const stateConnections = await frame.evaluate(() => {
    const diagram = document.querySelector('.ex-state-binary');
    const cards = [...diagram.querySelectorAll(':scope > .ex-state-card')];
    const tracks = diagram.querySelector('.ex-state-transitions').getBoundingClientRect();
    const railTop = tracks.top + parseFloat(getComputedStyle(diagram.querySelector('.ex-state-transitions'), '::before').top);
    const railBottom = tracks.bottom - parseFloat(getComputedStyle(diagram.querySelector('.ex-state-transitions'), '::before').bottom);
    return [...diagram.querySelectorAll('.ex-state-transition')].map(item => {
      const line = item.querySelector('.ex-state-line').getBoundingClientRect();
      const left = cards[0].getBoundingClientRect(), right = cards[1].getBoundingClientRect();
      return { line: Number(item.dataset.transitionLine), connected: Math.abs(line.left - left.right) <= 2 &&
        Math.abs(line.right - right.left) <= 2 && line.top >= railTop && line.top <= railBottom &&
        railTop < left.bottom && railBottom > left.top,
      direction: item.querySelector('.ex-state-line').className };
    });
  });
  assert(stateConnections.every(item => item.connected), JSON.stringify(stateConnections));
  assert(stateConnections.find(item => item.line === 619)?.direction.includes('right'));
  assert(stateConnections.find(item => item.line === 631)?.direction.includes('left'));
  const stateGeometry = await frame.evaluate(() => {
    const process = document.querySelector('.ex-state-main .ex-state-process');
    const line = document.querySelector('.ex-state-main .ex-state-line');
    const p = process.getBoundingClientRect(), l = line.getBoundingClientRect();
    const cards = [...document.querySelectorAll('.ex-state-binary > .ex-state-card')].map(item => item.getBoundingClientRect().height);
    const dynamic = document.querySelector('[data-transition-line="697"] .ex-view-dynamic-target').getBoundingClientRect();
    const citation = document.querySelector('[data-transition-line="697"] .ex-state-event a').getBoundingClientRect();
    return { process: process.textContent, height: Math.max(...cards), overlapping: p.left < l.right && p.right > l.left && p.top < l.bottom && p.bottom > l.top,
      separated: dynamic.left - citation.right };
  });
  assert(stateGeometry.overlapping && stateGeometry.height <= 120 && stateGeometry.process.includes('473–484行') &&
    stateGeometry.process.includes('613行') && stateGeometry.separated >= 4, JSON.stringify(stateGeometry));
  const imagePair = await frame.evaluate(() => [...document.querySelectorAll('.ex-screen-pair img')]
    .map(item => ({ width: item.getBoundingClientRect().width, x: item.getBoundingClientRect().x,
      y: item.getBoundingClientRect().y, loaded: item.naturalWidth > 0 })));
  assert.equal(imagePair.length, 2);
  assert(imagePair.every(item => item.loaded && item.width >= 380 && item.width <= 420), JSON.stringify(imagePair));
  assert(imagePair[0].x + imagePair[0].width < imagePair[1].x && Math.abs(imagePair[0].y - imagePair[1].y) <= 2,
    JSON.stringify(imagePair));
  const flowGeometry = await frame.evaluate(() => {
    const page = document.querySelector('[data-entry-line="393"]');
    const modified = document.querySelector('[data-entry-line="719"]');
    const write = document.querySelector('.ex-view-arrow-storage');
    const line = write.querySelector('.ex-view-arrow-line').getBoundingClientRect();
    const concern = write.querySelector('.ex-view-concern').getBoundingClientRect();
    return { pageCitation: page.querySelector('a[data-poiesis-citation]').dataset.poiesisCitation,
      modifiedBorder: getComputedStyle(modified).borderStyle, modifiedText: modified.textContent,
      concernOnWrite: concern.left < line.right && concern.right > line.left && Math.abs((concern.top + concern.bottom) / 2 - line.top) < 20 };
  });
  assert.equal(flowGeometry.pageCitation, 'index.html:728-728');
  assert.equal(flowGeometry.modifiedBorder, 'dashed');
  assert(flowGeometry.modifiedText.includes('手を入れた既存') && flowGeometry.concernOnWrite, JSON.stringify(flowGeometry));
  const raceGeometry = await frame.evaluate(() => {
    const date = document.querySelector('.ex-view-date-boundary');
    const notice = document.querySelector('.ex-view-notify');
    return { lanes: date.querySelectorAll('.ex-view-date-lane-line').length, events: date.querySelectorAll('.ex-view-date-event').length,
      flows: date.querySelectorAll('.ex-view-date-flow-line').length, markerHeight: date.querySelector('.ex-view-date-marker').getBoundingClientRect().height,
      notice: notice.textContent, noticeElementCount: document.querySelectorAll('.ex-view-notify').length,
      notifyDisplay: getComputedStyle(notice).display };
  });
  assert.deepEqual([raceGeometry.lanes, raceGeometry.events, raceGeometry.flows, raceGeometry.noticeElementCount], [2, 4, 2, 1]);
  assert(raceGeometry.markerHeight > 100 && raceGeometry.notice.includes('で両方の画面を読み直します。') &&
    raceGeometry.notifyDisplay === 'block', JSON.stringify(raceGeometry));
  const lineStyles = await frame.evaluate(() => ['call', 'storage', 'display'].map(kind =>
    getComputedStyle(document.querySelector(`.ex-legend-${kind}`)).borderTopStyle));
  assert.deepEqual(lineStyles, ['solid', 'dashed', 'dotted']);
  const storageId = views.structure.storageId;
  await frame.click(`[data-view="structure"] .ex-view-card[data-part="${storageId}"]`);
  assert(await frame.evaluate(() => document.querySelector('[data-view="data"]').classList.contains('ex-view-visible')));
  const dataFonts = await fontAudit();
  assert(dataFonts[0]?.size >= 12, JSON.stringify(dataFonts));
  const brokenGeometry = await frame.evaluate(() => {
    const broken = document.querySelector('.ex-view-broken');
    return { lineBottom: broken.querySelector(':scope > div').getBoundingClientRect().bottom,
      citationTop: broken.querySelector(':scope > small').getBoundingClientRect().top };
  });
  assert(brokenGeometry.citationTop - brokenGeometry.lineBottom >= 8, JSON.stringify(brokenGeometry));
  await frame.click('[data-view="structure"] .ex-view-record .ex-view-judgment > summary');
  assert(await frame.evaluate(() => Boolean(document.querySelector('.ex-view-record .ex-view-judgment[open] .ex-panel'))));
  const panelContent = await frame.$eval('.ex-view-record .ex-view-judgment[open] .ex-panel', item => item.textContent);
  assert(panelContent.includes('差分の抜粋') && panelContent.includes('work spanning local midnight'));
  const openedFonts = await fontAudit();
  assert(openedFonts[0]?.size >= 12, JSON.stringify(openedFonts));
  await new Promise(resolve => setTimeout(resolve, 300));
  await frame.click('.ex-view-record .ex-view-judgment[open] .ex-panel-close');
  await frame.waitForFunction(() => !document.querySelector('.ex-view-record .ex-view-judgment[open]'));
  await frame.click('[data-view="structure"] .ex-view-entry[data-entry-line="727"] .ex-view-judgment > summary');
  assert(await frame.$eval('[data-view="structure"] .ex-view-entry[data-entry-line="727"] .ex-view-judgment[open] .ex-view-judgment-image img',
    item => item.naturalWidth > 0));
  await new Promise(resolve => setTimeout(resolve, 300));
  await frame.click('[data-view="structure"] .ex-view-entry[data-entry-line="727"] .ex-view-judgment[open] .ex-panel-close');
  await frame.waitForFunction(() => !document.querySelector('[data-view="structure"] .ex-view-entry[data-entry-line="727"] .ex-view-judgment[open]'));
  await new Promise(resolve => setTimeout(resolve, 300));
  await frame.click(`[data-view="data"] .ex-view-card[data-part="${storageId}"] a[data-poiesis-citation]`);
  await page.waitForFunction(() => window.received.some(message => message.type === 'poiesis:open-citation'));
  const citationMessage = await page.evaluate(() => window.received.find(message => message.type === 'poiesis:open-citation'));
  assert.equal(citationMessage.citation, 'index.html:458-458');
  await frame.click('.ex-screen-pair button');
  await page.waitForFunction(() => window.received.some(message => message.type === 'poiesis:open-image'));
  const documentHeight = await frame.evaluate(() => document.documentElement.scrollHeight);
  await page.$eval('iframe', (item, height) => { item.style.height = `${height}px`; }, documentHeight);
  await page.screenshot({ path: resolve(out, 'results-skill-s6-four-views.png'), fullPage: true });
  const dateTop = await frame.$eval('.ex-view-date-boundary', item => item.getBoundingClientRect().top);
  await page.evaluate(top => window.scrollTo(0, top), dateTop);
  await page.screenshot({ path: resolve(out, 'results-skill-s6-date.png') });
  console.log(JSON.stringify({ preparationExit: prep.status, renderExit: made.status, s6TestsExit: tests.status,
    views: views.selected, states: machine.states.length, transitions: machine.transitions.map(item => item.line),
    steps: views.steps.map(item => item.line), boundary: [views.boundary.writeOriginLine, views.boundary.displayOriginLine],
    minFont: initialFonts[0].size, dataFont: dataFonts[0].size, openedFont: openedFonts[0].size,
    imagePair, stateGeometry, flowGeometry, raceGeometry, brokenGeometry, citation: citationMessage }));
} finally { await browser?.close(); }
const noReasonDraft = structuredClone(draft);
delete noReasonDraft.interpretations[0].why;
writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(noReasonDraft), 'utf8');
const noReasonRender = render();
assert.equal(noReasonRender.status, 0);
assert.equal(noReasonRender.body.ok, true, JSON.stringify(noReasonRender.body.reasons));
const noReasonHtml = readFileSync(resolve(runFolder, 'results.html'), 'utf8');
const firstPanel = noReasonHtml.match(/<div class="ex-panel"[^>]*aria-label="判断1の根拠"([\s\S]*?)<h3>確かめ方<\/h3>/)?.[1];
assert(firstPanel && !firstPanel.includes('class="ex-p-why') &&
  firstPanel.split(noReasonDraft.interpretations[0].decision).length - 1 === 1, '理由がないときは判断の文を繰り返さない');
writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(draft), 'utf8');
assert.equal(render().body.ok, true);
