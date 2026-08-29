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

@injectable()
class PoiesisUpdaterContribution implements ElectronMainApplicationContribution {
    protected logPath = '';

    onStart(_application: ElectronMainApplication): void {
        if (!app.isPackaged) {
            return;
        }

        this.logPath = process.env.POIESIS_UPDATER_LOG
            ? process.env.POIESIS_UPDATER_LOG
            : join(app.getPath('userData'), 'logs', 'updater.log');
        mkdirSync(dirname(this.logPath), { recursive: true });

        autoUpdater.logger = {
            debug: (...args: unknown[]) => this.writeLog('DEBUG', args),
            info: (...args: unknown[]) => this.writeLog('INFO', args),
            warn: (...args: unknown[]) => this.writeLog('WARN', args),
            error: (...args: unknown[]) => this.writeLog('ERROR', args)
        };
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;

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
            this.writeLog('INFO', [`POIESIS_UPDATE_DOWNLOADED version=${info.version}`]);
            void this.offerImmediateRestart(info);
        });
        autoUpdater.on('error', error => {
            this.writeLog('ERROR', ['POIESIS_UPDATE_ERROR', error]);
        });

        this.writeLog('INFO', [
            `POIESIS_UPDATER_START version=${app.getVersion()}`,
            `log=${this.logPath}`
        ]);
        void autoUpdater.checkForUpdates().catch(error => {
            this.writeLog('ERROR', ['POIESIS_UPDATE_CHECK_FAILED', error]);
        });
    }

    protected async offerImmediateRestart(info: UpdateInfo): Promise<void> {
        const result = await dialog.showMessageBox({
            type: 'info',
            title: 'Poiesis Update',
            message: `Poiesis ${info.version} の更新をダウンロードしました。`,
            detail: '今すぐ再起動して更新するか、アプリ終了時に自動適用できます。',
            buttons: ['今すぐ再起動して更新', '終了時に更新'],
            defaultId: 0,
            cancelId: 1,
            noLink: true
        });
        if (result.response === 0) {
            this.writeLog('INFO', ['POIESIS_UPDATE_RESTART_REQUESTED']);
            autoUpdater.quitAndInstall(false, true);
        } else {
            this.writeLog('INFO', ['POIESIS_UPDATE_DEFERRED_UNTIL_QUIT']);
        }
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
