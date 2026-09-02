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
import { AgentWindowHost, AgentWindowPart, UiFontScale } from './agent-window-host';

interface PersistedPoiesisSettings {
    version: 4;
    uiFontScale: UiFontScale;
    agentCli: KnownCliId;
    agentModel: string;
    resultsCli: KnownCliId;
    resultsModel: string;
    allowExternalResultsResources: boolean;
    automaticRequirementClassification: boolean;
}

interface LegacyPoiesisSettings {
    version?: 1 | 2 | 3;
    uiFontScale?: UiFontScale;
    preferredCli?: KnownCliId;
    agentCli?: KnownCliId;
    resultsCli?: KnownCliId;
    agentModel?: string;
    resultsModel?: string;
    allowExternalResultsResources?: boolean;
}

const SETTINGS_STORAGE_KEY = 'poiesis.settings.v1';

export class SettingsPart extends AgentWindowPart {
    protected readonly customModelRoles = new Set<AiRole>();

    protected cliDetectionLoading = false;

    protected clearDataConfirmation = false;

    public renderSettingsModal(): React.ReactNode {
        const archivedSessions = this.host.sessions.sessions
            .filter(session => session.archived && session.hasUserMessage)
            .sort((left, right) => right.updatedAt - left.updatedAt);
        return (
            <div
                className='poiesis-settings-modal__backdrop'
                onMouseDown={event => {
                    if (event.target === event.currentTarget) {
                        this.closeSettings();
                    }
                }}
            >
                <section
                    className='poiesis-settings-modal'
                    role='dialog'
                    aria-modal='true'
                    aria-labelledby='poiesis-settings-title'
                >
                    <header className='poiesis-settings-modal__header'>
                        <div>
                            <span className='codicon codicon-settings-gear' aria-hidden='true' />
                            <div><h1 id='poiesis-settings-title'>Poiesisの設定</h1><p>アプリの表示とAgent環境を管理します。</p></div>
                        </div>
                        <button type='button' aria-label='設定を閉じる' onClick={() => this.closeSettings()} autoFocus>
                            <span className='codicon codicon-close' aria-hidden='true' />
                        </button>
                    </header>
                    <div className='poiesis-settings-modal__body'>
                        <section className='poiesis-settings-modal__section' aria-labelledby='poiesis-settings-general'>
                            <h2 id='poiesis-settings-general'>一般</h2>
                            <div className='poiesis-settings-modal__row'>
                                <div><strong>UI文字サイズ</strong><small>Poiesisのサイドバー、会話、Resultsの表示スケールを変更します。</small></div>
                                <div className='poiesis-settings-modal__segmented' role='radiogroup' aria-label='UI文字サイズ'>
                                    {([['small', '小'], ['standard', '標準'], ['large', '大']] as Array<[UiFontScale, string]>).map(([scale, label]) => (
                                        <label key={scale} className={this.host.state.uiFontScale === scale ? 'active' : ''}>
                                            <input type='radio' name='poiesis-ui-scale' value={scale} checked={this.host.state.uiFontScale === scale} onChange={() => this.setUiFontScale(scale)} />
                                            <span>{label}</span>
                                        </label>
                                    ))}
                                </div>
                            </div>
                            <div className='poiesis-settings-modal__row'>
                                <div>
                                    <strong>要件の自動分類</strong>
                                    <small>タスク完了後、直前の要件と関係が薄いと高い確信で判定できた場合だけ、新しい要件として分けます。判定に迷う場合は現在の要件を継続します。</small>
                                </div>
                                <label className='poiesis-agent-window__switch'>
                                    <input
                                        type='checkbox'
                                        checked={this.host.state.automaticRequirementClassification}
                                        aria-label='要件の自動分類'
                                        onChange={event => this.setAutomaticRequirementClassification(event.currentTarget.checked)}
                                    />
                                    <span aria-hidden='true' />
                                </label>
                            </div>
                            <div className='poiesis-settings-modal__row poiesis-settings-modal__shortcuts-row'>
                                <div><strong>キーボードショートカット</strong><small>Poiesisで実際に使えるキー操作を確認します。</small></div>
                                <button type='button' className='poiesis-settings-modal__text-button' aria-haspopup='dialog' onClick={() => this.openShortcutsOverlay()}>一覧を開く</button>
                            </div>
                        </section>

                        <section className='poiesis-settings-modal__section' aria-labelledby='poiesis-settings-cli'>
                            <div className='poiesis-settings-modal__section-heading'>
                                <h2 id='poiesis-settings-cli'>AI の役割と Model</h2>
                                <button type='button' className='poiesis-settings-modal__text-button' disabled={this.cliDetectionLoading} onClick={() => void this.refreshCliDetection()}>再検出</button>
                            </div>
                            {this.renderCliRoleSelector('agent', 'Agent の AI', this.host.state.agentCli)}
                            {this.renderCliRoleSelector('results', 'Results の AI', this.host.state.resultsCli)}
                        </section>

                        <section className='poiesis-settings-modal__section' aria-labelledby='poiesis-settings-results'>
                            <h2 id='poiesis-settings-results'>Results・外部リソース</h2>
                            <p className='poiesis-settings-modal__section-copy'>成果文書は Results の AI が生成します（未検出時は組み込みテンプレート）。</p>
                            <div className='poiesis-settings-modal__row'>
                                <div><strong>成果文書の外部リソース読み込みを許可</strong><small>OFFではResults HTMLからのネットワーク画像や外部スタイルをブロックします。</small></div>
                                <label className='poiesis-agent-window__switch'>
                                    <input type='checkbox' checked={this.host.state.allowExternalResultsResources} aria-label='成果文書の外部リソースを許可' onChange={event => this.setAllowExternalResultsResources(event.currentTarget.checked)} />
                                    <span aria-hidden='true' />
                                </label>
                            </div>
                        </section>

                        <section className='poiesis-settings-modal__section' aria-labelledby='poiesis-settings-sessions'>
                            <h2 id='poiesis-settings-sessions'>セッション・データ管理</h2>
                            <div className='poiesis-settings-modal__archived'>
                                <strong>アーカイブ済み</strong>
                                {archivedSessions.length === 0 && <p>アーカイブ済みのセッションはありません。</p>}
                                {archivedSessions.map(session => (
                                    <div className='poiesis-settings-modal__archived-row' key={session.id}>
                                        <span><strong>{session.title}</strong><small>{this.host.sessionMeta(session)}</small></span>
                                        {this.host.state.deleteSessionConfirmationId === session.id ? (
                                            <div className='poiesis-settings-modal__confirm' role='group' aria-label={`${session.title}の完全削除を確認`}>
                                                <span>完全に削除しますか？</span>
                                                <button type='button' className='danger' onClick={() => void this.host.deleteSession(session.id)}>削除</button>
                                                <button type='button' onClick={() => this.host.cancelDeleteSession()}>戻る</button>
                                            </div>
                                        ) : (
                                            <button type='button' className='danger ghost' onClick={() => this.host.beginDeleteSession(session.id)}>完全削除</button>
                                        )}
                                    </div>
                                ))}
                            </div>
                            <div className='poiesis-settings-modal__danger-zone'>
                                <div><strong>保存データをすべてクリア</strong><small>会話、タスク、Resultsの保存状態をこのウィンドウから削除します。</small></div>
                                {this.clearDataConfirmation ? (
                                    <div className='poiesis-settings-modal__confirm' role='group' aria-label='保存データのクリアを確認'>
                                        <span>この操作は取り消せません。</span>
                                        <button type='button' className='danger' onClick={() => void this.clearSavedSessionData()}>クリア</button>
                                        <button type='button' onClick={() => { this.clearDataConfirmation = false; this.update(); }}>戻る</button>
                                    </div>
                                ) : (
                                    <button type='button' className='danger' onClick={() => { this.clearDataConfirmation = true; this.update(); }}>保存データをすべてクリア</button>
                                )}
                            </div>
                        </section>

                    </div>
                    <footer className='poiesis-settings-modal__footer'>
                        <button type='button' onClick={() => void this.openTheiaSettings()}>エディタとTerminalの設定は Theia Settings で</button>
                    </footer>
                </section>
            </div>
        );
    }

