import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { appInput, command, root, runFolder, skill, writeCase, prepare, render } from './fixtures/results-skill/helper.mjs';

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
const input = appInput(realWorkspace, diff);
input.verification.rows = [{ label: '作業回数の自動テスト', status: 'pass', detail: '8件すべて成功しました。', image: '' }];
input.verification.counts.pass = 1;
input.verification.total = 1;
input.verification.summary = '作業回数の自動テストを実行しました。';
writeCase(input);
const prep = prepare();
assert.equal(prep.status, 0);
assert.equal(prep.body.ok, true);
const made = render();
assert.equal(made.status, 0);
assert.equal(made.body.ok, true, JSON.stringify(made.body.reasons));
assert.equal(made.body.unassignedHunks, 0);
const prepared = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
assert(made.body.drawnEdges.every(id => prepared.map.edges.some(edge => edge.id === id)));
const tests = command(process.execPath, ['--test', '--test-reporter=tap', 'tests/daily-count.test.cjs'], { cwd: realWorkspace });
assert.equal(tests.status, 0, tests.stdout + tests.stderr);
assert.match(tests.stdout, /# pass 8/);
assert.match(tests.stdout, /# fail 0/);

const html = readFileSync(resolve(runFolder, 'results.html'), 'utf8');
const csp = `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'`;
const themeStyle = `:root{--results-bg:#fff;--results-fg:#1d2925;--results-muted:#57645e;--results-border:#d4ddd7;--results-accent:#17804b;--results-font-sans:Arial,sans-serif;--results-font-mono:Consolas,monospace}::-webkit-scrollbar{width:9px}`;
const srcdoc = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${themeStyle}</style>`)
  .replace('<html lang="ja">', '<html lang="ja" data-theme="light">');
let browser;
try {
  browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'], timeout: 30000 });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 720, deviceScaleFactor: 1 });
  await page.setContent('<!doctype html><html><body style="margin:0"><script>window.received=[];window.addEventListener("message",event=>window.received.push(event.data))</script></body></html>');
  await page.evaluate(value => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'width:900px;height:720px;border:0';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.srcdoc = value;
    document.body.append(frame);
  }, srcdoc);
  const iframe = await page.waitForSelector('iframe');
  const frame = await iframe.contentFrame();
  await frame.waitForSelector('.ex-map .ex-title');
  await frame.evaluate(() => document.fonts.ready);
  const measure = () => frame.evaluate(() => {
    const map = document.querySelector('.ex-map');
    const scale = map.getBoundingClientRect().width / map.viewBox.baseVal.width;
    return { overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      mapWidth: map.getBoundingClientRect().width,
      minFont: Math.min(...[...document.querySelectorAll('.ex-title')].map(el => parseFloat(getComputedStyle(el).fontSize) * scale)),
      open: document.querySelectorAll('details.ex-hit[open],details.ex-hit-inline[open]').length,
      panelWidth: document.querySelector('details.ex-hit[open] .ex-panel')?.getBoundingClientRect().width ?? 0 };
  });
  const closed = await measure();
  assert.equal(closed.overflow, 0);
  assert(closed.minFont >= 11);
  await page.screenshot({ path: resolve(out, 'results-skill-s6-map.png') });
  await frame.click('.ex-hit > summary');
  await frame.waitForSelector('.ex-hit[open] .ex-panel');
  await frame.evaluate(() => new Promise(done => setTimeout(done, 300)));
  const opened = await measure();
  assert.equal(opened.open, 1);
  const grip = await frame.$('.ex-hit[open] .ex-panel-grip');
  const box = await grip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x - 70, box.y + 100, { steps: 5 });
  await page.mouse.up();
  await frame.evaluate(() => new Promise(done => setTimeout(done, 300)));
  const resized = await measure();
  assert(resized.panelWidth > opened.panelWidth + 40, JSON.stringify({ opened, resized }));
  await frame.evaluate(() => document.querySelector('.ex-hit[open] .ex-panel-grip').focus());
  await page.keyboard.press('ArrowLeft');
  assert((await measure()).panelWidth >= resized.panelWidth + 19);
  await frame.click('.ex-hit[open] .ex-p-open');
  await page.waitForFunction(() => window.received.some(message => message.type === 'poiesis:open-citation'));
  const citation = await page.evaluate(() => window.received.find(message => message.type === 'poiesis:open-citation'));
  assert.match(citation.citation, /^index\.html:\d+-\d+$/);
  await page.screenshot({ path: resolve(out, 'results-skill-s6-panel.png') });
  await frame.evaluate(() => document.querySelector('.ex-hit[open] .ex-panel-grip').focus());
  await page.keyboard.press('Escape');
  const closedByEscape = await frame.evaluate(() => ({ open: !!document.querySelector('.ex-hit[open]'),
    focused: document.activeElement?.matches('.ex-hit > summary') }));
  assert.deepEqual(closedByEscape, { open: false, focused: true });
  assert.equal((await measure()).overflow, 0);
  const report = { preparationExit: prep.status, renderExit: made.status, s6TestsExit: tests.status,
    boxes: made.body.geometry.boxes.length, arrows: made.body.drawnEdges.length,
    columns: made.body.geometry.layerCount, width: made.body.geometry.width,
    minFont: closed.minFont, unassignedHunks: made.body.unassignedHunks,
    closed, opened, resized, citation };
  writeFileSync(resolve(out, 'results-skill-s6-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report));
} finally { await browser?.close(); }
