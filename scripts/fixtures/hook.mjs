import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const mode = process.argv[2] ?? 'context';
if (mode === 'timeout') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { shell: false, windowsHide: true, stdio: 'ignore' });
    if (process.argv[3]) writeFileSync(process.argv[3], String(child.pid), 'utf8');
    setInterval(() => {}, 1000);
} else if (mode === 'invalid') process.stdout.write('invalid');
else if (mode === 'exit') process.exitCode = 7;
else if (mode === 'empty') { /* Valid empty output. */ }
else if (mode === 'versioned-evidence') process.stdout.write(JSON.stringify({ evidence: [
    { label: '入力保持', status: 'pass', detail: '入力が残りました。', changeSetHash: input.data.changeSetHash, runId: input.runId, capturedAt: '2026-09-24T00:00:00Z', image: 'workspace-screen.png' },
    { label: '通信の復旧', status: 'fail', detail: '再接続できませんでした。', changeSetHash: input.data.changeSetHash },
    { label: '以前の画面', status: 'pass', detail: '前の変更で取得した記録です。', changeSetHash: 'sha256:previous' },
    { label: '配布の可否', status: 'human', detail: '通信の制約を案内して配布しますか？', changeSetHash: input.data.changeSetHash }
] }));
else if (mode === 'bad-evidence-version') process.stdout.write(JSON.stringify({ evidence: [{ label: 'bad', status: 'pass', detail: '', changeSetHash: 123 }] }));
else if (mode === 'bad-human') process.stdout.write(JSON.stringify({ evidence: [{ label: 'bad', status: 'human', detail: '' }] }));
else if (mode === 'block') process.stdout.write(JSON.stringify({ block: { reason: '確認してください。' } }));
else if (mode === 'evidence') process.stdout.write(JSON.stringify({ notes: 'Fixture verification', evidence: [{ label: 'fixture', status: 'pass', detail: input.taskId, image: 'evidence/after.png' }] }));
else if (mode === 'material') process.stdout.write(JSON.stringify({ material: 'Fixture Results material' }));
else process.stdout.write(JSON.stringify({ additionalContext: `HOOK_FIXTURE_CONTEXT ${input.event} ${process.argv[3] ?? ''}` }));
