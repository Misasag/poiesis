import { isOnDemandAgentSkill } from '../../common/skill-catalog';
import { HookConfiguration, HookRow, HOOK_EVENT_LABELS } from '../../common/hooks-protocol';
import * as React from '@theia/core/shared/react';
import { Disposable, DisposableCollection } from '@theia/core/lib/common';
import { FileUri } from '@theia/core/lib/common/file-uri';
import URI from '@theia/core/lib/common/uri';
import { MonacoEditor } from '@theia/monaco/lib/browser/monaco-editor';
import { SkillBundleKind } from '../../common/skill-bundle';
import { POIESIS_FONT_MONO } from '../typography';
import {
    WorkspaceSkillDefinition,
    WorkspaceSkillDiscoveryRoot,
    WorkspaceSkillPreview,
    WorkspaceSkillSource
} from '../workspace-skill-service';
import { PoiesisDisclosureSummary } from '../components/poiesis-disclosure';
import { PoiesisTextInput } from '../components/poiesis-inputs';
import { PoiesisSelect } from '../components/poiesis-select';
import { AgentWindowHost, AgentWindowPart } from './agent-window-host';

type NewSkillScope = 'workspace' | 'user';
type CustomizeTab = 'skills' | 'plugins' | 'hooks';
type CustomizeScope = 'all' | 'workspace' | 'user';
type PendingEditorNavigation = 'list' | 'close-customize';

interface WorkspaceSkillEditor {
    uri: string;
    path: string;
    content: string;
    savedContent: string;
}

export class CustomizePart extends AgentWindowPart {
    protected workspaceSkills: WorkspaceSkillDefinition[] = [];
    protected workspaceSkillsLoading = false;
    protected workspaceSkillsError?: string;
    protected workspaceSkillsRefreshGeneration = 0;
    protected workspaceSkillPreviews?: Record<SkillBundleKind, WorkspaceSkillPreview>;
    protected workspaceSkillWatchers?: DisposableCollection;
    protected workspaceSkillRefreshTimer?: number;

    protected customizeTab: CustomizeTab = 'skills';
    protected customizeScope: CustomizeScope = 'all';
    protected readonly customizeQueries: Record<CustomizeTab, string> = { skills: '', plugins: '', hooks: '' };
    protected hooksConfiguration?: HookConfiguration;
    protected selectedHook?: HookRow;
    protected hooksError?: string;
    protected hooksLoading = false;
    protected hooksWorkspace = '';
    protected readonly expandedSkillGroups = new Set<string>();
    protected customizeListScrollTop = 0;
    protected customizeListScrollRestorePending = false;
    protected customizeListMount?: HTMLElement;

    protected newSkillFormVisible = false;
    protected newSkillId = '';
    protected newSkillKind: SkillBundleKind = 'agent';
    protected newSkillScope: NewSkillScope = 'workspace';
    protected newSkillError?: string;
    protected newSkillCreating = false;

    protected selectedWorkspaceSkill?: WorkspaceSkillDefinition;
    protected workspaceSkillEditor?: WorkspaceSkillEditor;
    protected workspaceSkillEditorLoading = false;
    protected workspaceSkillEditorError?: string;
    protected workspaceSkillDiscardConfirmation = false;
    protected workspaceSkillSaving = false;
    protected pendingEditorNavigation?: PendingEditorNavigation;
    protected pendingExitAction?: () => void | Promise<void>;
    protected workspaceSkillOpenGeneration = 0;

    protected inlineEditorContainer?: HTMLDivElement;
    protected inlineEditor?: MonacoEditor;
    protected inlineEditorUri?: string;
    protected inlineEditorChangeListener?: { dispose(): void };
    protected inlineEditorCreationUri?: string;
    protected inlineEditorCreationContainer?: HTMLDivElement;
    protected inlineEditorGeneration = 0;

    protected customizeOpenedFromCode = false;

    protected readonly setInlineEditorContainer = (node: HTMLDivElement | null): void => {
        if (!node) {
            this.inlineEditorContainer = undefined;
            this.disposeInlineEditor();
            return;
        }
        this.inlineEditorContainer = node;
        void this.ensureInlineEditor();
    };

    protected readonly setCustomizeListMount = (node: HTMLElement | null): void => {
        this.customizeListMount = node ?? undefined;
        if (node) {
            this.applyCustomizeListScrollRestoration();
        }
    };

    public renderCustomizeView(): React.ReactNode {
        const detailVisible = Boolean(
            this.selectedWorkspaceSkill
            || this.workspaceSkillEditor
            || this.workspaceSkillEditorLoading
            || this.workspaceSkillEditorError
        );
        return (
            <section className={`poiesis-customize-view${detailVisible ? ' is-detail' : ''}`} aria-label='カスタマイズ'>
                <div className={`poiesis-customize-view__page${detailVisible ? ' is-detail' : ''}`}>
                    {detailVisible
                        ? this.renderWorkspaceSkillEditor()
                        : this.renderCustomizeList()}
                </div>
            </section>
        );
    }

    protected renderCustomizeList(): React.ReactNode {
        return (
            <>
                {this.renderCustomizeToolbar()}
                {this.customizeTab === 'skills' && this.newSkillFormVisible && this.renderNewSkillForm()}
                {this.customizeTab === 'skills' ? this.renderSkillsPanel() : this.customizeTab === 'hooks' ? this.renderHooksPanel() : this.renderPluginsPanel()}
            </>
        );
    }

