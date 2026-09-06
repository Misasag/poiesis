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
    CLI_DISPLAY_NAMES,
    CLI_EFFORT_LEVELS,
    CliDetectionReport,
    DEFAULT_CLI_ID,
    FolderBrowserResult,
    isKnownCliId,
    KNOWN_CLI_IDS,
    KnownCliId
} from '../../common/agent-runtime-protocol';
import { cliRoleAvailability, cliRoleAvailabilityLabel, CliRoleAvailability } from '../../common/cli-detection-lifecycle';
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
    version: 5;
    uiFontScale: UiFontScale;
    agentCli: KnownCliId;
    agentModel: string;
    agentEffort: string;
    resultsCli: KnownCliId;
    resultsModel: string;
    resultsEffort: string;
    effortByModel: Record<AiRole, Record<string, string>>;
    allowExternalResultsResources: boolean;
    automaticRequirementClassification: boolean;
}

interface LegacyPoiesisSettings {
    version?: 1 | 2 | 3 | 4;
    uiFontScale?: UiFontScale;
    preferredCli?: KnownCliId;
    agentCli?: KnownCliId;
    resultsCli?: KnownCliId;
    agentModel?: string;
    resultsModel?: string;
    allowExternalResultsResources?: boolean;
    automaticRequirementClassification?: boolean;
}

const SETTINGS_STORAGE_KEY = 'poiesis.settings.v1';

type SettingsCategory = 'display' | 'ai' | 'results' | 'keyboard' | 'data';

const SETTINGS_CATEGORIES: ReadonlyArray<{
    id: SettingsCategory;
    label: string;
    icon: string;
}> = [
    { id: 'display', label: '表示', icon: 'codicon-symbol-color' },
    { id: 'ai', label: 'AI', icon: 'codicon-sparkle' },
    { id: 'results', label: 'Results', icon: 'codicon-preview' },
    { id: 'keyboard', label: 'キーボード', icon: 'codicon-keyboard' },
    { id: 'data', label: 'データ管理', icon: 'codicon-database' }
];

export class SettingsPart extends AgentWindowPart {
    protected readonly customModelRoles = new Set<AiRole>();

    protected cliDetectionLoading = false;

    protected cliDetectionCompletion: Promise<void> = Promise.resolve();

    protected clearDataConfirmation = false;

    protected activeSettingsCategory: SettingsCategory = 'display';

    protected settingsPreviousFocus?: HTMLElement;

