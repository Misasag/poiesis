import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { injectable } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { FileResourceResolver } from '@theia/filesystem/lib/browser/file-resource';

/** Keeps file-safety confirmations inside the Poiesis language and dialog policy. */
@injectable()
export class PoiesisFileResourceResolver extends FileResourceResolver {
    protected override async shouldOpenAsText(uri: URI, error: string): Promise<boolean> {
        switch (this.applicationState.state) {
            case 'init':
            case 'started_contributions':
            case 'attached_shell':
                return true;
            default: {
                const binary = /binary|encoding|バイナリ|エンコーディング/i.test(error);
                const dialog = new ConfirmDialog({
                    title: binary ? 'ファイルを開く' : '大きなファイルを開く',
                    msg: binary
                        ? `このファイルはバイナリ、または未対応のエンコーディングです。開きますか？\n\n${this.labelProvider.getLongName(uri)}`
                        : `このファイルはサイズが大きいため、開くと動作が遅くなる場合があります。開きますか？\n\n${this.labelProvider.getLongName(uri)}`,
                    ok: '開く',
                    cancel: 'キャンセル'
                });
                return Boolean(await dialog.open());
            }
        }
    }

    protected override async shouldOverwrite(uri: URI): Promise<boolean> {
        const dialog = new ConfirmDialog({
            title: '外部で変更されたファイル',
            msg: `このファイルは外部で変更されています。現在の内容で上書きしますか？\n\n${this.labelProvider.getLongName(uri)}`,
            ok: '上書き',
            cancel: 'キャンセル'
        });
        return Boolean(await dialog.open());
    }
}
