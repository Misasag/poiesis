import { ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, extname, basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { KnownCliId } from '../common/agent-runtime-protocol';

export type HiddenCliProcess = ChildProcess & { readonly stdout: Readable; readonly stderr: Readable };

export interface HiddenCliSpawnOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
}

interface CliInvocation {
    executable: string;
    args: string[];
}

/**
 * Starts a known CLI without a command interpreter. On Windows, npm .cmd/.bat
 * shims are resolved to their real executable or JS entry point first.
 */
export function spawnHiddenCli(
    providerId: KnownCliId,
    command: string,
    args: readonly string[],
    options: HiddenCliSpawnOptions = {}
): HiddenCliProcess {
    const invocation = resolveKnownCliInvocation(providerId, command, args);
    const child = spawn(invocation.executable, invocation.args, {
        cwd: options.cwd,
        env: childCliEnvironment(options.env ?? process.env, options.cwd),
        windowsHide: true,
        shell: false,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    }) as HiddenCliProcess;
    if (options.input !== undefined) {
        child.stdin?.end(options.input, 'utf8');
    }
    return child;
}

/**
 * Prevents npm/npx processes started by an agent CLI from resolving a relative
 * cache setting against the user's Workspace. All unrelated environment values
 * (including registry and credential settings) pass through unchanged.
 */
export function childCliEnvironment(
    source: NodeJS.ProcessEnv = process.env,
    cwd?: string
): NodeJS.ProcessEnv {
    const env = { ...source };
    const cacheEntries = Object.entries(source)
        .filter(([key]) => key.toLocaleLowerCase() === 'npm_config_cache');
    const explicit = cacheEntries.find(([key]) => key === 'npm_config_cache')?.[1]
        ?? cacheEntries[0]?.[1];
    for (const key of Object.keys(env)) {
        if (key.toLocaleLowerCase() === 'npm_config_cache') {
            delete env[key];
        }
    }
    const workspacePath = cwd ? resolve(cwd) : undefined;
    const explicitPath = explicit?.trim();
    env.npm_config_cache = explicitPath && isAbsolute(explicitPath)
        && (!workspacePath || !pathIsWithin(workspacePath, explicitPath))
        ? resolve(explicitPath)
        : defaultRuntimeNpmCache(env, workspacePath);
    return env;
}

function defaultRuntimeNpmCache(env: NodeJS.ProcessEnv, workspacePath: string | undefined): string {
    const localAppData = environmentValue(env, 'LOCALAPPDATA');
    const candidates = [
        localAppData ? join(localAppData, 'Poiesis', 'runtime-cache', 'npm') : undefined,
        join(homedir(), '.poiesis', 'runtime-cache', 'npm'),
        join(tmpdir(), 'poiesis-runtime-cache', 'npm')
    ];
    for (const candidate of candidates) {
        if (candidate && isAbsolute(candidate)
            && (!workspacePath || !pathIsWithin(workspacePath, candidate))) {
            return resolve(candidate);
        }
    }
    if (workspacePath) {
        const workspaceHash = createHash('sha1').update(workspacePath, 'utf8').digest('hex').slice(0, 12);
        const sibling = join(dirname(workspacePath), `.poiesis-runtime-cache-${workspaceHash}`, 'npm');
        if (!pathIsWithin(workspacePath, sibling)) {
            return resolve(sibling);
        }
    }
    throw new Error('An npm runtime cache outside the Workspace could not be resolved.');
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
    return Object.entries(env).find(([key]) => key.toLocaleLowerCase() === name.toLocaleLowerCase())?.[1];
}

function pathIsWithin(parent: string, candidate: string): boolean {
    const parentPath = resolve(parent);
    const candidatePath = resolve(candidate);
    const comparisonParent = process.platform === 'win32' ? parentPath.toLocaleLowerCase() : parentPath;
    const comparisonCandidate = process.platform === 'win32' ? candidatePath.toLocaleLowerCase() : candidatePath;
    const relativePath = relative(comparisonParent, comparisonCandidate);
    return relativePath === '' || relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath);
}

export function resolveKnownCliInvocation(
    providerId: KnownCliId,
    command: string,
    args: readonly string[]
): CliInvocation {
    if (process.platform !== 'win32' || !['.cmd', '.bat'].includes(extname(command).toLocaleLowerCase())) {
        return { executable: command, args: [...args] };
    }

    const shimDirectory = dirname(command);
    if (providerId === 'claude') {
        const executable = join(shimDirectory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
        if (existsSync(executable)) {
            return { executable, args: [...args] };
        }
        throw new Error(`Claude CLI shim target was not found: ${executable}`);
    }
    if (providerId === 'codex') {
        const entryPoint = join(shimDirectory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        if (!existsSync(entryPoint)) {
            throw new Error(`Codex CLI shim target was not found: ${entryPoint}`);
        }
        return { executable: nodeExecutable(shimDirectory), args: [entryPoint, ...args] };
    }

    // Grok is distributed as grok.exe in the registry's supported locations.
    // Gemini has no executable role yet. Refuse an unknown script shim instead
    // of falling back to a command interpreter and risking a visible console.
    throw new Error(`${providerId} CLI script shims are not supported without a direct executable.`);
}

/** Kills a process tree without ever creating a visible taskkill console. */
export function killHiddenProcessTree(child: ChildProcess): Promise<void> {
    if (process.platform !== 'win32' || child.pid === undefined) {
        child.kill();
        return Promise.resolve();
    }
    return new Promise(resolvePromise => {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            shell: false,
            stdio: 'ignore'
        });
        killer.once('error', () => {
            child.kill();
            resolvePromise();
        });
        killer.once('close', () => {
            child.kill();
            resolvePromise();
        });
    });
}

function nodeExecutable(shimDirectory: string): string {
    const candidates = [
        join(shimDirectory, 'node.exe'),
        process.env.npm_node_execpath,
        ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, 'node.exe')),
        process.execPath
    ];
    const executable = candidates
        .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
        .find(candidate => /^node(?:\.exe)?$/i.test(basename(candidate)) && existsSync(candidate));
    if (!executable) {
        throw new Error('node.exe could not be resolved for the Codex CLI shim.');
    }
    return executable;
}
