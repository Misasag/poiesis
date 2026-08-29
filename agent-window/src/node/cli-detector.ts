import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, extname, join } from 'node:path';
import { injectable } from '@theia/core/shared/inversify';
import {
    CliDetection,
    CliDetectionReport,
    CliLocationSource
} from '../common/agent-runtime-protocol';
import { KnownCliDefinition, knownCliDefinitions } from './known-cli-registry';
import { HiddenCliProcess, spawnHiddenCli } from './hidden-process';

/** Registry-backed detector for PATH, well-known locations, and bounded version probes. */
@injectable()
export class CliDetector {
    protected lastReport?: CliDetectionReport;

    async detect(): Promise<CliDetectionReport> {
        const definitions = knownCliDefinitions();
        const detections: CliDetection[] = process.env.POIESIS_DISABLE_CLI_DETECTION === '1'
            ? definitions.map(definition => ({
                id: definition.id,
                name: definition.displayName,
                status: 'missing' as const,
                executableRoles: [...definition.executableRoles],
                models: [...definition.models],
                defaultModel: definition.defaultModel,
                checkedLocations: []
            }))
            : await Promise.all(definitions.map(definition => this.detectOne(definition)));
        const report: CliDetectionReport = {
            detectedAt: new Date().toISOString(),
            platform: process.platform,
            detections
        };
        this.lastReport = report;
        console.info('[Poiesis] Agent CLI detection:', detections.map(item =>
            `${item.name} ${item.status}${item.path ? ` (${item.path})` : ''}`
        ).join(', '));
        return report;
    }

    get recordedReport(): CliDetectionReport | undefined {
        return this.lastReport;
    }

    protected async detectOne(definition: KnownCliDefinition): Promise<CliDetection> {
        const candidates = this.candidates(definition);
        for (const candidate of candidates) {
            if (await this.exists(candidate.path)) {
                return {
                    id: definition.id,
                    name: definition.displayName,
                    status: 'found',
                    path: candidate.path,
                    source: candidate.source,
                    version: await this.probeVersion(definition, candidate.path),
                    executableRoles: [...definition.executableRoles],
                    models: [...definition.models],
                    defaultModel: definition.defaultModel,
                    checkedLocations: candidates.map(item => item.path)
                };
            }
        }
        return {
            id: definition.id,
            name: definition.displayName,
            status: 'missing',
            executableRoles: [...definition.executableRoles],
            models: [...definition.models],
            defaultModel: definition.defaultModel,
            checkedLocations: candidates.map(item => item.path)
        };
    }

    protected candidates(definition: KnownCliDefinition): Array<{ path: string; source: CliLocationSource }> {
        const candidates: Array<{ path: string; source: CliLocationSource }> = [];
        for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
            for (const executableName of definition.executableNames) {
                for (const commandName of this.commandNames(executableName)) {
                    candidates.push({ path: join(directory, commandName), source: 'PATH' });
                }
            }
        }
        for (const path of definition.wellKnownLocations) {
            candidates.push({ path, source: 'well-known' });
        }

        const unique = new Map<string, { path: string; source: CliLocationSource }>();
        for (const candidate of candidates) {
            unique.set(candidate.path.toLocaleLowerCase(), candidate);
        }
        return [...unique.values()];
    }

    protected commandNames(command: string): string[] {
        if (process.platform !== 'win32') {
            return [command];
        }
        const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT')
            .split(';')
            .filter(Boolean)
            .map(extension => extension.toLocaleLowerCase());
        return [...extensions.map(extension => `${command}${extension}`), command]
            .filter((value, index, all) => all.indexOf(value) === index)
            .filter(value => extname(value) !== '.' || value === command);
    }

    protected async exists(path: string): Promise<boolean> {
        try {
            await access(path, constants.F_OK);
            return true;
        } catch {
            return false;
        }
    }

    protected probeVersion(definition: KnownCliDefinition, command: string): Promise<string | undefined> {
        return new Promise(resolveProbe => {
            let child: HiddenCliProcess;
            try {
                child = spawnHiddenCli(definition.id, command, definition.versionProbe);
            } catch (error) {
                console.warn(`[Poiesis] ${definition.displayName} version probe skipped because no console-free invocation was available.`, error);
                resolveProbe(undefined);
                return;
            }
            let output = '';
            let settled = false;
            const finish = (): void => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                const version = output.trim().split(/\r?\n/).find(Boolean)?.trim();
                resolveProbe(version || undefined);
            };
            const timeout = setTimeout(() => {
                child.kill();
                finish();
            }, 8_000);
            child.stdout.on('data', chunk => output = `${output}${chunk.toString()}`.slice(-4_000));
            child.stderr.on('data', chunk => output = `${output}${chunk.toString()}`.slice(-4_000));
            child.once('error', finish);
            child.once('close', finish);
        });
    }
}