    protected renderCustomizeToolbar(): React.ReactNode {
        const query = this.customizeQueries[this.customizeTab];
        const workspaceName = this.host.sessions.workspaceRoot()?.resource.path.base || '現在のフォルダー';
        return (
            <header ref={this.setCustomizeListMount} className='poiesis-customize-view__toolbar'>
                <div className='poiesis-customize-view__toolbar-primary'>
                    <button type='button' className='poiesis-customize-view__return-chat' onClick={() => this.closeCustomize()}>
                        <span className='codicon codicon-arrow-left' aria-hidden='true' />
                        <span>チャットに戻る</span>
                    </button>
                    <label className='poiesis-customize-view__search'>
                        <span className='codicon codicon-search' aria-hidden='true' />
                        <input
                            type='search'
                            aria-label={this.customizeTab === 'skills' ? 'Skillsを検索' : this.customizeTab === 'hooks' ? 'Hooksを検索' : 'Pluginsを検索'}
                            placeholder={this.customizeTab === 'skills' ? 'Skillsを検索…' : this.customizeTab === 'hooks' ? 'Hooksを検索…' : 'Pluginsを検索…'}
                            value={query}
                            onChange={event => this.setCustomizeQuery(event.currentTarget.value)}
                        />
                    </label>
                    {this.customizeTab === 'skills' && (
                        <button type='button' className='poiesis-customize-view__primary-action' onClick={() => this.showNewSkillForm()}>
                            <span className='codicon codicon-add' aria-hidden='true' />
                            新しいSkill
                        </button>
                    )}
                </div>
                <div className='poiesis-customize-view__toolbar-secondary'>
                    <PoiesisSelect
                        className='poiesis-customize-view__scope-select'
                        value={this.customizeScope}
                        ariaLabel='Skillの使用範囲'
                        leadingIconClass='codicon-folder'
                        popoverMinWidth={260}
                        options={[
                            { value: 'all', label: 'すべて' },
                            { value: 'workspace', label: `このフォルダー · ${workspaceName}` },
                            { value: 'user', label: 'すべてのフォルダー' }
                        ]}
                        onChange={value => this.setCustomizeScope(value as CustomizeScope)}
                    />
                    <span className='poiesis-customize-view__toolbar-divider' aria-hidden='true' />
                    <div className='poiesis-customize-view__tabs-scroll'>
                        <div className='poiesis-customize-view__tabs' role='tablist' aria-label='カスタマイズの種類'>
                            {(['skills', 'plugins', 'hooks'] as const).map(tab => (
                                <button
                                    id={`poiesis-customize-${tab}-tab`}
                                    key={tab}
                                    type='button'
                                    role='tab'
                                    aria-selected={this.customizeTab === tab}
                                    aria-controls={`poiesis-customize-${tab}-panel`}
                                    tabIndex={this.customizeTab === tab ? 0 : -1}
                                    className={this.customizeTab === tab ? 'active' : ''}
                                    onClick={() => this.setCustomizeTab(tab)}
                                    onKeyDown={event => this.handleCustomizeTabKeyDown(event, tab)}
                                >
                                    {tab === 'skills' ? 'Skills' : tab === 'hooks' ? 'Hooks' : 'Plugins'}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            </header>
        );
    }

    protected async refreshHooks(action?: () => Promise<void>): Promise<void> {
        this.hooksLoading = true; this.hooksError = undefined; this.update();
        const workspace = this.host.sessions.workspaceRoot()?.resource.path.fsPath() ?? '';
        this.hooksWorkspace = workspace;
        try {
            if (action) { await action(); }
            this.hooksConfiguration = await this.taskService.hooksServer!.list(workspace);
            this.hooksWorkspace = workspace;
        } catch (error) { this.hooksError = error instanceof Error ? error.message : 'Hooks を読み込めませんでした。'; }
        finally { this.hooksLoading = false; this.update(); }
    }

    protected renderHooksPanel(): React.ReactNode {
        const configuration = this.hooksConfiguration;
        const workspace = this.host.sessions.workspaceRoot()?.resource.path.fsPath() ?? '';
        if (!this.hooksLoading && this.hooksWorkspace !== workspace) { void this.refreshHooks(); }
        const selected = this.selectedHook;
        if (selected) {
            const { id, command, timeoutMs, policy, enabled, event } = selected;
            return <section id='poiesis-customize-hooks-panel' role='tabpanel' aria-labelledby='poiesis-customize-hooks-tab' className='poiesis-hooks'>
                <button type='button' onClick={() => { this.selectedHook = undefined; this.update(); }}>一覧に戻る</button>
                <h2>{id}</h2><p>{HOOK_EVENT_LABELS[event]} · {policy === 'required' ? '必須' : '助言'}</p>
                <h3>設定</h3><pre>{JSON.stringify({ version: 1, hooks: { [event]: [{ id, command, timeoutMs, policy, enabled }] } }, undefined, 2)}</pre>
                <p>最終実行の入力: {selected.lastRun?.stdinBytes ?? 0} バイト · 出力: {selected.lastRun?.stdoutBytes ?? 0} バイト</p>
                {selected.lastRun?.error && <p role='alert'>{selected.lastRun.error}</p>}
            </section>;
        }
        return <section id='poiesis-customize-hooks-panel' role='tabpanel' aria-labelledby='poiesis-customize-hooks-tab' className='poiesis-hooks'>
            <p>設定ファイル: ユーザーフォルダーまたはワークスペースの .poiesis/hooks.json</p>
            <button type='button' disabled={this.hooksLoading} onClick={() => void this.refreshHooks()}>再読み込み</button>
            {this.hooksLoading && <p role='status'>読み込み中…</p>}
            {this.hooksError && <p role='alert'>{this.hooksError}</p>}
            {configuration?.errors.map((error, index) => <p role='alert' key={index}>{error}</p>)}
            {(['user', 'workspace'] as const).filter(scope => this.customizeScope === 'all' || this.customizeScope === scope).map(scope => {
                const rows = configuration?.rows.filter(row => row.scope === scope &&
                    `${row.id} ${row.command.join(' ')} ${HOOK_EVENT_LABELS[row.event]}`.toLocaleLowerCase().includes(this.customizeQueries.hooks.toLocaleLowerCase())) ?? [];
                return <section className='poiesis-hooks__group' key={scope}>
                    <h3>{scope === 'user' ? 'すべてのフォルダー' : 'このワークスペース'} · {rows.length} 件</h3>
                    {scope === 'workspace' && <div>
                        <label className='poiesis-hooks__trust'>
                            <input type='checkbox' role='switch' checked={configuration?.workspaceEnabled ?? false} disabled={!workspace || this.hooksLoading}
                                onChange={e => { const enabled = e.currentTarget.checked; void this.refreshHooks(() => this.taskService.hooksServer!.setWorkspaceEnabled(workspace, enabled)); }} />
                            このワークスペースで有効にする
                        </label>
                        <p>有効にすると、このフォルダーの設定に従ってコンピューター上でコマンドを実行します。</p>
                    </div>}
                    {rows.length === 0 && <p>フックはありません。</p>}
                    {rows.map(row => <div className='poiesis-hooks__row' key={`${row.event}/${row.id}`}>
                        <button type='button' className='poiesis-hooks__open' onClick={() => { this.selectedHook = row; this.update(); }}>
                            <strong>{row.id}</strong><span>{HOOK_EVENT_LABELS[row.event]}</span>
                            <code title={row.command.join(' ')}>{row.command.join(' ')}</code>
                        </button>
                        <span className='poiesis-hooks__policy'>{row.policy === 'required' ? '必須' : '助言'}</span>
                        <label className='poiesis-agent-window__switch'>
                            <input type='checkbox' role='switch' aria-label={`${row.id}を有効にする`} checked={row.enabled}
                                disabled={this.hooksLoading || scope === 'workspace' && !configuration?.workspaceEnabled}
                                onChange={e => { const enabled = e.currentTarget.checked; void this.refreshHooks(() => this.taskService.hooksServer!.setEnabled(workspace, scope, row.event, row.id, enabled)); }} />
                            <span aria-hidden='true' />
                        </label>
                        <span>{row.enabled ? '有効' : '無効'}</span>
                        <p className='poiesis-hooks__last'>{row.lastRun
                            ? `${row.lastRun.status === 'pass' ? '成功' : '失敗'} · ${row.lastRun.durationMs} ms · ${new Date(row.lastRun.time).toLocaleString('ja-JP')}` : '未実行'}</p>
                        {row.lastRun?.error && <p className='poiesis-hooks__error'>{row.lastRun.error}</p>}
                    </div>)}
                </section>;
            })}
        </section>;
    }

    protected renderNewSkillForm(): React.ReactNode {
        return (
            <form className='poiesis-customize-view__new-skill poiesis-agent-window__customize-card' onSubmit={event => {
                event.preventDefault();
                void this.createWorkspaceSkill();
            }}>
                <label>
                    <span>名前</span>
                    <PoiesisTextInput
                        autoFocus
                        value={this.newSkillId}
                        placeholder='my-skill'
                        aria-label='新しいSkillの名前'
                        disabled={this.newSkillCreating}
                        onValueChange={value => this.setNewSkillId(value)}
                    />
                </label>
                <label>
                    <span>役割</span>
                    <PoiesisSelect
                        value={this.newSkillKind}
                        ariaLabel='新しいSkillの役割'
                        disabled={this.newSkillCreating}
                        options={[{ value: 'agent', label: 'Agent' }, { value: 'results', label: 'Results' }]}
                        onChange={value => this.setNewSkillKind(value as SkillBundleKind)}
                    />
                </label>
                <label>
                    <span>使用範囲</span>
                    <PoiesisSelect
                        value={this.newSkillScope}
                        ariaLabel='新しいSkillの使用範囲'
                        disabled={this.newSkillCreating}
                        options={[{ value: 'workspace', label: 'このフォルダー' }, { value: 'user', label: 'すべてのフォルダー' }]}
                        onChange={value => this.setNewSkillScope(value as NewSkillScope)}
                    />
                </label>
                {this.newSkillError && <p role='alert'>{this.newSkillError}</p>}
                <div className='poiesis-customize-view__form-actions'>
                    <button type='button' disabled={this.newSkillCreating} onClick={() => this.hideNewSkillForm()}>キャンセル</button>
                    <button type='submit' className='primary' disabled={this.newSkillCreating || !this.newSkillId.trim()}>
                        {this.newSkillCreating ? '作成中…' : '作成して編集'}
                    </button>
                </div>
            </form>
        );
    }

    protected renderSkillsPanel(): React.ReactNode {
        const query = this.customizeQueries.skills.trim().toLocaleLowerCase('ja-JP');
        const scopedSkills = this.workspaceSkills.filter(skill => this.skillMatchesScope(skill));
        const skills = scopedSkills.filter(skill => this.skillMatchesQuery(skill, query));
        const hasAnySkills = this.workspaceSkills.length > 0;
        const hasMatches = skills.length > 0;
        return (
            <section
                id='poiesis-customize-skills-panel'
                className='poiesis-customize-view__panel'
                role='tabpanel'
                aria-labelledby='poiesis-customize-skills-tab'
            >
                {this.workspaceSkillsLoading ? this.renderStateCard('Skillsを読み込んでいます…', 'status', true) : undefined}
                {!this.workspaceSkillsLoading && this.workspaceSkillsError ? this.renderStateCard(this.workspaceSkillsError, 'alert') : undefined}
                {!this.workspaceSkillsLoading && !this.workspaceSkillsError && !hasAnySkills ? this.renderEmptySkillsCard() : undefined}
                {!this.workspaceSkillsLoading && !this.workspaceSkillsError && hasAnySkills && !hasMatches ? this.renderNoMatchesCard() : undefined}
                {!this.workspaceSkillsLoading && !this.workspaceSkillsError && hasMatches && (
                    <div className='poiesis-customize-view__groups'>
                        {this.renderWorkspaceSkillGroups(skills)}
                    </div>
                )}
                {!this.workspaceSkillsLoading && !this.workspaceSkillsError && this.renderGenerationDetails()}
            </section>
        );
    }

    protected renderPluginsPanel(): React.ReactNode {
        return (
            <section
                id='poiesis-customize-plugins-panel'
                className='poiesis-customize-view__panel'
                role='tabpanel'
                aria-labelledby='poiesis-customize-plugins-tab'
            >
                <div className='poiesis-customize-view__empty-state poiesis-agent-window__customize-card'>
                    <h2>Pluginsは追加されていません</h2>
                    <p><strong>Poiesis plugin bundles</strong> は Skills と設定をまとめて配布する仕組みです。現在は組み込みの bundle だけが使われ、追加する操作はまだありません。</p>
                </div>
            </section>
        );
    }

    protected renderStateCard(message: string, role: 'status' | 'alert', loading = false): React.ReactNode {
        return (
            <div className={`poiesis-customize-view__state-card${role === 'alert' ? ' error' : ''}`} role={role}>
                {loading && <span className='codicon codicon-loading codicon-modifier-spin' aria-hidden='true' />}
                <span>{message}</span>
            </div>
        );
    }

    protected renderEmptySkillsCard(): React.ReactNode {
        return (
            <div className='poiesis-customize-view__empty-state poiesis-agent-window__customize-card'>
                <h2>Skillsはまだありません</h2>
                <p>Skillを有効にすると、次の作業からAgentへの指示やResultsの生成ルールに反映されます。</p>
                <button type='button' className='poiesis-customize-view__primary-action' onClick={() => this.showNewSkillForm()}>
                    <span className='codicon codicon-add' aria-hidden='true' />
                    新しいSkill
                </button>
            </div>
        );
    }

    protected renderNoMatchesCard(): React.ReactNode {
        return <div className='poiesis-customize-view__empty-state poiesis-agent-window__customize-card'><h2>一致するSkillはありません</h2></div>;
    }

    protected renderWorkspaceSkillGroups(skills: WorkspaceSkillDefinition[]): React.ReactNode {
        const groups: Array<{ id: string; label: string; sources: WorkspaceSkillSource[] }> = [
            { id: 'workspace', label: 'このフォルダー', sources: ['workspace', 'workspace-agents'] },
            { id: 'global', label: 'すべてのフォルダー', sources: ['user', 'user-agents'] }
        ];
        return groups.map(group => {
            const groupedSkills = skills.filter(skill => group.sources.includes(skill.source));
            if (!groupedSkills.length) {
                return undefined;
            }
            const visible = this.visibleGroupItems(group.id, groupedSkills);
            return (
                <section className='poiesis-customize-view__scope-group' aria-labelledby={`poiesis-customize-${group.id}-title`} key={group.id}>
                    <h2 id={`poiesis-customize-${group.id}-title`} className='poiesis-customize-view__group-title'>
                        {group.label} <span>{groupedSkills.length}</span>
                    </h2>
                    <div className='poiesis-customize-view__group-card poiesis-agent-window__customize-card'>
                        {visible.map(skill => this.renderWorkspaceSkillRow(skill))}
                    </div>
                    {this.renderGroupMoreButton(group.id, groupedSkills.length)}
                </section>
            );
        });
    }

    protected visibleGroupItems<T>(groupId: string, items: T[]): T[] {
        return this.expandedSkillGroups.has(groupId) ? items : items.slice(0, 6);
    }

    protected renderGroupMoreButton(groupId: string, total: number): React.ReactNode {
        if (total <= 6) {
            return undefined;
        }
        const expanded = this.expandedSkillGroups.has(groupId);
        return (
            <button type='button' className='poiesis-customize-view__group-more' aria-expanded={expanded} onClick={() => this.toggleGroupExpanded(groupId)}>
                {expanded ? '表示を減らす' : `さらに${total - 6}件を表示`}
                <span className={`codicon codicon-chevron-${expanded ? 'up' : 'down'}`} aria-hidden='true' />
            </button>
        );
    }

    protected renderWorkspaceSkillRow(skill: WorkspaceSkillDefinition): React.ReactNode {
        const shadowed = Boolean(skill.shadowedBy);
        const titleId = `poiesis-skill-${this.domId(`${skill.source}-${skill.id}`)}-title`;
        const descriptionId = `${titleId}-description`;
        const description = skill.error
            || (shadowed ? '同じ名前のフォルダー用Skillが優先されています' : skill.description || '説明はありません');
        return (
            <div className={`poiesis-customize-view__skill-row${skill.error ? ' has-error' : ''}${shadowed ? ' is-shadowed' : ''}`} key={`${skill.source}:${skill.id}:${skill.uri}`}>
                <button type='button' className='poiesis-customize-view__row-target' aria-labelledby={`${titleId} ${descriptionId}`} onClick={() => void this.openWorkspaceSkillInline(skill)} />
                <div className='poiesis-agent-window__customize-icon'>
                    <span className={`codicon ${skill.kind === 'agent' ? 'codicon-tools' : 'codicon-book'}`} aria-hidden='true' />
                </div>
                <div className='poiesis-customize-view__row-copy'>
                    <div className='poiesis-agent-window__customize-title'>
                        <strong id={titleId}>{skill.name}</strong>
                        <span>{skill.kind === 'agent' ? 'Agent' : 'Results'}</span>
                        {isOnDemandAgentSkill(skill) && <span className='poiesis-customize-view__on-demand'>必要時に読み込み</span>}
                    </div>
                    <p id={descriptionId} className={`poiesis-customize-view__row-description${skill.error ? ' error' : shadowed ? ' warning' : ''}`}>{description}</p>
                </div>
                <label className='poiesis-agent-window__switch poiesis-customize-view__row-switch' title={shadowed ? '同名の上位Skillが優先されます' : `${skill.name}を${skill.enabled ? '無効' : '有効'}にする`}>
                    <input type='checkbox' checked={skill.enabled} disabled={shadowed} aria-label={`${skill.name}を有効にする`} onChange={event => void this.setWorkspaceSkillEnabled(skill, event.currentTarget.checked)} />
                    <span aria-hidden='true' />
                </label>
                <span className='codicon codicon-chevron-right poiesis-customize-view__row-chevron' aria-hidden='true' />
            </div>
        );
    }

    protected renderWorkspaceSkillEditor(): React.ReactNode {
        const editor = this.workspaceSkillEditor;
        const skill = this.selectedWorkspaceSkill;
        const dirty = this.workspaceSkillEditorDirty();
        const title = skill?.name ?? editor?.path.split('/').at(-2) ?? 'Skill';
        const relativePath = skill ? this.workspaceSkillPath(skill.source, skill.id, new URI(skill.uri).path.base) : editor?.path ?? '';
        const shadowed = Boolean(skill?.shadowedBy);
        return (
            <section className='poiesis-customize-view__detail poiesis-customize-view__editor' aria-label='Skillエディター' aria-busy={this.workspaceSkillSaving}>
                <header className='poiesis-customize-view__detail-header'>
                    <button type='button' className='poiesis-customize-view__back' aria-label='Skills一覧に戻る' onClick={() => this.requestReturnToSkillsList()}>
                        <span className='codicon codicon-chevron-left' aria-hidden='true' /><span>Skills</span>
                    </button>
                    <div className='poiesis-customize-view__detail-heading'>
                        <strong>{title}</strong>
                        <div className='poiesis-customize-view__detail-meta'>
                            {skill && <span className='poiesis-customize-view__kind-chip'>{skill.kind === 'agent' ? 'Agent' : 'Results'}</span>}
                            {skill && <span>{this.workspaceSkillSourceLabel(skill.source)}</span>}
                            {relativePath && <code>{relativePath}</code>}
                            {editor && (
                                <button type='button' className='poiesis-customize-view__code-link' disabled={dirty || this.workspaceSkillSaving} title={dirty ? '先に変更を保存してください' : undefined} onClick={() => void this.openWorkspaceSkillInCode(editor.uri)}>
                                    Codeで開く
                                </button>
                            )}
                        </div>
                    </div>
                    <div className='poiesis-customize-view__detail-actions'>
                        {skill && (
                            <label className='poiesis-agent-window__switch' title={shadowed ? '同名の上位Skillが優先されます' : undefined}>
                                <input type='checkbox' checked={skill.enabled} disabled={shadowed} aria-label={`${skill.name}を有効にする`} onChange={event => void this.setWorkspaceSkillEnabled(skill, event.currentTarget.checked)} />
                                <span aria-hidden='true' />
                            </label>
                        )}
                        <span className={`poiesis-customize-view__save-status${dirty ? ' active' : ''}`} role='status'>
                            {this.workspaceSkillSaving ? '保存中…' : dirty ? '未保存' : '保存済み'}
                        </span>
                        <button type='button' className='poiesis-customize-view__save primary' disabled={!dirty || this.workspaceSkillSaving} onClick={() => void this.saveWorkspaceSkill()}>保存</button>
                    </div>
                </header>
                {editor && skill && this.renderWorkspaceSkillInfo(skill, editor)}
                {this.workspaceSkillDiscardConfirmation && this.renderDiscardConfirmation()}
                {this.workspaceSkillEditorError && editor && <div className='poiesis-customize-view__detail-error' role='alert'>{this.workspaceSkillEditorError}</div>}
                <div className='poiesis-customize-view__detail-body'>
                    {this.workspaceSkillEditorLoading ? (
                        <div className='poiesis-customize-view__detail-state' role='status'><span className='codicon codicon-loading codicon-modifier-spin' aria-hidden='true' />Skillを開いています…</div>
                    ) : !editor && this.workspaceSkillEditorError ? (
                        <div className='poiesis-customize-view__detail-state error' role='alert'>{this.workspaceSkillEditorError}</div>
                    ) : editor ? (
                        <div key={editor.uri} ref={this.setInlineEditorContainer} className='poiesis-customize-view__monaco' data-uri={editor.uri} aria-label={`${relativePath}を編集`} />
                    ) : undefined}
                </div>
            </section>
        );
    }

    protected renderWorkspaceSkillInfo(skill: WorkspaceSkillDefinition, editor: WorkspaceSkillEditor): React.ReactNode {
        const preview = this.workspaceSkillPreviews?.[skill.kind];
        const previewItem = preview?.perSkill.find(item => item.id === skill.id && item.source === skill.source);
        const characters = editor.content.length;
        const items: string[] = [`文書 ${characters.toLocaleString('ja-JP')}文字`];
        if (skill.kind === 'results') {
            items.push(`Results 確認項目 ${previewItem?.assertions ?? skill.assertions.length}件`);
        }
        if (skill.shadowedBy) {
            items.push('同じ名前のフォルダー用Skillが優先されています');
        } else if (previewItem?.reason === '合計上限により未注入') {
            items.push('全体の文字数上限を超えるためAIには渡されません');
        } else if (previewItem?.included) {
            items.push(isOnDemandAgentSkill(skill) ? '名前と説明をAIに渡し、依頼に合うときだけ本文を読み込みます。' : 'AIに渡されます');
        } else if (previewItem?.reason) {
            items.push(`${previewItem.reason}のためAIには渡されません`);
        } else {
            items.push('AIには渡されません');
        }
        if (!isOnDemandAgentSkill(skill) && previewItem?.included && previewItem.chars > (preview?.limits.perSkill ?? 8_000)) {
            items.push('AIへ渡す内容は8,000文字までです');
        }
        items.push(...skill.warnings);
        return <div className='poiesis-customize-view__info-strip'>{items.map((item, index) => <span key={`${index}:${item}`}>{item}</span>)}</div>;
    }

    protected renderDiscardConfirmation(): React.ReactNode {
        return (
            <div className='poiesis-customize-view__discard-confirm' role='group' aria-label='未保存の変更を破棄する確認'>
                <span>未保存の変更を破棄しますか？</span>
                <button type='button' disabled={this.workspaceSkillSaving} onClick={() => this.cancelWorkspaceSkillClose()}>編集を続ける</button>
                <button type='button' className='danger' disabled={this.workspaceSkillSaving} onClick={() => this.discardWorkspaceSkillChanges()}>破棄して閉じる</button>
            </div>
        );
    }

    protected renderGenerationDetails(): React.ReactNode {
        return (
            <details className='poiesis-customize-view__generation-details poiesis-agent-window__customize-card'>
                <PoiesisDisclosureSummary><span>生成の詳細</span><small>ResultsとAIへの反映</small></PoiesisDisclosureSummary>
                <div className='poiesis-customize-view__generation-content'>
                    <div className='poiesis-customize-view__generation-list'>
                        <article><strong>AI Results</strong><p>ResultsのAIが成果文書を生成します。実行できない場合はBundled Resultsに切り替わります。</p></article>
                        <article><strong>Bundled Results</strong><p>組み込みの形式で成果文書を生成します。選択するモードではなく、自動的に使われる処理です。</p></article>
                    </div>
                    {this.renderSkillPromptTransparency()}
                </div>
            </details>
        );
    }

    protected workspaceSkillInjectedCharacters(kind: SkillBundleKind): number {
        const preview = this.workspaceSkillPreviews?.[kind];
        return preview?.perSkill.reduce((total, skill) => skill.included ? total + Math.min(skill.chars, preview.limits.perSkill) : total, 0) ?? 0;
    }

    protected renderSkillPromptTransparency(): React.ReactNode {
        return (
            <div className='poiesis-customize-view__prompt-previews'>
                {(['agent', 'results'] as const).map(kind => {
                    const label = kind === 'agent' ? 'Agent' : 'Results';
                    const preview = this.workspaceSkillPreviews?.[kind];
                    const characters = this.workspaceSkillInjectedCharacters(kind);
                    return (
                        <details className='poiesis-customize-view__prompt-preview' key={kind}>
                            <PoiesisDisclosureSummary>
                                <span>{label}に渡す内容</span>
                                <span className='poiesis-customize-view__prompt-meter'>
                                    <small>{characters.toLocaleString('ja-JP')} / 24,000文字</small>
                                    <meter min={0} max={24_000} value={characters} aria-label={`${label}に渡す内容の文字数`} />
                                </span>
                            </PoiesisDisclosureSummary>
                            <div className='poiesis-customize-view__prompt-preview-content'>
                                <pre>{preview?.prompt.content || '有効なSkillはありません'}</pre>
                                {Boolean(preview?.prompt.diagnostics.length) && (
                                    <div className='poiesis-customize-view__prompt-diagnostics'>
                                        <strong>診断</strong>
                                        <ul>{preview?.prompt.diagnostics.map((diagnostic, index) => <li key={`${kind}-${index}`}>{diagnostic}</li>)}</ul>
                                    </div>
                                )}
                            </div>
                        </details>
                    );
                })}
            </div>
        );
    }

    protected skillMatchesScope(skill: WorkspaceSkillDefinition): boolean {
        if (this.customizeScope === 'all') {
            return true;
        }
        const workspaceScoped = skill.source === 'workspace' || skill.source === 'workspace-agents';
        return this.customizeScope === 'workspace' ? workspaceScoped : !workspaceScoped;
    }

    protected skillMatchesQuery(skill: WorkspaceSkillDefinition, query: string): boolean {
        return !query || [skill.name, skill.id, skill.description].some(value => value.toLocaleLowerCase('ja-JP').includes(query));
    }

    protected setCustomizeQuery(query: string): void {
        this.customizeQueries[this.customizeTab] = query;
        this.update();
    }

    protected setCustomizeScope(scope: CustomizeScope): void {
        this.customizeScope = scope;
        this.update();
    }

    protected setCustomizeTab(tab: CustomizeTab): void {
        this.customizeTab = tab;
        if (tab === 'hooks') { this.selectedHook = undefined; void this.refreshHooks(); }
        this.newSkillFormVisible = false;
        this.update();
    }

    protected handleCustomizeTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, tab: CustomizeTab): void {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
            return;
        }
        event.preventDefault();
        const tabs: CustomizeTab[] = ['skills', 'plugins', 'hooks'];
        const next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : 2)) % tabs.length];
        this.setCustomizeTab(next);
        requestAnimationFrame(() => this.node.querySelector<HTMLElement>(`#poiesis-customize-${next}-tab`)?.focus());
    }

    protected toggleGroupExpanded(groupId: string): void {
        if (this.expandedSkillGroups.has(groupId)) {
            this.expandedSkillGroups.delete(groupId);
        } else {
            this.expandedSkillGroups.add(groupId);
        }
        this.update();
    }

    protected domId(value: string): string {
        return value.replace(/[^a-zA-Z0-9_-]/g, '-');
    }

    protected workspaceSkillSourceLabel(source: WorkspaceSkillSource): string {
        return source === 'workspace' || source === 'workspace-agents' ? 'このフォルダー' : 'すべてのフォルダー';
    }

    protected workspaceSkillPath(source: WorkspaceSkillSource, id: string, entryName: string): string {
        switch (source) {
            case 'workspace': return `.poiesis/skills/${id}/${entryName}`;
            case 'workspace-agents': return `.agents/skills/${id}/${entryName}`;
            case 'user': return `~/.poiesis/skills/${id}/${entryName}`;
            case 'user-agents': return `~/.agents/skills/${id}/${entryName}`;
        }
    }

    protected captureCustomizeListScroll(): void {
        const listMount = this.customizeListMount;
        if (!listMount?.isConnected) {
            return;
        }
        const view = listMount.closest<HTMLElement>('.poiesis-customize-view');
        if (view) {
            this.customizeListScrollTop = view.scrollTop;
            this.customizeListScrollRestorePending = false;
        }
    }

    protected restoreCustomizeListScroll(): void {
        this.customizeListScrollRestorePending = true;
        this.applyCustomizeListScrollRestoration();
    }

    protected applyCustomizeListScrollRestoration(): void {
        if (!this.customizeListScrollRestorePending) {
            return;
        }
        const listMount = this.customizeListMount;
        if (!listMount?.isConnected) {
            return;
        }
        const view = listMount.closest<HTMLElement>('.poiesis-customize-view');
        if (!view) {
            return;
        }
        view.scrollTop = this.customizeListScrollTop;
        this.customizeListScrollRestorePending = false;
    }

    protected workspaceSkillEditorDirty(): boolean {
        const editor = this.workspaceSkillEditor;
        if (!editor) {
            return false;
        }
        const modelContent = this.inlineEditor?.getControl().getModel()?.getValue();
        if (modelContent !== undefined && modelContent !== editor.content) {
            editor.content = modelContent;
        }
        return editor.content !== editor.savedContent;
    }

    protected async ensureInlineEditor(): Promise<void> {
        const state = this.workspaceSkillEditor;
        const container = this.inlineEditorContainer;
        if (!state || !container || this.inlineEditorUri === state.uri || this.inlineEditor) {
            return;
        }
        if (this.inlineEditorCreationUri === state.uri && this.inlineEditorCreationContainer === container) {
            return;
        }
        const generation = ++this.inlineEditorGeneration;
        this.inlineEditorCreationUri = state.uri;
        this.inlineEditorCreationContainer = container;
        try {
            const editor = await this.host.monacoEditorProvider.createInline(new URI(state.uri), container, {
                ariaLabel: `${state.path}を編集`,
                automaticLayout: true,
                folding: false,
                fontFamily: POIESIS_FONT_MONO,
                fontSize: 14,
                lineDecorationsWidth: 8,
                lineHeight: 24,
                lineNumbers: 'on',
                lineNumbersMinChars: 3,
                minimap: { enabled: false },
                renderLineHighlight: 'none',
                scrollBeyondLastLine: false,
                scrollbar: {
                    horizontalScrollbarSize: 8,
                    useShadows: false,
                    verticalScrollbarSize: 8
                },
                wordWrap: 'on'
            });
            if (generation !== this.inlineEditorGeneration
                || this.workspaceSkillEditor?.uri !== state.uri
                || this.inlineEditorContainer !== container
                || !container.isConnected) {
                editor.dispose();
                return;
            }
            this.inlineEditor = editor;
            this.inlineEditorUri = state.uri;
            const control = editor.getControl();
            const modelContent = control.getModel()?.getValue();
            if (modelContent !== undefined) {
                state.content = modelContent;
                if (!editor.document.dirty) {
                    state.savedContent = modelContent;
                }
            }
            const listeners = new DisposableCollection();
            listeners.push(control.onDidChangeModelContent(() => {
                if (this.workspaceSkillEditor !== state || this.inlineEditor !== editor) {
                    return;
                }
                state.content = control.getModel()?.getValue() ?? '';
                if (!editor.document.dirty) {
                    state.savedContent = state.content;
                }
                this.workspaceSkillEditorError = undefined;
                this.workspaceSkillDiscardConfirmation = false;
                this.pendingEditorNavigation = undefined;
                this.update();
            }));
            listeners.push(editor.document.onDirtyChanged(() => {
                if (this.workspaceSkillEditor !== state || this.inlineEditor !== editor || editor.document.dirty) {
                    return;
                }
                const content = control.getModel()?.getValue() ?? state.content;
                state.content = content;
                state.savedContent = content;
                this.update();
            }));
            this.inlineEditorChangeListener = listeners;
            // Keep focus on the page, not the editor, so Esc returns to the list until the user clicks into the text.
            this.node.querySelector<HTMLElement>('.poiesis-customize-view__back')?.focus();
            this.update();
        } catch (error) {
            if (generation === this.inlineEditorGeneration && this.workspaceSkillEditor?.uri === state.uri) {
                this.workspaceSkillEditorError = `Skillエディターを作成できませんでした: ${error instanceof Error ? error.message : String(error)}`;
                this.update();
            }
        } finally {
            if (generation === this.inlineEditorGeneration
                && this.inlineEditorCreationUri === state.uri
                && this.inlineEditorCreationContainer === container) {
                this.inlineEditorCreationUri = undefined;
                this.inlineEditorCreationContainer = undefined;
            }
        }
    }

    protected disposeInlineEditor(): void {
        this.inlineEditorGeneration++;
        this.inlineEditorChangeListener?.dispose();
        this.inlineEditorChangeListener = undefined;
        this.inlineEditor?.dispose();
        this.inlineEditor = undefined;
        this.inlineEditorUri = undefined;
        this.inlineEditorCreationUri = undefined;
        this.inlineEditorCreationContainer = undefined;
    }

    public installWorkspaceSkillSaveShortcut(): void {
        const onKeyDown = (event: KeyboardEvent): void => {
            const savePressed = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
                && (event.key.toLocaleLowerCase() === 's' || event.code === 'KeyS');
            const editorFocused = event.target instanceof Element && Boolean(event.target.closest('.poiesis-customize-view__monaco'));
            if (!savePressed || !this.host.state.customizeViewVisible || !this.workspaceSkillEditor || !editorFocused) {
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            void this.saveWorkspaceSkill();
        };
        document.addEventListener('keydown', onKeyDown, true);
        this.host.addDisposable(Disposable.create(() => document.removeEventListener('keydown', onKeyDown, true)));
    }

    public openCustomize(): void {
        if (this.host.state.customizeViewVisible) {
            return;
        }
        this.customizeOpenedFromCode = this.host.state.codeMode;
        if (this.host.state.codeMode) {
            this.host.detachCodeWidgets();
            this.host.state.codeMode = false;
        }
        this.host.state.settingsModalVisible = false;
        this.host.state.shortcutsOverlayVisible = false;
        this.host.state.customizeViewVisible = true;
        this.update();
        void this.refreshWorkspaceSkills();
        void this.installWorkspaceSkillWatchers();
    }

    public closeCustomize(update = true): void {
        if (this.workspaceSkillEditorDirty()) {
            this.pendingEditorNavigation = 'close-customize';
            this.pendingExitAction = undefined;
            this.workspaceSkillDiscardConfirmation = true;
            this.update();
            return;
        }
        this.performCloseCustomize(update);
    }

    protected performCloseCustomize(update: boolean): void {
        const restoreCode = update && this.customizeOpenedFromCode;
        this.customizeOpenedFromCode = false;
        this.pendingExitAction = undefined;
        this.clearWorkspaceSkillDetail();
        this.host.state.customizeViewVisible = false;
        this.disposeWorkspaceSkillWatchers();
        if (restoreCode) {
            this.host.ensureCodeFileIcons();
            this.host.state.codeMode = true;
            requestAnimationFrame(() => void this.host.ensureCodeTerminal());
        }
        if (update) {
            this.update();
        }
    }

    public prepareCustomizeNavigation(onDiscard?: () => void | Promise<void>): boolean {
        if (this.workspaceSkillSaving) {
            return false;
        }
        if (this.workspaceSkillEditorDirty()) {
            this.pendingEditorNavigation = 'close-customize';
            this.pendingExitAction = onDiscard;
            this.workspaceSkillDiscardConfirmation = true;
            this.update();
            return false;
        }
        return true;
    }

    public handleCustomizeEscape(): void {
        if (this.workspaceSkillDiscardConfirmation) {
            this.cancelWorkspaceSkillClose();
        } else if (this.selectedWorkspaceSkill || this.workspaceSkillEditor || this.workspaceSkillEditorLoading) {
            this.requestReturnToSkillsList();
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
        this.newSkillScope = this.customizeScope === 'user' ? 'user' : 'workspace';
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

    protected async openWorkspaceSkillInline(skill: WorkspaceSkillDefinition): Promise<void> {
        if (this.workspaceSkillEditor?.uri === skill.uri) {
            return;
        }
        if (this.workspaceSkillEditorDirty()) {
            this.pendingEditorNavigation = 'list';
            this.workspaceSkillDiscardConfirmation = true;
            this.update();
            return;
        }
        this.captureCustomizeListScroll();
        this.clearWorkspaceSkillDetail();
        this.selectedWorkspaceSkill = skill;
        this.workspaceSkillEditorLoading = true;
        const generation = ++this.workspaceSkillOpenGeneration;
        this.update();
        try {
            const uri = new URI(skill.uri);
            const content = await this.fileService.read(uri);
            if (generation !== this.workspaceSkillOpenGeneration || this.selectedWorkspaceSkill?.uri !== skill.uri) {
                return;
            }
            this.workspaceSkillEditor = {
                uri: skill.uri,
                path: FileUri.fsPath(uri).replace(/\\/g, '/'),
                content: content.value,
                savedContent: content.value
            };
        } catch (error) {
            if (generation === this.workspaceSkillOpenGeneration) {
                this.workspaceSkillEditorError = `Skillファイルを開けませんでした: ${error instanceof Error ? error.message : String(error)}`;
            }
        } finally {
            if (generation === this.workspaceSkillOpenGeneration) {
                this.workspaceSkillEditorLoading = false;
                this.update();
                requestAnimationFrame(() => void this.ensureInlineEditor());
            }
        }
    }

    protected async saveWorkspaceSkill(): Promise<void> {
        const state = this.workspaceSkillEditor;
        if (!state || this.workspaceSkillSaving) {
            return;
        }
        const inlineEditor = this.inlineEditor;
        const model = inlineEditor?.getControl().getModel();
        const content = model?.getValue() ?? state.content;
        if (content === state.savedContent) {
            return;
        }
        state.content = content;
        this.workspaceSkillSaving = true;
        this.workspaceSkillEditorError = undefined;
        this.update();
        try {
            await this.fileService.write(new URI(state.uri), content);
            if (this.workspaceSkillEditor === state) {
                state.savedContent = content;
                const sameEditor = this.inlineEditor === inlineEditor
                    && inlineEditor?.getControl().getModel() === model;
                if (sameEditor && inlineEditor && model) {
                    const currentContent = model.getValue();
                    state.content = currentContent;
                    if (currentContent === content) {
                        await inlineEditor.document.revert({ soft: true });
                    }
                } else if (!this.inlineEditor) {
                    state.content = content;
                }
                this.workspaceSkillDiscardConfirmation = false;
                this.pendingEditorNavigation = undefined;
            }
            await this.refreshWorkspaceSkills();
        } catch (error) {
            if (this.workspaceSkillEditor === state) {
                this.workspaceSkillEditorError = `Skillファイルを保存できませんでした: ${error instanceof Error ? error.message : String(error)}`;
            }
        } finally {
            this.workspaceSkillSaving = false;
            this.update();
        }
    }

    protected requestReturnToSkillsList(): void {
        if (this.workspaceSkillEditorDirty()) {
            this.pendingEditorNavigation = 'list';
            this.pendingExitAction = undefined;
            this.workspaceSkillDiscardConfirmation = true;
            this.update();
            return;
        }
        this.clearWorkspaceSkillDetail();
        this.update();
        this.restoreCustomizeListScroll();
    }

    protected cancelWorkspaceSkillClose(): void {
        this.workspaceSkillDiscardConfirmation = false;
        this.pendingEditorNavigation = undefined;
        this.pendingExitAction = undefined;
        this.update();
        requestAnimationFrame(() => this.inlineEditor?.getControl().focus());
    }

    protected discardWorkspaceSkillChanges(): void {
        if (this.workspaceSkillSaving) {
            return;
        }
        const navigation = this.pendingEditorNavigation ?? 'list';
        const exitAction = this.pendingExitAction;
        this.resetInlineEditorToSavedContent();
        this.clearWorkspaceSkillDetail();
        if (navigation === 'close-customize') {
            this.performCloseCustomize(true);
            void exitAction?.();
        } else {
            this.pendingExitAction = undefined;
            this.update();
            this.restoreCustomizeListScroll();
        }
    }

    protected resetInlineEditorToSavedContent(): void {
        const state = this.workspaceSkillEditor;
        const editor = this.inlineEditor;
        if (!state || !editor || this.inlineEditorUri !== state.uri) {
            return;
        }
        const model = editor.getControl().getModel();
        if (!model) {
            return;
        }
        if (model.getValue() !== state.savedContent) {
            model.setValue(state.savedContent);
        }
        state.content = state.savedContent;
        void editor.document.revert({ soft: true });
    }

    protected clearWorkspaceSkillDetail(): void {
        this.workspaceSkillOpenGeneration++;
        this.pendingExitAction = undefined;
        this.disposeInlineEditor();
        this.selectedWorkspaceSkill = undefined;
        this.workspaceSkillEditor = undefined;
        this.workspaceSkillEditorLoading = false;
        this.workspaceSkillEditorError = undefined;
        this.workspaceSkillDiscardConfirmation = false;
        this.pendingEditorNavigation = undefined;
    }

    public scheduleWorkspaceSkillsRefresh(): void {
        if (this.workspaceSkillRefreshTimer !== undefined) {
            window.clearTimeout(this.workspaceSkillRefreshTimer);
        }
        this.workspaceSkillRefreshTimer = window.setTimeout(() => {
            this.workspaceSkillRefreshTimer = undefined;
            if (this.host.state.customizeViewVisible) {
                void this.refreshWorkspaceSkills();
            }
        }, 300);
    }

    protected async installWorkspaceSkillWatchers(): Promise<void> {
        const root = this.host.sessions.workspaceRoot()?.resource;
        if (!this.host.state.customizeViewVisible || !root) {
            return;
        }
        let discoveryRoots: WorkspaceSkillDiscoveryRoot[];
        try {
            discoveryRoots = await this.workspaceSkillService.getDiscoveryRoots(root);
        } catch {
            return;
        }
        if (!this.host.state.customizeViewVisible || this.host.sessions.workspaceRoot()?.resource.toString() !== root.toString()) {
            return;
        }
        this.workspaceSkillWatchers?.dispose();
        const watchers = new DisposableCollection();
        const watchRoots = discoveryRoots.map(discoveryRoot => discoveryRoot.uri);
        for (const watchRoot of watchRoots) {
            try {
                watchers.push(this.fileService.watch(watchRoot, { recursive: true, excludes: [] }));
            } catch {
                // Discovery still works for providers that do not support watching this root.
            }
        }
        this.workspaceSkillWatchers = watchers;
        this.host.state.workspaceSkillWatchRoots = watchRoots;
    }

    public disposeWorkspaceSkillWatchers(): void {
        if (this.workspaceSkillRefreshTimer !== undefined) {
            window.clearTimeout(this.workspaceSkillRefreshTimer);
            this.workspaceSkillRefreshTimer = undefined;
        }
        this.workspaceSkillWatchers?.dispose();
        this.workspaceSkillWatchers = undefined;
        this.host.state.workspaceSkillWatchRoots = [];
        this.disposeInlineEditor();
    }

    public async refreshWorkspaceSkills(): Promise<void> {
        const generation = ++this.workspaceSkillsRefreshGeneration;
        const root = this.host.sessions.workspaceRoot()?.resource;
        this.workspaceSkillsLoading = true;
        this.workspaceSkillsError = undefined;
        this.update();
        if (!root) {
            this.workspaceSkills = [];
            this.workspaceSkillPreviews = undefined;
            this.workspaceSkillsLoading = false;
            this.workspaceSkillsError = 'Skillsを表示するにはフォルダーを開いてください。';
            this.update();
            return;
        }
        void this.installWorkspaceSkillWatchers();
        try {
            const [definitions, agentPreview, resultsPreview] = await Promise.all([
                this.workspaceSkillService.list(root),
                this.workspaceSkillService.preview(root.toString(), 'agent'),
                this.workspaceSkillService.preview(root.toString(), 'results')
            ]);
            if (generation === this.workspaceSkillsRefreshGeneration) {
                this.workspaceSkills = definitions;
                if (this.selectedWorkspaceSkill) {
                    this.selectedWorkspaceSkill = definitions.find(skill => skill.uri === this.selectedWorkspaceSkill?.uri) ?? this.selectedWorkspaceSkill;
                }
                this.workspaceSkillPreviews = { agent: agentPreview, results: resultsPreview };
                await this.synchronizeWorkspaceSkillEditorFromDisk();
            }
        } catch (error) {
            if (generation === this.workspaceSkillsRefreshGeneration) {
                this.workspaceSkills = [];
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

    protected async synchronizeWorkspaceSkillEditorFromDisk(): Promise<void> {
        const state = this.workspaceSkillEditor;
        if (!state || this.workspaceSkillSaving) {
            return;
        }
        const inlineEditor = this.inlineEditor;
        const model = inlineEditor?.getControl().getModel();
        const savedContent = state.savedContent;
        try {
            const content = (await this.fileService.read(new URI(state.uri))).value;
            if (this.workspaceSkillEditor !== state
                || this.workspaceSkillSaving
                || this.inlineEditor !== inlineEditor
                || inlineEditor?.getControl().getModel() !== model
                || state.savedContent !== savedContent) {
                return;
            }
            const currentContent = model?.getValue() ?? state.content;
            if (currentContent !== savedContent) {
                state.content = currentContent;
                state.savedContent = content;
                if (inlineEditor && currentContent === content) {
                    await inlineEditor.document.revert({ soft: true });
                }
                return;
            }
            if (model && currentContent !== content) {
                model.setValue(content);
            }
            state.content = content;
            state.savedContent = content;
            if (inlineEditor) {
                await inlineEditor.document.revert({ soft: true });
            }
        } catch {
            // The next discovery pass reports missing or unreadable Skill files.
        }
    }

    protected async createWorkspaceSkill(): Promise<void> {
        if (this.newSkillCreating) {
            return;
        }
        const id = this.newSkillId.trim();
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
            this.newSkillError = '名前は小文字の英数字とハイフンで入力してください。';
            this.update();
            return;
        }
        const root = this.host.sessions.workspaceRoot()?.resource;
        if (!root) {
            this.newSkillError = 'Skillを作成するにはフォルダーを開いてください。';
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
            await this.openWorkspaceSkillInline(this.workspaceSkillService.parse(id, skillUri, content, true, targetRoot.source, targetRoot.rank));
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
        if (this.workspaceSkillEditorDirty()) {
            return;
        }
        this.closeCustomize(false);
        try {
            await this.host.openCodeFile(rawUri);
        } catch (error) {
            this.host.state.customizeViewVisible = true;
            this.workspaceSkillEditorError = `SkillファイルをCodeで開けませんでした: ${error instanceof Error ? error.message : String(error)}`;
            this.update();
        }
    }

    constructor(host: AgentWindowHost) {
        super(host);
    }
}
