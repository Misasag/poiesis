import { ContainerModule, injectable } from '@theia/core/shared/inversify';
import {
    ElectronMainApplication,
    ElectronMainApplicationContribution
} from '@theia/core/lib/electron-main/electron-main-application';
import { app, dialog } from '@theia/core/electron-shared/electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { UpdateInfo } from 'electron-updater';

const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');

// The first update check fails when Poiesis is launched while an installer is still
// replacing files, or before the network is up; retry once instead of waiting for the next launch.
const UPDATE_CHECK_RETRY_DELAY_MS = 60_000;
// If the explicit restart is vetoed (a close confirmation was cancelled), fall back to
// installing on the next normal quit without relaunching.
const RESTART_REQUEST_TIMEOUT_MS = 30_000;

// The backend is a child process without Electron's `app`; pass the already-resolved
// Electron userData snapshot root through its inherited environment.
process.env.POIESIS_SNAPSHOT_STORE_DIR ??= join(app.getPath('userData'), 'poiesis-snapshots');

@injectable()
class PoiesisUpdaterContribution implements ElectronMainApplicationContribution {
    protected logPath = '';
    protected downloadedVersion: string | undefined;
    protected relaunchAfterInstall = false;
    protected restartRequestTimer: ReturnType<typeof setTimeout> | undefined;
    protected checkRetried = false;

    onStart(_application: ElectronMainApplication): void {
        if (!app.isPackaged) {
            return;
        }

        this.logPath = process.env.POIESIS_UPDATER_LOG
            ? process.env.POIESIS_UPDATER_LOG
            : join(app.getPath('userData'), 'logs', 'updater.log');
        mkdirSync(dirname(this.logPath), { recursive: true });

        if (process.platform === 'darwin') {
            this.writeLog('INFO', [
                'POIESIS_UPDATER_DISABLED',
                'platform=darwin',
                'reason=unsigned-and-unnotarized-build'
            ]);
            return;
        }

        autoUpdater.logger = {
            debug: (...args: unknown[]) => this.writeLog('DEBUG', args),
            info: (...args: unknown[]) => this.writeLog('INFO', args),
            warn: (...args: unknown[]) => this.writeLog('WARN', args),
            error: (...args: unknown[]) => this.writeLog('ERROR', args)
        };
        autoUpdater.autoDownload = true;
        // Installation is owned by installUpdateOnQuit(): the installer is spawned only once
        // Electron is actually quitting (never while Theia is still closing windows), and the
        // explicit restart can ask the installer to relaunch the app.
        autoUpdater.autoInstallOnAppQuit = false;

        autoUpdater.on('checking-for-update', () => {
            this.writeLog('INFO', ['POIESIS_UPDATE_CHECKING']);
        });
        autoUpdater.on('update-available', (info: UpdateInfo) => {
            this.writeLog('INFO', [`POIESIS_UPDATE_AVAILABLE version=${info.version}`]);
        });
        autoUpdater.on('update-not-available', (info: UpdateInfo) => {
            this.writeLog('INFO', [`POIESIS_UPDATE_NOT_AVAILABLE version=${info.version}`]);
        });
        autoUpdater.on('download-progress', progress => {
            this.writeLog('INFO', [`POIESIS_UPDATE_PROGRESS percent=${progress.percent.toFixed(1)}`]);
        });
        autoUpdater.on('update-downloaded', info => {
            this.downloadedVersion = info.version;
            this.writeLog('INFO', [`POIESIS_UPDATE_DOWNLOADED version=${info.version}`]);
            void this.offerImmediateRestart(info);
        });
        autoUpdater.on('error', error => {
            this.writeLog('ERROR', ['POIESIS_UPDATE_ERROR', error]);
        });

        app.on('quit', (_event, exitCode) => this.installUpdateOnQuit(exitCode));

        this.writeLog('INFO', [
            `POIESIS_UPDATER_START version=${app.getVersion()}`,
            `log=${this.logPath}`
        ]);
        void this.checkForUpdates();
    }