    public renderShortcutsOverlay(): React.ReactNode {
        const shortcuts = [
            { label: 'Agentへ送信', keys: ['Ctrl / ⌘', 'Enter'] },
            { label: 'Resultsへ質問を送信', keys: ['Enter'] },
            { label: 'Codeでファイルを保存', keys: ['Ctrl / ⌘', 'S'] },
            { label: 'CodeでTerminalを開閉', keys: ['Ctrl / ⌘', '`'] },
            { label: 'モーダル／ポップオーバーを閉じる', keys: ['Esc'] }
        ];
        return (
            <div
                className='poiesis-shortcuts__backdrop'
                onMouseDown={event => {
                    if (event.target === event.currentTarget) {
                        this.closeShortcutsOverlay();
                    }
                }}
            >
                <section className='poiesis-shortcuts' role='dialog' aria-modal='true' aria-labelledby='poiesis-shortcuts-title'>
                    <header>
                        <div><span className='codicon codicon-keyboard' aria-hidden='true' /><h2 id='poiesis-shortcuts-title'>キーボードショートカット</h2></div>
                        <button type='button' aria-label='キーボードショートカットを閉じる' onClick={() => this.closeShortcutsOverlay()} autoFocus>
                            <span className='codicon codicon-close' aria-hidden='true' />
                        </button>
                    </header>
                    <div className='poiesis-shortcuts__list'>
                        {shortcuts.map(shortcut => (
                            <div className='poiesis-shortcuts__row' key={shortcut.label}>
                                <span>{shortcut.label}</span>
                                <span className='poiesis-shortcuts__keys'>
                                    {shortcut.keys.map(key => <kbd key={key}>{key}</kbd>)}
                                </span>
                            </div>
                        ))}
                    </div>
                </section>
            </div>
        );
    }

