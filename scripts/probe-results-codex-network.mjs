import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'poiesis-codex-network-probe-'));
const home = join(root, 'codex-home');
const work = join(root, 'work');
await mkdir(home); await mkdir(work);
const sourceHome = process.env.CODEX_HOME || join(homedir(), '.codex');
const auth = join(sourceHome, 'auth.json');
if (await stat(auth).then(info => info.isFile(), () => false)) await copyFile(auth, join(home, 'auth.json'));
const cli = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
const args = [cli, 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
    '-c', 'sandbox_workspace_write.network_access=false', '-c', 'approval_policy="never"',
    '--sandbox', 'workspace-write', '--json', '-C', work, '-'];
const prompt = 'Use the shell tool to run this exact one-line command once, then report its output: '
    + 'node -e "fetch(\'https://example.com\',{signal:AbortSignal.timeout(5000)}).then(r=>console.log(\'NETWORK_REACHED\',r.status)).catch(e=>console.log(\'NETWORK_BLOCKED_OR_FAILED\',e.message))"';
let output = '';
let stderr = '';
try {
    const outsideStatus = await fetch('https://example.com', { signal: AbortSignal.timeout(5000) })
        .then(response => response.status, error => `failed:${error.name}`);
    const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd: work, env: { ...process.env, CODEX_HOME: home }, shell: false, windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'] });
        const timer = setTimeout(() => { child.kill(); reject(new Error('Codex network probe timed out')); }, 120_000);
        child.stdout.on('data', data => { output += data.toString('utf8'); });
        child.stderr.on('data', data => { stderr += data.toString('utf8'); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => { clearTimeout(timer); resolve(code); });
        child.stdin.end(prompt);
    });
    const events = output.split(/\r?\n/).filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
    });
    const commands = events.filter(event => event.item?.type === 'command_execution');
    const commandOutput = commands.map(event => event.item?.aggregated_output || '').join('\n');
    const persisted = (await readdir(home)).filter(name => name !== 'auth.json');
    const rejectedByPolicy = stderr.includes('rejected: blocked by policy');
    console.log(JSON.stringify({ exitCode: result, outsideStatus, commands: commands.length,
        networkReached: commandOutput.includes('NETWORK_REACHED'),
        networkBlockedOrFailed: commandOutput.includes('NETWORK_BLOCKED_OR_FAILED'),
        rejectedByPolicy, commandOutput: commandOutput.slice(0, 500), persistedHomeEntries: persisted }));
    if (result !== 0 || !commands.length && !rejectedByPolicy) process.exitCode = 1;
} finally {
    await rm(root, { recursive: true, force: true });
}
