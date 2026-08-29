import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { DiffUris } from '@theia/core/lib/browser/diff-uris';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { EditorManager } from '@theia/editor/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { getDesignVariant, isDesignVariant } from './design-variant';

type ChangesMode = 'code' | 'semantic' | 'parallel';

@injectable()
export class ChangesWidget extends ReactWidget {
    static readonly ID = 'poiesis-changes';
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
        getDesignVariant();
        this.id = ChangesWidget.ID;
        this.title.label = ChangesWidget.LABEL;
        this.title.caption = 'Code Diff and Semantic Diff for one Change Set';
        this.title.iconClass = 'codicon codicon-diff';
        this.title.closable = true;
        this.addClass('poiesis-changes');
        if (isDesignVariant('d7-b', 'semantic-card-closeup')) {
            this.mode = 'semantic';
        }
        this.update();
    }

    protected render(): React.ReactNode {
        return (
            <div className='poiesis-changes__content' data-change-set-id={ChangesWidget.CHANGE_SET_ID}>
                <header className='poiesis-changes__header'>
                    <div>
                        <div className='poiesis-changes__eyebrow'>CHANGE SET · 完了 · 14:32</div>
                        <h2>認証を Redis 方式へ変更</h2>
                    </div>
                    <button className='poiesis-changes__task-selector' aria-label='Select Task and Change Set'>
                        <span>Task 1 / 3</span>
                        <span className='codicon codicon-chevron-down' aria-hidden='true' />
                    </button>
                </header>
                <div className='poiesis-changes__tabs' role='tablist' aria-label='Change Set representations'>
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
                    {isDesignVariant('d3-b') && (
                        <button
                            className={this.mode === 'parallel' ? 'theia-button active' : 'theia-button secondary'}
                            role='tab'
                            aria-selected={this.mode === 'parallel'}
                            onClick={() => this.selectMode('parallel')}
                        >
                            Parallel
                        </button>
                    )}
                    {!isDesignVariant('d3-b') && (
                        <button className='theia-button secondary poiesis-changes__parallel-action' onClick={() => this.selectMode('parallel')}>
                            <span className='codicon codicon-layout-panel' aria-hidden='true' />
                            並列表示
                        </button>
                    )}
                </div>
                {this.mode === 'code' && this.renderCodeDiff()}
                {this.mode === 'semantic' && this.renderSemanticDiff()}
                {this.mode === 'parallel' && this.renderParallel()}
            </div>
        );
    }

    protected renderCodeDiff(): React.ReactNode {
        return (
            <section className='poiesis-changes__representation' aria-label='Code Diff representation'>
                <div className='poiesis-changes__eyebrow'>CODE DIFF · SAME CHANGE SET</div>
                <div className='poiesis-changes__summary'>3 files changed <span>+83 −9</span></div>
                <div className='poiesis-changes__files'>
                    <button className='poiesis-changes__file poiesis-changes__open-diff' onClick={() => this.openCodeDiff()}>
                        <span className='poiesis-changes__file-status modified'>M</span>
                        <span className='poiesis-changes__file-path'>src/auth/auth.service.ts</span>
                        <span className='poiesis-changes__lines'>+18 −9</span>
                    </button>
                    <button className='poiesis-changes__file' onClick={() => this.openCodeDiff()}>
                        <span className='poiesis-changes__file-status added'>A</span>
                        <span className='poiesis-changes__file-path'>src/auth/token-store.ts</span>
                        <span className='poiesis-changes__lines'>+64</span>
                    </button>
                    <button className='poiesis-changes__file' onClick={() => this.openCodeDiff()}>
                        <span className='poiesis-changes__file-status modified'>M</span>
                        <span className='poiesis-changes__file-path'>package.json</span>
                        <span className='poiesis-changes__lines'>+1</span>
                    </button>
                </div>
                {this.status && <div className='poiesis-changes__status' role='status'>{this.status}</div>}
            </section>
        );
    }

    protected renderSemanticDiff(): React.ReactNode {
        return (
            <section className='poiesis-changes__representation' aria-label='Semantic Diff representation'>
                <div className='poiesis-changes__eyebrow'>SEMANTIC DIFF · SAME CHANGE SET</div>
                <div className='poiesis-changes__semantic-heading'>
                    <h3>Refresh Token の保存先を Redis へ変更</h3>
                    <span className='poiesis-changes__confidence'>Confidence: 中</span>
                </div>
                <div className='poiesis-changes__before-after'>
                    <div>
                        <span>Before</span>
                        <strong>AuthService → PostgreSQL</strong>
                    </div>
                    <div className='poiesis-changes__arrow' aria-hidden='true'>→</div>
                    <div>
                        <span>After</span>
                        <strong>AuthService → TokenStore → Redis</strong>
                    </div>
                </div>
                <dl className='poiesis-changes__semantic-details'>
                    <div><dt>責務・依存</dt><dd>保存責務を AuthService から TokenStore へ分離。Redis client への依存を追加。</dd></div>
                    <div><dt>影響範囲</dt><dd><span>Refresh</span><span>Logout</span><span>Session</span></dd></div>
                    <div className='poiesis-changes__unknown'><dt>不明</dt><dd>Session cleanup への影響は未解析。</dd></div>
                </dl>
                <div className='poiesis-changes__evidence-list'>
                    <div className='poiesis-changes__evidence-title'>EVIDENCE · 3</div>
                    {this.renderEvidence('src/auth/auth.service.ts', '82–103', true)}
                    {this.renderEvidence('src/auth/token-store.ts', '1–64')}
                    {this.renderEvidence('package.json', '24')}
                </div>
                {this.status && <div className='poiesis-changes__status' role='status'>{this.status}</div>}
            </section>
        );
    }

    protected renderParallel(): React.ReactNode {
        return (
            <section className='poiesis-changes__representation poiesis-changes__parallel' aria-label='Parallel representation'>
                <div>
                    <div className='poiesis-changes__eyebrow'>CODE DIFF · EDITOR</div>
                    <h3>3 files changed</h3>
                    <p>既存 Diff Editor を main area に表示する。</p>
                    <button className='theia-button poiesis-changes__open-diff' onClick={() => this.openCodeDiff()}>
                        Diff Editor を開く
                    </button>
                </div>
                <div>
                    <div className='poiesis-changes__eyebrow'>SEMANTIC DIFF · CHANGES</div>
                    <h3>Refresh Token の保存先を Redis へ変更</h3>
                    <p>AuthService → TokenStore → Redis</p>
                </div>
            </section>
        );
    }

    protected renderEvidence(path: string, range: string, primary = false): React.ReactNode {
        return (
            <button
                className={`poiesis-changes__evidence${primary ? ' primary' : ''}`}
                onClick={() => this.openEvidence()}
                title={`${path}:${range} を Editor で開く`}
            >
                <span className='codicon codicon-go-to-file' aria-hidden='true' />
                <span>
                    <strong>{path}</strong>
                    <small>Lines {range}</small>
                </span>
            </button>
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
        return root.resolve(`sample-src/${name}`);
    }

    protected setStatus(status: string): void {
        this.status = status;
        this.update();
    }

    protected errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