    protected renderCliRoleSelector(role: AiRole, label: string, selected: KnownCliId): React.ReactNode {
        const detections = this.host.state.cliDetectionReport?.detections ?? [];
        const selectedDetection = detections.find(detection => detection.id === selected);
        const model = this.roleModel(role);
        const modelIds = selectedDetection?.models.map(option => option.id) ?? [];
        const customModel = this.customModelRoles.has(role) || !modelIds.includes(model);
        const modelSelection = customModel ? '__custom__' : model;
        return (
            <div className='poiesis-settings-modal__cli-role'>
                <h3>{label}</h3>
                <div className='poiesis-settings-modal__cli-list' role='radiogroup' aria-label={label}>
                    {detections.map(detection => {
                        const executable = detection.status === 'found' && detection.executableRoles.includes(role);
                        const status = this.cliDetectionLoading && !detection.path
                            ? '検出中…'
                            : detection.status === 'missing'
                                ? '未検出'
                                : executable ? '検出済み（実行可）' : '検出済み（実行対応は今後）';
                        return (
                            <label key={`${role}-${detection.id}`} className={`poiesis-settings-modal__cli-row${executable ? '' : ' unavailable'}`}>
                                <input
                                    type='radio'
                                    name={`poiesis-${role}-cli`}
                                    value={detection.id}
                                    checked={selected === detection.id}
                                    disabled={!executable}
                                    onChange={() => this.setRoleCli(role, detection.id)}
                                />
                                <span className='poiesis-settings-modal__cli-copy'>
                                    <strong>{detection.name}</strong>
                                    <small title={detection.path}>{detection.path ?? `${detection.id} CLI`}{detection.version ? ` · ${detection.version}` : ''}</small>
                                </span>
                                <span className={`poiesis-settings-modal__cli-status ${executable ? 'found' : detection.status === 'found' ? 'unsupported' : 'missing'}`}>{status}</span>
                            </label>
                        );
                    })}
                </div>
                {selectedDetection && (
                    <div className='poiesis-settings-modal__model-field'>
                        <label>
                            <span>モデル</span>
                            <PoiesisSelect
                                ariaLabel={`${label} モデル`}
                                value={modelSelection}
                                disabled={selectedDetection.status !== 'found' || !selectedDetection.executableRoles.includes(role)}
                                options={[
                                    ...selectedDetection.models.map(option => ({ value: option.id, label: option.label })),
                                    { value: '__custom__', label: 'カスタム…' }
                                ]}
                                onChange={value => this.setRoleModelChoice(role, value)}
                            />
                        </label>
                        {customModel && (
                            <label>
                                <span>カスタムモデルID</span>
                                <PoiesisTextInput
                                    value={model}
                                    maxLength={160}
                                    placeholder='モデルIDを入力'
                                    aria-label={`${label} カスタムモデルID`}
                                    onValueChange={value => this.setRoleModel(role, value)}
                                />
                            </label>
                        )}
                    </div>
                )}
            </div>
        );
    }

    protected roleChoiceValue(provider: KnownCliId, model: string): string {
        return `provider:${provider}:${encodeURIComponent(model)}`;
    }

