import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk.toString('utf8');
const input = JSON.parse(readFileSync('input.json', 'utf8'));
const mode = process.env.POIESIS_FIXTURE_OUTPUT ?? 'valid';
if (mode === 'stall') { setInterval(() => {}, 1000); }
else {
    if (!input.retry || mode.endsWith('-always')) {
        if (mode.startsWith('empty')) writeFileSync('results.html', '\uFEFF \n', 'utf8');
        else if (mode.startsWith('large')) writeFileSync('results.html', 'あ'.repeat(Math.ceil(8 * 1024 * 1024 / 3) + 1), 'utf8');
    }
    if (mode === 'valid' || input.retry && !mode.endsWith('-always')) {
        const result = spawnSync('node', [join(input.skillDir, 'scripts/render.mjs')], {
            cwd: process.cwd(), env: process.env, encoding: 'utf8', windowsHide: true, shell: false
        });
        if (result.status !== 0) throw Error('The skill could not run Node from PATH');
    }
    const output = { type: 'item.completed', item: { type: 'agent_message', text: '成果を保存しました。' } };
    console.log(JSON.stringify(output));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 10 } }));
}
