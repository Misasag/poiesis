import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, extname, basename, join } from 'node:path';
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
        env: options.env,
        windowsHide: true,
        shell: false,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    }) as HiddenCliProcess;
    if (options.input !== undefined) {
        child.stdin?.end(options.input, 'utf8');
    }
    return child;
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