    protected roleModelIsCustom(role: AiRole): boolean {
        const detection = this.host.state.cliDetectionReport?.detections.find(item => item.id === (role === 'agent' ? this.host.state.agentCli : this.host.state.resultsCli));
        const model = this.roleModel(role);
        return this.customModelRoles.has(role) || Boolean(detection && !detection.models.some(option => option.id === model));
    }

    protected rolePillOptions(role: AiRole): PoiesisSelectOption[] {
        const selectedProvider = role === 'agent' ? this.host.state.agentCli : this.host.state.resultsCli;
        const selectedModel = this.roleModel(role);
        const selectedCustom = this.roleModelIsCustom(role);
        const detections = this.host.state.cliDetectionReport?.detections ?? [];
        if (!detections.length) {
            const name = selectedProvider.charAt(0).toUpperCase() + selectedProvider.slice(1);
            return [{
                value: this.roleChoiceValue(selectedProvider, selectedCustom ? '__custom__' : selectedModel),
                label: '検出中…',
                triggerLabel: `${name} · ${selectedModel || '既定'} · 検出中…`,
                group: name,
                disabled: true
            }];
        }
        return detections.flatMap(detection => {
            const executable = detection.status === 'found' && detection.executableRoles.includes(role);
            const selected = detection.id === selectedProvider;
            if (!executable) {
                const status = detection.status === 'missing' ? '未検出' : '実行対応は今後';
                return [{
                    value: selected
                        ? this.roleChoiceValue(detection.id, selectedCustom ? '__custom__' : selectedModel)
                        : `unavailable:${role}:${detection.id}`,
                    label: status,
                    triggerLabel: `${detection.name} · ${selectedModel || '既定'} · ${status}`,
                    group: detection.name,
                    disabled: true
                }];
            }
            const group = `${detection.name} · 実行可`;
            return [
                ...detection.models.map(option => ({
                    value: this.roleChoiceValue(detection.id, option.id),
                    label: option.label,
                    triggerLabel: `${detection.name} · ${option.id || '既定'}`,
                    group
                })),
                {
                    value: this.roleChoiceValue(detection.id, '__custom__'),
                    label: 'カスタム…',
                    triggerLabel: `${detection.name} · ${selected && selectedCustom && selectedModel ? selectedModel : 'カスタム…'}`,
                    group,
                    keepOpen: true
                }
            ];
        });
    }

    protected setRoleProviderModelChoice(role: AiRole, value: string): void {
        const match = /^provider:([^:]+):(.*)$/.exec(value);
        if (!match || !isKnownCliId(match[1])) {
            return;
        }
        const provider = match[1];
        const modelChoice = decodeURIComponent(match[2]);
        const detection = this.host.state.cliDetectionReport?.detections.find(item => item.id === provider);
        if (detection?.status !== 'found' || !detection.executableRoles.includes(role)
            || (modelChoice !== '__custom__' && !detection.models.some(option => option.id === modelChoice))) {
            return;
        }
        const model = modelChoice === '__custom__' ? '' : modelChoice;
        if (role === 'agent') {
            this.host.state.agentCli = provider;
            this.host.state.agentModel = model;
        } else {
            this.host.state.resultsCli = provider;
            this.host.state.resultsModel = model;
            this.resultsGenerationContext.providerId = provider;
            this.resultsGenerationContext.model = model;
        }
        if (modelChoice === '__custom__') {
            this.customModelRoles.add(role);
        } else {
            this.customModelRoles.delete(role);
        }
        this.persistPoiesisSettings();
        this.update();
    }

