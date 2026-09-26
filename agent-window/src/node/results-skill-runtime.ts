import { existsSync } from 'node:fs';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseSkillDocument } from '../browser/skill-document';
import type { BundledResultsSkillInfo } from '../common/results-generation-protocol';
import { oneShotCliArgs, assertBoundedCliArgs, OneShotCliArgsInput } from './cli-args';

export function pathWithin(parent: string, child: string): boolean {
    const path = relative(parent, child);
    return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function resultsSkillCandidates(): string[] {
    const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? join(dirname(process.execPath), 'resources');
    // __dirname differs between the extension's tsc output and Theia's bundled backend.
    return [join(resources, 'poiesis-results'), resolve(__dirname, '../../skills/poiesis-results'),
        resolve(__dirname, '../../../agent-window/skills/poiesis-results')];
}

export async function loadBundledResultsSkill(): Promise<BundledResultsSkillInfo & { directory: string; content: string }> {
    const candidates = process.env.POIESIS_RESULTS_SKILL_DIR ? [resolve(process.env.POIESIS_RESULTS_SKILL_DIR)] : resultsSkillCandidates();
    for (const candidate of candidates) {
        try {
            const directory = await realpath(candidate);
            const content = (await readFile(join(directory, 'SKILL.md'), 'utf8')).replace(/^\uFEFF/, '');
            const parsed = parseSkillDocument('poiesis-results', content);
            if (parsed.error || parsed.kind !== 'results') { throw new Error('Invalid bundled skill'); }
            return { directory, content, name: parsed.name, description: parsed.description };
        } catch { /* Try only app-owned locations, never the user's workspace. */ }
    }
    throw new Error('組み込みの成果作成機能を読み込めませんでした。');
}

/** Use an unchanged Node binary, including in packaged Electron where execPath is not Node. */
export function resultsNodeExecutable(): string {
    const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? join(dirname(process.execPath), 'resources');
    const name = process.platform === 'win32' ? 'node.exe' : 'node';
    const candidates = [join(resources, 'results-runtime', name), process.execPath,
        process.env.npm_node_execpath, join(process.env.ProgramFiles ?? 'C:/Program Files', 'nodejs', name)];
    const executable = candidates.find((path): path is string => Boolean(path && basename(path).toLowerCase() === name && existsSync(path)));
    if (!executable) { throw new Error('成果作成に必要な実行環境が見つかりません。アプリを再インストールしてください。'); }
    return executable;
}

export function resultsExecutionEnvironment(node: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env = { ...source };
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
    const oldPath = env[pathKey] ?? '';
    for (const key of Object.keys(env)) { if (key.toLowerCase() === 'path') { delete env[key]; } }
    env.PATH = `${dirname(node)}${delimiter}${oldPath}`;
    // Inherited Node flags must not execute code before the approved script.
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
}

export function resultsSkillCliArgs(input: OneShotCliArgsInput, settings?: string): string[] {
    if (input.providerId !== 'codex' && input.providerId !== 'claude') {
        throw new Error('成果文書の作成には未対応');
    }
    const base = oneShotCliArgs({ ...input, skipGitRepositoryCheck: true });
    let args: string[];
    if (input.providerId === 'codex') {
        args = base.map(arg => arg === 'read-only' ? 'workspace-write' : arg);
        args.splice(1, 0, '-c', 'sandbox_workspace_write.network_access=false', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
            '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'web_search="disabled"', '-c', 'approval_policy="never"');
    } else {
        if (!settings) { throw new Error('成果作成の道具を制限できませんでした。'); }
        args = base.filter(arg => arg !== '--tools=' && arg !== '--safe-mode').map(arg => arg === 'plan' ? 'dontAsk' : arg);
        args.push('--tools', 'Read,Write,Bash', '--setting-sources', '', '--settings', settings);
    }
    assertBoundedCliArgs(args);
    return args;
}

// This is a security gate, not a document pipeline. It knows no script names or sequence.
export const CLAUDE_RESULTS_GATE = String.raw`
const fs = require('node:fs');
const p = require('node:path');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
function canonical(value) {
    const target = p.resolve(config.run, value);
    if (fs.existsSync(target)) return fs.realpathSync(target);
    return p.join(canonical(p.dirname(target)), p.basename(target));
}
function within(root, value) {
    const rel = p.relative(root, value);
    return !rel || rel !== '..' && !rel.startsWith('..' + p.sep) && !p.isAbsolute(rel);
}
function allowed(event) {
    const input = event.tool_input || {};
    if (event.tool_name === 'Read' || event.tool_name === 'Write') {
        if (typeof input.file_path !== 'string' || /[\x00-\x1f]/.test(input.file_path)) return false;
        const target = canonical(input.file_path);
        return (event.tool_name === 'Write' ? [config.run] : [config.run, config.workspace, config.skill]).some(root => within(root, target));
    }
    if (event.tool_name !== 'Bash' || typeof input.command !== 'string' || input.run_in_background) return false;
    const command = input.command.trim();
    if (/[\x00-\x1f$\x60;&|<>\\!*?{}()~]/.test(command)) return false;
    const tokens = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s"']+/g) || [];
    if (tokens.join(' ') !== command.replace(/ +/g, ' ')) return false;
    const args = tokens.map(token => /^['"]/.test(token) ? token.slice(1, -1) : token);
    if (args[0] !== 'node' || args.length < 2 || args[1].startsWith('-')) return false;
    const script = canonical(args[1]);
    return within(p.join(config.skill, 'scripts'), script) && /\.(?:mjs|cjs|js)$/.test(script) && fs.statSync(script).isFile();
}
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { data += chunk; if (data.length > 2 * 1024 * 1024) process.exit(2); });
process.stdin.on('end', () => {
    let ok = false;
    try { ok = allowed(JSON.parse(data)); } catch {}
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: ok ? 'allow' : 'deny',
        permissionDecisionReason: ok ? 'Approved Results skill operation' : 'Only the Results skill and its run folder are available' } }));
});
`;

export async function writeClaudeResultsSettings(control: string, run: string, workspace: string, skill: string, node: string): Promise<string> {
    const gate = join(control, 'gate.cjs');
    const policy = join(control, 'policy.json');
    await writeFile(gate, CLAUDE_RESULTS_GATE, 'utf8');
    await writeFile(policy, JSON.stringify({ run: await realpath(run), workspace: await realpath(workspace), skill: await realpath(skill) }), 'utf8');
    const quote = (value: string): string => {
        const normalized = value.replace(/\\/g, '/');
        if (/["$`\r\n]/.test(normalized)) { throw new Error('成果作成の実行環境を安全に準備できませんでした。'); }
        return `"${normalized}"`;
    };
    const settings = join(control, 'settings.json');
    await writeFile(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command',
        command: [node, gate, policy].map(quote).join(' '), timeout: 10 }] }] },
        permissions: { defaultMode: 'dontAsk' } }), 'utf8');
    return settings;
}
