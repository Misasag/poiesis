import { readFileSync, writeFileSync } from 'node:fs';
const input = JSON.parse(readFileSync('input.json', 'utf8').replace(/^\uFEFF/, ''));
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
writeFileSync('results.html', `<!doctype html><html lang="ja"><head><style>body { margin: 17px; font-family: var(--results-font-sans); }</style></head><body><h1>${escape(input.task.title)}</h1><button id="cite">引用</button><script>document.getElementById('cite').addEventListener('click', () => window.parent.postMessage({type:'poiesis:open-citation',citation:'src/a.ts:12-30'}, '*'));</script></body></html>`, 'utf8');