    public renderAiRolePill(role: AiRole, compact = false): React.ReactNode {
        const selectedProvider = role === 'agent' ? this.host.state.agentCli : this.host.state.resultsCli;
        const selectedModel = this.roleModel(role);
        const custom = this.roleModelIsCustom(role);
        const detection = this.host.state.cliDetectionReport?.detections.find(item => item.id === selectedProvider);
        const executable = detection?.status === 'found' && detection.executableRoles.includes(role);
        const loading = !this.host.state.cliDetectionReport || this.cliDetectionLoading;
        const warning = !loading && !executable;
        const value = this.roleChoiceValue(selectedProvider, custom ? '__custom__' : selectedModel);
        const roleLabel = role === 'agent' ? 'Agent' : 'Results';
        return (
            <div
                className={`poiesis-ai-role-pill ${compact ? 'compact' : ''}${warning ? ' warning' : ''}${loading ? ' loading' : ''}`}
                data-ai-role={role}
            >
                <PoiesisSelect
                    ariaLabel={`${roleLabel} の AI とモデル`}
                    value={value}
                    options={this.rolePillOptions(role)}
                    popoverClassName='poiesis-ai-role-pill__popover'
                    popoverMinWidth={280}
                    leadingIconClass={warning ? 'codicon-warning' : 'codicon-sparkle'}
                    popoverFooter={custom && executable ? (
                        <label className='poiesis-ai-role-pill__custom-model'>
                            <span>{detection?.name ?? selectedProvider} のカスタムモデルID</span>
                            <PoiesisTextInput
                                value={selectedModel}
                                maxLength={160}
                                placeholder='モデルIDを入力'
                                aria-label={`${roleLabel} の AI カスタムモデルID`}
                                autoFocus
                                onValueChange={model => this.setRoleModel(role, model)}
                            />
                        </label>
                    ) : undefined}
                    onChange={nextValue => this.setRoleProviderModelChoice(role, nextValue)}
                />
            </div>
        );
    }

    public openSettings(): void {
        this.host.closeCustomize(false);
        this.host.state.settingsModalVisible = true;
        this.host.state.shortcutsOverlayVisible = false;
        this.host.state.deleteSessionConfirmationId = undefined;
        this.clearDataConfirmation = false;
        this.update();
        void this.refreshCliDetection();
    }

    public closeSettings(): void {
        this.host.state.settingsModalVisible = false;
        this.host.state.shortcutsOverlayVisible = false;
        this.host.state.deleteSessionConfirmationId = undefined;
        this.clearDataConfirmation = false;
        this.update();
    }

    public openShortcutsOverlay(): void {
        this.host.state.shortcutsOverlayVisible = true;
        this.update();
    }

    public closeShortcutsOverlay(): void {
        this.host.state.shortcutsOverlayVisible = false;
        this.update();
    }

