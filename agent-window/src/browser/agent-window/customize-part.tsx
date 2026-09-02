import * as React from '@theia/core/shared/react';
import * as ReactDOM from '@theia/core/shared/react-dom';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { FormatType, open, OpenerService, Saveable, SaveableService, SaveReason, StorageService, WidgetManager } from '@theia/core/lib/browser';
import { IconThemeService } from '@theia/core/lib/browser/icon-theme-service';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { CommandService, Disposable, DisposableCollection, MessageService } from '@theia/core/lib/common';
import { FileUri } from '@theia/core/lib/common/file-uri';
import URI from '@theia/core/lib/common/uri';
import { Message, MessageLoop } from '@theia/core/shared/@lumino/messaging';
import { Widget } from '@theia/core/shared/@lumino/widgets';
import { EditorManager, EditorWidget } from '@theia/editor/lib/browser';
import { ScmCommand, ScmHistoryProvider, ScmProvider } from '@theia/scm/lib/browser/scm-provider';
import { ScmService } from '@theia/scm/lib/browser/scm-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { TerminalWidget } from '@theia/terminal/lib/browser/base/terminal-widget';
import { FileNavigatorCommands } from '@theia/navigator/lib/browser/navigator-contribution';
import { SearchInWorkspaceCommands } from '@theia/search-in-workspace/lib/browser/search-in-workspace-frontend-contribution';
import { BUILTIN_QUERY, VSXExtensionsSearchModel } from '@theia/vsx-registry/lib/browser/vsx-extensions-search-model';
import { AgentActivity, AgentActivityKind, AgentEvent, AgentProvider, AgentSession } from '../../common/agent-provider';
import {
    AgentRuntimeServer,
    AiRole,
    CliDetectionReport,
    DEFAULT_CLI_ID,
    FolderBrowserResult,
    isKnownCliId,
    KnownCliId
} from '../../common/agent-runtime-protocol';
import { formatRequirementExecutionEvidence, ResultsService } from '../results-skill';
import {
    ExecutionTask,
    formatTaskEndedAtJst,
    summarizeTaskChangeSet,
    TaskChangeSet,
    TaskResultDocument,
    TaskResultsQuestion,
    TaskService,
    taskTitleForRequest
} from '../task-service';
import { getDesignVariant } from '../design-variant';
import { FolderExplorerService } from '../folder-explorer-service';
import { ResultsQuestionService } from '../results-question-service';
import { GlobalStorageService } from '../global-storage-service';
import { ResultsGenerationContext } from '../results-generation-context';
import { SkillBundleKind } from '../../common/skill-bundle';
import {
    collectWorkspaceRichContentReferences,
    POIESIS_EXTERNAL_LINK_ATTRIBUTE,
    POIESIS_FILE_LINK_ATTRIBUTE,
    POIESIS_INLINE_IMAGE_ATTRIBUTE,
    renderSafeMarkdown
} from '../safe-markdown';
import {
    PendingSkillProposal,
    WorkspaceSkillDefinition,
    WorkspaceSkillDiscoveryRoot,
    WorkspaceSkillPreview,
    WorkspaceSkillService,
    WorkspaceSkillSource
} from '../workspace-skill-service';
import { diffTextLines } from '../text-diff';
import { formatTaskElapsedTime, shouldSubmitComposer } from '../composer-behavior';
import { POIESIS_FONT_MONO, POIESIS_FONT_SANS } from '../typography';
import { formatExecutionEvidence } from '../results-document-normalizer';
import { Requirement } from '../requirement-model';
import { RequirementService } from '../requirement-service';
import { RequirementClassificationService } from '../requirement-classification-service';
import { PoiesisSelect, PoiesisSelectOption } from '../components/poiesis-select';
import { PoiesisTextArea, PoiesisTextInput } from '../components/poiesis-inputs';
import { PoiesisComposer } from '../components/poiesis-composer';
import { PoiesisResultsElapsed, PoiesisTaskElapsed } from '../components/elapsed';
import { AgentWindowTab, ChatMessage, ResultsNotice, SessionStore, WindowAgentSession } from '../agent-window/session-store';
import { AgentWindowHost, AgentWindowPart } from './agent-window-host';

type NewSkillScope = 'workspace' | 'user';

interface WorkspaceSkillEditor {
    uri: string;
    path: string;
    content: string;
    savedContent: string;
}

export class CustomizePart extends AgentWindowPart {
    protected customizeViewVisible = false;

    protected workspaceSkills: WorkspaceSkillDefinition[] = [];

    protected pendingSkillProposals: PendingSkillProposal[] = [];

    protected workspaceSkillsLoading = false;

    protected workspaceSkillsError?: string;

    protected workspaceSkillsRefreshGeneration = 0;

    protected workspaceSkillPreviews?: Record<SkillBundleKind, WorkspaceSkillPreview>;

    protected readonly visibleSkillPromptPreviews = new Set<SkillBundleKind>();

    protected workspaceSkillWatchRoots: URI[] = [];

    protected workspaceSkillWatchers?: DisposableCollection;

    protected workspaceSkillRefreshTimer?: number;

    protected newSkillFormVisible = false;

    protected newSkillId = '';

    protected newSkillKind: SkillBundleKind = 'agent';

    protected newSkillScope: NewSkillScope = 'workspace';

    protected newSkillError?: string;

    protected newSkillCreating = false;

    protected selectedBuiltinSkill?: 'bundled-results' | 'ai-results';

    protected selectedPendingSkillId?: string;

    protected pendingSkillActionId?: string;

    protected pendingSkillActionError?: string;

    protected workspaceSkillEditor?: WorkspaceSkillEditor;

    protected workspaceSkillEditorLoading = false;

    protected workspaceSkillEditorError?: string;

    protected workspaceSkillDiscardConfirmation = false;

    protected workspaceSkillSaving = false;