    protected settingsBackgroundElements: HTMLElement[] = [];

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
                    onKeyDown={event => this.trapSettingsFocus(event)}
                >
                    <header className='poiesis-settings-modal__header'>
                        <h1 id='poiesis-settings-title'>設定</h1>
                        <button type='button' aria-label='設定を閉じる' onClick={() => this.closeSettings()}>
                            <span className='codicon codicon-close' aria-hidden='true' />
                        </button>
                    </header>
                    <div className='poiesis-settings-modal__shell'>
                        <nav className='poiesis-settings-modal__nav' aria-label='設定カテゴリ'>
                            {SETTINGS_CATEGORIES.map(category => (
                                <button
                                    key={category.id}
                                    type='button'
                                    className={this.activeSettingsCategory === category.id ? 'active' : ''}
                                    aria-current={this.activeSettingsCategory === category.id ? 'page' : undefined}
                                    data-settings-initial-focus={this.activeSettingsCategory === category.id ? 'true' : undefined}
                                    onClick={() => this.selectSettingsCategory(category.id)}
                                >
                                    <span className={`codicon ${category.icon}`} aria-hidden='true' />
                                    <span>{category.label}</span>
                                </button>
                            ))}
                        </nav>
                        <div className='poiesis-settings-modal__body' key={this.activeSettingsCategory}>
                            {this.renderSettingsCategory(archivedSessions)}
                        </div>
                    </div>
                </section>
            </div>
        );
    }

    public renderShortcutsOverlay(): React.ReactNode {
        return undefined;
    }

    protected renderSettingsCategory(archivedSessions: readonly WindowAgentSession[]): React.ReactNode {
        switch (this.activeSettingsCategory) {
            case 'display': return this.renderDisplaySettings();
            case 'ai': return this.renderAiSettings();
            case 'results': return this.renderResultsSettings();
            case 'keyboard': return this.renderKeyboardSettings();
            case 'data': return this.renderDataSettings(archivedSessions);
        }
    }

    protected renderDisplaySettings(): React.ReactNode {
        return (
            <section className='poiesis-settings-modal__section' aria-labelledby='poiesis-settings-display'>
                <div className='poiesis-settings-modal__section-title'>
                    <h2 id='poiesis-settings-display'>表示</h2>
                    <span>Poiesis</span>
                </div>
                <div className='poiesis-settings-modal__row'>
                    <div>
                        <strong>表示サイズ</strong>
                        <small>サイドバー、会話、Resultsに反映されます。Codeの表示サイズは別に設定します。</small>
                    </div>
                    <div className='poiesis-settings-modal__segmented' role='radiogroup' aria-label='表示サイズ'>
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
                        <strong>Codeの表示と操作</strong>
                        <small>エディターとターミナルの文字、テーマ、動作を設定します。</small>
                    </div>
                    <button type='button' className='poiesis-settings-modal__text-button' onClick={() => void this.openTheiaSettings()}>Code設定を開く</button>
                </div>
            </section>
        );
    }

    protected renderAiSettings(): React.ReactNode {
        return (
            <section className='poiesis-settings-modal__section poiesis-settings-modal__section--ai' aria-labelledby='poiesis-settings-ai'>
                <div className='poiesis-settings-modal__section-heading'>
                    <div className='poiesis-settings-modal__section-title'>
                        <h2 id='poiesis-settings-ai'>AI</h2>
                        <span>役割ごとに選択</span>
                    </div>
                    <button type='button' className='poiesis-settings-modal__text-button' disabled={this.cliDetectionLoading} onClick={() => void this.refreshCliDetection()}>
                        {this.cliDetectionLoading ? '検出中…' : '再検出'}
                    </button>
                </div>
                <div className='poiesis-settings-modal__ai-roles'>
                    {this.renderCliRoleSelector('agent', 'Agent の AI', this.host.state.agentCli)}
                    {this.renderCliRoleSelector('results', 'Results の AI', this.host.state.resultsCli)}
                </div>
                {this.renderCliDiagnostics()}
            </section>
        );
    }

    protected renderResultsSettings(): React.ReactNode {
        return (
            <section className='poiesis-settings-modal__section' aria-labelledby='poiesis-settings-results'>
                <div className='poiesis-settings-modal__section-title'>
                    <h2 id='poiesis-settings-results'>Results</h2>
                    <span>成果の整理と表示</span>
                </div>
                <p className='poiesis-settings-modal__section-copy'>成果文書は Results の AI が生成します（未検出時は組み込みテンプレート）。</p>
                <div className='poiesis-settings-modal__row'>
                    <div>
                        <strong>成果を自動で分ける</strong>
                        <small>完了した成果が直前の成果と別の目的だと高い確度で判断できた場合だけ、新しいまとまりに分けます。</small>
                    </div>
                    <label className='poiesis-agent-window__switch'>
                        <input
                            type='checkbox'
                            checked={this.host.state.automaticRequirementClassification}
                            aria-label='成果を自動で分ける'
                            onChange={event => this.setAutomaticRequirementClassification(event.currentTarget.checked)}
                        />
                        <span aria-hidden='true' />
                    </label>
                </div>
                <div className='poiesis-settings-modal__row'>
                    <div>
                        <strong>外部リソースを読み込む</strong>
                        <small>有効にすると、成果文書内のネットワーク画像や外部スタイルを表示できます。</small>
                    </div>
                    <label className='poiesis-agent-window__switch'>
                        <input
                            type='checkbox'
                            checked={this.host.state.allowExternalResultsResources}
                            aria-label='成果文書の外部リソースを読み込む'
                            onChange={event => this.setAllowExternalResultsResources(event.currentTarget.checked)}
                        />
                        <span aria-hidden='true' />
                    </label>
                </div>
            </section>
        );
    }

    protected renderKeyboardSettings(): React.ReactNode {
        const shortcuts: Array<{ label: string; detail?: string; keys: string[] }> = [
            { label: 'Agent／Resultsで送信', detail: '日本語入力の変換中は送信しません。', keys: ['Enter'] },
            { label: 'Agent／Resultsで改行', keys: ['Shift', 'Enter'] },
            { label: 'Codeで保存', keys: ['Ctrl', 'S'] },
            { label: 'Codeのサイドバーを開閉', keys: ['Ctrl', 'B'] },
            { label: 'ファイルを選んで開く', keys: ['Ctrl', 'P'] },
            { label: 'Codeのターミナルを開閉', keys: ['Ctrl', '`'] },
            { label: '開いているメニューや画面を閉じる', keys: ['Esc'] }
        ];
        return (
            <section className='poiesis-settings-modal__section' aria-labelledby='poiesis-settings-keyboard'>
                <div className='poiesis-settings-modal__section-title'>
                    <h2 id='poiesis-settings-keyboard'>キーボード</h2>
                    <span>Windows</span>
                </div>
                <div className='poiesis-settings-modal__shortcut-list'>
                    {shortcuts.map(shortcut => (
                        <div className='poiesis-settings-modal__shortcut-row' key={shortcut.label}>
                            <span><strong>{shortcut.label}</strong>{shortcut.detail && <small>{shortcut.detail}</small>}</span>
                            <span className='poiesis-settings-modal__keys'>
                                {shortcut.keys.map(key => <kbd key={key}>{key}</kbd>)}
                            </span>
                        </div>
                    ))}
                </div>
            </section>
        );
    }

    protected renderDataSettings(archivedSessions: readonly WindowAgentSession[]): React.ReactNode {
        const counts = this.savedDataCounts();
        const countSummary = `会話 ${counts.conversations}件、成果 ${counts.results}件、実行記録 ${counts.tasks}件`;
        return (
            <section className='poiesis-settings-modal__section' aria-labelledby='poiesis-settings-data'>
                <div className='poiesis-settings-modal__section-title'>
                    <h2 id='poiesis-settings-data'>データ管理</h2>
                    <span>すべてのフォルダー</span>
                </div>
                <p className='poiesis-settings-modal__section-copy'>Poiesisに保存されたすべてのフォルダーの履歴が対象です。フォルダー内のファイルは削除されません。</p>
                <div className='poiesis-settings-modal__data-summary' aria-label='保存データの件数'>
                    <span><strong>{counts.conversations}</strong>会話</span>
                    <span><strong>{counts.results}</strong>成果</span>
                    <span><strong>{counts.tasks}</strong>実行記録</span>
                </div>
                <div className='poiesis-settings-modal__archived'>
                    <div className='poiesis-settings-modal__subheading'><strong>アーカイブ済み</strong><span>{archivedSessions.length}件</span></div>
                    {archivedSessions.length === 0 && <p>アーカイブ済みの会話はありません。</p>}
                    {archivedSessions.map(session => {
                        const resultCount = this.host.sessions.resultsRequirements(session).length;
                        return (
                            <div className='poiesis-settings-modal__archived-row' key={session.id}>
                                <span>
                                    <strong>{session.title}</strong>
                                    <small>{this.host.sessionMeta(session)} · メッセージ {session.messages.length}件 · 成果 {resultCount}件</small>
                                </span>
                                {this.host.state.deleteSessionConfirmationId === session.id ? (
                                    <div className='poiesis-settings-modal__confirm' role='group' aria-label={`${session.title}の完全削除を確認`}>
                                        <span>この会話の履歴からメッセージ {session.messages.length}件と成果 {resultCount}件を削除します。</span>
                                        <button type='button' className='danger' onClick={() => void this.host.deleteSession(session.id)}>削除</button>
                                        <button type='button' onClick={() => this.host.cancelDeleteSession()}>戻る</button>
                                    </div>
                                ) : (
                                    <button type='button' className='danger ghost' onClick={() => this.host.beginDeleteSession(session.id)}>完全削除</button>
                                )}
                            </div>
                        );
                    })}
                </div>
                <div className='poiesis-settings-modal__danger-zone'>
                    <div>
                        <strong>保存した履歴をすべてクリア</strong>
                        <small>{countSummary}が対象です。この操作は取り消せません。</small>
                    </div>
                    {this.clearDataConfirmation ? (
                        <div className='poiesis-settings-modal__confirm' role='group' aria-label='保存した履歴のクリアを確認'>
                            <span>すべてのフォルダーの履歴から{countSummary}を削除します。</span>
                            <button type='button' className='danger' onClick={() => void this.clearSavedSessionData()}>すべてクリア</button>
                            <button type='button' onClick={() => { this.clearDataConfirmation = false; this.update(); }}>戻る</button>
                        </div>
                    ) : (
                        <button type='button' className='danger' onClick={() => { this.clearDataConfirmation = true; this.update(); }}>すべてクリア</button>
                    )}
                </div>
            </section>
        );
    }

    protected savedDataCounts(): { conversations: number; tasks: number; results: number } {
        const sessions = this.host.sessions.sessions.filter(session => session.hasUserMessage);
        const taskIds = new Set(sessions.flatMap(session => session.taskIds));
        return {
            conversations: sessions.length,
            tasks: taskIds.size,
            results: sessions.reduce((total, session) => total + this.host.sessions.resultsRequirements(session).length, 0)
        };
    }

    protected renderCliRoleSelector(role: AiRole, label: string, selected: KnownCliId): React.ReactNode {
        const report = this.host.state.cliDetectionReport;
        const detections = report?.detections ?? [];
        const selectedDetection = detections.find(detection => detection.id === selected);
        const model = this.roleModel(role);
        const modelIds = selectedDetection?.models.map(option => option.id) ?? [];
        const customModel = this.customModelRoles.has(role) || !modelIds.includes(model);
        const modelSelection = customModel ? '__custom__' : model;
        const effortOptions = this.effortOptions(selected);
        const purpose = role === 'agent'
            ? '依頼を理解し、コードやファイルを変更します。'
            : '完了した成果を読みやすい文書にまとめます。';
        return (
            <div className='poiesis-settings-modal__cli-role'>
                <div className='poiesis-settings-modal__role-heading'>
                    <h3>{label}</h3>
                    <p>{purpose}</p>
                </div>
                <div className='poiesis-settings-modal__cli-list' role='radiogroup' aria-label={label}>
                    {KNOWN_CLI_IDS.map(providerId => {
                        const detection = detections.find(candidate => candidate.id === providerId);
                        const availability = cliRoleAvailability(
                            this.host.state.cliDetectionPhase,
                            report,
                            providerId,
                            role
                        );
                        const executable = availability === 'available';
                        const status = availability === 'available'
                            ? '検出済み'
                            : availability === 'unsupported'
                                ? '検出済み（未対応）'
                                : cliRoleAvailabilityLabel(availability);
                        return (
                            <div className='poiesis-settings-modal__cli-item' key={`${role}-${providerId}`}>
                                <label className={`poiesis-settings-modal__cli-row${executable ? '' : ' unavailable'}`}>
                                    <input
                                        type='radio'
                                        name={`poiesis-${role}-cli`}
                                        value={providerId}
                                        checked={selected === providerId}
                                        disabled={!executable}
                                        onChange={() => this.setRoleCli(role, providerId)}
                                    />
                                    <span className='poiesis-settings-modal__cli-copy'>
                                        <strong>{detection?.name ?? CLI_DISPLAY_NAMES[providerId]}</strong>
                                    </span>
                                    <span className={`poiesis-settings-modal__cli-status ${this.cliAvailabilityClass(availability)}`}>{status}</span>
                                </label>
                            </div>
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
                                disabled={cliRoleAvailability(this.host.state.cliDetectionPhase, report, selected, role) !== 'available'}
                                options={[
                                    ...selectedDetection.models.map(option => ({ value: option.id, label: option.id ? option.label : '既定' })),
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
                        {effortOptions.length > 0 && (
                            <label>
                                <span>処理の深さ</span>
                                <PoiesisSelect
                                    ariaLabel={`${label}の処理の深さ`}
                                    value={this.roleEffort(role)}
                                    disabled={cliRoleAvailability(this.host.state.cliDetectionPhase, report, selected, role) !== 'available'}
                                    options={effortOptions}
                                    onChange={value => this.setRoleEffort(role, value)}
                                />
                            </label>
                        )}
                    </div>
                )}
            </div>
        );
    }

    protected renderCliDiagnostics(): React.ReactNode {
        const report = this.host.state.cliDetectionReport;
        const detections = report?.detections ?? [];
        const current = this.host.state.cliDetectionPhase === 'ready';
        return (
            <details className='poiesis-settings-modal__diagnostics'>
                <summary>診断情報</summary>
                <dl>
                    {KNOWN_CLI_IDS.map(providerId => {
                        const detection = detections.find(candidate => candidate.id === providerId);
                        const unavailableLabel = this.host.state.cliDetectionPhase === 'pending' ? '確認中' : '確認できませんでした';
                        return (
                            <div key={providerId}>
                                <dt>{detection?.name ?? CLI_DISPLAY_NAMES[providerId]}</dt>
                                <dd>
                                    <span>実行ファイル: {current ? detection?.path ?? '見つかりません' : unavailableLabel}</span>
                                    <span>バージョン: {current ? detection?.version ?? '不明' : '未確認'}</span>
                                    <span>検出元: {current ? detection?.source === 'well-known' ? '標準の場所' : detection?.source ?? '不明' : '未確認'}</span>
                                </dd>
                            </div>
                        );
                    })}
                </dl>
            </details>
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
        const selectedEffort = this.roleEffort(role);
        const report = this.host.state.cliDetectionReport;
        const detections = report?.detections ?? [];
        return KNOWN_CLI_IDS.flatMap(providerId => {
            const detection = detections.find(candidate => candidate.id === providerId);
            const availability = cliRoleAvailability(this.host.state.cliDetectionPhase, report, providerId, role);
            const selected = providerId === selectedProvider;
            const name = detection?.name ?? CLI_DISPLAY_NAMES[providerId];
            if (availability !== 'available' || !detection) {
                const status = cliRoleAvailabilityLabel(availability);
                return [{
                    value: selected
                        ? this.roleChoiceValue(providerId, selectedCustom ? '__custom__' : selectedModel)
                        : `unavailable:${role}:${providerId}`,
                    label: status,
                    triggerLabel: `${name} · ${selectedModel || '既定'}${selectedEffort ? ` · ${this.effortLabel(selectedEffort)}` : ''} · ${status}`,
                    group: name,
                    disabled: true
                }];
            }
            const group = `${name} · 検出済み`;
            return [
                ...detection.models.map(option => ({
                    value: this.roleChoiceValue(providerId, option.id),
                    label: option.id ? option.label : '既定',
                    triggerLabel: `${name} · ${option.id ? option.label : '既定'}${this.effortFor(role, providerId, option.id) ? ` · ${this.effortLabel(this.effortFor(role, providerId, option.id))}` : ''}`,
                    group
                })),
                {
                    value: this.roleChoiceValue(providerId, '__custom__'),
                    label: 'カスタム…',
                    triggerLabel: `${name} · ${selected && selectedCustom && selectedModel ? selectedModel : 'カスタム…'}${selected && selectedCustom && selectedEffort ? ` · ${this.effortLabel(selectedEffort)}` : ''}`,
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
        const effort = this.effortFor(role, provider, model);
        if (role === 'agent') {
            this.host.state.agentCli = provider;
            this.host.state.agentModel = model;
            this.host.state.agentEffort = effort;
        } else {
            this.host.state.resultsCli = provider;
            this.host.state.resultsModel = model;
            this.host.state.resultsEffort = effort;
            this.resultsGenerationContext.providerId = provider;
            this.resultsGenerationContext.model = model;
            this.resultsGenerationContext.effort = effort;
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
        const effortOptions = this.effortOptions(selectedProvider);
        const report = this.host.state.cliDetectionReport;
        const detection = report?.detections.find(item => item.id === selectedProvider);
        const availability = cliRoleAvailability(this.host.state.cliDetectionPhase, report, selectedProvider, role);
        const executable = availability === 'available';
        const loading = availability === 'pending';
        const warning = availability === 'missing' || availability === 'unsupported' || availability === 'error';
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
                    popoverFooter={executable && (custom || effortOptions.length > 0) ? (
                        <div className='poiesis-ai-role-pill__controls'>
                            {custom && (
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
                            )}
                            {effortOptions.length > 0 && (
                                <label className='poiesis-ai-role-pill__effort'>
                                    <span>処理の深さ</span>
                                    <PoiesisSelect
                                        ariaLabel={`${roleLabel}の処理の深さ`}
                                        value={this.roleEffort(role)}
                                        options={effortOptions}
                                        onChange={nextEffort => this.setRoleEffort(role, nextEffort)}
                                    />
                                </label>
                            )}
                        </div>
                    ) : undefined}
                    onChange={nextValue => this.setRoleProviderModelChoice(role, nextValue)}
                />
            </div>
        );
    }

    public openSettings(): void {
        this.settingsPreviousFocus = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : undefined;
        this.host.state.settingsModalVisible = true;
        this.host.state.shortcutsOverlayVisible = false;
        this.host.state.deleteSessionConfirmationId = undefined;
        this.clearDataConfirmation = false;
        this.update();
        requestAnimationFrame(() => {
            this.isolateSettingsBackground();
            this.node.querySelector<HTMLElement>('[data-settings-initial-focus="true"]')?.focus();
        });
        void this.refreshCliDetection();
    }

    public closeSettings(restoreFocus = true): void {
        const restoreTarget = this.settingsPreviousFocus;
        this.host.state.settingsModalVisible = false;
        this.host.state.shortcutsOverlayVisible = false;
        this.host.state.deleteSessionConfirmationId = undefined;
        this.clearDataConfirmation = false;
        this.restoreSettingsBackground();
        this.update();
        if (restoreFocus) {
            requestAnimationFrame(() => {
                if (restoreTarget?.isConnected) {
                    restoreTarget.focus();
                    return;
                }
                const fallback = Array.from(this.node.querySelectorAll<HTMLElement>(
                    '[aria-label="設定"], [role="tab"][aria-selected="true"], .poiesis-agent-window__code-control, .poiesis-agent-window__composer textarea'
                )).find(element => element.getClientRects().length > 0);
                if (fallback) {
                    fallback.focus();
                } else {
                    if (!this.node.hasAttribute('tabindex')) {
                        this.node.tabIndex = -1;
                    }
                    this.node.focus();
                }
            });
        }
        this.settingsPreviousFocus = undefined;
    }

    public openShortcutsOverlay(): void {
        this.activeSettingsCategory = 'keyboard';
        this.host.state.shortcutsOverlayVisible = false;
        this.host.state.settingsModalVisible = true;
        this.update();
    }

    public closeShortcutsOverlay(): void {
        this.host.state.shortcutsOverlayVisible = false;
        this.update();
    }

    protected selectSettingsCategory(category: SettingsCategory): void {
        if (category === this.activeSettingsCategory) {
            return;
        }
        this.activeSettingsCategory = category;
        this.host.state.deleteSessionConfirmationId = undefined;
        this.clearDataConfirmation = false;
        this.update();
    }

    protected trapSettingsFocus(event: React.KeyboardEvent<HTMLElement>): void {
        if (event.key !== 'Tab') {
            return;
        }
        const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>([
            'button:not([disabled])',
            'input:not([disabled])',
            'textarea:not([disabled])',
            'select:not([disabled])',
            'a[href]',
            'summary',
            '[tabindex]:not([tabindex="-1"])'
        ].join(','))).filter(element => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true');
        if (!focusable.length) {
            event.preventDefault();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && (active === last || !event.currentTarget.contains(active))) {
            event.preventDefault();
            first.focus();
        }
    }

    protected isolateSettingsBackground(): void {
        this.restoreSettingsBackground();
        const backdrop = this.node.querySelector<HTMLElement>('.poiesis-settings-modal__backdrop');
        const container = backdrop?.parentElement;
        if (!backdrop || !container) {
            return;
        }
        this.settingsBackgroundElements = Array.from(container.children)
            .filter((element): element is HTMLElement => element instanceof HTMLElement)
            .filter(element => element !== backdrop && !element.inert);
        for (const element of this.settingsBackgroundElements) {
            element.inert = true;
        }
    }

    protected restoreSettingsBackground(): void {
        for (const element of this.settingsBackgroundElements) {
            if (element.isConnected) {
                element.inert = false;
            }
        }
        this.settingsBackgroundElements = [];
    }

    protected async openTheiaSettings(): Promise<void> {
        if (this.host.state.customizeViewVisible && !this.host.prepareCustomizeNavigation()) {
            this.closeSettings(false);
            return;
        }
        this.closeSettings(false);
        if (this.host.state.customizeViewVisible) {
            this.host.closeCustomize(false);
        }
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
        const effort = this.effortFor(role, cli, defaultModel);
        if (role === 'agent') {
            this.host.state.agentCli = cli;
            this.host.state.agentModel = defaultModel;
            this.host.state.agentEffort = effort;
        } else {
            this.host.state.resultsCli = cli;
            this.host.state.resultsModel = defaultModel;
            this.host.state.resultsEffort = effort;
            this.resultsGenerationContext.providerId = cli;
            this.resultsGenerationContext.model = defaultModel;
            this.resultsGenerationContext.effort = effort;
        }
        this.customModelRoles.delete(role);
        this.persistPoiesisSettings();
        this.update();
    }

    protected roleModel(role: AiRole): string {
        return role === 'agent' ? this.host.state.agentModel : this.host.state.resultsModel;
    }

    protected roleEffort(role: AiRole): string {
        return role === 'agent' ? this.host.state.agentEffort : this.host.state.resultsEffort;
    }

    protected effortKey(provider: KnownCliId, model: string): string {
        return `${provider}:${model.trim()}`;
    }

    protected effortFor(role: AiRole, provider: KnownCliId, model: string): string {
        const effort = this.host.state.effortByModel[role][this.effortKey(provider, model)] ?? '';
        return CLI_EFFORT_LEVELS[provider].includes(effort) ? effort : '';
    }

    protected effortOptions(provider: KnownCliId): PoiesisSelectOption[] {
        return CLI_EFFORT_LEVELS[provider].length > 0 ? [
            { value: '', label: '既定' },
            ...CLI_EFFORT_LEVELS[provider].map(value => ({ value, label: this.effortLabel(value) }))
        ] : [];
    }

    protected effortLabel(value: string): string {
        switch (value) {
            case 'minimal': return '最小';
            case 'low': return '軽め';
            case 'medium': return '標準';
            case 'high': return '深め';
            case 'xhigh': return 'かなり深く';
            case 'max': return '最大';
            default: return value;
        }
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
        const provider = role === 'agent' ? this.host.state.agentCli : this.host.state.resultsCli;
        const effort = this.effortFor(role, provider, model);
        if (role === 'agent') {
            this.host.state.agentModel = model;
            this.host.state.agentEffort = effort;
        } else {
            this.host.state.resultsModel = model;
            this.host.state.resultsEffort = effort;
            this.resultsGenerationContext.model = model.trim();
            this.resultsGenerationContext.effort = effort;
        }
        this.persistPoiesisSettings();
        this.update();
    }

    protected setRoleEffort(role: AiRole, effort: string): void {
        const provider = role === 'agent' ? this.host.state.agentCli : this.host.state.resultsCli;
        const normalized = CLI_EFFORT_LEVELS[provider].includes(effort) ? effort : '';
        this.host.state.effortByModel[role][this.effortKey(provider, this.roleModel(role))] = normalized;
        if (role === 'agent') {
            this.host.state.agentEffort = normalized;
        } else {
            this.host.state.resultsEffort = normalized;
            this.resultsGenerationContext.effort = normalized;
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

    public refreshCliDetection(): Promise<void> {
        if (this.cliDetectionLoading) {
            return this.cliDetectionCompletion;
        }
        this.cliDetectionCompletion = this.performCliDetection();
        return this.cliDetectionCompletion;
    }

    public waitForCurrentCliDetection(): Promise<void> {
        return this.cliDetectionCompletion;
    }

    protected async performCliDetection(): Promise<void> {
        this.cliDetectionLoading = true;
        this.host.state.cliDetectionPhase = 'pending';
        this.update();
        try {
            this.host.state.cliDetectionReport = await this.agentRuntimeServer.detectClis();
            this.host.state.cliDetectionPhase = 'ready';
            let settingsChanged = false;
            for (const role of ['agent', 'results'] as const) {
                const selected = role === 'agent' ? this.host.state.agentCli : this.host.state.resultsCli;
                const currentModel = this.roleModel(role);
                const detection = this.host.state.cliDetectionReport.detections.find(item => item.id === selected);
                if (!currentModel && detection?.defaultModel) {
                    const effort = this.effortFor(role, selected, detection.defaultModel);
                    if (role === 'agent') {
                        this.host.state.agentModel = detection.defaultModel;
                        this.host.state.agentEffort = effort;
                    } else {
                        this.host.state.resultsModel = detection.defaultModel;
                        this.host.state.resultsEffort = effort;
                        this.resultsGenerationContext.model = detection.defaultModel;
                        this.resultsGenerationContext.effort = effort;
                    }
                    settingsChanged = true;
                }
            }
            if (settingsChanged) {
                this.persistPoiesisSettings();
            }
        } catch (error) {
            this.host.state.cliDetectionPhase = 'error';
            console.warn('[Poiesis] Could not detect Agent CLIs.', error);
        } finally {
            this.cliDetectionLoading = false;
            this.update();
        }
    }

    protected cliAvailabilityClass(availability: CliRoleAvailability): string {
        switch (availability) {
            case 'pending': return 'pending';
            case 'available': return 'found';
            case 'unsupported': return 'unsupported';
            case 'missing': return 'missing';
            case 'error': return 'error';
        }
    }

    public async restorePoiesisSettings(): Promise<void> {
        try {
            const state = await this.storageService.getData<Partial<PersistedPoiesisSettings> | LegacyPoiesisSettings>(SETTINGS_STORAGE_KEY);
            if (state?.version === 1 || state?.version === 2 || state?.version === 3 || state?.version === 4 || state?.version === 5) {
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
                this.host.state.agentModel = (state.version === 3 || state.version === 4 || state.version === 5) && typeof state.agentModel === 'string'
                    ? state.agentModel
                    : '';
                this.host.state.resultsModel = (state.version === 3 || state.version === 4 || state.version === 5) && typeof state.resultsModel === 'string'
                    ? state.resultsModel
                    : '';
                this.host.state.effortByModel = state.version === 5
                    ? this.normalizeEffortByModel(state.effortByModel)
                    : { agent: {}, results: {} };
                this.host.state.agentEffort = state.version === 5
                    ? this.normalizeEffort(this.host.state.agentCli, state.agentEffort)
                    : '';
                this.host.state.resultsEffort = state.version === 5
                    ? this.normalizeEffort(this.host.state.resultsCli, state.resultsEffort)
                    : '';
                this.host.state.effortByModel.agent[this.effortKey(this.host.state.agentCli, this.host.state.agentModel)]
                    = this.host.state.agentEffort;
                this.host.state.effortByModel.results[this.effortKey(this.host.state.resultsCli, this.host.state.resultsModel)]
                    = this.host.state.resultsEffort;
                this.host.state.allowExternalResultsResources = state.allowExternalResultsResources === true;
                this.host.state.automaticRequirementClassification = state.version === 4 || state.version === 5
                    ? state.automaticRequirementClassification !== false
                    : true;
            }
        } catch (error) {
            console.warn('[Poiesis] Could not restore settings.', error);
        }
        this.resultsGenerationContext.providerId = this.host.state.resultsCli;
        this.resultsGenerationContext.model = this.host.state.resultsModel.trim();
        this.resultsGenerationContext.effort = this.host.state.resultsEffort;
        this.requirementClassificationService.enabled = this.host.state.automaticRequirementClassification;
        this.update();
    }

    protected persistPoiesisSettings(): void {
        void this.storageService.setData<PersistedPoiesisSettings>(SETTINGS_STORAGE_KEY, {
            version: 5,
            uiFontScale: this.host.state.uiFontScale,
            agentCli: this.host.state.agentCli,
            agentModel: this.host.state.agentModel,
            agentEffort: this.host.state.agentEffort,
            resultsCli: this.host.state.resultsCli,
            resultsModel: this.host.state.resultsModel,
            resultsEffort: this.host.state.resultsEffort,
            effortByModel: this.host.state.effortByModel,
            allowExternalResultsResources: this.host.state.allowExternalResultsResources,
            automaticRequirementClassification: this.host.state.automaticRequirementClassification
        });
    }

    protected normalizeEffort(provider: KnownCliId, value: unknown): string {
        return typeof value === 'string' && CLI_EFFORT_LEVELS[provider].includes(value) ? value : '';
    }

    protected normalizeEffortByModel(value: unknown): Record<AiRole, Record<string, string>> {
        const source = value && typeof value === 'object' ? value as Partial<Record<AiRole, unknown>> : {};
        const normalizeRole = (role: AiRole): Record<string, string> => Object.fromEntries(
            Object.entries(source[role] && typeof source[role] === 'object' ? source[role] as Record<string, unknown> : {})
                .flatMap(([key, effort]) => {
                    const separator = key.indexOf(':');
                    const provider = separator > 0 ? key.slice(0, separator) : '';
                    return isKnownCliId(provider) && typeof effort === 'string'
                        && CLI_EFFORT_LEVELS[provider].includes(effort)
                        ? [[key, effort]]
                        : [];
                })
        );
        return { agent: normalizeRole('agent'), results: normalizeRole('results') };
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
