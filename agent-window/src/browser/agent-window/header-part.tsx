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

export class HeaderPart extends AgentWindowPart {
    public renderHeader(): React.ReactNode {
        if (this.host.state.codeMode) {
            return (
                <header className='poiesis-agent-window__header poiesis-agent-window__code-header'>
                    <div className='poiesis-agent-window__window-drag-surface' aria-hidden='true' />
                    <button
                        type='button'
                        className='poiesis-agent-window__code-control active'
                        aria-pressed='true'
                        aria-label='Agentへ戻る'
                        onClick={() => this.host.toggleCodeMode()}
                    >
                        <span className='codicon codicon-code' aria-hidden='true' />
                        <span>Code</span>
                    </button>
                    <span className='poiesis-agent-window__code-workspace'>{this.host.sessions.workspaceContextLabel()}</span>
                </header>
            );
        }
        if (this.host.state.customizeViewVisible) {
            return (
                <header className='poiesis-agent-window__header poiesis-agent-window__customize-header'>
                    <div className='poiesis-agent-window__window-drag-surface' aria-hidden='true' />
                    <div className='poiesis-agent-window__context'>
                        <div className='poiesis-agent-window__context-scope'>
                            <small>{this.host.sessions.workspaceContextLabel()}</small>
                            <button type='button' className='poiesis-agent-window__code-control' onClick={() => this.host.toggleCodeMode()}>
                                <span className='codicon codicon-code' aria-hidden='true' />
                                <span>Code</span>
                            </button>
                        </div>
                        <strong>カスタマイズ</strong>
                    </div>
                    <div className='poiesis-agent-window__customize-header-actions'>
                        <button
                            type='button'
                            className='poiesis-agent-window__customize-close'
                            aria-label='カスタマイズを閉じる'
                            onClick={() => this.host.closeCustomize()}
                        >
                            <span className='codicon codicon-close' aria-hidden='true' />
                        </button>
                    </div>
                </header>
            );
        }
        const session = this.host.sessions.selectedSession();
        const activeTab = session?.activeTab ?? 'agent';
        return (
            <header className='poiesis-agent-window__header'>
                <div className='poiesis-agent-window__window-drag-surface' aria-hidden='true' />
                <div className='poiesis-agent-window__context'>
                    <div className='poiesis-agent-window__context-scope'>
                        <small>{this.host.sessions.workspaceContextLabel()}</small>
                        <button
                            type='button'
                            className={`poiesis-agent-window__code-control${this.host.state.codeMode ? ' active' : ''}`}
                            aria-pressed={this.host.state.codeMode}
                            onClick={() => this.host.toggleCodeMode()}
                        >
                            <span className='codicon codicon-code' aria-hidden='true' />
                            <span>Code</span>
                        </button>
                    </div>
                    <strong>{this.host.state.codeMode ? 'Code' : session?.hasUserMessage ? session.title : '新しいチャット'}</strong>
                </div>
                {!this.host.state.codeMode && session?.hasUserMessage && (
                    <nav className='poiesis-agent-window__tabs' role='tablist' aria-label='Agent と Results の切り替え'>
                        <button
                            id='poiesis-agent-tab'
                            type='button'
                            role='tab'
                            className={activeTab === 'agent' ? 'active' : ''}
                            aria-selected={activeTab === 'agent'}
                            aria-controls='poiesis-agent-panel'
                            tabIndex={activeTab === 'agent' ? 0 : -1}
                            onClick={() => this.host.selectTab('agent')}
                        >
                            Agent
                        </button>
                        <button
                            id='poiesis-results-tab'
                            type='button'
                            role='tab'
                            className={activeTab === 'results' ? 'active' : ''}
                            aria-selected={activeTab === 'results'}
                            aria-controls='poiesis-results-panel'
                            tabIndex={activeTab === 'results' ? 0 : -1}
                            onClick={() => this.host.selectTab('results')}
                        >
                            Results
                        </button>
                    </nav>
                )}
            </header>
        );
    }

    constructor(host: AgentWindowHost) {
        super(host);
    }
}