    protected renderCustomizeView(): React.ReactNode {
        const workspaceName = this.workspaceRoot()?.resource.path.base;
        const editor = this.workspaceSkillEditor;
        const editorDirty = Boolean(editor && editor.content !== editor.savedContent);
        const agentInjectedCharacters = this.workspaceSkillInjectedCharacters('agent');
        const resultsInjectedCharacters = this.workspaceSkillInjectedCharacters('results');
        return (
            <section className='poiesis-customize-view' aria-labelledby='poiesis-customize-title'>
                <div className='poiesis-customize-view__page'>
                    <header className='poiesis-customize-view__intro'>
                        <span className='codicon codicon-tools' aria-hidden='true' />
                        <div><h1 id='poiesis-customize-title'>カスタマイズ</h1><p>PoiesisのSkillとPluginを管理します。</p></div>
                    </header>
                    <section className='poiesis-customize-view__section' aria-labelledby='poiesis-customize-skills'>
                            <div className='poiesis-customize-view__section-heading'>
                                <div>
                                    <h2 id='poiesis-customize-skills'>Skills</h2>
                                    <div className='poiesis-customize-view__budget' aria-live='polite'>
                                        <span>Agent へ注入: {agentInjectedCharacters.toLocaleString('ja-JP')} / 24,000 文字</span>
                                        <span>Results へ注入: {resultsInjectedCharacters.toLocaleString('ja-JP')} / 24,000 文字</span>
                                    </div>
                                </div>
                                <button
                                    type='button'
                                    className='poiesis-customize-view__text-button'
                                    onClick={() => this.showNewSkillForm()}
                                >
                                    新しいSkill
                                </button>
                            </div>
                            <p className='poiesis-customize-view__section-copy'>
                                有効なAgent Skillは次のTaskから実装指示へ加わり、有効なResults SkillはAI成果文書の構成を案内します。組み込みテンプレートへの切り替え時はResults Skillの追加指示を使いません。
                            </p>
                            {this.renderSkillPromptTransparency()}

                            <h3 className='poiesis-customize-view__group-title'>組み込み</h3>
                            <div className='poiesis-agent-window__customize-list'>
                                <button
                                    type='button'
                                    className={`poiesis-agent-window__customize-card poiesis-customize-view__skill-card${this.selectedBuiltinSkill === 'bundled-results' ? ' selected' : ''}`}
                                    aria-pressed={this.selectedBuiltinSkill === 'bundled-results'}
                                    onClick={() => this.selectBuiltinSkill('bundled-results')}
                                >
                                    <div className='poiesis-agent-window__customize-icon'><span className='codicon codicon-file-code' aria-hidden='true' /></div>
                                    <div>
                                        <div className='poiesis-agent-window__customize-title'><strong>Bundled Results</strong><span>Results</span></div>
                                        <p>確定したTaskとChange Setから、組み込みテンプレートで完成HTMLを生成します。</p>
                                    </div>
                                    <span className='poiesis-agent-window__status-badge active'>組み込み</span>
                                </button>
                                <button
                                    type='button'
                                    className={`poiesis-agent-window__customize-card poiesis-customize-view__skill-card${this.selectedBuiltinSkill === 'ai-results' ? ' selected' : ''}`}
                                    aria-pressed={this.selectedBuiltinSkill === 'ai-results'}
                                    onClick={() => this.selectBuiltinSkill('ai-results')}
                                >
                                    <div className='poiesis-agent-window__customize-icon'><span className='codicon codicon-preview' aria-hidden='true' /></div>
                                    <div>
                                        <div className='poiesis-agent-window__customize-title'><strong>AI Results</strong><span>Results</span></div>
                                        <p>Results AIが完成HTMLを生成し、実行できない場合は組み込みテンプレートへ切り替えます。</p>
                                    </div>
                                    <span className='poiesis-agent-window__status-badge active'>組み込み</span>
                                </button>
                            </div>
                            {this.selectedBuiltinSkill && (
                                <article className='poiesis-customize-view__builtin-preview' aria-live='polite'>
                                    <header>
                                        <div>
                                            <strong>{this.selectedBuiltinSkill === 'ai-results' ? 'AI Results' : 'Bundled Results'}</strong>
                                            <span>読み取り専用 · 組み込み</span>
                                        </div>
                                        <button type='button' aria-label='組み込みSkillの詳細を閉じる' onClick={() => this.selectBuiltinSkill(undefined)}>
                                            <span className='codicon codicon-close' aria-hidden='true' />
                                        </button>
                                    </header>
                                    <p>{this.selectedBuiltinSkill === 'ai-results'
                                        ? 'Task情報、Change Set、差分をResults AIへ読み取り専用で渡し、1つの自己完結HTML文書を生成します。失敗時はBundled Resultsへ切り替わります。'
                                        : 'Task情報とChange Setを決定的なテンプレートへ渡し、外部リソースやスクリプトを含まない自己完結HTML文書を生成します。'}</p>
                                    <pre>{this.selectedBuiltinSkill === 'ai-results'
                                        ? '入力 → Results AI → HTML検証 → Results キャンバス\n                    ↘ 失敗時: Bundled Results'
                                        : 'Task + Change Set → 組み込みHTML → Results キャンバス'}</pre>
                                </article>
                            )}

                            {this.pendingSkillProposals.length > 0 && (
                                <section className='poiesis-customize-view__proposals' aria-labelledby='poiesis-customize-proposals'>
                                    <h3 id='poiesis-customize-proposals' className='poiesis-customize-view__group-title'>提案された Skill</h3>
                                    <div className='poiesis-agent-window__customize-list'>
                                        {this.pendingSkillProposals.map(proposal => this.renderPendingSkillRow(proposal))}
                                    </div>
                                    {this.pendingSkillActionError && (
                                        <div className='poiesis-customize-view__proposal-error' role='alert'>{this.pendingSkillActionError}</div>
                                    )}
                                    {this.renderPendingSkillPreview()}
                                </section>
                            )}

                            <h3 className='poiesis-customize-view__group-title poiesis-customize-view__user-skills-title'>ユーザー Skills</h3>
                            {this.workspaceSkillsLoading && (
                                <div className='poiesis-customize-view__state' role='status'>
                                    <span className='codicon codicon-loading codicon-modifier-spin' aria-hidden='true' />
                                    Skillを読み込んでいます…
                                </div>
                            )}
                            {!this.workspaceSkillsLoading && this.workspaceSkillsError && (
                                <div className='poiesis-customize-view__state error' role='alert'>{this.workspaceSkillsError}</div>
                            )}
                            {!this.workspaceSkillsLoading && !this.workspaceSkillsError && this.workspaceSkills.length === 0 && (
                                <div className='poiesis-customize-view__state'>ユーザー Skill はまだありません。</div>
                            )}
                            {!this.workspaceSkillsLoading && !this.workspaceSkillsError && this.workspaceSkills.length > 0
                                && this.renderWorkspaceSkillGroups(editor, workspaceName)}

                            {(this.workspaceSkillEditorLoading || this.workspaceSkillEditorError || editor) && (
                                <section className='poiesis-customize-view__editor' aria-label='ユーザー Skill エディター'>
                                    {this.workspaceSkillEditorLoading ? (
                                        <div className='poiesis-customize-view__state' role='status'>
                                            <span className='codicon codicon-loading codicon-modifier-spin' aria-hidden='true' />
                                            Skillファイルを開いています…
                                        </div>
                                    ) : !editor && this.workspaceSkillEditorError ? (
                                        <div className='poiesis-customize-view__state error' role='alert'>{this.workspaceSkillEditorError}</div>
                                    ) : editor && (
                                        <>
                                            <header>
                                                <div>
                                                    <strong>{editor.path.split('/').at(-2) ?? 'SKILL.md'}</strong>
                                                    <small title={editor.path}>{editor.path}</small>
                                                </div>
                                                <span className={`poiesis-customize-view__dirty${editorDirty ? ' active' : ''}`}>
                                                    {editorDirty ? '未保存' : '保存済み'}
                                                </span>
                                            </header>
                                            <PoiesisTextArea
                                                key={editor.uri}
                                                className='poiesis-customize-view__editor-input'
                                                aria-label={`${editor.path}を編集`}
                                                spellCheck={false}
                                                value={editor.content}
                                                onValueChange={value => this.setWorkspaceSkillEditorContent(value)}
                                                onKeyDown={event => {
                                                    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                                                        event.preventDefault();
                                                        void this.saveWorkspaceSkill();
                                                    }
                                                }}
                                            />
                                            {this.workspaceSkillEditorError && <p role='alert'>{this.workspaceSkillEditorError}</p>}
                                            {this.workspaceSkillDiscardConfirmation && (
                                                <div className='poiesis-customize-view__discard-confirm' role='group' aria-label='未保存の変更を破棄する確認'>
                                                    <span>未保存の変更を破棄しますか？</span>
                                                    <button type='button' onClick={() => this.cancelWorkspaceSkillClose()}>編集を続ける</button>
                                                    <button type='button' className='danger' onClick={() => this.discardWorkspaceSkillChanges()}>破棄して閉じる</button>
                                                </div>
                                            )}
                                            <footer>
                                                <button
                                                    type='button'
                                                    disabled={editorDirty}
                                                    title={editorDirty ? '先に変更を保存してください' : undefined}
                                                    onClick={() => void this.openWorkspaceSkillInCode(editor.uri)}
                                                >
                                                    Codeで開く
                                                </button>
                                                <span />
                                                <button type='button' onClick={() => this.requestCloseWorkspaceSkill()}>閉じる</button>
                                                <button type='button' className='primary' disabled={!editorDirty || this.workspaceSkillSaving} onClick={() => void this.saveWorkspaceSkill()}>
                                                    {this.workspaceSkillSaving ? '保存中…' : '保存'}
                                                </button>
                                            </footer>
                                        </>
                                    )}
                                </section>
                            )}

                            {this.newSkillFormVisible && (
                                <form className='poiesis-customize-view__new-skill' onSubmit={event => {
                                    event.preventDefault();
                                    void this.createWorkspaceSkill();
                                }}>
                                    <label>
                                        <span>Skill ID</span>
                                        <PoiesisTextInput
                                            autoFocus
                                            value={this.newSkillId}
                                            placeholder='my-skill'
                                            aria-label='新しいSkill ID'
                                            disabled={this.newSkillCreating}
                                            onValueChange={value => this.setNewSkillId(value)}
                                        />
                                    </label>
                                    <label>
                                        <span>種類</span>
                                        <PoiesisSelect
                                            value={this.newSkillKind}
                                            ariaLabel='新しいSkillの種類'
                                            disabled={this.newSkillCreating}
                                            options={[
                                                { value: 'agent', label: 'Agent' },
                                                { value: 'results', label: 'Results' }
                                            ]}
                                            onChange={value => this.setNewSkillKind(value as SkillBundleKind)}
                                        />
                                    </label>
                                    <label>
                                        <span>スコープ</span>
                                        <PoiesisSelect
                                            value={this.newSkillScope}
                                            ariaLabel='新しいSkillのスコープ'
                                            disabled={this.newSkillCreating}
                                            options={[
                                                { value: 'workspace', label: 'Workspace' },
                                                { value: 'user', label: 'ユーザー' }
                                            ]}
                                            onChange={value => this.setNewSkillScope(value as NewSkillScope)}
                                        />
                                    </label>
                                    <small>{this.newSkillScope === 'user' ? '~/.poiesis/skills' : '.poiesis/skills'}/&lt;skill-id&gt;/SKILL.md を作成します。</small>
                                    {this.newSkillError && <p role='alert'>{this.newSkillError}</p>}
                                    <div>
                                        <button type='button' disabled={this.newSkillCreating} onClick={() => this.hideNewSkillForm()}>キャンセル</button>
                                        <button type='submit' className='primary' disabled={this.newSkillCreating || !this.newSkillId.trim()}>
                                            {this.newSkillCreating ? '作成中…' : '作成して開く'}
                                        </button>
                                    </div>
                                </form>
                            )}
                    </section>

                    <section className='poiesis-customize-view__section' aria-labelledby='poiesis-customize-plugins'>
                            <h2 id='poiesis-customize-plugins'>Plugins</h2>
                            <div className='poiesis-agent-window__customize-list'>
                                <article className='poiesis-agent-window__customize-card'>
                                    <div className='poiesis-agent-window__customize-icon'><span className='codicon codicon-package' aria-hidden='true' /></div>
                                    <div><div className='poiesis-agent-window__customize-title'><strong>Poiesis plugin bundles</strong><span>App</span></div><p>PoiesisのAgent、Skill、外部サービス連携を追加するアプリ用Pluginです。Code拡張機能とは別に管理されます。</p></div>
                                    <span className='poiesis-agent-window__status-badge'>追加なし</span>
                                </article>
                            </div>
                    </section>
                    <footer className='poiesis-customize-view__footer'>各スコープの Skill はこの画面で編集し、保存またはCtrl+Sで保存します。</footer>
                </div>
            </section>
        );
    }

    protected workspaceSkillInjectedCharacters(kind: SkillBundleKind): number {
        const preview = this.workspaceSkillPreviews?.[kind];
        return preview?.perSkill.reduce((total, skill) => skill.included
            ? total + Math.min(skill.chars, preview.limits.perSkill)
            : total, 0) ?? 0;
    }

    protected renderSkillPromptTransparency(): React.ReactNode {
        return (
            <div className='poiesis-customize-view__prompt-previews'>
                {(['agent', 'results'] as const).map(kind => {
                    const label = kind === 'agent' ? 'Agent' : 'Results';
                    const visible = this.visibleSkillPromptPreviews.has(kind);
                    const preview = this.workspaceSkillPreviews?.[kind];
                    return (
                        <section className='poiesis-customize-view__prompt-preview' key={kind}>
                            <header>
                                <strong>{label}</strong>
                                <button
                                    type='button'
                                    className='poiesis-customize-view__text-button'
                                    aria-expanded={visible}
                                    onClick={() => this.toggleSkillPromptPreview(kind)}
                                >
                                    AI へ渡される指示を表示
                                </button>
                            </header>
                            {visible && (
                                <div className='poiesis-customize-view__prompt-preview-content'>
                                    <pre>{preview?.prompt.content || '注入される Skill はありません'}</pre>
                                    {Boolean(preview?.prompt.diagnostics.length) && (
                                        <div className='poiesis-customize-view__prompt-diagnostics'>
                                            <strong>診断</strong>
                                            <ul>{preview?.prompt.diagnostics.map((diagnostic, index) => (
                                                <li key={`${kind}-${index}`}>{diagnostic}</li>
                                            ))}</ul>
                                        </div>
                                    )}
                                </div>
                            )}
                        </section>
                    );
                })}
            </div>
        );
    }

    protected renderWorkspaceSkillGroups(
        editor: WorkspaceSkillEditor | undefined,
        workspaceName: string | undefined
    ): React.ReactNode {
        const groups: Array<{ source: WorkspaceSkillSource; label: string; path: string; root: string }> = [
            {
                source: 'workspace', label: 'Workspace', root: '.poiesis/skills',
                path: workspaceName ? `${workspaceName} / .poiesis/skills` : '.poiesis/skills'
            },
            {
                source: 'workspace-agents', label: 'Workspace (.agents/skills)', root: '.agents/skills',
                path: workspaceName ? `${workspaceName} / .agents/skills` : '.agents/skills'
            },
            { source: 'user', label: 'ユーザー', path: '~/.poiesis/skills', root: '~/.poiesis/skills' },
            { source: 'user-agents', label: 'ユーザー (.agents/skills)', path: '~/.agents/skills', root: '~/.agents/skills' }
        ];
        const skillsBySource = new Map(groups.map(group => [
            group.source,
            this.workspaceSkills.filter(skill => skill.source === group.source)
        ]));
        const visibleGroups = groups.filter(group => group.source === 'workspace' || skillsBySource.get(group.source)?.length);
        const emptyRoots = groups.filter(group => !skillsBySource.get(group.source)?.length).map(group => group.root);
        return (
            <>
                {visibleGroups.map(group => {
                    const skills = skillsBySource.get(group.source) ?? [];
                    return (
                        <section className='poiesis-customize-view__scope-group' aria-label={group.label} key={group.source}>
                            <div className='poiesis-customize-view__user-heading'>
                                <h4 className='poiesis-customize-view__group-title'>{group.label}</h4>
                                <span>{group.path}</span>
                            </div>
                            {skills.length > 0 && (
                                <div className='poiesis-agent-window__customize-list'>
                                    {skills.map(skill => this.renderWorkspaceSkillRow(skill, editor))}
                                </div>
                            )}
                        </section>
                    );
                })}
                {emptyRoots.length > 0 && (
                    <div className='poiesis-customize-view__empty-roots'>
                        他のスコープに Skill はありません: {emptyRoots.join('、')}
                    </div>
                )}
            </>
        );
    }

    protected renderWorkspaceSkillRow(
        skill: WorkspaceSkillDefinition,
        editor: WorkspaceSkillEditor | undefined
    ): React.ReactNode {
        const shadowed = Boolean(skill.shadowedBy);
        const preview = this.workspaceSkillPreviews?.[skill.kind];
        const previewItem = preview?.perSkill.find(item => item.id === skill.id && item.source === skill.source);
        const characters = previewItem?.chars ?? (skill.instructions ?? '').length;
        const entryName = new URI(skill.uri).path.base;
        return (
            <div
                className={`poiesis-customize-view__skill-row${skill.error ? ' has-error' : ''}${shadowed ? ' is-shadowed' : ''}`}
                key={`${skill.source}:${skill.id}:${skill.uri}`}
            >
                <button
                    type='button'
                    className={`poiesis-agent-window__customize-card poiesis-customize-view__skill-card${editor?.uri === skill.uri ? ' selected' : ''}`}
                    aria-pressed={editor?.uri === skill.uri}
                    onClick={() => void this.openWorkspaceSkillInline(skill)}
                >
                    <div className='poiesis-agent-window__customize-icon'><span className='codicon codicon-book' aria-hidden='true' /></div>
                    <div>
                        <div className='poiesis-agent-window__customize-title'>
                            <strong>{skill.name}</strong>
                            <span>{skill.kind === 'agent' ? 'Agent' : 'Results'}</span>
                            <span className='poiesis-customize-view__source-badge'>{this.workspaceSkillSourceLabel(skill.source)}</span>
                        </div>
                        <p>{skill.error ?? skill.description}</p>
                        {shadowed && <div className='poiesis-customize-view__skill-note'>同名の Workspace Skill が優先</div>}
                        {skill.warnings.map((warning, index) => (
                            <div className='poiesis-customize-view__skill-note' key={`${skill.uri}-warning-${index}`}>{warning}</div>
                        ))}
                        <small>{this.workspaceSkillPath(skill.source, skill.id, entryName)}</small>
                        <div className='poiesis-customize-view__skill-size'>
                            <span>{characters.toLocaleString('ja-JP')} 文字</span>
                            {skill.kind === 'results' && <span>条件 {previewItem?.assertions ?? skill.assertions.length}件</span>}
                            {previewItem?.reason === '合計上限により未注入' && <span>合計上限により未注入</span>}
                            {previewItem?.included && characters > (preview?.limits.perSkill ?? 8_000) && <span>8,000 文字で切り詰め</span>}
                        </div>
                    </div>
                    <span className='codicon codicon-chevron-right' aria-hidden='true' />
                </button>
                <div className='poiesis-customize-view__skill-enablement'>
                    <span>{shadowed ? '非表示' : skill.enabled ? '有効' : '無効'}</span>
                    <label
                        className='poiesis-agent-window__switch'
                        title={shadowed ? '同名の上位Skillが優先されます' : `${skill.name}を${skill.enabled ? '無効' : '有効'}にする`}
                    >
                        <input
                            type='checkbox'
                            checked={skill.enabled}
                            disabled={shadowed}
                            aria-label={`${skill.name}を有効にする`}
                            onChange={event => void this.setWorkspaceSkillEnabled(skill, event.currentTarget.checked)}
                        />
                        <span aria-hidden='true' />
                    </label>
                </div>
            </div>
        );
    }

    protected renderPendingSkillRow(proposal: PendingSkillProposal): React.ReactNode {
        const selected = this.selectedPendingSkillId === proposal.id;
        const processing = this.pendingSkillActionId === proposal.id;
        return (
            <div
                className={`poiesis-customize-view__proposal-row${proposal.parsed.error ? ' has-error' : ''}`}
                key={proposal.id}
            >
                <button
                    type='button'
                    className={`poiesis-agent-window__customize-card poiesis-customize-view__skill-card${selected ? ' selected' : ''}`}
                    aria-pressed={selected}
                    onClick={() => this.selectPendingSkillProposal(proposal.id)}
                >
                    <div className='poiesis-agent-window__customize-icon'><span className='codicon codicon-lightbulb' aria-hidden='true' /></div>
                    <div>
                        <div className='poiesis-agent-window__customize-title'>
                            <strong>{proposal.parsed.name}</strong>
                            <span>{proposal.parsed.kind === 'agent' ? 'Agent' : 'Results'}</span>
                            <span className='poiesis-customize-view__source-badge'>
                                {proposal.existing ? '更新提案' : '新規提案'}
                            </span>
                        </div>
                        <p>{proposal.parsed.error ?? proposal.parsed.description}</p>
                        <small>.poiesis/pending/skills/{proposal.id}/SKILL.md</small>
                    </div>
                    <span className='codicon codicon-chevron-right' aria-hidden='true' />
                </button>
                <div className='poiesis-customize-view__proposal-actions'>
                    {!proposal.parsed.error && (
                        <button
                            type='button'
                            className='primary'
                            disabled={Boolean(this.pendingSkillActionId)}
                            onClick={() => void this.approvePendingSkill(proposal)}
                        >
                            {processing ? '処理中…' : '承認'}
                        </button>
                    )}
                    <button
                        type='button'
                        disabled={Boolean(this.pendingSkillActionId)}
                        onClick={() => void this.rejectPendingSkill(proposal)}
                    >
                        {processing ? '処理中…' : '却下'}
                    </button>
                </div>
            </div>
        );
    }

    protected renderPendingSkillPreview(): React.ReactNode {
        const proposal = this.pendingSkillProposals.find(candidate => candidate.id === this.selectedPendingSkillId);
        if (!proposal) {
            return undefined;
        }
        const diff = proposal.existing
            ? diffTextLines(proposal.existing.content, proposal.content)
            : undefined;
        return (
            <article className='poiesis-customize-view__proposal-preview' aria-label={`${proposal.parsed.name}の提案内容`}>
                <header>
                    <div>
                        <strong>{proposal.parsed.name}</strong>
                        <span>{proposal.existing ? '既存 Skill との差分 · 読み取り専用' : '提案された文書 · 読み取り専用'}</span>
                    </div>
                    <button type='button' aria-label='Skill提案の詳細を閉じる' onClick={() => this.selectPendingSkillProposal(undefined)}>
                        <span className='codicon codicon-close' aria-hidden='true' />
                    </button>
                </header>
                {proposal.parsed.error && <p role='alert'>{proposal.parsed.error}</p>}
                {diff ? (
                    <div className='poiesis-customize-view__proposal-diff' role='region' aria-label='Skill提案の差分'>
                        {diff.map((line, index) => (
                            <div className={`poiesis-customize-view__proposal-diff-line ${line.kind}`} key={`${index}:${line.kind}`}>
                                <span aria-hidden='true'>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}</span>
                                <span>{line.text || ' '}</span>
                            </div>
                        ))}
                    </div>
                ) : (
                    <pre>{proposal.content}</pre>
                )}
            </article>
        );
    }

    protected workspaceSkillSourceLabel(source: WorkspaceSkillSource): string {
        switch (source) {
            case 'workspace': return 'Workspace';
            case 'workspace-agents': return 'Workspace (.agents/skills)';
            case 'user': return 'ユーザー';
            case 'user-agents': return 'ユーザー (.agents/skills)';
        }
    }

    protected workspaceSkillPath(source: WorkspaceSkillSource, id: string, entryName: string): string {
        switch (source) {
            case 'workspace': return `.poiesis/skills/${id}/${entryName}`;
            case 'workspace-agents': return `.agents/skills/${id}/${entryName}`;
            case 'user': return `~/.poiesis/skills/${id}/${entryName}`;
            case 'user-agents': return `~/.agents/skills/${id}/${entryName}`;
        }
    }

    protected installWorkspaceSkillSaveShortcut(): void {
        const onKeyDown = (event: KeyboardEvent): void => {
            const savePressed = (event.ctrlKey || event.metaKey)
                && !event.altKey
                && !event.shiftKey
                && (event.key.toLocaleLowerCase() === 's' || event.code === 'KeyS');
            const editorFocused = event.target instanceof Element
                && event.target.classList.contains('poiesis-customize-view__editor-input');
            if (!savePressed || !this.customizeViewVisible || !this.workspaceSkillEditor || !editorFocused) {
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            void this.saveWorkspaceSkill();
        };
        document.addEventListener('keydown', onKeyDown, true);
        this.toDispose.push(Disposable.create(() => document.removeEventListener('keydown', onKeyDown, true)));
    }

    protected openCustomize(): void {
        if (this.customizeViewVisible) {
            this.closeCustomize();
            return;
        }
        if (this.codeMode) {
            this.detachCodeWidgets();
            this.codeMode = false;
        }
        this.settingsModalVisible = false;
        this.shortcutsOverlayVisible = false;
        this.customizeViewVisible = true;
        this.update();
        void this.refreshWorkspaceSkills();
        void this.installWorkspaceSkillWatchers();
    }

    protected closeCustomize(update = true): void {
        this.customizeViewVisible = false;
        this.disposeWorkspaceSkillWatchers();
        if (update) {
            this.update();
        }
    }

    protected handleCustomizeEscape(): void {
        if (this.workspaceSkillDiscardConfirmation) {
            this.cancelWorkspaceSkillClose();
        } else if (this.selectedPendingSkillId) {
            this.selectedPendingSkillId = undefined;
            this.update();
        } else if (this.workspaceSkillEditor) {
            this.requestCloseWorkspaceSkill();
        } else if (this.selectedBuiltinSkill) {
            this.selectBuiltinSkill(undefined);
        } else if (this.newSkillFormVisible) {
            this.hideNewSkillForm();
        } else {
            this.closeCustomize();
        }
    }

    protected showNewSkillForm(): void {
        this.newSkillFormVisible = true;
        this.newSkillId = '';
        this.newSkillKind = 'agent';
        this.newSkillScope = 'workspace';
        this.newSkillError = undefined;
        this.update();
    }

    protected hideNewSkillForm(): void {
        if (this.newSkillCreating) {
            return;
        }
        this.newSkillFormVisible = false;
        this.newSkillId = '';
        this.newSkillError = undefined;
        this.update();
    }

    protected setNewSkillId(id: string): void {
        this.newSkillId = id;
        this.newSkillError = undefined;
        this.update();
    }

    protected setNewSkillKind(kind: SkillBundleKind): void {
        this.newSkillKind = kind;
        this.update();
    }

    protected setNewSkillScope(scope: NewSkillScope): void {
        this.newSkillScope = scope;
        this.newSkillError = undefined;
        this.update();
    }

    protected toggleSkillPromptPreview(kind: SkillBundleKind): void {
        if (this.visibleSkillPromptPreviews.has(kind)) {
            this.visibleSkillPromptPreviews.delete(kind);
        } else {
            this.visibleSkillPromptPreviews.add(kind);
        }
        this.update();
    }

    protected selectBuiltinSkill(skill: 'bundled-results' | 'ai-results' | undefined): void {
        if (this.workspaceSkillEditor && this.workspaceSkillEditor.content !== this.workspaceSkillEditor.savedContent) {
            this.workspaceSkillDiscardConfirmation = true;
            this.update();
            return;
        }
        this.workspaceSkillEditor = undefined;
        this.workspaceSkillEditorError = undefined;
        this.workspaceSkillDiscardConfirmation = false;
        this.selectedPendingSkillId = undefined;
        this.selectedBuiltinSkill = skill;
        this.update();
    }

    protected selectPendingSkillProposal(id: string | undefined): void {
        if (this.workspaceSkillEditor && this.workspaceSkillEditor.content !== this.workspaceSkillEditor.savedContent) {
            this.workspaceSkillDiscardConfirmation = true;
            this.update();
            return;
        }
        this.workspaceSkillEditor = undefined;
        this.workspaceSkillEditorError = undefined;
        this.workspaceSkillDiscardConfirmation = false;
        this.selectedBuiltinSkill = undefined;
        this.selectedPendingSkillId = id;
        this.pendingSkillActionError = undefined;
        this.update();
    }

    protected async approvePendingSkill(proposal: PendingSkillProposal): Promise<void> {
        if (this.pendingSkillActionId || proposal.parsed.error) {
            return;
        }
        this.pendingSkillActionId = proposal.id;
        this.pendingSkillActionError = undefined;
        this.update();
        try {
            await this.workspaceSkillService.approvePending(proposal.id);
            if (this.selectedPendingSkillId === proposal.id) {
                this.selectedPendingSkillId = undefined;
            }
            await this.refreshWorkspaceSkills();
        } catch (error) {
            this.pendingSkillActionError = `Skill提案を承認できませんでした: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            this.pendingSkillActionId = undefined;
            this.update();
        }
    }

    protected async rejectPendingSkill(proposal: PendingSkillProposal): Promise<void> {
        if (this.pendingSkillActionId) {
            return;
        }
        this.pendingSkillActionId = proposal.id;
        this.pendingSkillActionError = undefined;
        this.update();
        try {
            await this.workspaceSkillService.rejectPending(proposal.id);
            if (this.selectedPendingSkillId === proposal.id) {
                this.selectedPendingSkillId = undefined;
            }
            await this.refreshWorkspaceSkills();
        } catch (error) {
            this.pendingSkillActionError = `Skill提案を却下できませんでした: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            this.pendingSkillActionId = undefined;
            this.update();
        }
    }

    protected async openWorkspaceSkillInline(skill: WorkspaceSkillDefinition): Promise<void> {
        if (this.workspaceSkillEditor?.uri === skill.uri) {
            return;
        }
        if (this.workspaceSkillEditor && this.workspaceSkillEditor.content !== this.workspaceSkillEditor.savedContent) {
            this.workspaceSkillDiscardConfirmation = true;
            this.update();
            return;
        }
        this.selectedBuiltinSkill = undefined;
        this.selectedPendingSkillId = undefined;
        this.workspaceSkillEditor = undefined;
        this.workspaceSkillEditorError = undefined;
        this.workspaceSkillDiscardConfirmation = false;
        this.workspaceSkillEditorLoading = true;
        this.update();
        try {
            const uri = new URI(skill.uri);
            const content = await this.fileService.read(uri);
            this.workspaceSkillEditor = {
                uri: skill.uri,
                path: FileUri.fsPath(uri).replace(/\\/g, '/'),
                content: content.value,
                savedContent: content.value
            };
        } catch (error) {
            this.workspaceSkillEditorError = `Skillファイルを開けませんでした: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            this.workspaceSkillEditorLoading = false;
            this.update();
        }
    }

    protected setWorkspaceSkillEditorContent(content: string): void {
        if (!this.workspaceSkillEditor || this.workspaceSkillSaving) {
            return;
        }
        this.workspaceSkillEditor.content = content;
        this.workspaceSkillEditorError = undefined;
        this.workspaceSkillDiscardConfirmation = false;
        this.update();
    }

    protected async saveWorkspaceSkill(): Promise<void> {
        const editor = this.workspaceSkillEditor;
        if (!editor || this.workspaceSkillSaving || editor.content === editor.savedContent) {
            return;
        }
        this.workspaceSkillSaving = true;
        this.workspaceSkillEditorError = undefined;
        this.update();
        try {
            await this.fileService.write(new URI(editor.uri), editor.content);
            editor.savedContent = editor.content;
            this.workspaceSkillDiscardConfirmation = false;
            await this.refreshWorkspaceSkills();
        } catch (error) {
            this.workspaceSkillEditorError = `Skillファイルを保存できませんでした: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            this.workspaceSkillSaving = false;
            this.update();
        }
    }

    protected requestCloseWorkspaceSkill(): void {
        if (!this.workspaceSkillEditor) {
            return;
        }
        if (this.workspaceSkillEditor.content !== this.workspaceSkillEditor.savedContent) {
            this.workspaceSkillDiscardConfirmation = true;
        } else {
            this.workspaceSkillEditor = undefined;
            this.workspaceSkillEditorError = undefined;
        }
        this.update();
    }

    protected cancelWorkspaceSkillClose(): void {
        this.workspaceSkillDiscardConfirmation = false;
        this.update();
    }

    protected discardWorkspaceSkillChanges(): void {
        this.workspaceSkillEditor = undefined;
        this.workspaceSkillEditorError = undefined;
        this.workspaceSkillDiscardConfirmation = false;
        this.update();
    }

    protected scheduleWorkspaceSkillsRefresh(): void {
        if (this.workspaceSkillRefreshTimer !== undefined) {
            window.clearTimeout(this.workspaceSkillRefreshTimer);
        }
        this.workspaceSkillRefreshTimer = window.setTimeout(() => {
            this.workspaceSkillRefreshTimer = undefined;
            if (this.customizeViewVisible) {
                void this.refreshWorkspaceSkills();
            }
        }, 300);
    }

    protected async installWorkspaceSkillWatchers(): Promise<void> {
        const root = this.workspaceRoot()?.resource;
        if (!this.customizeViewVisible || !root) {
            return;
        }
        let discoveryRoots: WorkspaceSkillDiscoveryRoot[];
        try {
            discoveryRoots = await this.workspaceSkillService.getDiscoveryRoots(root);
        } catch {
            return;
        }
        if (!this.customizeViewVisible || this.workspaceRoot()?.resource.toString() !== root.toString()) {
            return;
        }
        this.workspaceSkillWatchers?.dispose();
        const watchers = new DisposableCollection();
        const watchRoots = [
            ...discoveryRoots.map(discoveryRoot => discoveryRoot.uri),
            root.resolve('.poiesis/pending/skills')
        ];
        for (const watchRoot of watchRoots) {
            try {
                watchers.push(this.fileService.watch(watchRoot, { recursive: true, excludes: [] }));
            } catch {
                // Discovery still works for providers that do not support watching this root.
            }
        }
        this.workspaceSkillWatchers = watchers;
        this.workspaceSkillWatchRoots = watchRoots;
    }

    protected disposeWorkspaceSkillWatchers(): void {
        if (this.workspaceSkillRefreshTimer !== undefined) {
            window.clearTimeout(this.workspaceSkillRefreshTimer);
            this.workspaceSkillRefreshTimer = undefined;
        }
        this.workspaceSkillWatchers?.dispose();
        this.workspaceSkillWatchers = undefined;
        this.workspaceSkillWatchRoots = [];
    }

    protected async refreshWorkspaceSkills(): Promise<void> {
        const generation = ++this.workspaceSkillsRefreshGeneration;
        const root = this.workspaceRoot()?.resource;
        this.workspaceSkillsLoading = true;
        this.workspaceSkillsError = undefined;
        this.update();
        if (!root) {
            this.workspaceSkills = [];
            this.pendingSkillProposals = [];
            this.workspaceSkillPreviews = undefined;
            this.workspaceSkillsLoading = false;
            this.workspaceSkillsError = 'ユーザー Skill を表示するにはワークスペースを開いてください。';
            this.update();
            return;
        }
        void this.installWorkspaceSkillWatchers();
        try {
            const [definitions, pending, agentPreview, resultsPreview] = await Promise.all([
                this.workspaceSkillService.list(root),
                this.workspaceSkillService.listPending(root),
                this.workspaceSkillService.preview(root.toString(), 'agent'),
                this.workspaceSkillService.preview(root.toString(), 'results')
            ]);
            if (generation === this.workspaceSkillsRefreshGeneration) {
                this.workspaceSkills = definitions;
                this.pendingSkillProposals = pending;
                if (this.selectedPendingSkillId
                    && !pending.some(proposal => proposal.id === this.selectedPendingSkillId)) {
                    this.selectedPendingSkillId = undefined;
                }
                this.workspaceSkillPreviews = { agent: agentPreview, results: resultsPreview };
            }
        } catch (error) {
            if (generation === this.workspaceSkillsRefreshGeneration) {
                this.workspaceSkills = [];
                this.pendingSkillProposals = [];
                this.workspaceSkillPreviews = undefined;
                this.workspaceSkillsError = `ユーザー Skill を読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`;
            }
        } finally {
            if (generation === this.workspaceSkillsRefreshGeneration) {
                this.workspaceSkillsLoading = false;
                this.update();
            }
        }
    }

    protected async createWorkspaceSkill(): Promise<void> {
        if (this.newSkillCreating) {
            return;
        }
        const id = this.newSkillId.trim();
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
            this.newSkillError = 'Skill IDは小文字の英数字とハイフンで入力してください。';
            this.update();
            return;
        }
        const root = this.workspaceRoot()?.resource;
        if (!root) {
            this.newSkillError = 'Skillを作成するにはワークスペースを開いてください。';
            this.update();
            return;
        }
        this.newSkillCreating = true;
        this.newSkillError = undefined;
        this.update();
        try {
            const targetSource: WorkspaceSkillSource = this.newSkillScope === 'user' ? 'user' : 'workspace';
            const discoveryRoots = await this.workspaceSkillService.getDiscoveryRoots(root);
            const targetRoot = discoveryRoots.find(candidate => candidate.source === targetSource);
            if (!targetRoot) {
                throw new Error('Skillの作成先を解決できませんでした。');
            }
            const skillDirectory = targetRoot.uri.resolve(id);
            const skillUri = skillDirectory.resolve('SKILL.md');
            if (await this.fileService.exists(skillDirectory)) {
                this.newSkillError = `「${id}」はすでに存在します。`;
                return;
            }
            await this.fileService.createFolder(skillDirectory);
            const content = this.workspaceSkillTemplate(id, this.newSkillKind);
            await this.fileService.create(skillUri, content);
            await this.workspaceSkillService.setEnabled(skillUri.toString(), true);
            await this.refreshWorkspaceSkills();
            this.newSkillFormVisible = false;
            this.newSkillId = '';
            await this.openWorkspaceSkillInline(this.workspaceSkillService.parse(
                id,
                skillUri,
                content,
                true,
                targetRoot.source,
                targetRoot.rank
            ));
        } catch (error) {
            this.newSkillError = `Skillを作成できませんでした: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            this.newSkillCreating = false;
            this.update();
        }
    }

    protected workspaceSkillTemplate(id: string, kind: SkillBundleKind): string {
        const body = kind === 'agent'
            ? `## いつ使うか\nこのSkillを適用する状況と、適用しない状況を1行で記述してください。\n\n## 手順\n作業時に守る手順を、実行順に記述してください。\n\n## 落とし穴\n避けるべき失敗や、判断時の注意点を記述してください。\n\n## 検証\n完了前に実行する確認と、成功条件を記述してください。`
            : `## 構成\n成果文書の見出し順と、各節の目的を記述してください。\n\n## 表現ルール\n言語、語り口、図や表の使い方を記述してください。\n\n## 必須の節\n必ず含める節と、そこに必要な情報を記述してください。\n\n## 引用ルール\n根拠コードの示し方と、主張に必要な引用の粒度を記述してください。\n\nアプリが固定表示するタスク題名・状態・時刻・diffstat と引用マークアップ(\`data-poiesis-citation\`)はここに書かない`;
        return `---\nname: ${id}\ndescription: このSkillの目的を記述してください\nmetadata:\n  poiesis:\n    kind: ${kind}\n---\n\n# ${id}\n\n${body}\n`;
    }

    protected async setWorkspaceSkillEnabled(skill: WorkspaceSkillDefinition, enabled: boolean): Promise<void> {
        const previous = skill.enabled;
        skill.enabled = enabled;
        this.update();
        try {
            await this.workspaceSkillService.setEnabled(skill.uri, enabled);
            await this.refreshWorkspaceSkills();
        } catch (error) {
            skill.enabled = previous;
            this.workspaceSkillsError = `Skillの有効状態を保存できませんでした: ${error instanceof Error ? error.message : String(error)}`;
            this.update();
        }
    }

    protected async openWorkspaceSkillInCode(rawUri: string): Promise<void> {
        this.closeCustomize(false);
        try {
            await this.openCodeFile(rawUri);
        } catch (error) {
            this.customizeViewVisible = true;
            this.workspaceSkillEditorError = `SkillファイルをCodeで開けませんでした: ${error instanceof Error ? error.message : String(error)}`;
            this.update();
        }
    }

    constructor(host: AgentWindowHost) {
        super(host);
    }
}
