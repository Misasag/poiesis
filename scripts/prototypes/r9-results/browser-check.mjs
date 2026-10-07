import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire('C:/Users/owner/github/poiesis-wt-chrome/electron-app/package.json');
const puppeteer = require('puppeteer-core');
const fail = message => { throw new Error(message); };

export async function verifyBrowser(cases, workspace, evidence) {
  const source = readFileSync(resolve(here, '../../..', 'agent-window/src/browser/results-rich-content.ts'), 'utf8');
  const style = source.match(/export const RESULTS_RICH_STYLE = `([\s\S]*?)`;/)?.[1];
  if (!style || style.includes('${')) fail('アプリの表示用CSSを抽出できません。');
  const paths = new Set([...evidence.images.map(i => i.path), evidence.mapImage]);
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '').slice(1));
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html><body style="margin:0;background:#e2e3de;display:flex;justify-content:center"></body></html>'); }
    else if (paths.has(path)) { res.setHeader('Content-Type', 'image/png'); res.end(readFileSync(resolve(workspace, path))); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = mkdtempSync(resolve(here, 'out/browser-check-'));
  let browser;
  const report = [];
  try {
    browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
      userDataDir: profile, args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'], timeout: 30000 });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    for (const { name, result } of cases) {
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.evaluate(html => {
        const frame = document.createElement('iframe');
        frame.style.cssText = 'width:900px;height:720px;border:0'; frame.srcdoc = html; document.body.append(frame);
      }, result.html.replace('</head>', `<style>${style}</style></head>`));
      const handle = await page.waitForSelector('iframe'), frame = await handle.contentFrame();
      await frame.waitForSelector('.ex-map .ex-title');
      await frame.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode())); });
      const measure = () => frame.evaluate(() => {
        const map = document.querySelector('.ex-map'), rect = map.getBoundingClientRect(), scale = rect.width / map.viewBox.baseVal.width;
        const names = [...document.querySelectorAll('.ex-title')];
        const panels = [...document.querySelectorAll('details.ex-hit[open] > .ex-panel')];
        const overflowing = [...document.querySelectorAll('.ex-mapfig,.ex-mapviewport,.ex-mapbox,.ex-map')]
          .filter(e => e.scrollWidth > e.clientWidth).map(e => ({ class: e.className.baseVal ?? e.className, scroll: e.scrollWidth, client: e.clientWidth }));
        const outside = [...document.querySelectorAll('[data-map-node]')].flatMap(g => {
          const r = g.querySelector('rect').getBBox();
          return [...g.querySelectorAll('text')].filter(t => { const b = t.getBBox(); return b.x < r.x || b.y < r.y || b.x + b.width > r.x + r.width || b.y + b.height > r.y + r.height; }).map(t => t.textContent);
        });
        return { mapWidth: rect.width, scrollWidth: map.scrollWidth, clientWidth: map.clientWidth, overflowing, outside,
          minNameHeight: Math.min(...names.map(n => n.getBoundingClientRect().height)),
          minNameFont: Math.min(...names.map(n => parseFloat(getComputedStyle(n).fontSize) * scale)),
          panelCount: panels.length, panelLeft: panels[0]?.getBoundingClientRect().left, mapRight: rect.right,
          images: [...document.images].filter(i => i.classList.contains('ex-mapshot')).map(i => ({ width: i.naturalWidth, height: i.naturalHeight })) };
      });
      const closed = await measure();
      if (closed.overflowing.length || closed.outside.length || closed.minNameHeight < 11 || closed.minNameFont < 11) fail(`${name}: 通常幅で地図が読めません: ${JSON.stringify(closed)}`);
      if (!closed.images.length || closed.images.some(i => !i.width)) fail(`${name}: 本物の画面画像が読み込まれていません。`);
      await page.screenshot({ path: resolve(here, `out/${name}-map.png`) });
      await frame.click('.ex-hit > summary');
      // The panel slides in and the body narrows with CSS transitions; measure the settled layout.
      await frame.evaluate(() => Promise.race([Promise.allSettled(document.getAnimations().map(animation => animation.finished)), new Promise(done => setTimeout(done, 600))]));
      const opened = await measure();
      if (opened.overflowing.length || opened.panelCount !== 1 || opened.mapWidth < 440 || opened.mapWidth > 470 || opened.mapRight > opened.panelLeft) fail(`${name}: パネルを開いた幅で地図がはみ出しています: ${JSON.stringify(opened)}`);
      await page.screenshot({ path: resolve(here, `out/${name}-panel.png`) });
      await frame.click('.ex-hit[open] .ex-close > summary');
      await frame.evaluate(() => Promise.race([Promise.allSettled(document.getAnimations().map(animation => animation.finished)), new Promise(done => setTimeout(done, 600))]));
      if (await frame.$('.ex-hit[open]')) fail(`${name}: 閉じる操作が動きません。`);
      const panels = await frame.$$eval('details[data-node-id]', nodes => nodes.map(n => n.dataset.nodeId));
      for (const id of panels) {
        await frame.click(`details[data-node-id="${id}"] > summary`);
        await frame.evaluate(() => Promise.race([Promise.allSettled(document.getAnimations().map(animation => animation.finished)), new Promise(done => setTimeout(done, 600))]));
        const open = await frame.$$eval('details[data-node-id][open]', nodes => nodes.map(n => n.dataset.nodeId));
        if (open.length !== 1 || open[0] !== id) fail(`${name}: 部品を押したときのパネルが違います。`);
        const sourceText = await frame.$eval(`details[data-node-id="${id}"] .ex-p-source`, node => node.textContent);
        const box = result.geometry.boxes.find(b => b.id === id);
        if (box?.subs.some(s => !sourceText.includes(s))) fail(`${name}: 省略前の補助行がパネルにありません。`);
        await frame.click(`details[data-node-id="${id}"] .ex-close > summary`);
        await frame.evaluate(() => Promise.race([Promise.allSettled(document.getAnimations().map(animation => animation.finished)), new Promise(done => setTimeout(done, 600))]));
      }
      report.push({ name, closed, opened, testedPanels: panels.length });
    }
    writeFileSync(resolve(here, 'out/browser-metrics.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    return report;
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    // This run owns only this freshly created profile, never the earlier worker's profile.
    const root = resolve(here, 'out') + sep;
    if (!resolve(profile).startsWith(root)) throw new Error('ブラウザの一時領域が出力先の外にあります。');
    rmSync(profile, { recursive: true, force: true });
  }
}
