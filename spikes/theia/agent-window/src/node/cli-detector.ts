import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, extname, join } from 'node:path';
import { injectable } from '@theia/core/shared/inversify';
import {
    CliDetection,
    CliDetectionReport,
    CliLocationSource,
    KnownCliId
} from '../common/agent-runtime-protocol';

interface CliDefinition {
    id: KnownCliId;
    name: string;
    commandNames: string[];
    wellKnownLocations: string[];
}

/** Windows detector only; it records PATH and well-known probes without running a CLI. */
@injectable()
export class CliDetector {
    protected lastReport?: CliDetectionReport;

    async detect(): Promise<CliDetectionReport> {
        const definitions = this.definitions();
        const detections = await Promise.all(definitions.map(definition => this.detectOne(definition)));
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

    protected async detectOne(definition: CliDefinition): Promise<CliDetection> {
        const candidates = this.candidates(definition);
        for (const candidate of candidates) {
            if (await this.exists(candidate.path)) {
                return {
                    id: definition.id,
                    name: definition.name,
                    status: 'found',
                    path: candidate.path,
                    source: candidate.source,
                    checkedLocations: candidates.map(item => item.path)
                };
            }
        }
        return {
            id: definition.id,
            name: definition.name,
            status: 'missing',
            checkedLocations: candidates.map(item => item.path)
        };
    }

    protected candidates(definition: CliDefinition): Array<{ path: string; source: CliLocationSource }> {
        const candidates: Array<{ path: string; source: CliLocationSource }> = [];
        for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
            for (const commandName of definition.commandNames) {
                candidates.push({ path: join(directory, commandName), source: 'PATH' });
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

    protected definitions(): CliDefinition[] {
        const appData = process.env.APPDATA;
        const localAppData = process.env.LOCALAPPDATA;
        const userProfile = process.env.USERPROFILE;
        return [
            {
                id: 'codex',
                name: 'Codex',
                commandNames: this.commandNames('codex'),
                wellKnownLocations: this.compact([
                    appData && join(appData, 'npm', 'codex.cmd'),
                    localAppData && join(localAppData, 'Programs', 'codex', 'codex.exe'),
                    userProfile && join(userProfile, '.codex', 'bin', 'codex.exe'),
                    userProfile && join(userProfile, '.local', 'bin', 'codex.exe')
                ])
            },
            {
                id: 'claude',
                name: 'Claude',
                commandNames: this.commandNames('claude'),
                wellKnownLocations: this.compact([
                    appData && join(appData, 'npm', 'claude.cmd'),
                    localAppData && join(localAppData, 'Programs', 'claude', 'claude.exe'),
                    userProfile && join(userProfile, '.local', 'bin', 'claude.exe')
                ])
            }
        ];
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

    protected compact(values: Array<string | undefined>): string[] {
        return values.filter((value): value is string => Boolean(value));
    }

    protected async exists(path: string): Promise<boolean> {
        try {
            await access(path, constants.F_OK);
            return true;
        } catch {
            return false;
        }
    }
}