    protected async openTheiaSettings(): Promise<void> {
        this.closeSettings();
        if (!this.host.state.codeMode) {
            this.host.ensureCodeFileIcons();
            this.host.state.codeMode = true;
            this.update();
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
        await this.host.openCodeSettings();
    }

    public uiFontScaleValue(): number {
        return this.host.state.uiFontScale === 'small' ? 0.92 : this.host.state.uiFontScale === 'large' ? 1.12 : 1;
    }

    protected setUiFontScale(scale: UiFontScale): void {
        this.host.state.uiFontScale = scale;
        this.persistPoiesisSettings();
        this.update();
    }

    protected setRoleCli(role: AiRole, cli: KnownCliId): void {
        const defaultModel = this.host.state.cliDetectionReport?.detections.find(detection => detection.id === cli)?.defaultModel ?? '';
        if (role === 'agent') {
            this.host.state.agentCli = cli;
            this.host.state.agentModel = defaultModel;
        } else {
            this.host.state.resultsCli = cli;
            this.host.state.resultsModel = defaultModel;
            this.resultsGenerationContext.providerId = cli;
            this.resultsGenerationContext.model = defaultModel;
        }
        this.customModelRoles.delete(role);
        this.persistPoiesisSettings();
        this.update();
    }

    protected roleModel(role: AiRole): string {
        return role === 'agent' ? this.host.state.agentModel : this.host.state.resultsModel;
    }

    protected setRoleModelChoice(role: AiRole, value: string): void {
        if (value === '__custom__') {
            this.customModelRoles.add(role);
            this.setRoleModel(role, '');
            return;
        }
        this.customModelRoles.delete(role);
        this.setRoleModel(role, value);
    }

    protected setRoleModel(role: AiRole, model: string): void {
        if (role === 'agent') {
            this.host.state.agentModel = model;
        } else {
            this.host.state.resultsModel = model;
            this.resultsGenerationContext.model = model.trim();
        }
        this.persistPoiesisSettings();
        this.update();
    }

    protected setAllowExternalResultsResources(allow: boolean): void {
        this.host.state.allowExternalResultsResources = allow;
        this.persistPoiesisSettings();
        this.update();
    }

    protected setAutomaticRequirementClassification(enabled: boolean): void {
        this.host.state.automaticRequirementClassification = enabled;
        this.requirementClassificationService.enabled = enabled;
        this.persistPoiesisSettings();
        this.update();
    }

    public async refreshCliDetection(): Promise<void> {
        if (this.cliDetectionLoading) {
            return;
        }
        this.cliDetectionLoading = true;
        this.update();
        try {
            this.host.state.cliDetectionReport = await this.agentRuntimeServer.detectClis();
            let settingsChanged = false;
            for (const role of ['agent', 'results'] as const) {
                const selected = role === 'agent' ? this.host.state.agentCli : this.host.state.resultsCli;
                const currentModel = this.roleModel(role);
                const detection = this.host.state.cliDetectionReport.detections.find(item => item.id === selected);
                if (!currentModel && detection?.defaultModel) {
                    if (role === 'agent') {
                        this.host.state.agentModel = detection.defaultModel;
                    } else {
                        this.host.state.resultsModel = detection.defaultModel;
                        this.resultsGenerationContext.model = detection.defaultModel;
                    }
                    settingsChanged = true;
                }
            }
            if (settingsChanged) {
                this.persistPoiesisSettings();
            }
        } finally {
            this.cliDetectionLoading = false;
            this.update();
        }
    }

    public async restorePoiesisSettings(): Promise<void> {
        try {
            const state = await this.storageService.getData<Partial<PersistedPoiesisSettings> | LegacyPoiesisSettings>(SETTINGS_STORAGE_KEY);
            if (state?.version === 1 || state?.version === 2 || state?.version === 3 || state?.version === 4) {
                this.host.state.uiFontScale = state.uiFontScale === 'small' || state.uiFontScale === 'large'
                    ? state.uiFontScale
                    : 'standard';
                const legacyCli = state.version === 1 && isKnownCliId(state.preferredCli)
                    ? state.preferredCli
                    : DEFAULT_CLI_ID;
                this.host.state.agentCli = state.version !== 1 && isKnownCliId(state.agentCli)
                    ? state.agentCli
                    : legacyCli;
                this.host.state.resultsCli = state.version !== 1 && isKnownCliId(state.resultsCli)
                    ? state.resultsCli
                    : legacyCli;
                this.host.state.agentModel = (state.version === 3 || state.version === 4) && typeof state.agentModel === 'string'
                    ? state.agentModel
                    : '';
                this.host.state.resultsModel = (state.version === 3 || state.version === 4) && typeof state.resultsModel === 'string'
                    ? state.resultsModel
                    : '';
                this.host.state.allowExternalResultsResources = state.allowExternalResultsResources === true;
                this.host.state.automaticRequirementClassification = state.version === 4
                    ? state.automaticRequirementClassification !== false
                    : true;
            }
        } catch (error) {
            console.warn('[Poiesis] Could not restore settings.', error);
        }
        this.resultsGenerationContext.providerId = this.host.state.resultsCli;
        this.resultsGenerationContext.model = this.host.state.resultsModel.trim();
        this.requirementClassificationService.enabled = this.host.state.automaticRequirementClassification;
        this.update();
    }

    protected persistPoiesisSettings(): void {
        void this.storageService.setData<PersistedPoiesisSettings>(SETTINGS_STORAGE_KEY, {
            version: 4,
            uiFontScale: this.host.state.uiFontScale,
            agentCli: this.host.state.agentCli,
            agentModel: this.host.state.agentModel,
            resultsCli: this.host.state.resultsCli,
            resultsModel: this.host.state.resultsModel,
            allowExternalResultsResources: this.host.state.allowExternalResultsResources,
            automaticRequirementClassification: this.host.state.automaticRequirementClassification
        });
    }

    protected async clearSavedSessionData(): Promise<void> {
        if (!this.clearDataConfirmation) {
            return;
        }
        for (const session of [...this.host.sessions.sessions]) {
            for (const [taskId, notice] of session.resultsNotices) {
                if (notice.status === 'sending') {
                    await this.resultsQuestionService.cancel(taskId);
                }
            }
            if (session.agentSession) {
                try {
                    await this.agentProvider.cancel(session.agentSession.id);
                } catch {
                    // The local process may already have ended; data removal still continues.
                }
            }
            this.taskService.remove(session.taskIds);
            this.resultsService.remove(session.taskIds);
            this.host.disposeAgentRichContentForSession(session.id);
        }
        this.host.sessions.sessions.splice(0, this.host.sessions.sessions.length);
        this.host.sessions.selectedSessionId = undefined;
        this.host.state.deleteSessionConfirmationId = undefined;
        this.clearDataConfirmation = false;
        await this.host.sessions.createSession();
    }

    constructor(host: AgentWindowHost) {
        super(host);
    }
}
