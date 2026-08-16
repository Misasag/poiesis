import { spawn } from 'node:child_process';
import { assertHostExists, ensureRuntimeDirectories, hostArguments, hostEnvironment, hostExecutable } from './host-utils.mjs';

assertHostExists();
const directories = await ensureRuntimeDirectories('user-data');
const child = spawn(hostExecutable, hostArguments(directories), {
    stdio: 'inherit',
    windowsHide: false,
    env: hostEnvironment()
});

child.on('error', error => {
    console.error(error);
    process.exitCode = 1;
});

const exitCode = await new Promise(resolve => child.on('exit', code => resolve(code ?? 0)));
process.exitCode = exitCode;
