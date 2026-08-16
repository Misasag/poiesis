import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { DiffUris } from '@theia/core/lib/browser/diff-uris';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { EditorManager } from '@theia/editor/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';

type ChangesMode = 'code' | 'semantic';

@injectable()
export class ChangesWidget extends ReactWidget {
    static readonly ID = 'lens-changes';
    static readonly LABEL = 'IDE Changes';
    static readonly CHANGE_SET_ID = 'task-auth-redis-001';

    @inject(EditorManager)
    protected readonly editorManager!: EditorManager;

    @inject(FileService)
    protected readonly fileService!: FileService;

    @inject(WorkspaceService)
    protected readonly workspaceService!: WorkspaceService;

    protected mode: ChangesMode = 'code';
    protected status = '';

    @postConstruct()
    protected init(): void {
        this.id = ChangesWidget.ID;
        this.title.label = ChangesWidget.LABEL;
        this.title.caption = 'Code Diff and Semantic Diff for one Change Set';
        this.title.iconClass = 'codicon codicon-diff';
        this.title.closable = true;
        this.addClass('lens-changes');
        this.update();
    }

    protected render(): React.ReactNode {
        return (
            <div className='lens-changes__content' data-change-set-id={ChangesWidget.CHANGE_SET_ID}>
                <header className='lens-changes__header'>
                    <div>
                        <div className='lens-changes__eyebrow'>CHANGE SET · MOCK</div>
                        <h2>認証トークン保存方式の変更</h2>
                    </div>
                    <code>{ChangesWidget.CHANGE_SET_ID}</code>
                </header>
                <div className='lens-changes__tabs' role='tablist' aria-label='Change Set representations'>
                    <button
                        className={this.mode === 'code' ? 'theia-button active' : 'theia-button secondary'}
                        role='tab'
                        aria-selected={this.mode === 'code'}
                        onClick={() => this.selectMode('code')}
                    >
                        Code Diff
                    </button>
                    <button
                        className={this.mode === 'semantic' ? 'theia-button active' : 'theia-button secondary'}
                        role='tab'
                        aria-selected={this.mode === 'semantic'}
                        onClick={() => this.selectMode('semantic')}
                    >
                        Semantic Diff
                    </button>
                </div>
                {this.mode === 'code' ? this.renderCodeDiff() : this.renderSemanticDiff()}
            </div>
        );
    }

    protected renderCodeDiff(): React.ReactNode {
        return (
            <section className='lens-changes__representation' aria-label='Code Diff representation'>
                <div className='lens-changes__eyebrow'>CODE DIFF · SAME CHANGE SET</div>
                <h3>sample-src/auth-service.ts</h3>
                <p>AuthService の保存先を Database から TokenStore へ変更。</p>
                <button className='theia-button lens-changes__open-diff' onClick={() => this.openCodeDiff()}>
                    既存 Diff Editor で開く
                </button>
                {this.status && <div className='lens-changes__status' role='status'>{this.status}</div>}
            </section>
        );
    }

    protected renderSemanticDiff(): React.ReactNode {
        return (
            <section className='lens-changes__representation' aria-label='Semantic Diff representation'>
                <div className='lens-changes__eyebrow'>SEMANTIC DIFF · SAME CHANGE SET</div>
                <h3>Refresh Token の保存責務を分離</h3>
                <div className='lens-changes__before-after'>
                    <div>
                        <span>変更前</span>
                        <strong>AuthService → Database</strong>
                    </div>
                    <div className='lens-changes__arrow' aria-hidden='true'>→</div>
                    <div>
                        <span>変更後</span>
                        <strong>AuthService → TokenStore → Redis</strong>
                    </div>
                </div>
                <p className='lens-changes__impact'>影響: Refresh / Logout / Session</p>
                <button
                    className='lens-changes__evidence'
                    onClick={() => this.openEvidence()}
                    title='sample-src/auth-service.ts の 12 行目を Editor で開く'
                >
                    <span className='codicon codicon-go-to-file' aria-hidden='true' />
                    <span>
                        <strong>根拠コードを開く</strong>
                        <small>sample-src/auth-service.ts:12</small>
                    </span>
                </button>
                {this.status && <div className='lens-changes__status' role='status'>{this.status}</div>}
            </section>
        );
    }

    protected selectMode(mode: ChangesMode): void {
        this.mode = mode;
        this.status = '';
        this.update();
    }

    protected async openCodeDiff(): Promise<void> {
        const root = this.getWorkspaceRoot();
        if (!root) {
            this.setStatus('Workspace が開かれていません。');
            return;
        }
        const before = await this.resolveSampleFile(root.resource, 'auth-service.before.ts');
        const after = await this.resolveSampleFile(root.resource, 'auth-service.ts');
        try {
            const diffUri = DiffUris.encode(before, after, 'Change Set: auth-service.ts');
            await this.editorManager.open(diffUri, { mode: 'activate' });
            this.setStatus('Theia の既存 Diff Editor で Code Diff を開きました。');
        } catch (error) {
            this.setStatus(`Code Diff を開けませんでした: ${this.errorMessage(error)}`);
        }
    }

    protected async openEvidence(): Promise<void> {
        const root = this.getWorkspaceRoot();
        if (!root) {
            this.setStatus('Workspace が開かれていません。');
            return;
        }
        this.setStatus('根拠コードを開いています…');
        const uri = await this.resolveSampleFile(root.resource, 'auth-service.ts');
        try {
            await this.editorManager.open(uri, {
                mode: 'activate',
                selection: {
                    start: { line: 11, character: 0 },
                    end: { line: 11, character: 68 }
                }
            });
            this.setStatus('根拠コードの 12 行目を Editor で開きました。');
        } catch (error) {
            this.setStatus(`Editor を開けませんでした: ${this.errorMessage(error)}`);
        }
    }

    protected getWorkspaceRoot() {
        return this.workspaceService.tryGetRoots()[0]
            ?? (this.workspaceService.workspace?.isDirectory ? this.workspaceService.workspace : undefined);
    }

    protected async resolveSampleFile(root: URI, name: string): Promise<URI> {
        const direct = root.resolve(`sample-src/${name}`);
        if (await this.fileService.exists(direct)) {
            return direct;
        }
        return root.resolve(`spikes/theia/sample-src/${name}`);
    }

    protected setStatus(status: string): void {
        this.status = status;
        this.update();
    }

    protected errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