    protected async checkForUpdates(): Promise<void> {
        try {
            await autoUpdater.checkForUpdates();
        } catch (error) {
            this.writeLog('ERROR', ['POIESIS_UPDATE_CHECK_FAILED', error]);
            if (this.checkRetried) {
                return;
            }
            this.checkRetried = true;
            this.writeLog('INFO', [`POIESIS_UPDATE_CHECK_RETRY_SCHEDULED delay_ms=${UPDATE_CHECK_RETRY_DELAY_MS}`]);
            setTimeout(() => void this.checkForUpdates(), UPDATE_CHECK_RETRY_DELAY_MS).unref();
        }
    }

    protected async offerImmediateRestart(info: UpdateInfo): Promise<void> {
        const result = await dialog.showMessageBox({
            type: 'info',
            title: 'Poiesis Update',
            message: `Poiesis ${info.version} の更新をダウンロードしました。`,
            detail: [
                '「今すぐ再起動して更新」を選ぶと Poiesis を閉じて更新を適用し、完了後に自動で起動します。',
                '適用には 1 分ほどかかります。その間は Poiesis を手動で起動しないでください。',
                '「終了時に更新」を選ぶと、次に Poiesis を終了したときに適用します。'
            ].join('\n'),
            buttons: ['今すぐ再起動して更新', '終了時に更新'],
            defaultId: 0,
            cancelId: 1,
            noLink: true
        });
        if (result.response === 0) {
            this.requestRestart();
        } else {
            this.writeLog('INFO', ['POIESIS_UPDATE_DEFERRED_UNTIL_QUIT']);
        }
    }

    protected requestRestart(): void {
        this.writeLog('INFO', ['POIESIS_UPDATE_RESTART_REQUESTED']);
        this.relaunchAfterInstall = true;
        // Quit through Theia so windows close gracefully (save prompts, state persistence).
        // The installer starts in installUpdateOnQuit() once the app is actually quitting.
        app.quit();
        this.restartRequestTimer = setTimeout(() => {
            this.restartRequestTimer = undefined;
            this.relaunchAfterInstall = false;
            this.writeLog('INFO', ['POIESIS_UPDATE_RESTART_NOT_COMPLETED', 'fallback=install-on-quit']);
        }, RESTART_REQUEST_TIMEOUT_MS);
        this.restartRequestTimer.unref();
    }

    protected installUpdateOnQuit(exitCode: number): void {
        if (this.restartRequestTimer) {
            clearTimeout(this.restartRequestTimer);
            this.restartRequestTimer = undefined;
        }
        if (!this.downloadedVersion) {
            return;
        }
        if (exitCode !== 0) {
            this.writeLog('INFO', [`POIESIS_UPDATE_INSTALL_SKIPPED exit_code=${exitCode}`]);
            return;
        }
        this.writeLog('INFO', [
            `POIESIS_UPDATE_INSTALL_ON_QUIT version=${this.downloadedVersion}`,
            `relaunch=${this.relaunchAfterInstall}`
        ]);
        // Always the silent installer (never the assisted wizard). It waits for the remaining
        // Poiesis processes to exit and relaunches the app only for an explicit restart.
        autoUpdater.quitAndInstall(true, this.relaunchAfterInstall);
    }

    protected writeLog(level: string, values: unknown[]): void {
        const line = `${new Date().toISOString()} [${level}] ${values.map(formatLogValue).join(' ')}\n`;
        try {
            appendFileSync(this.logPath, line, 'utf8');
        } catch (error) {
            console.error('Poiesis updater log write failed.', error);
        }
        const consoleMethod = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
        consoleMethod(line.trimEnd());
    }
}

function formatLogValue(value: unknown): string {
    if (value instanceof Error) {
        return value.stack ?? value.message;
    }
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

export default new ContainerModule(bind => {
    bind(PoiesisUpdaterContribution).toSelf().inSingletonScope();
    bind(ElectronMainApplicationContribution).toService(PoiesisUpdaterContribution);
});
