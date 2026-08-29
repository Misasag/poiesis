import * as React from '@theia/core/shared/react';
import * as ReactDOM from '@theia/core/shared/react-dom';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { FormatType, open, OpenerService, Saveable, SaveableService, SaveReason, StorageService, WidgetManager } from '@theia/core/lib/browser';
import { IconThemeService } from '@theia/core/lib/browser/icon-theme-service';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { CommandService, Disposable, MessageService } from '@theia/core/lib/common';
import { FileUri } from '@theia/core/lib/common/file-uri';
import URI from '@theia/core/lib/common/uri';
import { Message, MessageLoop } from '@theia/core/shared/@lumino/messaging';
import { Widget } from '@theia/core/shared/@lumino/widgets';
import { EditorManager, EditorWidget } from '@theia/editor/lib/browser';
import { ScmHistoryProvider, ScmProvider } from '@theia/scm/lib/browser/scm-provider';
import { ScmService } from '@theia/scm/lib/browser/scm-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { TerminalWidget } from '@theia/terminal/lib/browser/base/terminal-widget';
import { FileNavigatorCommands } from '@theia/navigator/lib/browser/navigator-contribution';
import { SearchInWorkspaceCommands } from '@theia/search-in-workspace/lib/browser/search-in-workspace-frontend-contribution';
import { BUILTIN_QUERY, VSXExtensionsSearchModel } from '@theia/vsx-registry/lib/browser/vsx-extensions-search-model';
import { AgentEvent, AgentProvider, AgentSession } from '../common/agent-provider';
import {
    AgentRuntimeServer,
    AiRole,
    CliDetectionReport,
    DEFAULT_CLI_ID,
    FolderBrowserResult,
    isKnownCliId,
    KnownCliId
} from '../common/agent-runtime-protocol';
import { ResultsService } from './results-skill';
import {
    ExecutionTask,
    formatTaskEndedAtJst,
    summarizeTaskChangeSet,
    TaskResultDocument,
    TaskResultsQuestion,
    TaskService,
    taskTitleForRequest
} from './task-service';
import { getDesignVariant } from './design-variant';
import { FolderExplorerService } from './folder-explorer-service';
import { ResultsQuestionService } from './results-question-service';
import { GlobalStorageService } from './global-storage-service';
import { ResultsGenerationContext } from './results-generation-context';
import { SkillBundleKind } from '../common/skill-bundle';
import {
    collectWorkspaceRichContentReferences,
    POIESIS_EXTERNAL_LINK_ATTRIBUTE,
    POIESIS_FILE_LINK_ATTRIBUTE,
    POIESIS_INLINE_IMAGE_ATTRIBUTE,
    renderSafeMarkdown
} from './safe-markdown';
import { WorkspaceSkillDefinition, WorkspaceSkillService } from './workspace-skill-service';
import { formatTaskElapsedTime, shouldSubmitComposer } from './composer-behavior';

type AgentWindowTab = 'agent' | 'results';
type CodeSidebarTab = 'files' | 'search' | 'git' | 'extensions';
type UiFontScale = 'small' | 'standard' | 'large';
const NEW_SESSION_TITLE = '新しい会話';
const SESSION_STORAGE_KEY = 'poiesis.agent-window.sessions.v1';
const GLOBAL_SESSION_STORAGE_KEY = 'poiesis.agent-window.sessions.global.v1';
const SESSION_MIGRATION_MARKER_KEY = 'poiesis.agent-window.sessions.migrated.v1';
const SETTINGS_STORAGE_KEY = 'poiesis.settings.v1';
const RESULTS_QA_PANEL_STORAGE_KEY = 'poiesis.results-qa-panel.sessions.v1';
const DEFAULT_RAIL_WIDTH = 258;
const MIN_RAIL_WIDTH = 196;
const MAX_RAIL_WIDTH = 420;
const DEFAULT_CODE_SIDEBAR_WIDTH = 260;
const MIN_CODE_SIDEBAR_WIDTH = 180;
const MAX_CODE_SIDEBAR_WIDTH = 520;
const DEFAULT_CODE_PANEL_HEIGHT = 190;
const MIN_CODE_PANEL_HEIGHT = 96;
const MAX_PERSISTED_TASKS_PER_SESSION = 10;
const MAX_PERSISTED_RESULTS_HTML_CHARS = 300_000;
interface ChatMessage {
    id: string;
    role: 'user' | 'agent';
    content: string;
    complete: boolean;
    taskId?: string;
    error?: boolean;
    errorDetails?: string;
}

interface AgentHtmlPreview {
    uri: string;
    fileName: string;
    html: string;
    revision: number;
}

interface AgentRichContentState {
    signature: string;
    workspaceUri: string;
    imageSources: Map<string, string>;
    htmlPreviews: AgentHtmlPreview[];
}

interface ResultsNotice {
    question: string;
    status: 'sending' | 'answered' | 'failed';
    text: string;
    historyTimestamp?: string;
}

interface ResultsFrameMessage {
    type: 'poiesis:open-citation' | 'poiesis:retry-ai-results';
    citation?: string;
}

interface WindowAgentSession {
    id: string;
    createdAt: number;
    updatedAt: number;
    workspaceUri?: string;
    branch?: string;
    runTarget: 'local';
    agentSession?: AgentSession;
    title: string;
    hasUserMessage: boolean;
    lastTaskStatus?: 'completed' | 'failed' | 'cancelled';
    unreadTaskCompletion?: boolean;
    pinned: boolean;
    archived: boolean;
    activeTab: AgentWindowTab;
    agentDraft: string;
    messages: ChatMessage[];
    taskIds: string[];
    selectedResultsTaskId?: string;
    readonly resultsDrafts: Map<string, string>;
    readonly resultsNotices: Map<string, ResultsNotice>;
    readonly resultsQaExpanded: Map<string, boolean>;
}

interface PersistedAgentWindowState {
    version: 1;
    selectedSessionId?: string;
    railWidth: number;
    railCollapsed: boolean;
    sessions: Array<Omit<WindowAgentSession, 'agentSession' | 'taskIds' | 'resultsDrafts' | 'resultsNotices' | 'resultsQaExpanded'> & {
        resultsDrafts: Array<[string, string]>;
        tasks?: ExecutionTask[];
        resultsDocuments?: TaskResultDocument[];
    }>;
}

interface PersistedResultsQaPanelState {
    version: 1;
    taskRailCollapsed?: boolean;
    sessions: Record<string, {
        selectedTaskId?: string;
        expandedTaskIds: string[];
    }>;
}

interface PersistedPoiesisSettings {
    version: 3;
    uiFontScale: UiFontScale;
    agentCli: KnownCliId;
    agentModel: string;
    resultsCli: KnownCliId;
    resultsModel: string;
    allowExternalResultsResources: boolean;
}

interface LegacyPoiesisSettings {
    version?: 1 | 2;
    uiFontScale?: UiFontScale;
    preferredCli?: KnownCliId;
    agentCli?: KnownCliId;
    resultsCli?: KnownCliId;
    allowExternalResultsResources?: boolean;
}

interface PickerAnchor {
    left: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
}

interface WorkspaceSessionGroup {
    key: string;
    workspaceUri?: string;
    name: string;
    branch: string;
    current: boolean;
    activeSessions: WindowAgentSession[];
    archivedSessions: WindowAgentSession[];
}

interface WorkspaceSkillEditor {
    uri: string;
    path: string;
    content: string;
    savedContent: string;
}

interface PoiesisSelectOption {
    value: string;
    label: string;
    triggerLabel?: string;
    group?: string;
    disabled?: boolean;
    keepOpen?: boolean;
}

interface PoiesisSelectProps {
    value: string;
    options: PoiesisSelectOption[];
    ariaLabel: string;
    onChange: (value: string) => void;
    className?: string;
    disabled?: boolean;
    popoverClassName?: string;
    popoverFooter?: React.ReactNode;
    popoverMinWidth?: number;
    leadingIconClass?: string;
}

interface PoiesisSelectPosition {
    left: number;
    width: number;
    maxHeight: number;
    top?: number;
    bottom?: number;
}

/** A select-only ARIA combobox whose listbox is portaled so modal and panel overflow cannot clip it. */
const PoiesisSelect = ({
    value,
    options,
    ariaLabel,
    onChange,
    className = '',
    disabled = false,
    popoverClassName = '',
    popoverFooter,
    popoverMinWidth = 180,
    leadingIconClass
}: PoiesisSelectProps): React.ReactElement => {
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const popoverRef = React.useRef<HTMLDivElement>(null);
    const listboxId = `poiesis-select-${React.useId().replace(/:/g, '')}`;
    const selectedIndex = Math.max(0, options.findIndex(option => option.value === value));
    const [open, setOpen] = React.useState(false);
    const [activeIndex, setActiveIndex] = React.useState(selectedIndex);
    const [position, setPosition] = React.useState<PoiesisSelectPosition>();
    const selectedOption = options[selectedIndex];

    const enabledIndex = React.useCallback((start: number, direction: 1 | -1): number => {
        if (!options.length) {
            return -1;
        }
        let index = start;
        for (let count = 0; count < options.length; count++) {
            index = (index + direction + options.length) % options.length;
            if (!options[index].disabled) {
                return index;
            }
        }
        return -1;
    }, [options]);

    const updatePosition = React.useCallback((): void => {
        const trigger = triggerRef.current;
        if (!trigger) {
            return;
        }
        const rect = trigger.getBoundingClientRect();
        const margin = 8;
        const gap = 4;
        const width = Math.min(Math.max(rect.width, popoverMinWidth), window.innerWidth - margin * 2);
        const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin);
        const availableBelow = window.innerHeight - rect.bottom - gap - margin;
        const availableAbove = rect.top - gap - margin;
        const flipAbove = availableBelow < 160 && availableAbove > availableBelow;
        const maxHeight = Math.max(72, Math.min(280, flipAbove ? availableAbove : availableBelow));
        const nextPosition: PoiesisSelectPosition = flipAbove
            ? { left, width, maxHeight, bottom: Math.max(margin, window.innerHeight - rect.top + gap) }
            : { left, width, maxHeight, top: rect.bottom + gap };
        setPosition(current => current
            && Math.abs(current.left - nextPosition.left) < 0.5
            && Math.abs(current.width - nextPosition.width) < 0.5
            && Math.abs(current.maxHeight - nextPosition.maxHeight) < 0.5
            && Math.abs((current.top ?? -1) - (nextPosition.top ?? -1)) < 0.5
            && Math.abs((current.bottom ?? -1) - (nextPosition.bottom ?? -1)) < 0.5
            ? current
            : nextPosition);
    }, [popoverMinWidth]);

    const close = React.useCallback((restoreFocus = true): void => {
        setOpen(false);
        if (restoreFocus) {
            requestAnimationFrame(() => triggerRef.current?.focus());
        }
    }, []);

    const openList = React.useCallback((direction?: 1 | -1): void => {
        if (disabled || !options.length) {
            return;
        }
        const initial = options[selectedIndex]?.disabled
            ? enabledIndex(selectedIndex, direction ?? 1)
            : selectedIndex;
        setActiveIndex(initial);
        updatePosition();
        setOpen(true);
    }, [disabled, enabledIndex, options, selectedIndex, updatePosition]);

    React.useEffect(() => {
        if (!open) {
            return undefined;
        }
        const reposition = (): void => updatePosition();
        let trackingFrame = requestAnimationFrame(function trackAnchor(): void {
            updatePosition();
            trackingFrame = requestAnimationFrame(trackAnchor);
        });
        const closeOutside = (event: PointerEvent): void => {
            const target = event.target as Node | null;
            if (target && !triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
                close();
            }
        };
        window.addEventListener('resize', reposition);
        window.addEventListener('scroll', reposition, true);
        document.addEventListener('pointerdown', closeOutside, true);
        const closeOnEscape = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close();
            }
        };
        document.addEventListener('keydown', closeOnEscape, true);
        return () => {
            window.removeEventListener('resize', reposition);
            window.removeEventListener('scroll', reposition, true);
            document.removeEventListener('pointerdown', closeOutside, true);
            document.removeEventListener('keydown', closeOnEscape, true);
            cancelAnimationFrame(trackingFrame);
        };
    }, [close, open, updatePosition]);

    React.useEffect(() => {
        if (open) {
            setActiveIndex(selectedIndex);
        }
    }, [open, selectedIndex]);

    const choose = (index: number): void => {
        const option = options[index];
        if (!option || option.disabled) {
            return;
        }
        if (option.value !== value) {
            onChange(option.value);
        }
        if (!option.keepOpen) {
            close();
        }
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
        if (!open) {
            if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                openList(event.key === 'ArrowUp' ? -1 : 1);
            }
            return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const next = enabledIndex(activeIndex, event.key === 'ArrowDown' ? 1 : -1);
            if (next >= 0) {
                setActiveIndex(next);
            }
        } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            choose(activeIndex);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
        } else if (event.key === 'Tab' && !popoverFooter) {
            close(false);
        }
    };

    const rootClass = `poiesis-select${className ? ` ${className}` : ''}`;
    return (
        <div className={rootClass} data-value={value} data-option-count={options.length}>
            <button
                ref={triggerRef}
                type='button'
                className='poiesis-select__trigger'
                data-value={value}
                role='combobox'
                aria-label={ariaLabel}
                aria-haspopup='listbox'
                aria-controls={listboxId}
                aria-expanded={open}
                aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
                disabled={disabled}
                onClick={() => open ? close(false) : openList()}
                onKeyDown={handleKeyDown}
            >
                {leadingIconClass && <span className={`codicon ${leadingIconClass}`} aria-hidden='true' />}
                <span className='poiesis-select__trigger-label'>{selectedOption?.triggerLabel ?? selectedOption?.label ?? value}</span>
                <span className={`codicon codicon-chevron-${open ? 'up' : 'down'}`} aria-hidden='true' />
            </button>
            {open && position && ReactDOM.createPortal(
                <div
                    ref={popoverRef}
                    id={listboxId}
                    className={`poiesis-select__listbox${popoverClassName ? ` ${popoverClassName}` : ''}`}
                    role='listbox'
                    aria-label={ariaLabel}
                    style={position}
                >
                    {options.map((option, index) => (
                        <React.Fragment key={option.value}>
                            {option.group && option.group !== options[index - 1]?.group && (
                                <div className='poiesis-select__group' role='presentation'>{option.group}</div>
                            )}
                            <div
                                id={`${listboxId}-option-${index}`}
                                className={`poiesis-select__option${index === activeIndex ? ' active' : ''}${option.disabled ? ' disabled' : ''}`}
                                data-value={option.value}
                                role='option'
                                aria-selected={option.value === value}
                                aria-disabled={option.disabled || undefined}
                                onMouseEnter={() => !option.disabled && setActiveIndex(index)}
                                onMouseDown={event => event.preventDefault()}
                                onClick={() => choose(index)}
                            >
                                <span>{option.label}</span>
                                {option.value === value && <span className='codicon codicon-check' aria-hidden='true' />}
                            </div>
                        </React.Fragment>
                    ))}
                    {popoverFooter && <div className='poiesis-select__footer' role='presentation'>{popoverFooter}</div>}
                </div>,
                document.body
            )}
        </div>
    );
};

interface PoiesisImeValueProps<T extends HTMLInputElement | HTMLTextAreaElement> {
    value: string;
    onValueChange: (value: string) => void;
    elementRef?: (element: T | null) => void;
}

type PoiesisImeInputProps = PoiesisImeValueProps<HTMLInputElement> & Omit<React.InputHTMLAttributes<HTMLInputElement>,
'value' | 'defaultValue' | 'onChange' | 'onInput' | 'onCompositionStart' | 'onCompositionEnd'>;
type PoiesisImeTextareaProps = PoiesisImeValueProps<HTMLTextAreaElement> & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>,
'value' | 'defaultValue' | 'onChange' | 'onInput' | 'onCompositionStart' | 'onCompositionEnd'>;
type PoiesisComposerProps = PoiesisImeValueProps<HTMLTextAreaElement>
    & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    'value' | 'defaultValue' | 'onChange' | 'onInput' | 'onCompositionStart' | 'onCompositionEnd' | 'onSubmit'>
    & { onSubmit: () => void };

/**
 * Keeps the DOM's in-progress IME composition out of React's value reconciliation.
 * Outside composition, `value` remains the canonical application state and external
 * changes are copied back into the DOM without making the control React-controlled.
 */
const useImeSafeValue = <T extends HTMLInputElement | HTMLTextAreaElement>(
    value: string,
    onValueChange: (value: string) => void,
    elementRef?: (element: T | null) => void
): {
    ref: (element: T | null) => void;
    onInput: (event: React.FormEvent<T>) => void;
    onCompositionStart: () => void;
    onCompositionEnd: (event: React.CompositionEvent<T>) => void;
} => {
    const input = React.useRef<T | null>(null);
    const composing = React.useRef(false);
    const lastReportedValue = React.useRef(value);
    React.useLayoutEffect(() => {
        const element = input.current;
        if (!composing.current && element && element.value !== value) {
            element.value = value;
        }
        if (!composing.current) {
            lastReportedValue.current = value;
        }
    }, [value]);
    const report = (nextValue: string): void => {
        if (nextValue !== lastReportedValue.current) {
            lastReportedValue.current = nextValue;
            onValueChange(nextValue);
        }
    };
    return {
        ref: element => {
            input.current = element;
            elementRef?.(element);
        },
        onInput: event => {
            const nativeEvent = event.nativeEvent as InputEvent;
            if (!composing.current && !nativeEvent.isComposing) {
                report(event.currentTarget.value);
            }
        },
        onCompositionStart: () => {
            composing.current = true;
        },
        onCompositionEnd: event => {
            composing.current = false;
            report(event.currentTarget.value);
        }
    };
};

const PoiesisTextInput = ({ value, onValueChange, elementRef, ...props }: PoiesisImeInputProps): React.ReactElement => {
    const ime = useImeSafeValue<HTMLInputElement>(value, onValueChange, elementRef);
    return <input {...props} {...ime} defaultValue={value} />;
};

const PoiesisTextArea = ({ value, onValueChange, elementRef, ...props }: PoiesisImeTextareaProps): React.ReactElement => {
    const ime = useImeSafeValue<HTMLTextAreaElement>(value, onValueChange, elementRef);
    return <textarea {...props} {...ime} defaultValue={value} />;
};

const PoiesisComposer = ({
    value,
    onValueChange,
    elementRef,
    onSubmit,
    onKeyDown,
    ...props
}: PoiesisComposerProps): React.ReactElement => {
    const ime = useImeSafeValue<HTMLTextAreaElement>(value, onValueChange, elementRef);
    return (
        <textarea
            {...props}
            {...ime}
            defaultValue={value}
            onKeyDown={event => {
                onKeyDown?.(event);
                if (event.defaultPrevented) {
                    return;
                }
                const nativeEvent = event.nativeEvent as KeyboardEvent;
                if (shouldSubmitComposer({
                    key: event.key,
                    shiftKey: event.shiftKey,
                    isComposing: nativeEvent.isComposing,
                    keyCode: nativeEvent.keyCode
                }, event.currentTarget.value)) {
                    event.preventDefault();
                    onSubmit();
                }
            }}
        />
    );
};

const PoiesisTaskElapsed = ({ startedAt }: { startedAt: string }): React.ReactElement => {
    const [now, setNow] = React.useState(Date.now());
    React.useEffect(() => {
        setNow(Date.now());
        const interval = window.setInterval(() => setNow(Date.now()), 1_000);
        return () => window.clearInterval(interval);
    }, [startedAt]);
    return (
        <span role='timer' aria-live='off' aria-atomic='true'>
            作業中 · {formatTaskElapsedTime(startedAt, now)}
        </span>
    );
};

@injectable()
export class AgentWindowWidget extends ReactWidget {
    static readonly ID = 'poiesis-agent-window';
    static readonly FILES_WIDGET_FACTORY_ID = 'files';
    static readonly SEARCH_WIDGET_FACTORY_ID = 'search-in-workspace';
    static readonly GIT_WIDGET_FACTORY_ID = 'scm-view';
    static readonly GIT_GRAPH_WIDGET_FACTORY_ID = 'scm-history-graph-widget';
    static readonly EDITOR_WIDGET_FACTORY_ID = 'code-editor-opener';
    static readonly SETTINGS_WIDGET_FACTORY_ID = 'settings_widget';
    static readonly EXTENSIONS_WIDGET_FACTORY_ID = 'vsx-extensions-view-container';
    protected codeMode = false;
    protected settingsModalVisible = false;
    protected customizeViewVisible = false;
    protected shortcutsOverlayVisible = false;
    protected workspaceSkills: WorkspaceSkillDefinition[] = [];
    protected workspaceSkillsLoading = false;
    protected workspaceSkillsError?: string;
    protected workspaceSkillsRefreshGeneration = 0;
    protected newSkillFormVisible = false;
    protected newSkillId = '';
    protected newSkillKind: SkillBundleKind = 'agent';
    protected newSkillError?: string;
    protected newSkillCreating = false;
    protected selectedBuiltinSkill?: 'bundled-results' | 'ai-results';
    protected workspaceSkillEditor?: WorkspaceSkillEditor;
    protected workspaceSkillEditorLoading = false;
    protected workspaceSkillEditorError?: string;
    protected workspaceSkillDiscardConfirmation = false;
    protected workspaceSkillSaving = false;
    protected uiFontScale: UiFontScale = 'standard';
    protected agentCli: KnownCliId = DEFAULT_CLI_ID;
    protected agentModel = '';
    protected resultsCli: KnownCliId = DEFAULT_CLI_ID;
    protected resultsModel = '';
    protected readonly customModelRoles = new Set<AiRole>();
    protected allowExternalResultsResources = false;
    protected cliDetectionReport?: CliDetectionReport;
    protected cliDetectionLoading = false;
    protected deleteSessionConfirmationId?: string;
    protected deleteTaskConfirmationId?: string;
    protected clearDataConfirmation = false;
    protected codeSidebarTab: CodeSidebarTab = 'files';
    protected codeFilesWidget?: Widget;
    protected codeSearchWidget?: Widget;
    protected codeGitWidget?: Widget;
    protected codeGitGraphWidget?: Widget;
    protected codeGitGraphExpanded = true;
    protected codeExtensionsWidget?: Widget;
    protected codeExtensionsInitialized = false;
    protected codeTerminalWidget?: TerminalWidget;
    protected readonly codeTerminalWidgets: TerminalWidget[] = [];
    protected readonly codeTerminalWidgetListeners = new Map<TerminalWidget, Disposable>();
    protected codeTerminalCreation?: Promise<TerminalWidget>;
    protected readonly codeCenterWidgets: Widget[] = [];
    protected readonly codeCenterWidgetListeners = new Map<Widget, Disposable>();
    protected readonly pendingDuplicateCodeWidgets = new WeakSet<Widget>();
    protected readonly pendingPinnedEditorUris = new Set<string>();
    protected activeCodeCenterWidget?: Widget;
    protected previewCodeCenterWidget?: Widget;
    protected pendingCodeCenterClose?: Widget;
    protected pendingCodeCenterCloseBusy = false;
    protected codeSidebarHost?: HTMLDivElement;
    protected codeGitGraphHost?: HTMLDivElement;
    protected codeEditorHost?: HTMLDivElement;
    protected codeTerminalHost?: HTMLDivElement;
    protected codeSidebarResizeObserver?: ResizeObserver;
    protected codeGitGraphResizeObserver?: ResizeObserver;
    protected codeEditorResizeObserver?: ResizeObserver;
    protected codeTerminalResizeObserver?: ResizeObserver;
    protected codeWidgetAttachmentFrame?: number;
    protected codeSidebarWidth = DEFAULT_CODE_SIDEBAR_WIDTH;
    protected codeSidebarResizeCleanup?: Disposable;
    protected codePanelVisible = true;
    protected codePanelHeight = DEFAULT_CODE_PANEL_HEIGHT;
    protected codePanelResizeCleanup?: Disposable;
    protected codeSidebarTreeInteractionCleanup?: Disposable;
    protected codeFilePointerDrag?: {
        pointerId: number;
        uri: string;
        startX: number;
        startY: number;
        active: boolean;
        sourceNode: HTMLElement;
    };
    protected suppressNextCodeFileClick = false;
    protected explorerMoreVisible = false;
    protected readonly sessions: WindowAgentSession[] = [];
    protected sessionsInitialized = false;
    protected sessionsInitialization: Promise<void> = Promise.resolve();
    protected windowStatePersistence: Promise<void> = Promise.resolve();
    protected resultsQaPanelStatePersistence: Promise<void> = Promise.resolve();
    protected resultsTaskRailCollapsed = false;
    protected legacyErrorMessagesMigrated = false;
    protected readonly providerPreparationErrors = new Map<string, string>();
    protected readonly agentRichContent = new Map<string, AgentRichContentState>();
    protected readonly agentRichContentPending = new Map<string, string>();
    protected readonly agentHtmlPreviewExpanded = new Map<string, boolean>();
    protected selectedSessionId?: string;
    protected sessionSequence = 0;
    protected railCollapsed = false;
    protected railWidth = DEFAULT_RAIL_WIDTH;
    protected openSessionMenuId?: string;
    protected renamingSessionId?: string;
    protected renameDraft = '';
    protected showArchivedSessions = false;
    protected sessionSearchVisible = false;
    protected sessionSearchQuery = '';
    protected readonly expandedWorkspaceGroups = new Set<string>();
    protected sessionSearchInput?: HTMLInputElement;
    protected agentComposerInput?: HTMLTextAreaElement;
    protected workspacePickerVisible = false;
    protected workspacePickerAnchor?: PickerAnchor;
    protected workspaceSearchQuery = '';
    protected workspaceSearchInput?: HTMLInputElement;
    protected recentWorkspaceUris: string[] = [];
    protected repositoryPickerVisible = false;
    protected repositoryPickerAnchor?: PickerAnchor;
    protected repositorySearchQuery = '';
    protected repositorySearchInput?: HTMLInputElement;
    protected folderExplorerVisible = false;
    protected folderExplorerSessionId?: string;
    protected folderExplorerResult?: FolderBrowserResult;
    protected folderExplorerLoading = false;
    protected folderExplorerError?: string;
    protected folderExplorerAddress = '';
    protected creatingFolder = false;
    protected newFolderName = '';
    protected railResizeCleanup?: Disposable;
    protected readonly watchedScmProviders = new WeakSet<ScmProvider>();
    protected readonly watchedScmHistoryProviders = new WeakSet<ScmHistoryProvider>();

    constructor(
        @inject(AgentProvider) protected readonly agentProvider: AgentProvider,
        @inject(TaskService) protected readonly taskService: TaskService,
        @inject(ResultsService) protected readonly resultsService: ResultsService,
        @inject(WorkspaceService) protected readonly workspaceService: WorkspaceService,
        @inject(ScmService) protected readonly scmService: ScmService,
        @inject(TerminalService) protected readonly terminalService: TerminalService,
        @inject(WidgetManager) protected readonly widgetManager: WidgetManager,
        @inject(EditorManager) protected readonly editorManager: EditorManager,
        @inject(OpenerService) protected readonly openerService: OpenerService,
        @inject(FileService) protected readonly fileService: FileService,
        @inject(CommandService) protected readonly commandService: CommandService,
        @inject(SaveableService) protected readonly saveableService: SaveableService,
        @inject(IconThemeService) protected readonly iconThemeService: IconThemeService,
        @inject(VSXExtensionsSearchModel) protected readonly extensionsSearchModel: VSXExtensionsSearchModel,
        @inject(StorageService) protected readonly storageService: StorageService,
        @inject(GlobalStorageService) protected readonly globalStorageService: GlobalStorageService,
        @inject(FolderExplorerService) protected readonly folderExplorerService: FolderExplorerService,
        @inject(AgentRuntimeServer) protected readonly agentRuntimeServer: AgentRuntimeServer,
        @inject(ResultsQuestionService) protected readonly resultsQuestionService: ResultsQuestionService,
        @inject(ResultsGenerationContext) protected readonly resultsGenerationContext: ResultsGenerationContext,
        @inject(WorkspaceSkillService) protected readonly workspaceSkillService: WorkspaceSkillService,
        @inject(MessageService) protected readonly messageService: MessageService
    ) {
        super();
    }

    @postConstruct()
    protected init(): void {
        getDesignVariant();
        this.id = AgentWindowWidget.ID;
        this.addClass('poiesis-agent-window');
        this.toDispose.push(Disposable.create(() => {
            for (const content of this.agentRichContent.values()) {
                this.revokeAgentImageSources(content.imageSources);
            }
            this.agentRichContent.clear();
            this.agentRichContentPending.clear();
        }));

        const closeSessionMenu = (event: PointerEvent): void => {
            if (this.openSessionMenuId && !(event.target as Element | null)?.closest('.poiesis-agent-window__session-actions')) {
                this.openSessionMenuId = undefined;
                this.update();
            }
            if (this.repositoryPickerVisible
                && !(event.target as Element | null)?.closest('.poiesis-agent-window__repository-picker, .poiesis-agent-window__context-pill.primary')) {
                this.repositoryPickerVisible = false;
                this.repositoryPickerAnchor = undefined;
                this.repositorySearchQuery = '';
                this.update();
            }
            if (this.workspacePickerVisible
                && !(event.target as Element | null)?.closest('.poiesis-agent-window__workspace-picker, .poiesis-agent-window__repository-open')) {
                this.workspacePickerVisible = false;
                this.workspacePickerAnchor = undefined;
                this.workspaceSearchQuery = '';
                this.update();
            }
            if (this.explorerMoreVisible
                && !(event.target as Element | null)?.closest('.poiesis-agent-window__code-explorer-more')) {
                this.explorerMoreVisible = false;
                this.update();
            }
        };
        document.addEventListener('pointerdown', closeSessionMenu);
        this.toDispose.push(Disposable.create(() => document.removeEventListener('pointerdown', closeSessionMenu)));
        const closeOverlaysOnEscape = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') {
                return;
            }
            if (this.shortcutsOverlayVisible) {
                event.preventDefault();
                event.stopPropagation();
                this.closeShortcutsOverlay();
            } else if (this.folderExplorerVisible) {
                event.preventDefault();
                event.stopPropagation();
                if (this.creatingFolder) {
                    this.creatingFolder = false;
                    this.newFolderName = '';
                    this.update();
                } else {
                    this.closeFolderExplorer();
                }
            } else if (this.settingsModalVisible) {
                event.preventDefault();
                event.stopPropagation();
                this.closeSettings();
            } else if (document.querySelector('.poiesis-select__listbox')) {
                return;
            } else if (this.customizeViewVisible) {
                event.preventDefault();
                event.stopPropagation();
                this.handleCustomizeEscape();
            } else if (this.workspacePickerVisible || this.repositoryPickerVisible) {
                event.preventDefault();
                this.workspacePickerVisible = false;
                this.workspacePickerAnchor = undefined;
                this.repositoryPickerVisible = false;
                this.repositoryPickerAnchor = undefined;
                this.workspaceSearchQuery = '';
                this.repositorySearchQuery = '';
                this.update();
            } else if (this.explorerMoreVisible || this.openSessionMenuId) {
                event.preventDefault();
                this.explorerMoreVisible = false;
                this.openSessionMenuId = undefined;
                this.update();
            }
        };
        document.addEventListener('keydown', closeOverlaysOnEscape, true);
        this.toDispose.push(Disposable.create(() => document.removeEventListener('keydown', closeOverlaysOnEscape, true)));
        this.installWorkspaceSkillSaveShortcut();
        this.installCodeEditorSaveShortcut();
        this.installCodeTerminalShortcut();
        this.installCodeTabDropTarget();
        const receiveResultsMessage = (event: MessageEvent): void => this.handleResultsFrameMessage(event);
        window.addEventListener('message', receiveResultsMessage);
        this.toDispose.push(Disposable.create(() => window.removeEventListener('message', receiveResultsMessage)));

        this.toDispose.push(this.agentProvider.onEvent(event => this.handleAgentEvent(event)));
        this.toDispose.push(this.taskService.onDidChangeTask(event => {
            const session = this.findSessionForTask(event.task);
            if (session) {
                if (!session.taskIds.includes(event.task.id)) {
                    session.taskIds.push(event.task.id);
                }
                session.unreadTaskCompletion = event.type === 'ended' && session.id !== this.selectedSessionId;
                session.lastTaskStatus = event.type === 'started'
                    ? undefined
                    : event.type === 'ended' ? 'completed' : event.type;
                session.updatedAt = Date.now();
            }
            const shouldSelectResultsTask = event.type === 'ended'
                || event.type === 'failed'
                || event.type === 'cancelled';
            if (shouldSelectResultsTask && session) {
                session.selectedResultsTaskId = event.task.id;
                this.persistResultsQaPanelState();
            }
            this.persistWindowState();
            this.update();
        }));
        this.toDispose.push(this.resultsService.onDidChange(document => {
            if (!this.taskService.isFinalizing(document.taskId)) {
                this.persistWindowState();
            }
            this.update();
        }));
        this.toDispose.push(this.workspaceService.onWorkspaceChanged(() => {
            void this.refreshRecentWorkspaces();
            if (this.customizeViewVisible) {
                void this.refreshWorkspaceSkills();
            }
            this.update();
        }));
        this.toDispose.push(this.workspaceService.onWorkspaceLocationChanged(() => {
            void this.refreshRecentWorkspaces();
            if (this.customizeViewVisible) {
                void this.refreshWorkspaceSkills();
            }
            this.update();
        }));
        this.toDispose.push(this.scmService.onDidAddRepository(repository => {
            this.watchScmProvider(repository.provider);
            this.update();
        }));
        this.toDispose.push(this.scmService.onDidRemoveRepository(() => this.update()));
        this.toDispose.push(this.scmService.onDidChangeSelectedRepository(() => this.update()));
        this.toDispose.push(this.scmService.onDidChangeStatusBarCommands(() => this.update()));
        for (const repository of this.scmService.repositories) {
            this.watchScmProvider(repository.provider);
        }

        this.sessionsInitialization = this.restorePoiesisSettings()
            .then(() => this.refreshCliDetection())
            .then(() => this.initializeSessions()).catch(error => {
            console.error('[Poiesis] Could not initialize Agent Window sessions.', error);
        }).finally(() => {
            this.sessionsInitialized = true;
            this.update();
        });
        void this.refreshRecentWorkspaces();
        this.update();
    }

    protected render(): React.ReactNode {
        if (!this.sessionsInitialized) {
            return (
                <div
                    className='poiesis-agent-window__content poiesis-agent-window__content--initializing'
                    data-mode='agent'
                    data-rail-collapsed='false'
                    style={{ '--poiesis-ui-font-scale': this.uiFontScaleValue() } as React.CSSProperties}
                >
                    <div className='poiesis-agent-window__initializing' role='status'>
                        <span className='codicon codicon-loading codicon-modifier-spin' aria-hidden='true' />
                        <span>セッションを復元しています…</span>
                    </div>
                </div>
            );
        }
        const session = this.selectedSession();
        const activeTab = session?.activeTab ?? 'agent';
        const runningTask = this.runningTask(session);
        return (
            <div
                className='poiesis-agent-window__content'
                data-mode={this.codeMode ? 'code' : this.customizeViewVisible ? 'customize' : activeTab}
                data-rail-collapsed={this.railCollapsed ? 'true' : 'false'}
                style={{
                    '--poiesis-rail-width': `${this.railWidth}px`,
                    '--poiesis-ui-font-scale': this.uiFontScaleValue()
                } as React.CSSProperties}
            >
                {!this.codeMode && this.renderRail()}
                <main className='poiesis-agent-window__workspace'>
                    {this.renderHeader()}
                    <div className='poiesis-agent-window__viewport'>
                        {this.codeMode
                            ? this.renderCode()
                            : this.customizeViewVisible
                                ? this.renderCustomizeView()
                            : activeTab === 'agent'
                                ? <>
                                    {this.renderAgent(session, runningTask)}
                                    {session?.hasUserMessage && (
                                        <section
                                            id='poiesis-results-panel'
                                            role='tabpanel'
                                            aria-labelledby='poiesis-results-tab'
                                            hidden
                                        />
                                    )}
                                </>
                                : <>
                                    <section
                                        id='poiesis-agent-panel'
                                        role='tabpanel'
                                        aria-labelledby='poiesis-agent-tab'
                                        hidden
                                    />
                                    {this.renderResults(session)}
                                </>}
                    </div>
                </main>
                {this.workspacePickerVisible && this.workspacePickerAnchor && this.renderWorkspacePicker()}
                {this.repositoryPickerVisible && this.repositoryPickerAnchor && session && this.renderRepositoryPicker(session)}
                {this.folderExplorerVisible && this.renderFolderExplorer()}
                {this.settingsModalVisible && this.renderSettingsModal()}
                {this.shortcutsOverlayVisible && this.renderShortcutsOverlay()}
            </div>
        );
    }

    protected renderRail(): React.ReactNode {
        const workspaceGroups = this.workspaceSessionGroups();
        const toggleLabel = this.railCollapsed ? '左サイドバーを展開' : '左サイドバーを折りたたむ';
        return (
            <aside
                className='poiesis-agent-window__rail'
                data-collapsed={this.railCollapsed ? 'true' : 'false'}
                aria-label='セッションのサイドバー'
            >
                <div className='poiesis-agent-window__rail-top'>
                    <div className='poiesis-agent-window__rail-controls'>
                        <button
                            type='button'
                            className='poiesis-agent-window__rail-toggle'
                            title={toggleLabel}
                            aria-label={toggleLabel}
                            onClick={() => this.toggleRail()}
                        >
                            <span
                                className={`codicon ${this.railCollapsed
                                    ? 'codicon-layout-sidebar-left'
                                    : 'codicon-layout-sidebar-left-off'}`}
                                aria-hidden='true'
                            />
                        </button>
                    </div>
                    <button
                        type='button'
                        className='poiesis-agent-window__rail-action'
                        title='新しいチャット'
                        onClick={() => void this.newChat()}
                    >
                        <span className='poiesis-agent-window__rail-action-icon' aria-hidden='true'>
                            <span className='codicon codicon-comment-add' />
                        </span>
                        <span className='poiesis-agent-window__rail-action-label'>新しいチャット</span>
                    </button>
                    <button
                        type='button'
                        className={`poiesis-agent-window__rail-action${this.sessionSearchVisible ? ' active' : ''}`}
                        aria-expanded={this.sessionSearchVisible && !this.railCollapsed}
                        aria-controls='poiesis-agent-window-session-search'
                        title='検索'
                        onClick={() => this.showSessionSearch()}
                    >
                        <span className='poiesis-agent-window__rail-action-icon' aria-hidden='true'>
                            <span className='codicon codicon-search' />
                        </span>
                        <span className='poiesis-agent-window__rail-action-label'>検索</span>
                    </button>
                    <button
                        type='button'
                        className={`poiesis-agent-window__rail-action${this.customizeViewVisible ? ' active' : ''}`}
                        title='カスタマイズ'
                        aria-current={this.customizeViewVisible ? 'page' : undefined}
                        onClick={() => this.openCustomize()}
                    >
                        <span className='poiesis-agent-window__rail-action-icon' aria-hidden='true'>
                            <span className='codicon codicon-tools' />
                        </span>
                        <span className='poiesis-agent-window__rail-action-label'>カスタマイズ</span>
                    </button>
                    {this.sessionSearchVisible && !this.railCollapsed && (
                        <label className='poiesis-agent-window__session-search' id='poiesis-agent-window-session-search'>
                            <span className='codicon codicon-search' aria-hidden='true' />
                            <PoiesisTextInput
                                elementRef={this.setSessionSearchInput}
                                type='search'
                                value={this.sessionSearchQuery}
                                placeholder='Search conversations'
                                aria-label='会話をタイトルで検索'
                                onValueChange={value => this.setSessionSearchQuery(value)}
                                onKeyDown={event => {
                                    if (event.key === 'Escape') {
                                        this.closeSessionSearch();
                                    }
                                }}
                            />
                        </label>
                    )}
                </div>
                <div className='poiesis-agent-window__rail-heading'>
                    <span>Workspaces</span>
                    <button
                        type='button'
                        className='poiesis-agent-window__repository-open'
                        title='Open Folder'
                        aria-label='フォルダーを開いてリポジトリを選択または追加'
                        aria-expanded={this.workspacePickerVisible}
                        aria-controls='poiesis-agent-window-workspace-picker'
                        onClick={event => this.toggleWorkspacePicker(event.currentTarget)}
                    >
                        <span className='codicon codicon-add' aria-hidden='true' />
                    </button>
                </div>
                <div className='poiesis-agent-window__sessions'>
                    {workspaceGroups.map(group => this.renderWorkspaceSessionGroup(group))}
                </div>
                <div className='poiesis-agent-window__rail-footer'>
                    <span className='poiesis-agent-window__rail-footer-label'>Poiesis</span>
                    <div className='poiesis-agent-window__rail-footer-actions'>
                        <button type='button' title='設定' aria-label='設定' onClick={() => this.openSettings()}>
                            <span className='codicon codicon-settings-gear' aria-hidden='true' />
                        </button>
                    </div>
                </div>
                {!this.railCollapsed && (
                    <div
                        className='poiesis-agent-window__rail-resize-handle'
                        role='separator'
                        aria-label='サイドバーの幅を変更'
                        aria-orientation='vertical'
                        aria-valuemin={MIN_RAIL_WIDTH}
                        aria-valuemax={MAX_RAIL_WIDTH}
                        aria-valuenow={this.railWidth}
                        tabIndex={0}
                        onPointerDown={event => this.startRailResize(event)}
                        onDoubleClick={() => this.resetRailWidth()}
                        onKeyDown={event => this.resizeRailWithKeyboard(event)}
                    />
                )}
            </aside>
        );
    }

    protected workspaceSessionGroups(): WorkspaceSessionGroup[] {
        const currentWorkspaceUri = this.workspaceRoot()?.resource.toString();
        const groups = new Map<string, WorkspaceSessionGroup>();
        const ensureGroup = (workspaceUri?: string): WorkspaceSessionGroup => {
            const key = this.workspaceGroupKey(workspaceUri);
            let group = groups.get(key);
            if (!group) {
                const resource = workspaceUri ? new URI(workspaceUri) : undefined;
                group = {
                    key,
                    workspaceUri,
                    name: resource?.path.base || resource?.displayName || 'ワークスペースなし',
                    branch: this.sameWorkspaceUri(workspaceUri, currentWorkspaceUri)
                        ? this.gitBranchForWorkspace(workspaceUri) ?? this.currentGitBranch() ?? 'main'
                        : 'main',
                    current: this.sameWorkspaceUri(workspaceUri, currentWorkspaceUri),
                    activeSessions: [],
                    archivedSessions: []
                };
                groups.set(key, group);
            }
            return group;
        };
        if (currentWorkspaceUri) {
            ensureGroup(currentWorkspaceUri);
        }
        for (const session of this.filteredSessions(false).filter(candidate => candidate.hasUserMessage)) {
            const group = ensureGroup(session.workspaceUri);
            group.activeSessions.push(session);
            group.branch = session.branch ?? group.branch;
        }
        for (const session of this.filteredSessions(true).filter(candidate => candidate.hasUserMessage)) {
            const group = ensureGroup(session.workspaceUri);
            group.archivedSessions.push(session);
            group.branch = session.branch ?? group.branch;
        }
        return [...groups.values()].sort((left, right) => {
            if (left.current !== right.current) {
                return left.current ? -1 : 1;
            }
            const latest = (group: WorkspaceSessionGroup): number => Math.max(
                0,
                ...group.activeSessions.map(session => session.updatedAt),
                ...group.archivedSessions.map(session => session.updatedAt)
            );
            return latest(right) - latest(left) || left.name.localeCompare(right.name);
        });
    }

    protected renderWorkspaceSessionGroup(group: WorkspaceSessionGroup): React.ReactNode {
        const expanded = this.expandedWorkspaceGroups.has(group.key);
        const pinnedSessions = group.activeSessions.filter(session => session.pinned);
        const recentSessions = group.activeSessions.filter(session => !session.pinned);
        return (
            <div className={`poiesis-agent-window__workspace-group${group.current ? ' current' : ''}`} key={group.key}>
                <button
                    type='button'
                    className='poiesis-agent-window__workspace-name'
                    aria-expanded={expanded}
                    onClick={() => this.toggleWorkspaceGroup(group.key)}
                >
                    <span className='codicon codicon-folder-opened' aria-hidden='true' />
                    <span className='poiesis-agent-window__workspace-name-copy'>
                        <strong>{group.name}</strong>
                        <small>Local · {group.branch}</small>
                    </span>
                    <span className={`codicon codicon-chevron-${expanded ? 'down' : 'right'}`} aria-hidden='true' />
                </button>
                {expanded && pinnedSessions.length > 0 && (
                    <div className='poiesis-agent-window__session-section-label'>Pinned</div>
                )}
                {expanded && pinnedSessions.map(session => this.renderSessionRow(session))}
                {expanded && pinnedSessions.length > 0 && recentSessions.length > 0 && (
                    <div className='poiesis-agent-window__session-section-label'>Recent</div>
                )}
                {expanded && recentSessions.map(session => this.renderSessionRow(session))}
                {expanded && !group.activeSessions.length && (
                    <div className='poiesis-agent-window__session-empty'>
                        {this.sessionSearchQuery.trim() ? '一致する会話はありません。' : 'セッションはありません。'}
                    </div>
                )}
                {expanded && group.archivedSessions.length > 0 && (
                    <>
                        <button
                            type='button'
                            className='poiesis-agent-window__archived-toggle'
                            aria-expanded={this.showArchivedSessions}
                            onClick={() => this.toggleArchivedSessions()}
                        >
                            <span className={`codicon codicon-chevron-${this.showArchivedSessions ? 'down' : 'right'}`} aria-hidden='true' />
                            <span>Archived</span>
                            <small>{group.archivedSessions.length}</small>
                        </button>
                        {this.showArchivedSessions && group.archivedSessions.map(session => this.renderSessionRow(session))}
                    </>
                )}
            </div>
        );
    }

    protected workspaceGroupKey(workspaceUri: string | undefined): string {
        return this.canonicalWorkspaceUri(workspaceUri) ?? '__no-workspace__';
    }

    protected canonicalWorkspaceUri(workspaceUri: string | undefined): string | undefined {
        if (!workspaceUri) {
            return undefined;
        }
        try {
            return new URI(workspaceUri).toString();
        } catch {
            return workspaceUri;
        }
    }

    protected sameWorkspaceUri(left: string | undefined, right: string | undefined): boolean {
        return this.canonicalWorkspaceUri(left) === this.canonicalWorkspaceUri(right);
    }

    protected renderSessionRow(session: WindowAgentSession): React.ReactNode {
        const selected = session.id === this.selectedSessionId;
        const renaming = session.id === this.renamingSessionId;
        const menuOpen = session.id === this.openSessionMenuId;
        const state = this.sessionState(session);
        const running = state.kind === 'running';
        const switchesWorkspace = Boolean(session.workspaceUri
            && !this.sameWorkspaceUri(session.workspaceUri, this.workspaceRoot()?.resource.toString()));
        return (
            <div
                key={session.id}
                className={`poiesis-agent-window__session-row${selected ? ' active' : ''}${session.archived ? ' archived' : ''}`}
                data-session-id={session.id}
                data-session-archived={session.archived ? 'true' : 'false'}
                data-session-pinned={session.pinned ? 'true' : 'false'}
            >
                {renaming ? (
                    <PoiesisTextInput
                        className='poiesis-agent-window__session-rename'
                        value={this.renameDraft}
                        aria-label='セッション名を変更'
                        autoFocus
                        onValueChange={value => {
                            this.renameDraft = value;
                            this.update();
                        }}
                        onBlur={() => this.commitSessionRename(session.id)}
                        onKeyDown={event => {
                            if (event.key === 'Enter') {
                                event.preventDefault();
                                this.commitSessionRename(session.id);
                            } else if (event.key === 'Escape') {
                                event.preventDefault();
                                this.cancelSessionRename();
                            }
                        }}
                    />
                ) : (
                    <button
                        type='button'
                        className='poiesis-agent-window__session'
                        title={switchesWorkspace
                            ? `${session.title} — ${this.repositoryLabel(session.workspaceUri)}へ切り替え`
                            : session.title}
                        aria-current={selected ? 'true' : undefined}
                        onClick={() => session.archived ? this.restoreSession(session.id, true) : this.selectSession(session.id)}
                    >
                        {session.pinned && <span className='codicon codicon-pinned' aria-label='ピン留め済み' />}
                        <span className={`poiesis-agent-window__status-dot ${state.kind}`} aria-hidden='true' />
                        <span className='poiesis-agent-window__session-copy'>
                            <span className='poiesis-agent-window__session-title'>{session.title}</span>
                            <small className={`poiesis-agent-window__session-meta ${state.kind}`}>{state.label}</small>
                        </span>
                        <time className='poiesis-agent-window__session-time'>{this.sessionMeta(session)}</time>
                    </button>
                )}
                {!renaming && (
                    <div className='poiesis-agent-window__session-actions'>
                        <button
                            type='button'
                            className='poiesis-agent-window__session-menu-trigger'
                            title='その他の操作'
                            aria-label={`${session.title}のその他の操作`}
                            aria-haspopup='menu'
                            aria-expanded={menuOpen}
                            onClick={() => this.toggleSessionMenu(session.id)}
                        >
                            <span className='codicon codicon-more' aria-hidden='true' />
                        </button>
                        {menuOpen && (
                            <div className='poiesis-agent-window__session-menu' role='menu'>
                                {session.archived ? (
                                    <>
                                        <button type='button' role='menuitem' onClick={() => this.restoreSession(session.id)}>
                                            <span className='codicon codicon-archive' aria-hidden='true' />復元
                                        </button>
                                        {this.deleteSessionConfirmationId === session.id ? (
                                            <div className='poiesis-agent-window__inline-confirm' role='group' aria-label='完全削除の確認'>
                                                <span>取り消せません</span>
                                                <button type='button' className='danger' onClick={() => void this.deleteSession(session.id)}>削除</button>
                                                <button type='button' onClick={() => this.cancelDeleteSession()}>戻る</button>
                                            </div>
                                        ) : (
                                            <button type='button' role='menuitem' className='danger' onClick={() => this.beginDeleteSession(session.id)}>
                                                <span className='codicon codicon-trash' aria-hidden='true' />完全に削除
                                            </button>
                                        )}
                                    </>
                                ) : (
                                    <>
                                        <button type='button' role='menuitem' onClick={() => this.togglePinnedSession(session.id)}>
                                            <span className={`codicon codicon-${session.pinned ? 'pinned-dirty' : 'pin'}`} aria-hidden='true' />
                                            {session.pinned ? 'ピン留めを外す' : 'ピン留め'}
                                        </button>
                                        <button type='button' role='menuitem' onClick={() => this.beginSessionRename(session.id)}>
                                            <span className='codicon codicon-edit' aria-hidden='true' />名前を変更
                                        </button>
                                        <button type='button' role='menuitem' disabled={running} onClick={() => void this.archiveSession(session.id)}>
                                            <span className='codicon codicon-archive' aria-hidden='true' />
                                            {running ? '実行中はアーカイブ不可' : 'アーカイブ'}
                                        </button>
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
    }

    protected readonly setSessionSearchInput = (input: HTMLInputElement | null): void => {
        this.sessionSearchInput = input ?? undefined;
    };

    protected filteredSessions(archived: boolean): WindowAgentSession[] {
        const query = this.sessionSearchQuery.trim().toLocaleLowerCase();
        return this.sessions
            .filter(session => session.archived === archived)
            .filter(session => !query
                || session.title.toLocaleLowerCase().includes(query)
                || session.messages.some(message => message.content.toLocaleLowerCase().includes(query)))
            .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt);
    }

    protected toggleSessionMenu(sessionId: string): void {
        this.openSessionMenuId = this.openSessionMenuId === sessionId ? undefined : sessionId;
        this.update();
    }

    protected beginSessionRename(sessionId: string): void {
        const session = this.sessions.find(candidate => candidate.id === sessionId);
        if (!session) {
            return;
        }
        this.openSessionMenuId = undefined;
        this.renamingSessionId = sessionId;
        this.renameDraft = session.title;
        this.update();
    }

    protected commitSessionRename(sessionId: string): void {
        if (this.renamingSessionId !== sessionId) {
            return;
        }
        const session = this.sessions.find(candidate => candidate.id === sessionId);
        const title = this.renameDraft.replace(/\s+/g, ' ').trim();
        if (session && title) {
            session.title = title.slice(0, 80);
            session.updatedAt = Date.now();
        }
        this.renamingSessionId = undefined;
        this.renameDraft = '';
        this.persistWindowState();
        this.update();
    }

    protected cancelSessionRename(): void {
        this.renamingSessionId = undefined;
        this.renameDraft = '';
        this.update();
    }

    protected togglePinnedSession(sessionId: string): void {
        const session = this.sessions.find(candidate => candidate.id === sessionId && !candidate.archived);
        if (!session) {
            return;
        }
        session.pinned = !session.pinned;
        session.updatedAt = Date.now();
        this.openSessionMenuId = undefined;
        this.persistWindowState();
        this.update();
    }

    protected async archiveSession(sessionId: string): Promise<void> {
        const session = this.sessions.find(candidate => candidate.id === sessionId && !candidate.archived);
        if (!session || this.runningTask(session)) {
            return;
        }
        session.archived = true;
        session.pinned = false;
        session.updatedAt = Date.now();
        this.openSessionMenuId = undefined;
        if (this.selectedSessionId === sessionId) {
            const next = this.filteredSessions(false)[0];
            this.selectedSessionId = next?.id;
            if (!next) {
                await this.createSession();
                return;
            }
        }
        this.persistWindowState();
        this.update();
    }

    protected restoreSession(sessionId: string, select = false): void {
        const session = this.sessions.find(candidate => candidate.id === sessionId && candidate.archived);
        if (!session) {
            return;
        }
        session.archived = false;
        session.updatedAt = Date.now();
        this.openSessionMenuId = undefined;
        if (select) {
            session.activeTab = 'agent';
            this.selectSession(session.id);
            return;
        }
        this.persistWindowState();
        this.update();
    }

    protected beginDeleteSession(sessionId: string): void {
        this.deleteSessionConfirmationId = sessionId;
        this.update();
    }

    protected cancelDeleteSession(): void {
        this.deleteSessionConfirmationId = undefined;
        this.update();
    }

    protected async deleteSession(sessionId: string): Promise<void> {
        const session = this.sessions.find(candidate => candidate.id === sessionId && candidate.archived);
        if (!session || this.deleteSessionConfirmationId !== sessionId) {
            return;
        }
        for (const [taskId, notice] of session.resultsNotices) {
            if (notice.status === 'sending') {
                await this.resultsQuestionService.cancel(taskId);
            }
        }
        this.taskService.remove(session.taskIds);
        this.resultsService.remove(session.taskIds);
        this.disposeAgentRichContentForSession(session.id);
        const index = this.sessions.indexOf(session);
        if (index !== -1) {
            this.sessions.splice(index, 1);
        }
        this.openSessionMenuId = undefined;
        this.deleteSessionConfirmationId = undefined;
        this.persistWindowState();
        this.persistResultsQaPanelState();
        this.update();
    }

    protected toggleArchivedSessions(): void {
        this.showArchivedSessions = !this.showArchivedSessions;
        this.update();
    }

    protected startRailResize(event: React.PointerEvent<HTMLDivElement>): void {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = this.railWidth;
        const resize = (moveEvent: PointerEvent): void => {
            this.railWidth = this.clampRailWidth(startWidth + moveEvent.clientX - startX);
            this.update();
        };
        const finish = (): void => {
            this.railResizeCleanup?.dispose();
            this.railResizeCleanup = undefined;
            this.persistWindowState();
        };
        this.railResizeCleanup?.dispose();
        document.body.classList.add('poiesis-is-resizing-rail');
        document.addEventListener('pointermove', resize);
        document.addEventListener('pointerup', finish, { once: true });
        this.railResizeCleanup = Disposable.create(() => {
            document.body.classList.remove('poiesis-is-resizing-rail');
            document.removeEventListener('pointermove', resize);
            document.removeEventListener('pointerup', finish);
        });
    }

    protected resizeRailWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>): void {
        const delta = event.key === 'ArrowLeft' ? -12 : event.key === 'ArrowRight' ? 12 : 0;
        if (!delta && event.key !== 'Home' && event.key !== 'End') {
            return;
        }
        event.preventDefault();
        this.railWidth = event.key === 'Home'
            ? MIN_RAIL_WIDTH
            : event.key === 'End'
                ? MAX_RAIL_WIDTH
                : this.clampRailWidth(this.railWidth + delta);
        this.persistWindowState();
        this.update();
    }

    protected resetRailWidth(): void {
        this.railWidth = DEFAULT_RAIL_WIDTH;
        this.persistWindowState();
        this.update();
    }

    protected clampRailWidth(width: number): number {
        return Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, Math.round(width)));
    }

    protected toggleRail(): void {
        this.railCollapsed = !this.railCollapsed;
        this.persistWindowState();
        this.update();
        if (!this.railCollapsed && this.sessionSearchVisible) {
            requestAnimationFrame(() => this.sessionSearchInput?.focus());
        }
    }

    protected toggleResultsTaskRail(): void {
        this.resultsTaskRailCollapsed = !this.resultsTaskRailCollapsed;
        this.persistResultsQaPanelState();
        this.update();
    }

    protected showSessionSearch(): void {
        this.railCollapsed = false;
        this.sessionSearchVisible = true;
        this.update();
        requestAnimationFrame(() => this.sessionSearchInput?.focus());
    }

    protected closeSessionSearch(): void {
        this.sessionSearchVisible = false;
        this.sessionSearchQuery = '';
        this.update();
    }

    protected setSessionSearchQuery(value: string): void {
        this.sessionSearchQuery = value;
        this.update();
    }

    protected toggleWorkspaceGroup(groupKey: string): void {
        if (this.expandedWorkspaceGroups.has(groupKey)) {
            this.expandedWorkspaceGroups.delete(groupKey);
        } else {
            this.expandedWorkspaceGroups.add(groupKey);
        }
        this.update();
    }

    protected repositoryChoices(): Array<{ uri: string; name: string; path: string }> {
        return this.workspaceService.tryGetRoots().map(root => ({
            uri: root.resource.toString(),
            name: root.resource.path.base || root.resource.displayName,
            path: root.resource.path.fsPath()
        }));
    }

    protected toggleWorkspacePicker(anchor: HTMLElement): void {
        this.workspacePickerVisible = !this.workspacePickerVisible;
        this.repositoryPickerVisible = false;
        this.repositoryPickerAnchor = undefined;
        this.workspaceSearchQuery = '';
        this.workspacePickerAnchor = this.workspacePickerVisible
            ? this.pickerAnchor(anchor, 'right')
            : undefined;
        this.update();
        if (this.workspacePickerVisible) {
            requestAnimationFrame(() => this.workspaceSearchInput?.focus());
        }
    }

    protected async refreshRecentWorkspaces(): Promise<void> {
        try {
            this.recentWorkspaceUris = await this.workspaceService.recentWorkspaces();
            this.update();
        } catch {
            this.recentWorkspaceUris = [];
        }
    }

    protected workspaceChoices(): Array<{ uri: string; name: string; path: string; current: boolean }> {
        const currentUris = new Set(this.repositoryChoices().map(choice => this.workspaceGroupKey(choice.uri)));
        const choices = this.repositoryChoices().map(choice => ({ ...choice, current: true }));
        for (const workspaceUri of this.recentWorkspaceUris) {
            if (currentUris.has(this.workspaceGroupKey(workspaceUri))) {
                continue;
            }
            const resource = new URI(workspaceUri);
            choices.push({
                uri: workspaceUri,
                name: resource.path.base || resource.displayName,
                path: resource.path.fsPath(),
                current: false
            });
        }
        return choices;
    }

    protected setWorkspaceSearchQuery(value: string): void {
        this.workspaceSearchQuery = value;
        this.update();
        requestAnimationFrame(() => {
            this.workspaceSearchInput?.focus();
            this.workspaceSearchInput?.setSelectionRange(value.length, value.length);
        });
    }

    protected renderWorkspacePicker(): React.ReactNode {
        const query = this.workspaceSearchQuery.trim().toLocaleLowerCase();
        const choices = this.workspaceChoices().filter(choice => !query
            || choice.name.toLocaleLowerCase().includes(query)
            || choice.path.toLocaleLowerCase().includes(query));
        const currentChoices = choices.filter(choice => choice.current);
        const recentChoices = choices.filter(choice => !choice.current);
        return (
            <div
                className='poiesis-agent-window__workspace-picker'
                id='poiesis-agent-window-workspace-picker'
                role='dialog'
                aria-label='Workspaceを開く'
                style={this.workspacePickerAnchor}
            >
                <div className='poiesis-agent-window__workspace-picker-title'>Workspaceを開く</div>
                <label className='poiesis-agent-window__workspace-picker-search'>
                    <span className='codicon codicon-search' aria-hidden='true' />
                    <PoiesisTextInput
                        elementRef={input => { this.workspaceSearchInput = input ?? undefined; }}
                        value={this.workspaceSearchQuery}
                        placeholder='Workspaceを検索'
                        aria-label='Workspaceを検索'
                        onValueChange={value => this.setWorkspaceSearchQuery(value)}
                        onKeyDown={event => {
                            if (event.key === 'Escape') {
                                this.workspacePickerVisible = false;
                                this.workspacePickerAnchor = undefined;
                                this.workspaceSearchQuery = '';
                                this.update();
                            }
                        }}
                    />
                </label>
                {currentChoices.length > 0 && (
                    <>
                        <div className='poiesis-agent-window__workspace-picker-label'>On This PC</div>
                        {currentChoices.map(choice => (
                            <button
                                type='button'
                                className='poiesis-agent-window__workspace-picker-item'
                                key={choice.uri}
                                onClick={() => this.openKnownWorkspace(choice.uri)}
                            >
                                <span className='codicon codicon-folder-opened' aria-hidden='true' />
                                <span><strong>{choice.name}</strong><small>{choice.path}</small></span>
                                <span className='codicon codicon-arrow-right' aria-hidden='true' />
                            </button>
                        ))}
                    </>
                )}
                {recentChoices.length > 0 && (
                    <>
                        <div className='poiesis-agent-window__workspace-picker-label'>Recent</div>
                        {recentChoices.map(choice => (
                            <button
                                type='button'
                                className='poiesis-agent-window__workspace-picker-item'
                                key={choice.uri}
                                onClick={() => this.openKnownWorkspace(choice.uri)}
                            >
                                <span className='codicon codicon-history' aria-hidden='true' />
                                <span><strong>{choice.name}</strong><small>{choice.path}</small></span>
                                <span className='codicon codicon-arrow-right' aria-hidden='true' />
                            </button>
                        ))}
                    </>
                )}
                {choices.length === 0 && query && (
                    <div className='poiesis-agent-window__workspace-picker-empty'>一致するWorkspaceはありません</div>
                )}
                <div className='poiesis-agent-window__workspace-picker-divider' />
                <button
                    type='button'
                    className='poiesis-agent-window__workspace-picker-item action'
                    onClick={() => void this.openRepository()}
                >
                    <span className='codicon codicon-folder-opened' aria-hidden='true' />
                    <span><strong>Open Folder…</strong><small>このPCからフォルダーを選択</small></span>
                </button>
            </div>
        );
    }

    protected openKnownWorkspace(workspaceUri: string): void {
        this.workspacePickerVisible = false;
        this.workspacePickerAnchor = undefined;
        this.workspaceSearchQuery = '';
        this.workspaceService.open(new URI(workspaceUri), { preserveWindow: true });
    }

    protected repositoryLabel(workspaceUri: string | undefined): string {
        if (!workspaceUri) {
            return 'Select repository';
        }
        const known = this.repositoryChoices().find(choice => this.sameWorkspaceUri(choice.uri, workspaceUri));
        return known?.name ?? new URI(workspaceUri).path.base ?? 'Repository';
    }

    protected toggleRepositoryPicker(anchor: HTMLElement): void {
        this.repositoryPickerVisible = !this.repositoryPickerVisible;
        this.workspacePickerVisible = false;
        this.workspacePickerAnchor = undefined;
        this.repositorySearchQuery = '';
        this.repositoryPickerAnchor = this.repositoryPickerVisible
            ? this.pickerAnchor(anchor, 'above')
            : undefined;
        this.update();
        if (this.repositoryPickerVisible) {
            requestAnimationFrame(() => this.repositorySearchInput?.focus());
        }
    }

    protected closeNewAgentPickers(): void {
        this.repositoryPickerVisible = false;
        this.repositoryPickerAnchor = undefined;
        this.repositorySearchQuery = '';
        this.update();
    }

    protected pickerAnchor(anchor: HTMLElement, placement: 'right' | 'above'): PickerAnchor {
        const rect = anchor.getBoundingClientRect();
        const edge = 8;
        const width = Math.min(360, window.innerWidth - edge * 2);
        const left = placement === 'right'
            ? Math.min(Math.max(edge, rect.right + 8), window.innerWidth - width - edge)
            : Math.min(Math.max(edge, rect.left), window.innerWidth - width - edge);
        if (placement === 'above') {
            return {
                left,
                bottom: Math.max(edge, window.innerHeight - rect.top + 7),
                maxHeight: Math.max(180, Math.min(500, rect.top - edge * 2))
            };
        }
        const top = Math.min(Math.max(edge, rect.top), Math.max(edge, window.innerHeight - 240));
        return {
            left,
            top,
            maxHeight: Math.max(180, window.innerHeight - top - edge)
        };
    }

    protected setRepositorySearchQuery(value: string): void {
        this.repositorySearchQuery = value;
        this.update();
        requestAnimationFrame(() => {
            this.repositorySearchInput?.focus();
            this.repositorySearchInput?.setSelectionRange(value.length, value.length);
        });
    }

    protected selectRepository(session: WindowAgentSession, workspaceUri: string): void {
        if (session.hasUserMessage || session.agentSession) {
            return;
        }
        session.workspaceUri = workspaceUri;
        session.branch = this.gitBranchForWorkspace(workspaceUri) ?? 'main';
        session.updatedAt = Date.now();
        this.closeNewAgentPickers();
        this.persistWindowState();
    }

    protected async openFolderExplorer(session?: WindowAgentSession, createFolder = false): Promise<void> {
        this.folderExplorerVisible = true;
        this.folderExplorerSessionId = session?.id;
        this.folderExplorerError = undefined;
        this.creatingFolder = createFolder;
        this.newFolderName = '';
        this.update();
        await this.loadFolderExplorer(session?.workspaceUri
            ? new URI(session.workspaceUri).path.fsPath()
            : this.workspaceRoot()?.resource.path.fsPath());
    }

    protected async loadFolderExplorer(path?: string): Promise<void> {
        this.folderExplorerLoading = true;
        this.folderExplorerError = undefined;
        this.update();
        try {
            this.folderExplorerResult = await this.folderExplorerService.browse(path);
            this.folderExplorerAddress = this.folderExplorerResult.path;
        } catch (error) {
            this.folderExplorerError = `フォルダーを開けませんでした: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            this.folderExplorerLoading = false;
            this.update();
        }
    }

    protected closeFolderExplorer(): void {
        this.folderExplorerVisible = false;
        this.folderExplorerSessionId = undefined;
        this.folderExplorerError = undefined;
        this.creatingFolder = false;
        this.update();
    }

    protected async createFolderInExplorer(): Promise<void> {
        const parentPath = this.folderExplorerResult?.path;
        const name = this.newFolderName.trim();
        if (!parentPath || !name) {
            return;
        }
        this.folderExplorerLoading = true;
        this.folderExplorerError = undefined;
        this.update();
        try {
            const folderPath = await this.folderExplorerService.create(parentPath, name);
            this.creatingFolder = false;
            this.newFolderName = '';
            await this.loadFolderExplorer(folderPath);
        } catch (error) {
            this.folderExplorerLoading = false;
            this.folderExplorerError = `フォルダーを作成できませんでした: ${error instanceof Error ? error.message : String(error)}`;
            this.update();
        }
    }

    protected selectFolderFromExplorer(): void {
        const session = this.folderExplorerSessionId
            ? this.sessions.find(candidate => candidate.id === this.folderExplorerSessionId)
            : undefined;
        const selectedPath = this.folderExplorerResult?.path;
        if (!selectedPath || (this.folderExplorerSessionId && !session)) {
            return;
        }
        const folder = URI.fromFilePath(selectedPath);
        if (session) {
            session.workspaceUri = folder.toString();
            session.branch = 'main';
            session.updatedAt = Date.now();
        }
        this.repositoryPickerVisible = false;
        this.repositoryPickerAnchor = undefined;
        this.repositorySearchQuery = '';
        this.closeFolderExplorer();
        this.persistWindowState();
        this.workspaceService.open(folder, { preserveWindow: true });
    }

    protected async openRepository(): Promise<void> {
        this.workspacePickerVisible = false;
        this.workspacePickerAnchor = undefined;
        this.workspaceSearchQuery = '';
        await this.openFolderExplorer();
    }

    protected sessionMeta(session: WindowAgentSession): string {
        const ageInMinutes = Math.floor(Math.max(0, Date.now() - session.createdAt) / 60_000);
        if (ageInMinutes < 1) {
            return '今';
        }
        if (ageInMinutes < 60) {
            return `${ageInMinutes}m`;
        }
        const ageInHours = Math.floor(ageInMinutes / 60);
        return ageInHours < 24 ? `${ageInHours}h` : `${Math.floor(ageInHours / 24)}d`;
    }

    protected sessionState(session: WindowAgentSession): {
        kind: 'running' | 'failed' | 'unread' | 'cancelled' | 'idle';
        label: string;
    } {
        if (this.runningTask(session)) {
            return { kind: 'running', label: '実行中' };
        }
        if (session.lastTaskStatus === 'failed') {
            return { kind: 'failed', label: '失敗' };
        }
        if (session.unreadTaskCompletion) {
            return { kind: 'unread', label: '完了 · 未読' };
        }
        if (session.lastTaskStatus === 'cancelled') {
            return { kind: 'cancelled', label: 'キャンセル' };
        }
        return { kind: 'idle', label: '待機中' };
    }

    protected renderHeader(): React.ReactNode {
        if (this.codeMode) {
            return (
                <header className='poiesis-agent-window__header poiesis-agent-window__code-header'>
                    <div className='poiesis-agent-window__window-drag-surface' aria-hidden='true' />
                    <button
                        type='button'
                        className='poiesis-agent-window__code-control active'
                        aria-pressed='true'
                        aria-label='Agentへ戻る'
                        onClick={() => this.toggleCodeMode()}
                    >
                        <span className='codicon codicon-code' aria-hidden='true' />
                        <span>Code</span>
                    </button>
                    <span className='poiesis-agent-window__code-workspace'>{this.workspaceContextLabel()}</span>
                    <span className='poiesis-agent-window__code-hint'>Poiesis Workbench</span>
                </header>
            );
        }
        if (this.customizeViewVisible) {
            return (
                <header className='poiesis-agent-window__header poiesis-agent-window__customize-header'>
                    <div className='poiesis-agent-window__window-drag-surface' aria-hidden='true' />
                    <div className='poiesis-agent-window__context'>
                        <small>{this.workspaceContextLabel()}</small>
                        <strong>Customize</strong>
                    </div>
                    <div className='poiesis-agent-window__customize-header-actions'>
                        <button type='button' className='poiesis-agent-window__code-control' onClick={() => this.toggleCodeMode()}>
                            <span className='codicon codicon-code' aria-hidden='true' />
                            <span>Code</span>
                        </button>
                        <button
                            type='button'
                            className='poiesis-agent-window__customize-close'
                            aria-label='Customizeを閉じる'
                            onClick={() => this.closeCustomize()}
                        >
                            <span className='codicon codicon-close' aria-hidden='true' />
                        </button>
                    </div>
                </header>
            );
        }
        const session = this.selectedSession();
        const activeTab = session?.activeTab ?? 'agent';
        return (
            <header className='poiesis-agent-window__header'>
                <div className='poiesis-agent-window__window-drag-surface' aria-hidden='true' />
                <div className='poiesis-agent-window__context'>
                    <div className='poiesis-agent-window__context-scope'>
                        <small>{this.workspaceContextLabel()}</small>
                        <button
                            type='button'
                            className={`poiesis-agent-window__code-control${this.codeMode ? ' active' : ''}`}
                            aria-pressed={this.codeMode}
                            onClick={() => this.toggleCodeMode()}
                        >
                            <span className='codicon codicon-code' aria-hidden='true' />
                            <span>Code</span>
                        </button>
                    </div>
                    <strong>{this.codeMode ? 'Code' : session?.hasUserMessage ? session.title : 'New Agent'}</strong>
                </div>
                {!this.codeMode && session?.hasUserMessage && (
                    <nav className='poiesis-agent-window__tabs' role='tablist' aria-label='Agent と Results の切り替え'>
                        <button
                            id='poiesis-agent-tab'
                            type='button'
                            role='tab'
                            className={activeTab === 'agent' ? 'active' : ''}
                            aria-selected={activeTab === 'agent'}
                            aria-controls='poiesis-agent-panel'
                            tabIndex={activeTab === 'agent' ? 0 : -1}
                            onClick={() => this.selectTab('agent')}
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
                            onClick={() => this.selectTab('results')}
                        >
                            Results
                        </button>
                    </nav>
                )}
            </header>
        );
    }

    protected renderAgent(session: WindowAgentSession | undefined, runningTask?: ExecutionTask): React.ReactNode {
        const newAgent = Boolean(session && !session.hasUserMessage);
        return (
            <section
                id={session?.hasUserMessage ? 'poiesis-agent-panel' : undefined}
                className='poiesis-agent-window__agent'
                role={session?.hasUserMessage ? 'tabpanel' : undefined}
                aria-labelledby={session?.hasUserMessage ? 'poiesis-agent-tab' : undefined}
                aria-label={session?.hasUserMessage ? undefined : 'Agent の会話'}
            >
                <div className='poiesis-agent-window__messages' aria-live='polite'>
                    <div className='poiesis-agent-window__messages-inner'>
                        {newAgent && session?.messages.length === 0 && (
                            <div className='poiesis-agent-window__new-agent-empty'>
                                <span className='codicon codicon-comment-add' aria-hidden='true' />
                                <strong>何を作りますか?</strong>
                                <small>Repository、branch、実行場所を選んでからAgentへ依頼します</small>
                            </div>
                        )}
                        {(session?.messages ?? []).map(message => (
                            <section
                                key={message.id}
                                aria-label={message.role === 'user' ? 'あなたのメッセージ' : 'Agent のメッセージ'}
                                className={message.role === 'user'
                                    ? 'poiesis-agent-window__user-message'
                                    : 'poiesis-agent-window__message'}
                            >
                                {message.error ? (
                                    <div className='poiesis-agent-window__message-error' role='alert'>
                                        <strong>{message.content}</strong>
                                        {message.errorDetails && (
                                            <details>
                                                <summary>詳細</summary>
                                                <pre>{message.errorDetails}</pre>
                                            </details>
                                        )}
                                        {message.taskId && (
                                            <button type='button' onClick={() => void this.retryTask(message.taskId!)}>再試行</button>
                                        )}
                                    </div>
                                ) : message.role === 'agent'
                                    ? this.renderAgentMessage(session, message)
                                    : <p>{message.content || '…'}</p>}
                                {!message.complete && runningTask && runningTask.id === message.taskId && (
                                    <small className='poiesis-agent-window__message-state'>
                                        <PoiesisTaskElapsed startedAt={runningTask.startedAt} />
                                    </small>
                                )}
                            </section>
                        ))}
                    </div>
                </div>
                {runningTask && (
                    <div className='poiesis-agent-window__task-state' role='status'>
                        <span>{this.taskService.isFinalizing(runningTask.id) ? '成果を作成中' : 'タスクを実行中'} · {runningTask.title}</span>
                        {!this.taskService.isFinalizing(runningTask.id) && (
                            <button type='button' onClick={() => void this.cancelRun()}>
                                キャンセル
                            </button>
                        )}
                    </div>
                )}
                <section className='poiesis-agent-window__composer' aria-label='Agent の入力欄'>
                    <PoiesisComposer
                        key={session?.id ?? 'no-session'}
                        elementRef={input => { this.agentComposerInput = input ?? undefined; }}
                        value={session?.agentDraft ?? ''}
                        placeholder='次の変更内容や質問を入力…'
                        aria-label='Agent へのメッセージ'
                        rows={2}
                        disabled={!session || Boolean(runningTask)}
                        onValueChange={value => this.setAgentDraft(session?.id, value)}
                        onSubmit={() => void this.sendAgentMessage()}
                    />
                    <div className='poiesis-agent-window__composer-footer'>
                        {session && newAgent && this.renderNewAgentContext(session)}
                        {session && !newAgent && this.renderAiRolePill('agent')}
                        <button
                            className='poiesis-agent-window__send'
                            type='button'
                            aria-label='Agent へ送信'
                            disabled={!session?.workspaceUri || Boolean(runningTask) || !session.agentDraft.trim()}
                            onClick={() => void this.sendAgentMessage()}
                        >
                            <span className='codicon codicon-arrow-up' aria-hidden='true' />
                        </button>
                    </div>
                </section>
            </section>
        );
    }

    protected renderFolderExplorer(): React.ReactNode {
        const result = this.folderExplorerResult;
        return (
            <section className='poiesis-folder-explorer' role='dialog' aria-modal='true' aria-label='フォルダーを選択'>
                <header className='poiesis-folder-explorer__header'>
                    <div>
                        <span className='codicon codicon-folder-opened' aria-hidden='true' />
                        <strong>Select workspace folder</strong>
                    </div>
                    <button type='button' aria-label='フォルダー選択を閉じる' onClick={() => this.closeFolderExplorer()}>
                        <span className='codicon codicon-close' aria-hidden='true' />
                    </button>
                </header>
                <div className='poiesis-folder-explorer__toolbar'>
                    <button
                        type='button'
                        title='一つ上のフォルダーへ'
                        aria-label='一つ上のフォルダーへ'
                        disabled={!result?.parentPath || this.folderExplorerLoading}
                        onClick={() => void this.loadFolderExplorer(result?.parentPath)}
                    >
                        <span className='codicon codicon-arrow-up' aria-hidden='true' />
                    </button>
                    <label>
                        <span className='codicon codicon-folder' aria-hidden='true' />
                        <PoiesisTextInput
                            value={this.folderExplorerAddress}
                            aria-label='フォルダーパス'
                            onValueChange={value => {
                                this.folderExplorerAddress = value;
                                this.update();
                            }}
                            onKeyDown={event => {
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    void this.loadFolderExplorer(this.folderExplorerAddress);
                                }
                            }}
                        />
                    </label>
                    <button type='button' title='再読み込み' aria-label='再読み込み' disabled={this.folderExplorerLoading} onClick={() => void this.loadFolderExplorer(result?.path)}>
                        <span className='codicon codicon-refresh' aria-hidden='true' />
                    </button>
                </div>
                <main className='poiesis-folder-explorer__body'>
                    <div className='poiesis-folder-explorer__column-heading'><span>Name</span><span>Type</span></div>
                    {this.creatingFolder && (
                        <div className='poiesis-folder-explorer__new-folder-row'>
                            <span className='codicon codicon-folder' aria-hidden='true' />
                            <PoiesisTextInput
                                autoFocus
                                value={this.newFolderName}
                                placeholder='New folder'
                                aria-label='新しいフォルダー名'
                                onValueChange={value => {
                                    this.newFolderName = value;
                                    this.update();
                                }}
                                onKeyDown={event => {
                                    if (event.key === 'Enter') {
                                        event.preventDefault();
                                        void this.createFolderInExplorer();
                                    } else if (event.key === 'Escape') {
                                        this.creatingFolder = false;
                                        this.newFolderName = '';
                                        this.update();
                                    }
                                }}
                            />
                            <button type='button' disabled={!this.newFolderName.trim()} onClick={() => void this.createFolderInExplorer()}>Create</button>
                        </div>
                    )}
                    {this.folderExplorerLoading && <div className='poiesis-folder-explorer__state'>Loading folders…</div>}
                    {!this.folderExplorerLoading && this.folderExplorerError && <div className='poiesis-folder-explorer__state error' role='alert'>{this.folderExplorerError}</div>}
                    {!this.folderExplorerLoading && !this.folderExplorerError && result?.directories.map(directory => (
                        <button
                            type='button'
                            className='poiesis-folder-explorer__folder-row'
                            key={directory.path}
                            onDoubleClick={() => void this.loadFolderExplorer(directory.path)}
                            onClick={() => void this.loadFolderExplorer(directory.path)}
                        >
                            <span><span className='codicon codicon-folder' aria-hidden='true' /><strong>{directory.name}</strong></span>
                            <small>File folder</small>
                            <span className='codicon codicon-chevron-right' aria-hidden='true' />
                        </button>
                    ))}
                    {!this.folderExplorerLoading && !this.folderExplorerError && result?.directories.length === 0 && (
                        <div className='poiesis-folder-explorer__state'>このフォルダーにサブフォルダーはありません。</div>
                    )}
                </main>
                <footer className='poiesis-folder-explorer__footer'>
                    <button
                        type='button'
                        className='poiesis-folder-explorer__new-folder'
                        onClick={() => {
                            this.creatingFolder = true;
                            this.newFolderName = '';
                            this.update();
                        }}
                    >
                        <span className='codicon codicon-new-folder' aria-hidden='true' />
                        New folder
                    </button>
                    <span className='poiesis-folder-explorer__selection'>{result?.path ?? ''}</span>
                    <button type='button' onClick={() => this.closeFolderExplorer()}>Cancel</button>
                    <button type='button' className='primary' disabled={!result || this.folderExplorerLoading} onClick={() => this.selectFolderFromExplorer()}>Select Folder</button>
                </footer>
            </section>
        );
    }

    protected renderSettingsModal(): React.ReactNode {
        const archivedSessions = this.sessions
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
                                        <label key={scale} className={this.uiFontScale === scale ? 'active' : ''}>
                                            <input type='radio' name='poiesis-ui-scale' value={scale} checked={this.uiFontScale === scale} onChange={() => this.setUiFontScale(scale)} />
                                            <span>{label}</span>
                                        </label>
                                    ))}
                                </div>
                            </div>
                            <div className='poiesis-settings-modal__row poiesis-settings-modal__shortcuts-row'>
                                <div><strong>キーボードショートカット</strong><small>Poiesisで実際に使えるキー操作を確認します。</small></div>
                                <button type='button' className='poiesis-settings-modal__text-button' aria-haspopup='dialog' onClick={() => this.openShortcutsOverlay()}>一覧を開く</button>
                            </div>
                        </section>

                        <section className='poiesis-settings-modal__section' aria-labelledby='poiesis-settings-cli'>
                            <div className='poiesis-settings-modal__section-heading'>
                                <h2 id='poiesis-settings-cli'>AI — Provider / Model</h2>
                                <button type='button' className='poiesis-settings-modal__text-button' disabled={this.cliDetectionLoading} onClick={() => void this.refreshCliDetection()}>再検出</button>
                            </div>
                            {this.renderCliRoleSelector('agent', 'Agent の AI', this.agentCli)}
                            {this.renderCliRoleSelector('results', 'Results の AI', this.resultsCli)}
                        </section>

                        <section className='poiesis-settings-modal__section' aria-labelledby='poiesis-settings-results'>
                            <h2 id='poiesis-settings-results'>Results — 外部リソース</h2>
                            <p className='poiesis-settings-modal__section-copy'>成果文書は Results の AI が生成します（未検出時は組み込みテンプレート）。</p>
                            <div className='poiesis-settings-modal__row'>
                                <div><strong>成果文書の外部リソース読み込みを許可</strong><small>OFFではResults HTMLからのネットワーク画像や外部スタイルをブロックします。</small></div>
                                <label className='poiesis-agent-window__switch'>
                                    <input type='checkbox' checked={this.allowExternalResultsResources} aria-label='成果文書の外部リソースを許可' onChange={event => this.setAllowExternalResultsResources(event.currentTarget.checked)} />
                                    <span aria-hidden='true' />
                                </label>
                            </div>
                        </section>

                        <section className='poiesis-settings-modal__section' aria-labelledby='poiesis-settings-sessions'>
                            <h2 id='poiesis-settings-sessions'>セッション — データ管理</h2>
                            <div className='poiesis-settings-modal__archived'>
                                <strong>アーカイブ済み</strong>
                                {archivedSessions.length === 0 && <p>アーカイブ済みのセッションはありません。</p>}
                                {archivedSessions.map(session => (
                                    <div className='poiesis-settings-modal__archived-row' key={session.id}>
                                        <span><strong>{session.title}</strong><small>{this.sessionMeta(session)}</small></span>
                                        {this.deleteSessionConfirmationId === session.id ? (
                                            <div className='poiesis-settings-modal__confirm' role='group' aria-label={`${session.title}の完全削除を確認`}>
                                                <span>完全に削除しますか？</span>
                                                <button type='button' className='danger' onClick={() => void this.deleteSession(session.id)}>削除</button>
                                                <button type='button' onClick={() => this.cancelDeleteSession()}>戻る</button>
                                            </div>
                                        ) : (
                                            <button type='button' className='danger ghost' onClick={() => this.beginDeleteSession(session.id)}>完全削除</button>
                                        )}
                                    </div>
                                ))}
                            </div>
                            <div className='poiesis-settings-modal__danger-zone'>
                                <div><strong>保存データをすべてクリア</strong><small>会話、タスク、Resultsの保存状態をこのWindowから削除します。</small></div>
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

    protected renderShortcutsOverlay(): React.ReactNode {
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

    protected renderCustomizeView(): React.ReactNode {
        const workspaceName = this.workspaceRoot()?.resource.path.base;
        const editor = this.workspaceSkillEditor;
        const editorDirty = Boolean(editor && editor.content !== editor.savedContent);
        return (
            <section className='poiesis-customize-view' aria-labelledby='poiesis-customize-title'>
                <div className='poiesis-customize-view__page'>
                    <header className='poiesis-customize-view__intro'>
                        <span className='codicon codicon-tools' aria-hidden='true' />
                        <div><h1 id='poiesis-customize-title'>Customize</h1><p>PoiesisのSkillとPluginを管理します。</p></div>
                    </header>
                    <section className='poiesis-customize-view__section' aria-labelledby='poiesis-customize-skills'>
                            <div className='poiesis-customize-view__section-heading'>
                                <h2 id='poiesis-customize-skills'>Skills</h2>
                                <button
                                    type='button'
                                    className='poiesis-customize-view__text-button'
                                    onClick={() => this.showNewSkillForm()}
                                >
                                    新しいSkill
                                </button>
                            </div>
                            <p className='poiesis-customize-view__section-copy'>
                                有効なAgent Skillは次のTaskから実装指示へ加わり、有効なResults SkillはAI成果文書の構成を案内します。組み込みテンプレートへのfallback時はResults Skillの追加指示を使いません。
                            </p>

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
                                        ? '入力 → Results AI → HTML検証 → Results canvas\n                    ↘ 失敗時: Bundled Results'
                                        : 'Task + Change Set → 組み込みHTML → Results canvas'}</pre>
                                </article>
                            )}

                            <div className='poiesis-customize-view__user-heading'>
                                <h3 className='poiesis-customize-view__group-title'>User Skills</h3>
                                <span>{workspaceName ? `${workspaceName} / .poiesis/skills` : 'Workspaceが開かれていません'}</span>
                            </div>
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
                                <div className='poiesis-customize-view__state'>User Skillはまだありません。</div>
                            )}
                            {!this.workspaceSkillsLoading && this.workspaceSkills.length > 0 && (
                                <div className='poiesis-agent-window__customize-list'>
                                    {this.workspaceSkills.map(skill => (
                                        <div className={`poiesis-customize-view__skill-row${skill.error ? ' has-error' : ''}`} key={skill.id}>
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
                                                        <span>{skill.kind ? (skill.kind === 'agent' ? 'Agent' : 'Results') : '要修正'}</span>
                                                    </div>
                                                    <p>{skill.error ?? skill.description}</p>
                                                    <small>.poiesis/skills/{skill.id}/skill.md</small>
                                                </div>
                                                <span className='codicon codicon-chevron-right' aria-hidden='true' />
                                            </button>
                                            <div className='poiesis-customize-view__skill-enablement'>
                                                <span>{skill.enabled ? '有効' : '無効'}</span>
                                                <label className='poiesis-agent-window__switch' title={`${skill.name}を${skill.enabled ? '無効' : '有効'}にする`}>
                                                    <input
                                                        type='checkbox'
                                                        checked={skill.enabled}
                                                        aria-label={`${skill.name}を有効にする`}
                                                        onChange={event => void this.setWorkspaceSkillEnabled(skill, event.currentTarget.checked)}
                                                    />
                                                    <span aria-hidden='true' />
                                                </label>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {(this.workspaceSkillEditorLoading || this.workspaceSkillEditorError || editor) && (
                                <section className='poiesis-customize-view__editor' aria-label='User Skill editor'>
                                    {this.workspaceSkillEditorLoading ? (
                                        <div className='poiesis-customize-view__state' role='status'>
                                            <span className='codicon codicon-loading codicon-modifier-spin' aria-hidden='true' />
                                            skill.mdを開いています…
                                        </div>
                                    ) : !editor && this.workspaceSkillEditorError ? (
                                        <div className='poiesis-customize-view__state error' role='alert'>{this.workspaceSkillEditorError}</div>
                                    ) : editor && (
                                        <>
                                            <header>
                                                <div>
                                                    <strong>{editor.path.split('/').at(-2) ?? 'skill.md'}</strong>
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
                                        <span>Kind</span>
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
                                    <small>.poiesis/skills/&lt;skill-id&gt;/skill.md を作成します。</small>
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
                                    <span className='poiesis-agent-window__status-badge'>No additions</span>
                                </article>
                            </div>
                    </section>
                    <footer className='poiesis-customize-view__footer'>User Skillはこの画面で編集し、保存またはCtrl+Sで保存します。</footer>
                </div>
            </section>
        );
    }

    protected renderCliRoleSelector(role: AiRole, label: string, selected: KnownCliId): React.ReactNode {
        const detections = this.cliDetectionReport?.detections ?? [];
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
        const detection = this.cliDetectionReport?.detections.find(item => item.id === (role === 'agent' ? this.agentCli : this.resultsCli));
        const model = this.roleModel(role);
        return this.customModelRoles.has(role) || Boolean(detection && !detection.models.some(option => option.id === model));
    }

    protected rolePillOptions(role: AiRole): PoiesisSelectOption[] {
        const selectedProvider = role === 'agent' ? this.agentCli : this.resultsCli;
        const selectedModel = this.roleModel(role);
        const selectedCustom = this.roleModelIsCustom(role);
        const detections = this.cliDetectionReport?.detections ?? [];
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
        const detection = this.cliDetectionReport?.detections.find(item => item.id === provider);
        if (detection?.status !== 'found' || !detection.executableRoles.includes(role)
            || (modelChoice !== '__custom__' && !detection.models.some(option => option.id === modelChoice))) {
            return;
        }
        const model = modelChoice === '__custom__' ? '' : modelChoice;
        if (role === 'agent') {
            this.agentCli = provider;
            this.agentModel = model;
        } else {
            this.resultsCli = provider;
            this.resultsModel = model;
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

    protected renderAiRolePill(role: AiRole, compact = false): React.ReactNode {
        const selectedProvider = role === 'agent' ? this.agentCli : this.resultsCli;
        const selectedModel = this.roleModel(role);
        const custom = this.roleModelIsCustom(role);
        const detection = this.cliDetectionReport?.detections.find(item => item.id === selectedProvider);
        const executable = detection?.status === 'found' && detection.executableRoles.includes(role);
        const loading = !this.cliDetectionReport || this.cliDetectionLoading;
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

    protected renderNewAgentContext(session: WindowAgentSession): React.ReactNode {
        const branch = session.branch ?? this.gitBranchForWorkspace(session.workspaceUri) ?? 'main';
        return (
            <div className='poiesis-agent-window__new-agent-context'>
                <button
                    type='button'
                    className='poiesis-agent-window__context-pill primary'
                    aria-expanded={this.repositoryPickerVisible}
                    aria-controls='poiesis-agent-window-repository-picker'
                    onClick={event => this.toggleRepositoryPicker(event.currentTarget)}
                >
                    <span className='codicon codicon-folder' aria-hidden='true' />
                    <span>{this.repositoryLabel(session.workspaceUri)}</span>
                    <span className='codicon codicon-chevron-down' aria-hidden='true' />
                </button>
                <span className='poiesis-agent-window__context-pill static' title='現在のローカルブランチ'>
                    <span className='codicon codicon-git-branch' aria-hidden='true' />
                    <span>{branch}</span>
                </span>
                <span className='poiesis-agent-window__context-pill static' title='現在利用できる実行先はLocalのみです'>
                    <span className='codicon codicon-device-desktop' aria-hidden='true' />
                    <span>Run on · This Computer</span>
                </span>
                {this.renderAiRolePill('agent')}
            </div>
        );
    }

    protected renderRepositoryPicker(session: WindowAgentSession): React.ReactNode {
        const repositoryChoices = this.repositoryChoices();
        const query = this.repositorySearchQuery.trim().toLocaleLowerCase();
        const filteredChoices = repositoryChoices.filter(choice => !query
            || choice.name.toLocaleLowerCase().includes(query)
            || choice.path.toLocaleLowerCase().includes(query));
        return (
            <div
                className='poiesis-agent-window__repository-picker'
                id='poiesis-agent-window-repository-picker'
                role='dialog'
                aria-label='Repositoryを選択'
                style={this.repositoryPickerAnchor}
            >
                <label className='poiesis-agent-window__repository-search'>
                    <span className='codicon codicon-search' aria-hidden='true' />
                    <PoiesisTextInput
                        elementRef={input => { this.repositorySearchInput = input ?? undefined; }}
                        value={this.repositorySearchQuery}
                        placeholder='Repositoryを検索'
                        aria-label='Repositoryを検索'
                        onValueChange={value => this.setRepositorySearchQuery(value)}
                    />
                </label>
                {repositoryChoices.length > 0 && (
                    <>
                        <div className='poiesis-agent-window__repository-group-label'>Recent</div>
                        {repositoryChoices.slice(0, 2).map(choice => this.renderRepositoryChoice(session, choice, 'codicon-history'))}
                    </>
                )}
                <div className='poiesis-agent-window__repository-group-label'>On This PC</div>
                {filteredChoices.map(choice => this.renderRepositoryChoice(session, choice, 'codicon-device-desktop'))}
                {!filteredChoices.length && (
                    <div className='poiesis-agent-window__repository-empty'>一致するRepositoryはありません</div>
                )}
                <div className='poiesis-agent-window__repository-footer'>
                    <button type='button' onClick={() => void this.openFolderExplorer(session)}>
                        <span className='codicon codicon-folder-opened' aria-hidden='true' />
                        Use Existing…
                    </button>
                    <button type='button' onClick={() => void this.openFolderExplorer(session, true)}>
                        <span className='codicon codicon-new-folder' aria-hidden='true' />
                        New Folder
                    </button>
                </div>
            </div>
        );
    }

    protected renderRepositoryChoice(
        session: WindowAgentSession,
        choice: { uri: string; name: string; path: string },
        iconClass: string
    ): React.ReactNode {
        const selected = this.sameWorkspaceUri(session.workspaceUri, choice.uri);
        return (
            <button
                type='button'
                key={`${iconClass}-${choice.uri}`}
                className={`poiesis-agent-window__repository-option${selected ? ' selected' : ''}`}
                onClick={() => this.selectRepository(session, choice.uri)}
            >
                <span className={`codicon ${iconClass}`} aria-hidden='true' />
                <span><strong>{choice.name}</strong><small>{choice.path}</small></span>
                {selected && <span className='codicon codicon-check' aria-hidden='true' />}
            </button>
        );
    }

    protected renderResults(session: WindowAgentSession | undefined): React.ReactNode {
        const resultsTasks = [...this.finishedTasks(session)].reverse();
        const selectedTask = resultsTasks.find(task => task.id === session?.selectedResultsTaskId)
            ?? resultsTasks[0];
        const document = selectedTask ? this.resultsService.get(selectedTask.id) : undefined;
        const draft = selectedTask ? session?.resultsDrafts.get(selectedTask.id) ?? '' : '';
        const notice = selectedTask ? session?.resultsNotices.get(selectedTask.id) : undefined;
        const questionSending = notice?.status === 'sending';
        const questionHistory = selectedTask?.resultsQuestions ?? [];
        const questionPanelExpanded = selectedTask
            ? session?.resultsQaExpanded.get(selectedTask.id) === true
            : false;

        return (
            <section
                id='poiesis-results-panel'
                className='poiesis-results'
                data-task-rail-collapsed={this.resultsTaskRailCollapsed ? 'true' : 'false'}
                role='tabpanel'
                aria-labelledby='poiesis-results-tab'
            >
                <div
                    id='poiesis-results-task-panel'
                    className='poiesis-results__main'
                    role='tabpanel'
                    aria-labelledby={selectedTask ? `poiesis-results-task-tab-${selectedTask.id}` : undefined}
                >
                    <div className='poiesis-results__canvas' aria-label='Results HTML キャンバス'>
                        {!selectedTask && <div className='poiesis-results__empty'>Agent でタスクを完了すると、ここに成果が表示されます。</div>}
                        {selectedTask && this.renderResultsHeader(selectedTask)}
                        {selectedTask?.status === 'failed' && !document && (
                            <div className='poiesis-results__state error' role='alert'>
                                <strong>タスクに失敗しました</strong>
                                <p>{selectedTask.failure?.summary ?? 'Codex がタスクを完了できませんでした。'}</p>
                                <button type='button' onClick={() => void this.retryTask(selectedTask.id)}>再試行</button>
                            </div>
                        )}
                        {selectedTask?.status === 'cancelled' && !document && (
                            <div className='poiesis-results__state cancelled' role='status'>
                                <strong>タスクはキャンセルされました</strong>
                                <p>成果は確定していません。必要なら同じ依頼を再試行できます。</p>
                                <button type='button' onClick={() => void this.retryTask(selectedTask.id)}>再試行</button>
                            </div>
                        )}
                        {selectedTask?.status === 'completed' && selectedTask.changeSet?.error && !document && (
                            <div className='poiesis-results__state error' role='alert'>
                                <strong>変更内容を取得できませんでした</strong>
                                <p>Repository の状態を確認して、タスクを再試行してください。</p>
                                <button type='button' onClick={() => void this.retryTask(selectedTask.id)}>再試行</button>
                            </div>
                        )}
                        {selectedTask && (document?.status === 'generating'
                                || selectedTask.status === 'completed' && !document) && (
                            <div className='poiesis-results__empty' role='status'>成果を作成しています…</div>
                        )}
                        {selectedTask && document?.status === 'failed' && (
                            <div className='poiesis-results__state error' role='alert'>
                                <strong>成果を作成できませんでした</strong>
                                <p>Results skill の処理に失敗しました。</p>
                                <button type='button' onClick={() => void this.retryResults(selectedTask.id)}>再試行</button>
                            </div>
                        )}
                        {selectedTask && document?.status === 'ready' && document.html && (
                            <iframe
                                key={`${selectedTask?.id}-${this.allowExternalResultsResources ? 'external' : 'isolated'}`}
                                className='poiesis-results__document'
                                title={`${selectedTask?.title}の成果`}
                                sandbox='allow-scripts'
                                srcDoc={this.resultsDocumentHtml(document.html)}
                            />
                        )}
                    </div>
                    {selectedTask && (questionHistory.length > 0 || questionSending)
                        && this.renderResultsQuestionPanel(
                            selectedTask,
                            questionHistory,
                            questionSending ? notice : undefined,
                            questionPanelExpanded
                        )}
                    <section className='poiesis-results__composer' aria-label='Results の入力欄'>
                        <PoiesisComposer
                            key={selectedTask?.id ?? 'no-results-task'}
                            value={draft}
                            placeholder='この結果について質問…'
                            aria-label='表示中の成果について質問'
                            rows={2}
                            maxLength={4_000}
                            disabled={!selectedTask || document?.status !== 'ready' || questionSending}
                            onValueChange={value => selectedTask && this.setResultsDraft(selectedTask.id, value)}
                            onSubmit={() => selectedTask && void this.submitResultsQuestion(selectedTask.id)}
                        />
                        <button
                            type='button'
                            className='poiesis-results__send'
                            aria-label='Results 内へ送信'
                            disabled={!selectedTask || document?.status !== 'ready' || questionSending || !draft.trim()}
                            onClick={() => selectedTask && void this.submitResultsQuestion(selectedTask.id)}
                        >
                            <span className='codicon codicon-arrow-up' aria-hidden='true' />
                        </button>
                        {selectedTask && document?.status === 'ready' && this.renderAiRolePill('results', true)}
                    </section>
                </div>
                <aside
                    className='poiesis-results__task-switcher'
                    data-collapsed={this.resultsTaskRailCollapsed ? 'true' : 'false'}
                    aria-label='同じセッションの実行タスク'
                >
                    {this.resultsTaskRailCollapsed ? (
                        <button
                            type='button'
                            className='poiesis-agent-window__rail-toggle poiesis-results__task-switcher-collapsed-button'
                            title='タスクレールを展開'
                            aria-label='タスクレールを展開'
                            aria-expanded='false'
                            aria-controls='poiesis-results-task-list'
                            onClick={() => this.toggleResultsTaskRail()}
                        >
                            <span className='poiesis-results__task-count' aria-label={`タスク ${resultsTasks.length}件`}>
                                {resultsTasks.length}
                            </span>
                            <span className='codicon codicon-layout-sidebar-right' aria-hidden='true' />
                        </button>
                    ) : <>
                        <div className='poiesis-results__task-switcher-header'>
                            <strong>タスク</strong>
                            <div className='poiesis-results__task-switcher-header-actions'>
                                <span className='poiesis-results__task-count'>{resultsTasks.length}</span>
                                <button
                                    type='button'
                                    className='poiesis-agent-window__rail-toggle poiesis-results__task-switcher-toggle'
                                    title='タスクレールを折りたたむ'
                                    aria-label='タスクレールを折りたたむ'
                                    aria-expanded='true'
                                    aria-controls='poiesis-results-task-list'
                                    onClick={() => this.toggleResultsTaskRail()}
                                >
                                    <span className='codicon codicon-layout-sidebar-right-off' aria-hidden='true' />
                                </button>
                            </div>
                        </div>
                        <div id='poiesis-results-task-list' className='poiesis-results__task-list' role='tablist'>
                        {resultsTasks.map((task, index) => {
                            const confirmingDelete = this.deleteTaskConfirmationId === task.id;
                            const finalizing = this.taskService.isFinalizing(task.id);
                            const state = task.status === 'cancelled' ? 'キャンセル' : task.status === 'failed' ? '失敗' : '完了';
                            const time = task.endedAt ? this.taskFinishedTime(task) : '';
                            return (
                                <div
                                    key={task.id}
                                    role='presentation'
                                    className='poiesis-results__task-row'
                                >
                                    <button
                                        id={`poiesis-results-task-tab-${task.id}`}
                                        type='button'
                                        role='tab'
                                        aria-selected={selectedTask?.id === task.id}
                                        aria-controls='poiesis-results-task-panel'
                                        tabIndex={selectedTask?.id === task.id ? 0 : -1}
                                        className={`poiesis-results__task-select${selectedTask?.id === task.id ? ' active' : ''}`}
                                        onClick={() => this.selectResultsTask(task.id)}
                                    >
                                        <small>
                                            {index === 0 ? '最新 · ' : ''}{state}
                                            {time ? ` · ${time}` : ''}
                                        </small>
                                        <span title={task.title}>{task.title}</span>
                                    </button>
                                    {finalizing ? null : confirmingDelete ? (
                                        <div className='poiesis-results__task-delete-confirm' role='group' aria-label={`${task.title}の削除を確認`}>
                                            <span>削除しますか？</span>
                                            <button type='button' className='danger' onClick={() => void this.deleteResultsTask(task.id)}>削除</button>
                                            <button type='button' onClick={() => this.cancelDeleteResultsTask()}>戻る</button>
                                        </div>
                                    ) : (
                                        <button
                                            type='button'
                                            className='poiesis-results__task-delete'
                                            aria-label={`${task.title}を削除`}
                                            title='タスクを削除'
                                            onClick={() => this.beginDeleteResultsTask(task.id)}
                                        >
                                            <span className='codicon codicon-close' aria-hidden='true' />
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                        {!resultsTasks.length && <p>完了したタスクはありません。</p>}
                    </>}
                </aside>
            </section>
        );
    }

    protected renderResultsHeader(task: ExecutionTask): React.ReactNode {
        const diffstat = summarizeTaskChangeSet(task.changeSet);
        const status = task.status === 'completed' ? '完了' : task.status === 'failed' ? '失敗' : 'キャンセル';
        const completedAtJst = formatTaskEndedAtJst(task.endedAt);
        return (
            <header className='poiesis-results__fixed-header' data-task-status={task.status}>
                <div className='poiesis-results__fixed-title'>
                    <small>実行結果</small>
                    <h1 data-task-title={task.title}>{task.title}</h1>
                </div>
                <div className='poiesis-results__fixed-meta' aria-label='タスクの状態と変更規模'>
                    <span className={`poiesis-results__status ${task.status}`}>{status}</span>
                    {completedAtJst && <time dateTime={task.endedAt}>{completedAtJst}</time>}
                    <span className='poiesis-results__diffstat'>
                        <b>{diffstat.fileCount}ファイル</b>
                        <ins>+{diffstat.additions}</ins>
                        <del>−{diffstat.deletions}</del>
                    </span>
                </div>
            </header>
        );
    }

    protected renderResultsQuestionPanel(
        task: ExecutionTask,
        history: readonly TaskResultsQuestion[],
        pending: ResultsNotice | undefined,
        expanded: boolean
    ): React.ReactNode {
        const questionCount = history.length + (pending ? 1 : 0);
        const panelBodyId = `poiesis-results-qa-panel-${task.id}`;
        return (
            <section
                className={`poiesis-results__qa-panel${expanded ? ' expanded' : ' collapsed'}`}
                aria-label={`${task.title}への質問パネル`}
                data-results-task-id={task.id}
            >
                <button
                    type='button'
                    className='poiesis-results__qa-toggle'
                    aria-controls={panelBodyId}
                    aria-expanded={expanded}
                    aria-label={expanded ? '質問パネルをたたむ' : '質問パネルを展開'}
                    onClick={() => this.setResultsQuestionPanelExpanded(task.id, !expanded)}
                >
                    <span className='poiesis-results__qa-toggle-title'>
                        <span className='codicon codicon-comment-discussion' aria-hidden='true' />
                        <strong>質問 {questionCount}件</strong>
                    </span>
                    <span className='poiesis-results__qa-toggle-action'>
                        {expanded ? 'たたむ' : '表示'}
                        <span className={`codicon codicon-chevron-${expanded ? 'down' : 'up'}`} aria-hidden='true' />
                    </span>
                </button>
                {expanded && (
                    <div
                        id={panelBodyId}
                        className='poiesis-results__qa-history'
                        aria-label={`${task.title}への質問履歴`}
                    >
                        {history.map((entry, index) => (
                            <article className={`poiesis-results__qa-entry${entry.error ? ' failed' : ''}`} key={`${entry.timestamp}-${index}`}>
                                <div className='poiesis-results__qa-meta'>
                                    <strong>質問</strong>
                                    <time dateTime={entry.timestamp}>{this.questionTime(entry.timestamp)}</time>
                                </div>
                                <p>{entry.question}</p>
                                <div className='poiesis-results__qa-response'>
                                    <strong>{entry.error ? '回答に失敗' : '回答'}</strong>
                                    {entry.error
                                        ? <p>{entry.error}</p>
                                        : this.renderMarkdown(entry.answer ?? '')}
                                    {entry.error && (
                                        <button type='button' onClick={() => void this.submitResultsQuestion(task.id, entry.question)}>再試行</button>
                                    )}
                                </div>
                            </article>
                        ))}
                        {pending && (
                            <article className='poiesis-results__qa-entry sending' role='status' aria-live='polite'>
                                <div className='poiesis-results__qa-meta'>
                                    <strong>質問</strong>
                                    <span>送信中</span>
                                </div>
                                <p>{pending.question}</p>
                                <div className='poiesis-results__qa-response'>
                                    <strong>回答</strong>
                                    <p className='poiesis-results__qa-sending'>
                                        <span className='codicon codicon-loading codicon-modifier-spin' aria-hidden='true' />
                                        回答を作成しています…
                                    </p>
                                </div>
                            </article>
                        )}
                    </div>
                )}
            </section>
        );
    }

    protected questionTime(timestamp: string): string {
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) {
            return '';
        }
        return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    }

    protected renderAgentMessage(session: WindowAgentSession | undefined, message: ChatMessage): React.ReactNode {
        const workspaceUri = session?.workspaceUri ?? this.workspaceRoot()?.resource.toString();
        const messageKey = `${session?.id ?? 'workspace'}:${message.id}`;
        const signature = `${workspaceUri ?? ''}\0${message.content}`;
        const richContent = this.agentRichContent.get(messageKey);
        if (message.complete && workspaceUri && richContent?.signature !== signature
            && this.agentRichContentPending.get(messageKey) !== signature) {
            this.agentRichContentPending.set(messageKey, signature);
            queueMicrotask(() => void this.prepareAgentRichContent(messageKey, signature, message.content, workspaceUri));
        }
        const current = richContent?.signature === signature ? richContent : undefined;
        return (
            <>
                {this.renderMarkdown(message.content, current?.imageSources, workspaceUri)}
                {current?.htmlPreviews.map((preview, index) => this.renderAgentHtmlPreview(messageKey, preview, index))}
            </>
        );
    }

    protected renderMarkdown(
        content: string,
        workspaceImageSources?: ReadonlyMap<string, string>,
        explicitWorkspaceUri?: string
    ): React.ReactNode {
        const workspaceUri = explicitWorkspaceUri ?? this.workspaceRoot()?.resource.toString();
        return (
            <div
                className='poiesis-markdown'
                onClick={event => this.handleMarkdownClick(event)}
                onErrorCapture={event => this.handleMarkdownImageError(event)}
                dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(content, workspaceUri, workspaceImageSources) }}
            />
        );
    }

    protected renderAgentHtmlPreview(messageKey: string, preview: AgentHtmlPreview, index: number): React.ReactNode {
        const previewKey = `${messageKey}:${preview.uri}`;
        const expanded = this.agentHtmlPreviewExpanded.get(previewKey) ?? index === 0;
        return (
            <section className={`poiesis-agent-html-preview${expanded ? ' expanded' : ' collapsed'}`} key={preview.uri}>
                <header className='poiesis-agent-html-preview__header'>
                    <button
                        type='button'
                        className='poiesis-agent-html-preview__toggle'
                        aria-expanded={expanded}
                        aria-label={`${preview.fileName} のプレビューを${expanded ? 'たたむ' : '展開'}`}
                        onClick={() => {
                            this.agentHtmlPreviewExpanded.set(previewKey, !expanded);
                            this.update();
                        }}
                    >
                        <span className={`codicon codicon-chevron-${expanded ? 'down' : 'right'}`} aria-hidden='true' />
                        <strong>{preview.fileName}</strong>
                    </button>
                    <div className='poiesis-agent-html-preview__actions'>
                        <button
                            type='button'
                            title='プレビューを再読み込み'
                            aria-label={`${preview.fileName} のプレビューを再読み込み`}
                            onClick={() => void this.reloadAgentHtmlPreview(messageKey, preview.uri)}
                        >
                            <span className='codicon codicon-refresh' aria-hidden='true' />
                        </button>
                        <button
                            type='button'
                            className='poiesis-agent-html-preview__open-code'
                            aria-label={`${preview.fileName} を Code で開く`}
                            onClick={() => void this.openMarkdownFile(preview.uri)}
                        >
                            Code で開く
                        </button>
                    </div>
                </header>
                {expanded && (
                    <iframe
                        key={`${preview.uri}:${preview.revision}`}
                        className='poiesis-agent-html-preview__frame'
                        title={`${preview.fileName} のHTMLプレビュー`}
                        sandbox='allow-scripts'
                        referrerPolicy='no-referrer'
                        srcDoc={this.agentHtmlPreviewDocument(preview.html)}
                    />
                )}
            </section>
        );
    }

    protected async prepareAgentRichContent(
        messageKey: string,
        signature: string,
        content: string,
        workspaceUri: string
    ): Promise<void> {
        const references = collectWorkspaceRichContentReferences(content, workspaceUri);
        const workspace = new URI(workspaceUri).normalizePath();
        const imageSources = new Map<string, string>();
        const htmlPreviews: AgentHtmlPreview[] = [];
        await Promise.all(references.imageUris.map(async file => {
            try {
                const stat = await this.fileService.resolve(file);
                if (!stat.isFile || !workspace.isEqualOrParent(file, false)) {
                    return;
                }
                const contentResult = await this.fileService.readFile(file);
                const blob = new Blob([contentResult.value.buffer as BlobPart], { type: this.agentImageMimeType(file) });
                imageSources.set(file.toString(), URL.createObjectURL(blob));
            } catch {
                // Missing and unreadable image targets stay as ordinary file links.
            }
        }));
        for (const file of references.htmlUris) {
            const preview = await this.readAgentHtmlPreview(file, workspace);
            if (preview) {
                htmlPreviews.push(preview);
            }
        }
        if (this.agentRichContentPending.get(messageKey) !== signature) {
            this.revokeAgentImageSources(imageSources);
            return;
        }
        const previous = this.agentRichContent.get(messageKey);
        if (previous) {
            this.revokeAgentImageSources(previous.imageSources);
        }
        this.agentRichContent.set(messageKey, { signature, workspaceUri, imageSources, htmlPreviews });
        this.agentRichContentPending.delete(messageKey);
        this.update();
    }

    protected async readAgentHtmlPreview(file: URI, workspace: URI): Promise<AgentHtmlPreview | undefined> {
        try {
            const normalized = file.withQuery('').withFragment('').normalizePath();
            if (!workspace.isEqualOrParent(normalized, false) || !/\.html?$/i.test(normalized.path.base)) {
                return undefined;
            }
            const stat = await this.fileService.resolve(normalized);
            if (!stat.isFile) {
                return undefined;
            }
            const content = await this.fileService.readFile(normalized);
            return {
                uri: normalized.toString(),
                fileName: normalized.path.base,
                html: content.value.toString(),
                revision: Date.now()
            };
        } catch {
            return undefined;
        }
    }

    protected async reloadAgentHtmlPreview(messageKey: string, rawUri: string): Promise<void> {
        const current = this.agentRichContent.get(messageKey);
        if (!current) {
            return;
        }
        const workspace = new URI(current.workspaceUri).normalizePath();
        const preview = await this.readAgentHtmlPreview(new URI(rawUri), workspace);
        if (!preview || this.agentRichContent.get(messageKey) !== current) {
            this.messageService.error('HTMLプレビューを再読み込みできませんでした。');
            return;
        }
        current.htmlPreviews = current.htmlPreviews.map(item => item.uri === preview.uri ? preview : item);
        this.update();
    }

    protected agentHtmlPreviewDocument(html: string): string {
        const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'">`;
        if (/<head(?:\s[^>]*)?>/i.test(html)) {
            return html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}\n  ${policy}`);
        }
        if (/<html(?:\s[^>]*)?>/i.test(html)) {
            return html.replace(/<html(?:\s[^>]*)?>/i, match => `${match}\n<head>${policy}</head>`);
        }
        return `${policy}\n${html}`;
    }

    protected agentImageMimeType(file: URI): string {
        const extension = file.path.ext.toLocaleLowerCase();
        switch (extension) {
            case '.jpg':
            case '.jpeg': return 'image/jpeg';
            case '.gif': return 'image/gif';
            case '.webp': return 'image/webp';
            case '.svg': return 'image/svg+xml';
            default: return 'image/png';
        }
    }

    protected revokeAgentImageSources(sources: ReadonlyMap<string, string>): void {
        for (const source of sources.values()) {
            URL.revokeObjectURL(source);
        }
    }

    protected disposeAgentRichContentForSession(sessionId: string): void {
        const prefix = `${sessionId}:`;
        for (const [messageKey, content] of this.agentRichContent) {
            if (messageKey.startsWith(prefix)) {
                this.revokeAgentImageSources(content.imageSources);
                this.agentRichContent.delete(messageKey);
            }
        }
        for (const messageKey of this.agentRichContentPending.keys()) {
            if (messageKey.startsWith(prefix)) {
                this.agentRichContentPending.delete(messageKey);
            }
        }
        for (const previewKey of this.agentHtmlPreviewExpanded.keys()) {
            if (previewKey.startsWith(prefix)) {
                this.agentHtmlPreviewExpanded.delete(previewKey);
            }
        }
    }

    protected handleMarkdownImageError(event: React.SyntheticEvent<HTMLElement>): void {
        const image = event.target;
        if (!(image instanceof HTMLImageElement) || !image.hasAttribute(POIESIS_INLINE_IMAGE_ATTRIBUTE)) {
            return;
        }
        const anchor = image.closest(`a[${POIESIS_FILE_LINK_ATTRIBUTE}]`);
        if (!anchor) {
            image.remove();
            return;
        }
        const code = document.createElement('code');
        code.textContent = image.alt || anchor.getAttribute('title') || 'image';
        image.replaceWith(code);
    }

    protected handleMarkdownClick(event: React.MouseEvent<HTMLElement>): void {
        const target = event.target instanceof Element ? event.target.closest('a') : undefined;
        if (!(target instanceof HTMLAnchorElement)) {
            return;
        }
        const fileUri = target.getAttribute(POIESIS_FILE_LINK_ATTRIBUTE);
        const externalUri = target.getAttribute(POIESIS_EXTERNAL_LINK_ATTRIBUTE);
        if (!fileUri && !externalUri) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (fileUri) {
            try {
                const citationSuffix = target.nextSibling?.textContent?.match(/^:(\d+)(?:\s*[-–—]\s*(\d+))?/);
                const citationPath = target.textContent?.trim().replace(/\\/g, '/');
                if (citationSuffix && citationPath && !citationPath.startsWith('/') && !/^[A-Za-z]:/.test(citationPath)) {
                    void this.openResultsCitation(
                        `${citationPath}:${citationSuffix[1]}${citationSuffix[2] ? `-${citationSuffix[2]}` : ''}`
                    );
                } else {
                    void this.openMarkdownFile(decodeURIComponent(fileUri));
                }
            } catch {
                return;
            }
        } else if (externalUri) {
            void open(this.openerService, new URI(externalUri)).catch(error => {
                console.error(`Poiesis could not open the external Agent link: ${externalUri}`, error);
            });
        }
    }

    protected async openMarkdownFile(rawUri: string): Promise<void> {
        try {
            const workspace = this.workspaceRoot()?.resource.normalizePath();
            const file = new URI(rawUri).withQuery('').withFragment('').normalizePath();
            if (!workspace?.isEqualOrParent(file, false) || !await this.fileService.exists(file)) {
                return;
            }
            await this.openCodeFile(file.toString());
        } catch (error) {
            console.error(`Poiesis could not open the Agent file link: ${rawUri}`, error);
        }
    }

    protected renderCode(): React.ReactNode {
        const sidebarLabels: Record<CodeSidebarTab, string> = {
            files: 'Explorer',
            search: 'Search',
            git: 'Source Control',
            extensions: 'Extensions'
        };
        return (
            <section
                className='poiesis-agent-window__code'
                aria-label='Code モード'
                style={{ '--poiesis-code-sidebar-width': `${this.codeSidebarWidth}px` } as React.CSSProperties}
            >
                <nav className='poiesis-agent-window__code-activity' aria-label='Code Activity Bar'>
                    <div className='poiesis-agent-window__code-activity-main'>
                        {this.renderCodeActivity('files', 'files', 'Explorer')}
                        {this.renderCodeActivity('search', 'search', 'Search')}
                        {this.renderCodeActivity('git', 'source-control', 'Source Control')}
                        {this.renderCodeActivity('extensions', 'extensions', 'Extensions')}
                    </div>
                    <div className='poiesis-agent-window__code-activity-footer'>
                        <button type='button' title='設定' aria-label='設定' onClick={() => this.openSettings()}>
                            <span className='codicon codicon-settings-gear' aria-hidden='true' />
                        </button>
                    </div>
                </nav>
                <aside
                    className={`poiesis-agent-window__code-sidebar${this.codeSidebarTab === 'files' ? ' explorer' : ''}`}
                    aria-label='Code のサイドバー'
                >
                    <div className='poiesis-agent-window__code-sidebar-title'>
                        <span>{sidebarLabels[this.codeSidebarTab]}</span>
                        <div className='poiesis-agent-window__code-sidebar-actions'>
                            {this.codeSidebarTab === 'files' && (
                                <React.Fragment>
                                    {this.renderExplorerAction('new-file', 'New File', FileNavigatorCommands.NEW_FILE_TOOLBAR.id)}
                                    {this.renderExplorerAction('new-folder', 'New Folder', FileNavigatorCommands.NEW_FOLDER_TOOLBAR.id)}
                                    {this.renderExplorerAction('refresh', 'Refresh Explorer', FileNavigatorCommands.REFRESH_NAVIGATOR.id)}
                                    {this.renderExplorerAction('collapse-all', 'Collapse Folders', FileNavigatorCommands.COLLAPSE_ALL.id)}
                                </React.Fragment>
                            )}
                            {this.codeSidebarTab === 'search' && (
                                <React.Fragment>
                                    {this.renderSearchAction('refresh', 'Refresh Search Results', SearchInWorkspaceCommands.REFRESH_RESULTS.id)}
                                    {this.renderSearchAction('clear-all', 'Clear Search Results', SearchInWorkspaceCommands.CLEAR_ALL.id)}
                                    {this.renderSearchAction('collapse-all', 'Collapse All Search Results', SearchInWorkspaceCommands.COLLAPSE_ALL.id)}
                                </React.Fragment>
                            )}
                            {this.codeSidebarTab === 'git' && (
                                <button
                                    type='button'
                                    title='Refresh Source Control'
                                    aria-label='Refresh Source Control'
                                    onClick={() => void this.commandService.executeCommand('git.refresh')}
                                >
                                    <span className='codicon codicon-refresh' aria-hidden='true' />
                                </button>
                            )}
                            {this.codeSidebarTab === 'files' && (
                                <div className='poiesis-agent-window__code-explorer-more'>
                                    <button
                                        type='button'
                                        title='More Actions'
                                        aria-label='More Actions'
                                        aria-haspopup='menu'
                                        aria-expanded={this.explorerMoreVisible}
                                        onClick={() => {
                                            this.explorerMoreVisible = !this.explorerMoreVisible;
                                            this.update();
                                        }}
                                    >
                                        <span className='codicon codicon-ellipsis' aria-hidden='true' />
                                    </button>
                                    {this.explorerMoreVisible && this.renderExplorerMoreMenu()}
                                </div>
                            )}
                        </div>
                    </div>
                    {this.codeSidebarTab === 'files' && (
                        <div className='poiesis-agent-window__code-explorer-root'>
                            <span className='codicon codicon-chevron-down' aria-hidden='true' />
                            <strong>{this.workspaceFolderName()}</strong>
                        </div>
                    )}
                    {this.codeSidebarTab === 'git' ? (
                        <div className={`poiesis-agent-window__code-source-control${this.codeGitGraphExpanded ? ' graph-expanded' : ''}`}>
                            <div className='poiesis-agent-window__code-sidebar-host' ref={this.setCodeSidebarHost} />
                            <button
                                type='button'
                                className='poiesis-agent-window__code-git-graph-title'
                                aria-controls='poiesis-code-git-graph'
                                aria-expanded={this.codeGitGraphExpanded}
                                onClick={() => {
                                    this.codeGitGraphExpanded = !this.codeGitGraphExpanded;
                                    this.update();
                                }}
                            >
                                <span
                                    className={`codicon codicon-chevron-${this.codeGitGraphExpanded ? 'down' : 'right'}`}
                                    aria-hidden='true'
                                />
                                <strong>Graph</strong>
                            </button>
                            <div
                                id='poiesis-code-git-graph'
                                className='poiesis-agent-window__code-git-graph-host'
                                aria-hidden={!this.codeGitGraphExpanded}
                                hidden={!this.codeGitGraphExpanded}
                                ref={this.setCodeGitGraphHost}
                            />
                        </div>
                    ) : (
                        <div className='poiesis-agent-window__code-sidebar-host' ref={this.setCodeSidebarHost} />
                    )}
                    <div
                        className='poiesis-agent-window__code-sidebar-resize'
                        role='separator'
                        aria-label='Explorerの幅を変更'
                        aria-orientation='vertical'
                        aria-valuemin={MIN_CODE_SIDEBAR_WIDTH}
                        aria-valuemax={MAX_CODE_SIDEBAR_WIDTH}
                        aria-valuenow={this.codeSidebarWidth}
                        tabIndex={0}
                        onPointerDown={event => this.startCodeSidebarResize(event)}
                        onDoubleClick={() => this.setCodeSidebarWidth(DEFAULT_CODE_SIDEBAR_WIDTH)}
                        onKeyDown={event => {
                            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                                event.preventDefault();
                                this.setCodeSidebarWidth(this.codeSidebarWidth + (event.key === 'ArrowLeft' ? -12 : 12));
                            }
                        }}
                    />
                </aside>
                <main className='poiesis-agent-window__code-editor' aria-label='Editor'>
                    <div
                        className='poiesis-agent-window__code-editor-tabs'
                        role='tablist'
                        aria-label='開いているEditor'
                    >
                        {this.codeCenterWidgets.map(widget => {
                            const active = this.activeCodeCenterWidget === widget;
                            const dirty = Saveable.isDirty(widget);
                            const preview = this.previewCodeCenterWidget === widget;
                            const label = this.codeCenterWidgetLabel(widget);
                            return (
                                <div
                                    key={widget.id}
                                    className={`poiesis-agent-window__code-editor-tab${active ? ' active' : ''}${dirty ? ' dirty' : ''}${preview ? ' preview' : ''}`}
                                    data-code-widget-id={widget.id}
                                    data-preview={preview}
                                    onDoubleClick={() => this.pinCodeCenterWidget(widget)}
                                    onAuxClick={event => {
                                        if (event.button === 1) {
                                            event.preventDefault();
                                            void this.closeCodeCenterWidget(widget);
                                        }
                                    }}
                                >
                                    <button
                                        type='button'
                                        role='tab'
                                        aria-selected={active}
                                        tabIndex={active ? 0 : -1}
                                        title={widget.title.caption || label}
                                        className='poiesis-agent-window__code-editor-tab-label'
                                        onClick={() => this.selectCodeCenterWidget(widget)}
                                        onKeyDown={event => this.handleCodeTabKeyDown(event, widget)}
                                    >
                                        {widget.title.iconClass && <span className={widget.title.iconClass} aria-hidden='true' />}
                                        <span className='poiesis-agent-window__code-editor-tab-name'>{label}</span>
                                    </button>
                                    <button
                                        type='button'
                                        className='poiesis-agent-window__code-editor-tab-close'
                                        title='Close'
                                        aria-label={`${label}を閉じる`}
                                        onClick={() => void this.closeCodeCenterWidget(widget)}
                                    >
                                        {dirty && <span className='codicon codicon-circle-filled poiesis-agent-window__code-editor-tab-dirty' aria-hidden='true' />}
                                        <span className='codicon codicon-close poiesis-agent-window__code-editor-tab-close-icon' aria-hidden='true' />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                    <div
                        className={`poiesis-agent-window__code-editor-stack${this.codePanelVisible ? '' : ' panel-collapsed'}`}
                        style={{ '--poiesis-code-panel-height': `${this.codePanelHeight}px` } as React.CSSProperties}
                    >
                        <div className='poiesis-agent-window__code-editor-host' ref={this.setCodeEditorHost}>
                            {!this.activeCodeCenterWidget && (
                                <div className='poiesis-agent-window__code-empty'>ファイルを開いて編集を開始</div>
                            )}
                        </div>
                        {this.codePanelVisible && (
                            <section className='poiesis-agent-window__code-panel' aria-label='Bottom Panel'>
                                <div
                                    className='poiesis-agent-window__code-panel-resize'
                                    role='separator'
                                    aria-label='Resize Terminal Panel'
                                    aria-orientation='horizontal'
                                    aria-valuemin={MIN_CODE_PANEL_HEIGHT}
                                    aria-valuenow={this.codePanelHeight}
                                    tabIndex={0}
                                    onPointerDown={event => this.startCodePanelResize(event)}
                                    onDoubleClick={() => this.setCodePanelHeight(DEFAULT_CODE_PANEL_HEIGHT)}
                                    onKeyDown={event => {
                                        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                                            event.preventDefault();
                                            this.setCodePanelHeight(this.codePanelHeight + (event.key === 'ArrowUp' ? 12 : -12));
                                        }
                                    }}
                                />
                                <div className='poiesis-agent-window__code-panel-tabs'>
                                    <button
                                        type='button'
                                        className='poiesis-agent-window__code-panel-tab active'
                                        aria-pressed='true'
                                        aria-label='ターミナルを選択'
                                        onClick={() => this.codeTerminalWidget?.activate()}
                                    >
                                        TERMINAL
                                    </button>
                                    <span className='poiesis-agent-window__code-panel-spacer' />
                                    {this.codeTerminalWidgets.length > 0 && this.codeTerminalWidget && (
                                        <PoiesisSelect
                                            className='poiesis-agent-window__code-terminal-select'
                                            ariaLabel='Active Terminal'
                                            value={this.codeTerminalWidget.id}
                                            options={this.codeTerminalWidgets.map(terminal => ({
                                                value: terminal.id,
                                                label: this.codeTerminalLabel(terminal)
                                            }))}
                                            onChange={value => this.selectCodeTerminalById(value)}
                                        />
                                    )}
                                    <button type='button' title='New Terminal' aria-label='New Terminal' onClick={() => void this.createCodeTerminal()}>
                                        <span className='codicon codicon-add' aria-hidden='true' />
                                    </button>
                                    <button
                                        type='button'
                                        title='Kill Terminal'
                                        aria-label='Kill Terminal'
                                        disabled={!this.codeTerminalWidget}
                                        onClick={() => this.closeCodeTerminal()}
                                    >
                                        <span className='codicon codicon-trash' aria-hidden='true' />
                                    </button>
                                    <button type='button' title='Close Panel' aria-label='Close Panel' onClick={() => this.toggleCodePanel(false)}>
                                        <span className='codicon codicon-close' aria-hidden='true' />
                                    </button>
                                </div>
                                <div className='poiesis-agent-window__code-terminal-host' ref={this.setCodeTerminalHost} />
                            </section>
                        )}
                    </div>
                </main>
                <footer className='poiesis-agent-window__code-status' aria-label='Status Bar'>
                    <span><span className='codicon codicon-source-control' aria-hidden='true' /> {this.currentGitBranch() ?? 'main'}</span>
                    <span><span className='codicon codicon-sync' aria-hidden='true' /></span>
                    <span><span className='codicon codicon-error' aria-hidden='true' /> 0</span>
                    <span><span className='codicon codicon-warning' aria-hidden='true' /> 0</span>
                    <span className='poiesis-agent-window__code-status-spacer' />
                    <span>UTF-8</span>
                    <span>LF</span>
                    <span>Spaces: 4</span>
                    <span><span className='codicon codicon-bell' aria-hidden='true' /></span>
                    <button
                        type='button'
                        className={this.codePanelVisible ? 'active' : ''}
                        title='Toggle Panel'
                        aria-label='Toggle Panel'
                        aria-expanded={this.codePanelVisible}
                        onClick={() => this.toggleCodePanel()}
                    >
                        <span className='codicon codicon-layout-panel' aria-hidden='true' />
                    </button>
                </footer>
                {this.renderCodeCenterCloseDialog()}
            </section>
        );
    }

    protected renderCodeCenterCloseDialog(): React.ReactNode {
        const widget = this.pendingCodeCenterClose;
        if (!widget) {
            return undefined;
        }
        const label = this.codeCenterWidgetLabel(widget);
        return (
            <div
                className='poiesis-agent-window__code-close-overlay'
                onKeyDown={event => {
                    if (event.key === 'Escape' && !this.pendingCodeCenterCloseBusy) {
                        event.preventDefault();
                        this.cancelCodeCenterClose();
                    }
                }}
            >
                <section
                    className='poiesis-agent-window__code-close-dialog'
                    role='dialog'
                    aria-modal='true'
                    aria-labelledby='poiesis-code-close-title'
                >
                    <header>
                        <h2 id='poiesis-code-close-title'>Save changes to {label}?</h2>
                        <button
                            type='button'
                            title='Cancel'
                            aria-label='Cancel'
                            disabled={this.pendingCodeCenterCloseBusy}
                            onClick={() => this.cancelCodeCenterClose()}
                        >
                            <span className='codicon codicon-close' aria-hidden='true' />
                        </button>
                    </header>
                    <p>Your changes will be lost if you don't save them.</p>
                    <footer>
                        <button
                            type='button'
                            disabled={this.pendingCodeCenterCloseBusy}
                            onClick={() => this.cancelCodeCenterClose()}
                        >
                            Cancel
                        </button>
                        <button
                            type='button'
                            disabled={this.pendingCodeCenterCloseBusy}
                            onClick={() => void this.resolveCodeCenterClose(false)}
                        >
                            Don't Save
                        </button>
                        <button
                            type='button'
                            className='primary'
                            autoFocus
                            disabled={this.pendingCodeCenterCloseBusy}
                            onClick={() => void this.resolveCodeCenterClose(true)}
                        >
                            Save
                        </button>
                    </footer>
                </section>
            </div>
        );
    }

    protected renderCodeActivity(tab: CodeSidebarTab, icon: string, label: string): React.ReactNode {
        return (
            <button
                type='button'
                className={this.codeSidebarTab === tab ? 'active' : ''}
                aria-pressed={this.codeSidebarTab === tab}
                title={label}
                aria-label={label}
                onClick={() => this.selectCodeSidebarTab(tab)}
            >
                <span className={`codicon codicon-${icon}`} aria-hidden='true' />
            </button>
        );
    }

    protected ensureCodeFileIcons(): void {
        if (this.iconThemeService.current === 'none' && this.iconThemeService.getDefinition('theia-file-icons')) {
            this.iconThemeService.current = 'theia-file-icons';
        }
    }

    protected renderExplorerAction(icon: string, label: string, command: string): React.ReactNode {
        return (
            <button
                type='button'
                title={label}
                aria-label={label}
                onClick={() => void this.commandService.executeCommand(command, this.codeFilesWidget)}
            >
                <span className={`codicon codicon-${icon}`} aria-hidden='true' />
            </button>
        );
    }

    protected renderSearchAction(icon: string, label: string, command: string): React.ReactNode {
        return (
            <button
                type='button'
                title={label}
                aria-label={label}
                onClick={() => void this.commandService.executeCommand(command, this.codeSearchWidget)}
            >
                <span className={`codicon codicon-${icon}`} aria-hidden='true' />
            </button>
        );
    }

    protected renderExplorerMoreMenu(): React.ReactNode {
        return (
            <div className='poiesis-agent-window__code-explorer-menu' role='menu' aria-label='Explorer More Actions'>
                {this.renderExplorerMenuItem('Toggle Hidden Files', FileNavigatorCommands.TOGGLE_HIDDEN_FILES.id)}
                {this.renderExplorerMenuItem('Auto Reveal', FileNavigatorCommands.TOGGLE_AUTO_REVEAL.id)}
                <div className='poiesis-agent-window__code-explorer-menu-separator' role='separator' />
                {this.renderExplorerMenuItem('Refresh Explorer', FileNavigatorCommands.REFRESH_NAVIGATOR.id)}
                {this.renderExplorerMenuItem('Collapse Folders', FileNavigatorCommands.COLLAPSE_ALL.id)}
            </div>
        );
    }

    protected renderExplorerMenuItem(label: string, command: string): React.ReactNode {
        return (
            <button
                type='button'
                role='menuitem'
                onClick={() => {
                    this.explorerMoreVisible = false;
                    void this.commandService.executeCommand(command, this.codeFilesWidget);
                    this.update();
                }}
            >
                {label}
            </button>
        );
    }

    registerCodeWidget(factoryId: string, widget: Widget, pinned = false): void {
        let changed = false;
        if (factoryId === AgentWindowWidget.FILES_WIDGET_FACTORY_ID) {
            changed = this.codeFilesWidget !== widget;
            this.codeFilesWidget = widget;
        } else if (factoryId === AgentWindowWidget.SEARCH_WIDGET_FACTORY_ID) {
            changed = this.codeSearchWidget !== widget;
            this.codeSearchWidget = widget;
        } else if (factoryId === AgentWindowWidget.GIT_WIDGET_FACTORY_ID) {
            changed = this.codeGitWidget !== widget;
            this.codeGitWidget = widget;
        } else if (factoryId === AgentWindowWidget.GIT_GRAPH_WIDGET_FACTORY_ID) {
            changed = this.codeGitGraphWidget !== widget;
            this.codeGitGraphWidget = widget;
        } else if (factoryId === AgentWindowWidget.EXTENSIONS_WIDGET_FACTORY_ID) {
            changed = this.codeExtensionsWidget !== widget;
            this.codeExtensionsWidget = widget;
        } else if (this.isCodeCenterWidget(factoryId, widget)
            && !this.codeCenterWidgets.includes(widget)) {
            if (widget instanceof EditorWidget) {
                const uri = widget.editor.uri.toString();
                const shouldPin = pinned || this.pendingPinnedEditorUris.has(uri);
                const existing = this.codeCenterWidgets.find(candidate => candidate instanceof EditorWidget
                    && candidate.editor.uri.toString() === uri);
                if (existing) {
                    if (shouldPin) {
                        this.pinCodeCenterWidget(existing);
                    }
                    this.selectCodeCenterWidget(existing);
                    this.closeDuplicateCodeWidget(widget);
                    return;
                }
                if (!shouldPin) {
                    const previousPreview = this.previewCodeCenterWidget;
                    if (previousPreview && previousPreview !== widget) {
                        if (Saveable.isDirty(previousPreview)) {
                            this.pinCodeCenterWidget(previousPreview);
                        } else {
                            this.previewCodeCenterWidget = undefined;
                            previousPreview.close();
                        }
                    }
                    this.previewCodeCenterWidget = widget;
                }
            }
            this.detachCodeWidget(this.activeCodeCenterWidget);
            this.codeCenterWidgets.push(widget);
            this.activeCodeCenterWidget = widget;
            changed = true;
            const onDisposed = (): void => this.removeCodeCenterWidget(widget);
            const onTitleChanged = (): void => this.update();
            widget.disposed.connect(onDisposed);
            widget.title.changed.connect(onTitleChanged);
            const dirtyListener = Saveable.get(widget)?.onDirtyChanged(() => {
                if (Saveable.isDirty(widget)) {
                    this.pinCodeCenterWidget(widget);
                } else {
                    this.update();
                }
            });
            const listeners = Disposable.create(() => {
                widget.disposed.disconnect(onDisposed);
                widget.title.changed.disconnect(onTitleChanged);
                dirtyListener?.dispose();
            });
            this.codeCenterWidgetListeners.set(widget, listeners);
            this.toDispose.push(listeners);
            requestAnimationFrame(() => this.revealCodeCenterTab(widget));
        }
        if (changed && this.codeMode) {
            this.update();
            this.scheduleCodeWidgetAttachments();
        }
    }

    protected closeDuplicateCodeWidget(widget: Widget): void {
        if (this.pendingDuplicateCodeWidgets.has(widget)) {
            return;
        }
        this.pendingDuplicateCodeWidgets.add(widget);
        requestAnimationFrame(() => {
            this.pendingDuplicateCodeWidgets.delete(widget);
            if (!widget.isDisposed) {
                widget.close();
            }
        });
    }

    protected isCodeCenterWidget(factoryId: string, widget: Widget): boolean {
        return widget instanceof EditorWidget
            || factoryId.startsWith(AgentWindowWidget.EDITOR_WIDGET_FACTORY_ID)
            || factoryId === AgentWindowWidget.SETTINGS_WIDGET_FACTORY_ID;
    }

    protected readonly setCodeSidebarHost = (host: HTMLDivElement | null): void => {
        this.codeSidebarTreeInteractionCleanup?.dispose();
        this.codeSidebarTreeInteractionCleanup = undefined;
        if (!host) {
            this.detachCodeWidget(this.activeCodeSidebarWidget());
            this.codeSidebarResizeObserver?.disconnect();
            this.codeSidebarResizeObserver = undefined;
            this.codeSidebarHost = undefined;
            return;
        }
        this.codeSidebarHost = host;
        this.codeSidebarResizeObserver = new ResizeObserver(() =>
            this.resizeCodeWidget(this.activeCodeSidebarWidget(), host));
        this.codeSidebarResizeObserver.observe(host);
        if (this.codeSidebarTab === 'git') {
            this.codeSidebarTreeInteractionCleanup = this.installCodeSidebarTreeInteractions(host);
        }
        this.scheduleCodeWidgetAttachments();
    };

    protected installCodeSidebarTreeInteractions(host: HTMLDivElement): Disposable {
        let gesture: {
            pointerId: number;
            node: HTMLElement;
            nodeId: string;
            targetCollapsed: boolean;
        } | undefined;
        let suppressClickNodeId: string | undefined;
        let suppressClickTimer: number | undefined;
        let pendingToggleNodeId: string | undefined;
        let pendingToggleCollapsed: boolean | undefined;
        let toggleGeneration = 0;
        let pendingToggleTimers: number[] = [];

        const expandableNode = (target: EventTarget | null): HTMLElement | undefined => {
            if (!(target instanceof Element)) {
                return undefined;
            }
            return target.closest<HTMLElement>('.theia-CompositeTreeNode.theia-ExpandableTreeNode') ?? undefined;
        };
        const expansionToggle = (node: HTMLElement): HTMLElement | undefined =>
            node.querySelector<HTMLElement>('.theia-ExpansionToggle[data-node-id]') ?? undefined;
        const expansionToggleByNodeId = (nodeId: string): HTMLElement | undefined =>
            Array.from(host.querySelectorAll<HTMLElement>('.theia-ExpansionToggle[data-node-id]'))
                .find(toggle => toggle.dataset.nodeId === nodeId);
        const isProtectedControl = (target: EventTarget | null): boolean => target instanceof Element
            && !!target.closest('.theia-ExpansionToggle, .theia-scm-inline-actions-container, button, input, textarea, select, a');
        const clearGesture = (): void => {
            gesture = undefined;
        };
        const clearSuppressedClick = (): void => {
            suppressClickNodeId = undefined;
            if (suppressClickTimer !== undefined) {
                window.clearTimeout(suppressClickTimer);
                suppressClickTimer = undefined;
            }
        };
        const clearPendingToggle = (): void => {
            toggleGeneration++;
            for (const timer of pendingToggleTimers) {
                window.clearTimeout(timer);
            }
            pendingToggleTimers = [];
            pendingToggleNodeId = undefined;
            pendingToggleCollapsed = undefined;
        };
        const onPointerDown = (event: PointerEvent): void => {
            if (event.button === 0 && event.isPrimary && event.pointerType === 'mouse') {
                clearSuppressedClick();
            }
            if (event.button !== 0 || !event.isPrimary || event.pointerType !== 'mouse' || isProtectedControl(event.target)) {
                clearGesture();
                return;
            }
            const node = expandableNode(event.target);
            const toggle = node && expansionToggle(node);
            const nodeId = toggle?.dataset.nodeId;
            if (!node || !nodeId) {
                clearGesture();
                return;
            }
            const currentCollapsed = pendingToggleNodeId === nodeId
                ? pendingToggleCollapsed
                : toggle.classList.contains('theia-mod-collapsed');
            clearPendingToggle();
            window.getSelection()?.removeAllRanges();
            event.preventDefault();
            gesture = {
                pointerId: event.pointerId,
                node,
                nodeId,
                targetCollapsed: !currentCollapsed
            };
            try {
                node.setPointerCapture(event.pointerId);
            } catch {
                // The node can be redrawn while Git finishes registering its actions.
            }
        };
        const onPointerUp = (event: PointerEvent): void => {
            const active = gesture;
            clearGesture();
            if (!active || event.pointerId !== active.pointerId || expandableNode(event.target) !== active.node) {
                return;
            }
            event.preventDefault();
            clearSuppressedClick();
            suppressClickNodeId = active.nodeId;
            suppressClickTimer = window.setTimeout(clearSuppressedClick, 250);
            pendingToggleNodeId = active.nodeId;
            pendingToggleCollapsed = active.targetCollapsed;
            const generation = ++toggleGeneration;
            const applyToggle = (): void => {
                if (generation !== toggleGeneration) {
                    return;
                }
                const toggle = expansionToggleByNodeId(active.nodeId);
                if (toggle && toggle.classList.contains('theia-mod-collapsed') !== active.targetCollapsed) {
                    toggle.click();
                }
            };
            pendingToggleTimers = [50, 200, 500].map((delay, index, delays) => window.setTimeout(() => {
                applyToggle();
                if (index === delays.length - 1 && generation === toggleGeneration) {
                    pendingToggleTimers = [];
                    pendingToggleNodeId = undefined;
                    pendingToggleCollapsed = undefined;
                }
            }, delay));
        };
        const onClick = (event: MouseEvent): void => {
            if (!suppressClickNodeId || (event.target instanceof Element && event.target.closest('.theia-ExpansionToggle'))) {
                return;
            }
            clearSuppressedClick();
            event.preventDefault();
            event.stopImmediatePropagation();
        };

        host.addEventListener('pointerdown', onPointerDown, true);
        host.addEventListener('pointerup', onPointerUp, true);
        host.addEventListener('pointercancel', clearGesture, true);
        host.addEventListener('click', onClick, true);
        return Disposable.create(() => {
            clearGesture();
            clearSuppressedClick();
            clearPendingToggle();
            host.removeEventListener('pointerdown', onPointerDown, true);
            host.removeEventListener('pointerup', onPointerUp, true);
            host.removeEventListener('pointercancel', clearGesture, true);
            host.removeEventListener('click', onClick, true);
        });
    }

    protected readonly setCodeEditorHost = (host: HTMLDivElement | null): void => {
        if (!host) {
            this.codeEditorResizeObserver?.disconnect();
            this.codeEditorResizeObserver = undefined;
            this.codeEditorHost = undefined;
            return;
        }
        this.codeEditorHost = host;
        this.codeEditorResizeObserver = new ResizeObserver(() =>
            this.resizeCodeWidget(this.activeCodeCenterWidget, host));
        this.codeEditorResizeObserver.observe(host);
        this.scheduleCodeWidgetAttachments();
    };

    protected readonly setCodeGitGraphHost = (host: HTMLDivElement | null): void => {
        if (!host) {
            this.codeGitGraphResizeObserver?.disconnect();
            this.codeGitGraphResizeObserver = undefined;
            this.codeGitGraphHost = undefined;
            return;
        }
        this.codeGitGraphHost = host;
        this.codeGitGraphResizeObserver = new ResizeObserver(() =>
            this.resizeCodeWidget(this.codeGitGraphWidget, host));
        this.codeGitGraphResizeObserver.observe(host);
        this.scheduleCodeWidgetAttachments();
    };

    protected readonly setCodeTerminalHost = (host: HTMLDivElement | null): void => {
        if (!host) {
            this.codeTerminalResizeObserver?.disconnect();
            this.codeTerminalResizeObserver = undefined;
            this.codeTerminalHost = undefined;
            return;
        }
        this.codeTerminalHost = host;
        this.codeTerminalResizeObserver = new ResizeObserver(() =>
            this.resizeCodeWidget(this.codeTerminalWidget, host));
        this.codeTerminalResizeObserver.observe(host);
        this.scheduleCodeWidgetAttachments();
    };

    protected activeCodeSidebarWidget(): Widget | undefined {
        if (this.codeSidebarTab === 'files') {
            return this.codeFilesWidget;
        }
        if (this.codeSidebarTab === 'search') {
            return this.codeSearchWidget;
        }
        if (this.codeSidebarTab === 'git') {
            return this.codeGitWidget;
        }
        return this.codeExtensionsWidget;
    }

    protected scheduleCodeWidgetAttachments(): void {
        if (this.codeWidgetAttachmentFrame !== undefined) {
            return;
        }
        this.codeWidgetAttachmentFrame = requestAnimationFrame(() => {
            this.codeWidgetAttachmentFrame = undefined;
            if (this.isDisposed) {
                return;
            }
            this.syncCodeWidgetAttachments();
            if (this.codeMode && this.codePanelVisible && this.codeTerminalHost) {
                void this.ensureCodeTerminal();
            }
        });
    }

    protected syncCodeWidgetAttachments(): void {
        if (!this.codeMode) {
            this.detachCodeWidgets();
            return;
        }
        this.attachCodeWidget(this.activeCodeSidebarWidget(), this.codeSidebarHost);
        if (this.codeSidebarTab === 'git') {
            this.attachCodeWidget(this.codeGitGraphWidget, this.codeGitGraphHost);
        } else {
            this.detachCodeWidget(this.codeGitGraphWidget);
        }
        this.attachCodeWidget(this.activeCodeCenterWidget, this.codeEditorHost);
        if (this.codePanelVisible) {
            this.attachCodeWidget(this.codeTerminalWidget, this.codeTerminalHost);
        } else {
            this.detachCodeWidget(this.codeTerminalWidget);
        }
    }

    protected async ensureCodeTerminal(): Promise<void> {
        if (!this.codeTerminalWidget) {
            if (!this.codeTerminalCreation) {
                this.codeTerminalCreation = this.newCodeTerminal()
                    .then(terminal => {
                        this.registerCodeTerminal(terminal);
                        return terminal;
                    })
                    .finally(() => {
                        this.codeTerminalCreation = undefined;
                    });
            }
            await this.codeTerminalCreation;
        }
        if (this.codeMode && this.codePanelVisible) {
            this.attachCodeWidget(this.codeTerminalWidget, this.codeTerminalHost);
        }
    }

    protected async createCodeTerminal(): Promise<void> {
        const terminal = await this.newCodeTerminal();
        this.registerCodeTerminal(terminal);
        this.codePanelVisible = true;
        this.selectCodeTerminal(terminal);
        this.update();
    }

    protected async newCodeTerminal(): Promise<TerminalWidget> {
        const cwd = this.workspaceService.tryGetRoots()[0]?.resource.toString();
        const terminal = await this.terminalService.newTerminal({ cwd, destroyTermOnClose: true });
        void terminal.start();
        return terminal;
    }

    protected registerCodeTerminal(terminal: TerminalWidget): void {
        if (this.codeTerminalWidgets.includes(terminal)) {
            return;
        }
        this.codeTerminalWidgets.push(terminal);
        this.codeTerminalWidget ??= terminal;
        const onDisposed = (): void => this.removeCodeTerminal(terminal);
        const onTitleChanged = (): void => this.update();
        const closedListener = terminal.onTerminalDidClose(() => this.removeCodeTerminal(terminal));
        terminal.disposed.connect(onDisposed);
        terminal.title.changed.connect(onTitleChanged);
        const listeners = Disposable.create(() => {
            closedListener.dispose();
            terminal.disposed.disconnect(onDisposed);
            terminal.title.changed.disconnect(onTitleChanged);
        });
        this.codeTerminalWidgetListeners.set(terminal, listeners);
        this.toDispose.push(listeners);
        this.update();
    }

    protected removeCodeTerminal(terminal: TerminalWidget): void {
        const index = this.codeTerminalWidgets.indexOf(terminal);
        if (index === -1) {
            return;
        }
        const next = this.codeTerminalWidgets[index + 1] ?? this.codeTerminalWidgets[index - 1];
        if (this.codeTerminalWidget === terminal) {
            this.detachCodeWidget(terminal);
            this.codeTerminalWidget = next;
        }
        this.codeTerminalWidgets.splice(index, 1);
        this.codeTerminalWidgetListeners.get(terminal)?.dispose();
        this.codeTerminalWidgetListeners.delete(terminal);
        if (!this.codeTerminalWidget) {
            this.codePanelVisible = false;
        }
        this.update();
        this.syncCodeWidgetAttachments();
    }

    protected selectCodeTerminalById(id: string): void {
        const terminal = this.codeTerminalWidgets.find(candidate => candidate.id === id);
        if (terminal) {
            this.selectCodeTerminal(terminal);
        }
    }

    protected selectCodeTerminal(terminal: TerminalWidget): void {
        if (this.codeTerminalWidget !== terminal) {
            this.detachCodeWidget(this.codeTerminalWidget);
            this.codeTerminalWidget = terminal;
        }
        this.codePanelVisible = true;
        this.update();
        this.attachCodeWidget(terminal, this.codeTerminalHost);
    }

    protected closeCodeTerminal(): void {
        this.codeTerminalWidget?.close();
    }

    protected codeTerminalLabel(terminal: TerminalWidget): string {
        const index = this.codeTerminalWidgets.indexOf(terminal);
        const label = terminal.title.label || 'Terminal';
        const fileName = label.split(/[\\/]/).pop() || label;
        const basename = fileName.replace(/\.[^.]+$/, '');
        return `${index + 1}: ${basename}`;
    }

    protected toggleCodePanel(visible = !this.codePanelVisible): void {
        if (visible === this.codePanelVisible) {
            return;
        }
        if (!visible) {
            this.detachCodeWidget(this.codeTerminalWidget);
        }
        this.codePanelVisible = visible;
        this.update();
        if (visible) {
            requestAnimationFrame(() => void this.ensureCodeTerminal());
        }
    }

    protected attachCodeWidget(widget: Widget | undefined, host: HTMLDivElement | undefined): void {
        if (!widget || !host) {
            return;
        }
        if (widget.node.parentElement !== host) {
            if (widget.parent) {
                widget.parent = null;
            }
            if (widget.isAttached) {
                Widget.detach(widget);
            }
            Widget.attach(widget, host);
        }
        this.revealCodeWidget(widget, host);
    }

    protected revealCodeWidget(widget: Widget, host: HTMLDivElement): void {
        widget.show();
        widget.update();
        widget.activate();
        this.resizeCodeWidget(widget, host);
        requestAnimationFrame(() => {
            if (!widget.isDisposed && widget.isAttached && widget.node.parentElement === host) {
                widget.show();
                widget.update();
                this.resizeCodeWidget(widget, host);
            }
        });
    }

    protected resizeCodeWidget(widget: Widget | undefined, host: HTMLDivElement): void {
        if (!widget?.isAttached || widget.node.parentElement !== host) {
            return;
        }
        const width = host.clientWidth;
        const height = host.clientHeight;
        MessageLoop.sendMessage(widget, new Widget.ResizeMessage(width, height));
        widget.update();
        if (widget instanceof EditorWidget) {
            widget.editor.resizeToFit();
            widget.editor.refresh();
        }
    }

    protected detachCodeWidget(widget: Widget | undefined): void {
        const parent = widget?.node.parentElement;
        if (widget?.isAttached && (parent === this.codeSidebarHost
            || parent === this.codeGitGraphHost
            || parent === this.codeEditorHost
            || parent === this.codeTerminalHost)) {
            Widget.detach(widget);
        }
    }

    protected detachCodeWidgets(): void {
        this.detachCodeWidget(this.activeCodeSidebarWidget());
        this.detachCodeWidget(this.codeGitGraphWidget);
        this.detachCodeWidget(this.activeCodeCenterWidget);
        this.detachCodeWidget(this.codeTerminalWidget);
    }

    protected selectCodeSidebarTab(tab: CodeSidebarTab): void {
        this.detachCodeWidget(this.activeCodeSidebarWidget());
        this.detachCodeWidget(this.codeGitGraphWidget);
        this.explorerMoreVisible = false;
        this.codeSidebarTab = tab;
        this.update();
        if (tab === 'extensions') {
            void this.ensureCodeExtensionsWidget();
        } else {
            this.scheduleCodeWidgetAttachments();
        }
    }

    protected async ensureCodeExtensionsWidget(): Promise<void> {
        if (!this.codeExtensionsWidget) {
            this.codeExtensionsWidget = await this.widgetManager.getOrCreateWidget(AgentWindowWidget.EXTENSIONS_WIDGET_FACTORY_ID);
        }
        if (!this.codeExtensionsInitialized) {
            this.codeExtensionsInitialized = true;
            if (!this.extensionsSearchModel.query.trim()) {
                this.extensionsSearchModel.query = BUILTIN_QUERY;
            }
        }
        if (this.codeMode && this.codeSidebarTab === 'extensions') {
            this.scheduleCodeWidgetAttachments();
        }
    }

    protected startCodeSidebarResize(event: React.PointerEvent<HTMLDivElement>): void {
        event.preventDefault();
        this.codeSidebarResizeCleanup?.dispose();
        const startX = event.clientX;
        const startWidth = this.codeSidebarWidth;
        const onPointerMove = (moveEvent: PointerEvent): void => {
            this.setCodeSidebarWidth(startWidth + moveEvent.clientX - startX);
        };
        const finish = (): void => {
            this.codeSidebarResizeCleanup?.dispose();
            this.codeSidebarResizeCleanup = undefined;
        };
        document.body.classList.add('poiesis-code-sidebar-resizing');
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', finish, { once: true });
        document.addEventListener('pointercancel', finish, { once: true });
        this.codeSidebarResizeCleanup = Disposable.create(() => {
            document.body.classList.remove('poiesis-code-sidebar-resizing');
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', finish);
            document.removeEventListener('pointercancel', finish);
        });
    }

    protected setCodeSidebarWidth(width: number): void {
        this.codeSidebarWidth = Math.max(MIN_CODE_SIDEBAR_WIDTH, Math.min(MAX_CODE_SIDEBAR_WIDTH, width));
        const code = this.node.querySelector<HTMLElement>('.poiesis-agent-window__code');
        code?.style.setProperty('--poiesis-code-sidebar-width', `${this.codeSidebarWidth}px`);
        this.node.querySelector('.poiesis-agent-window__code-sidebar-resize')
            ?.setAttribute('aria-valuenow', `${this.codeSidebarWidth}`);
    }

    protected startCodePanelResize(event: React.PointerEvent<HTMLDivElement>): void {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        this.codePanelResizeCleanup?.dispose();
        const startY = event.clientY;
        const startHeight = this.codePanelHeight;
        const onPointerMove = (moveEvent: PointerEvent): void => {
            this.setCodePanelHeight(startHeight + startY - moveEvent.clientY);
        };
        const finish = (): void => {
            this.codePanelResizeCleanup?.dispose();
            this.codePanelResizeCleanup = undefined;
        };
        document.body.classList.add('poiesis-code-panel-resizing');
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', finish, { once: true });
        document.addEventListener('pointercancel', finish, { once: true });
        this.codePanelResizeCleanup = Disposable.create(() => {
            document.body.classList.remove('poiesis-code-panel-resizing');
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', finish);
            document.removeEventListener('pointercancel', finish);
        });
    }

    protected setCodePanelHeight(height: number): void {
        const stack = this.node.querySelector<HTMLElement>('.poiesis-agent-window__code-editor-stack');
        const maximum = Math.max(MIN_CODE_PANEL_HEIGHT, (stack?.clientHeight ?? DEFAULT_CODE_PANEL_HEIGHT + 80) - 80);
        this.codePanelHeight = Math.max(MIN_CODE_PANEL_HEIGHT, Math.min(maximum, height));
        stack?.style.setProperty('--poiesis-code-panel-height', `${this.codePanelHeight}px`);
        this.node.querySelector('.poiesis-agent-window__code-panel-resize')
            ?.setAttribute('aria-valuenow', `${this.codePanelHeight}`);
    }

    protected selectCodeCenterWidget(widget: Widget, focusTab = false): void {
        this.detachCodeWidget(this.activeCodeCenterWidget);
        this.activeCodeCenterWidget = widget;
        this.update();
        this.syncCodeWidgetAttachments();
        requestAnimationFrame(() => this.revealCodeCenterTab(widget, focusTab));
    }

    protected pinCodeCenterWidget(widget: Widget): void {
        if (this.previewCodeCenterWidget === widget) {
            this.previewCodeCenterWidget = undefined;
            this.update();
        }
    }

    protected installCodeTabDropTarget(): void {
        const onPointerDown = (event: PointerEvent): void => {
            if (event.button !== 0 || !(event.target instanceof Element)) {
                return;
            }
            const node = event.target.closest<HTMLElement>('#files .theia-FileStatNode[draggable="true"]');
            if (!node || node.classList.contains('theia-ExpandableTreeNode') || !node.title) {
                return;
            }
            this.finishCodeFilePointerDrag();
            const uri = FileUri.create(node.title).toString();
            this.codeFilePointerDrag = {
                pointerId: event.pointerId,
                uri,
                startX: event.clientX,
                startY: event.clientY,
                active: false,
                sourceNode: node
            };
            node.draggable = false;
        };
        const onPointerMove = (event: PointerEvent): void => {
            const drag = this.codeFilePointerDrag;
            if (!drag || drag.pointerId !== event.pointerId) {
                return;
            }
            if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) {
                return;
            }
            drag.active = true;
            event.preventDefault();
            document.body?.classList.add('poiesis-code-file-pointer-drag');
            this.setCodeTabDropActive(!!this.codeTabsAtPoint(event.clientX, event.clientY));
        };
        const onPointerUp = (event: PointerEvent): void => {
            const drag = this.codeFilePointerDrag;
            if (!drag || drag.pointerId !== event.pointerId) {
                return;
            }
            const droppedOnTabs = drag.active && !!this.codeTabsAtPoint(event.clientX, event.clientY);
            if (drag.active) {
                event.preventDefault();
                event.stopPropagation();
                this.suppressNextCodeFileClick = true;
                setTimeout(() => this.suppressNextCodeFileClick = false, 0);
            }
            const uri = drag.uri;
            this.finishCodeFilePointerDrag();
            if (droppedOnTabs) {
                void this.openDraggedCodeFile(uri);
            }
        };
        const onPointerCancel = (event: PointerEvent): void => {
            if (this.codeFilePointerDrag?.pointerId === event.pointerId) {
                this.finishCodeFilePointerDrag();
            }
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape' && this.codeFilePointerDrag?.active) {
                event.preventDefault();
                this.finishCodeFilePointerDrag();
            }
        };
        const onWindowBlur = (): void => this.finishCodeFilePointerDrag();
        const onClick = (event: MouseEvent): void => {
            if (!this.suppressNextCodeFileClick) {
                return;
            }
            this.suppressNextCodeFileClick = false;
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('pointermove', onPointerMove, true);
        document.addEventListener('pointerup', onPointerUp, true);
        document.addEventListener('pointercancel', onPointerCancel, true);
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('click', onClick, true);
        window.addEventListener('blur', onWindowBlur);
        this.toDispose.push(Disposable.create(() => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('pointermove', onPointerMove, true);
            document.removeEventListener('pointerup', onPointerUp, true);
            document.removeEventListener('pointercancel', onPointerCancel, true);
            document.removeEventListener('keydown', onKeyDown, true);
            document.removeEventListener('click', onClick, true);
            window.removeEventListener('blur', onWindowBlur);
            this.finishCodeFilePointerDrag();
        }));
    }

    protected codeTabsAtPoint(clientX: number, clientY: number): HTMLElement | undefined {
        const tabs = this.node.querySelector<HTMLElement>('.poiesis-agent-window__code-editor-tabs');
        if (!tabs) {
            return undefined;
        }
        const bounds = tabs.getBoundingClientRect();
        return clientX >= bounds.left && clientX <= bounds.right
            && clientY >= bounds.top && clientY <= bounds.bottom
            ? tabs
            : undefined;
    }

    protected finishCodeFilePointerDrag(): void {
        const drag = this.codeFilePointerDrag;
        if (drag) {
            drag.sourceNode.draggable = true;
        }
        this.codeFilePointerDrag = undefined;
        document.body?.classList.remove('poiesis-code-file-pointer-drag');
        this.setCodeTabDropActive(false);
    }

    protected setCodeTabDropActive(active: boolean): void {
        this.node.querySelector('.poiesis-agent-window__code-editor-tabs')?.classList.toggle('drop-target', active);
    }

    protected async openDraggedCodeFile(rawUri: string): Promise<void> {
        if (!rawUri) {
            return;
        }
        const uri = new URI(rawUri);
        const uriKey = uri.toString();
        this.pendingPinnedEditorUris.add(uriKey);
        try {
            await this.editorManager.open(uri);
            const opened = this.codeCenterWidgets.find(candidate => candidate instanceof EditorWidget
                && candidate.editor.uri.toString() === uriKey);
            if (opened) {
                this.pinCodeCenterWidget(opened);
                this.selectCodeCenterWidget(opened);
            }
        } finally {
            this.pendingPinnedEditorUris.delete(uriKey);
        }
    }

    protected installCodeEditorSaveShortcut(): void {
        const onKeyDown = (event: KeyboardEvent): void => {
            const savePressed = (event.ctrlKey || event.metaKey)
                && !event.altKey
                && !event.shiftKey
                && (event.key.toLocaleLowerCase() === 's' || event.code === 'KeyS');
            const widget = this.codeMode ? this.activeCodeCenterWidget : undefined;
            if (!savePressed || !widget || !Saveable.get(widget)) {
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            void this.saveableService.save(widget, {
                formatType: FormatType.ON,
                saveReason: SaveReason.Manual
            });
        };
        document.addEventListener('keydown', onKeyDown, true);
        this.toDispose.push(Disposable.create(() => document.removeEventListener('keydown', onKeyDown, true)));
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

    protected installCodeTerminalShortcut(): void {
        const onKeyDown = (event: KeyboardEvent): void => {
            const togglePressed = (event.ctrlKey || event.metaKey)
                && !event.altKey
                && !event.shiftKey
                && (event.key === '`' || event.code === 'Backquote');
            if (!this.codeMode || !togglePressed) {
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            this.toggleCodePanel();
        };
        document.addEventListener('keydown', onKeyDown, true);
        this.toDispose.push(Disposable.create(() => document.removeEventListener('keydown', onKeyDown, true)));
    }

    protected closeCodeCenterWidget(widget: Widget): void {
        if (widget.id === AgentWindowWidget.SETTINGS_WIDGET_FACTORY_ID) {
            this.detachCodeWidget(widget);
            widget.hide();
            this.removeCodeCenterWidget(widget);
            return;
        }
        if (!Saveable.isDirty(widget)) {
            widget.close();
            return;
        }
        this.pendingCodeCenterClose = widget;
        this.pendingCodeCenterCloseBusy = false;
        this.update();
    }

    protected cancelCodeCenterClose(): void {
        if (this.pendingCodeCenterCloseBusy) {
            return;
        }
        this.pendingCodeCenterClose = undefined;
        this.update();
    }

    protected async resolveCodeCenterClose(save: boolean): Promise<void> {
        const widget = this.pendingCodeCenterClose;
        if (!widget || this.pendingCodeCenterCloseBusy) {
            return;
        }
        const saveable = Saveable.get(widget);
        this.pendingCodeCenterCloseBusy = true;
        this.update();
        try {
            if (save) {
                await saveable?.save();
                if (Saveable.isDirty(widget)) {
                    return;
                }
            } else {
                await saveable?.revert?.();
            }
            this.pendingCodeCenterClose = undefined;
            widget.close();
        } finally {
            this.pendingCodeCenterCloseBusy = false;
            this.update();
        }
    }

    protected removeCodeCenterWidget(widget: Widget): void {
        const index = this.codeCenterWidgets.indexOf(widget);
        const nextWidget = index === -1
            ? undefined
            : this.codeCenterWidgets[index + 1] ?? this.codeCenterWidgets[index - 1];
        if (index !== -1) {
            this.codeCenterWidgets.splice(index, 1);
        }
        this.codeCenterWidgetListeners.get(widget)?.dispose();
        this.codeCenterWidgetListeners.delete(widget);
        if (this.previewCodeCenterWidget === widget) {
            this.previewCodeCenterWidget = undefined;
        }
        if (this.pendingCodeCenterClose === widget) {
            this.pendingCodeCenterClose = undefined;
            this.pendingCodeCenterCloseBusy = false;
        }
        if (this.activeCodeCenterWidget === widget) {
            this.activeCodeCenterWidget = nextWidget;
        }
        this.update();
        this.syncCodeWidgetAttachments();
        if (this.activeCodeCenterWidget) {
            requestAnimationFrame(() => this.revealCodeCenterTab(this.activeCodeCenterWidget));
        }
    }

    protected handleCodeTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, widget: Widget): void {
        const index = this.codeCenterWidgets.indexOf(widget);
        if (index === -1 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            return;
        }
        event.preventDefault();
        let nextIndex = index;
        if (event.key === 'ArrowLeft') {
            nextIndex = (index - 1 + this.codeCenterWidgets.length) % this.codeCenterWidgets.length;
        } else if (event.key === 'ArrowRight') {
            nextIndex = (index + 1) % this.codeCenterWidgets.length;
        } else if (event.key === 'Home') {
            nextIndex = 0;
        } else if (event.key === 'End') {
            nextIndex = this.codeCenterWidgets.length - 1;
        }
        this.selectCodeCenterWidget(this.codeCenterWidgets[nextIndex], true);
    }

    protected revealCodeCenterTab(widget: Widget | undefined, focus = false): void {
        if (!widget) {
            return;
        }
        const tab = Array.from(this.node.querySelectorAll<HTMLElement>('.poiesis-agent-window__code-editor-tab'))
            .find(candidate => candidate.dataset.codeWidgetId === widget.id);
        tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        if (focus) {
            tab?.querySelector<HTMLButtonElement>('.poiesis-agent-window__code-editor-tab-label')?.focus();
        }
    }

    protected codeCenterWidgetLabel(widget: Widget): string {
        if (widget.id === AgentWindowWidget.SETTINGS_WIDGET_FACTORY_ID) {
            return 'Settings';
        }
        return widget.title.label || widget.title.caption || 'Editor';
    }

    protected async openCodeSettings(): Promise<void> {
        const settings = await this.widgetManager.getOrCreateWidget(AgentWindowWidget.SETTINGS_WIDGET_FACTORY_ID);
        this.registerCodeWidget(AgentWindowWidget.SETTINGS_WIDGET_FACTORY_ID, settings);
        this.selectCodeCenterWidget(settings);
    }

    protected openSettings(): void {
        this.closeCustomize(false);
        this.settingsModalVisible = true;
        this.shortcutsOverlayVisible = false;
        this.deleteSessionConfirmationId = undefined;
        this.clearDataConfirmation = false;
        this.update();
        void this.refreshCliDetection();
    }

    protected closeSettings(): void {
        this.settingsModalVisible = false;
        this.shortcutsOverlayVisible = false;
        this.deleteSessionConfirmationId = undefined;
        this.clearDataConfirmation = false;
        this.update();
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
    }

    protected closeCustomize(update = true): void {
        this.customizeViewVisible = false;
        if (update) {
            this.update();
        }
    }

    protected handleCustomizeEscape(): void {
        if (this.workspaceSkillDiscardConfirmation) {
            this.cancelWorkspaceSkillClose();
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

    protected openShortcutsOverlay(): void {
        this.shortcutsOverlayVisible = true;
        this.update();
    }

    protected closeShortcutsOverlay(): void {
        this.shortcutsOverlayVisible = false;
        this.update();
    }

    protected showNewSkillForm(): void {
        this.newSkillFormVisible = true;
        this.newSkillId = '';
        this.newSkillKind = 'agent';
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

    protected selectBuiltinSkill(skill: 'bundled-results' | 'ai-results' | undefined): void {
        if (this.workspaceSkillEditor && this.workspaceSkillEditor.content !== this.workspaceSkillEditor.savedContent) {
            this.workspaceSkillDiscardConfirmation = true;
            this.update();
            return;
        }
        this.workspaceSkillEditor = undefined;
        this.workspaceSkillEditorError = undefined;
        this.workspaceSkillDiscardConfirmation = false;
        this.selectedBuiltinSkill = skill;
        this.update();
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
            this.workspaceSkillEditorError = `skill.mdを開けませんでした: ${error instanceof Error ? error.message : String(error)}`;
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
            this.workspaceSkillEditorError = `skill.mdを保存できませんでした: ${error instanceof Error ? error.message : String(error)}`;
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

    protected async refreshWorkspaceSkills(): Promise<void> {
        const generation = ++this.workspaceSkillsRefreshGeneration;
        const root = this.workspaceRoot()?.resource;
        this.workspaceSkillsLoading = true;
        this.workspaceSkillsError = undefined;
        this.update();
        if (!root) {
            this.workspaceSkills = [];
            this.workspaceSkillsLoading = false;
            this.workspaceSkillsError = 'User Skillを表示するにはWorkspaceを開いてください。';
            this.update();
            return;
        }
        try {
            const definitions = await this.workspaceSkillService.list(root);
            if (generation === this.workspaceSkillsRefreshGeneration) {
                this.workspaceSkills = definitions;
            }
        } catch (error) {
            if (generation === this.workspaceSkillsRefreshGeneration) {
                this.workspaceSkills = [];
                this.workspaceSkillsError = `User Skillを読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`;
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
            this.newSkillError = 'Skillを作成するにはWorkspaceを開いてください。';
            this.update();
            return;
        }
        const skillDirectory = root.resolve(`.poiesis/skills/${id}`);
        const skillUri = skillDirectory.resolve('skill.md');
        this.newSkillCreating = true;
        this.newSkillError = undefined;
        this.update();
        try {
            if (await this.fileService.exists(skillUri)) {
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
            await this.openWorkspaceSkillInline(this.workspaceSkillService.parse(id, skillUri, content));
        } catch (error) {
            this.newSkillError = `Skillを作成できませんでした: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            this.newSkillCreating = false;
            this.update();
        }
    }

    protected workspaceSkillTemplate(id: string, kind: SkillBundleKind): string {
        return `---\nname: ${id}\ndescription: このSkillの目的を記述してください\nkind: ${kind}\n---\n\n# ${id}\n\nここにSkillの指示を記述してください。\n`;
    }

    protected async setWorkspaceSkillEnabled(skill: WorkspaceSkillDefinition, enabled: boolean): Promise<void> {
        const previous = skill.enabled;
        skill.enabled = enabled;
        this.update();
        try {
            await this.workspaceSkillService.setEnabled(skill.uri, enabled);
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
            this.workspaceSkillEditorError = `skill.mdをCodeで開けませんでした: ${error instanceof Error ? error.message : String(error)}`;
            this.update();
        }
    }

    protected async openCodeFile(rawUri: string): Promise<void> {
        this.closeCustomize(false);
        if (!this.codeMode) {
            this.ensureCodeFileIcons();
            this.codeMode = true;
            this.update();
            requestAnimationFrame(() => void this.ensureCodeTerminal());
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        } else {
            this.update();
        }
        await this.openDraggedCodeFile(rawUri);
    }

    protected async openTheiaSettings(): Promise<void> {
        this.closeSettings();
        if (!this.codeMode) {
            this.ensureCodeFileIcons();
            this.codeMode = true;
            this.update();
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
        await this.openCodeSettings();
    }

    protected uiFontScaleValue(): number {
        return this.uiFontScale === 'small' ? 0.92 : this.uiFontScale === 'large' ? 1.12 : 1;
    }

    protected setUiFontScale(scale: UiFontScale): void {
        this.uiFontScale = scale;
        this.persistPoiesisSettings();
        this.update();
    }

    protected setRoleCli(role: AiRole, cli: KnownCliId): void {
        const defaultModel = this.cliDetectionReport?.detections.find(detection => detection.id === cli)?.defaultModel ?? '';
        if (role === 'agent') {
            this.agentCli = cli;
            this.agentModel = defaultModel;
        } else {
            this.resultsCli = cli;
            this.resultsModel = defaultModel;
            this.resultsGenerationContext.providerId = cli;
            this.resultsGenerationContext.model = defaultModel;
        }
        this.customModelRoles.delete(role);
        this.persistPoiesisSettings();
        this.update();
    }

    protected roleModel(role: AiRole): string {
        return role === 'agent' ? this.agentModel : this.resultsModel;
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
            this.agentModel = model;
        } else {
            this.resultsModel = model;
            this.resultsGenerationContext.model = model.trim();
        }
        this.persistPoiesisSettings();
        this.update();
    }

    protected setAllowExternalResultsResources(allow: boolean): void {
        this.allowExternalResultsResources = allow;
        this.persistPoiesisSettings();
        this.update();
    }

    protected async refreshCliDetection(): Promise<void> {
        if (this.cliDetectionLoading) {
            return;
        }
        this.cliDetectionLoading = true;
        this.update();
        try {
            this.cliDetectionReport = await this.agentRuntimeServer.detectClis();
            let settingsChanged = false;
            for (const role of ['agent', 'results'] as const) {
                const selected = role === 'agent' ? this.agentCli : this.resultsCli;
                const currentModel = this.roleModel(role);
                const detection = this.cliDetectionReport.detections.find(item => item.id === selected);
                if (!currentModel && detection?.defaultModel) {
                    if (role === 'agent') {
                        this.agentModel = detection.defaultModel;
                    } else {
                        this.resultsModel = detection.defaultModel;
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

    protected async restorePoiesisSettings(): Promise<void> {
        try {
            const state = await this.storageService.getData<Partial<PersistedPoiesisSettings> | LegacyPoiesisSettings>(SETTINGS_STORAGE_KEY);
            if (state?.version === 1 || state?.version === 2 || state?.version === 3) {
                this.uiFontScale = state.uiFontScale === 'small' || state.uiFontScale === 'large'
                    ? state.uiFontScale
                    : 'standard';
                const legacyCli = state.version === 1 && isKnownCliId(state.preferredCli)
                    ? state.preferredCli
                    : DEFAULT_CLI_ID;
                this.agentCli = (state.version === 2 || state.version === 3) && isKnownCliId(state.agentCli)
                    ? state.agentCli
                    : legacyCli;
                this.resultsCli = (state.version === 2 || state.version === 3) && isKnownCliId(state.resultsCli)
                    ? state.resultsCli
                    : legacyCli;
                this.agentModel = state.version === 3 && typeof state.agentModel === 'string' ? state.agentModel : '';
                this.resultsModel = state.version === 3 && typeof state.resultsModel === 'string' ? state.resultsModel : '';
                this.allowExternalResultsResources = state.allowExternalResultsResources === true;
            }
        } catch (error) {
            console.warn('[Poiesis] Could not restore settings.', error);
        }
        this.resultsGenerationContext.providerId = this.resultsCli;
        this.resultsGenerationContext.model = this.resultsModel.trim();
        this.update();
    }

    protected persistPoiesisSettings(): void {
        void this.storageService.setData<PersistedPoiesisSettings>(SETTINGS_STORAGE_KEY, {
            version: 3,
            uiFontScale: this.uiFontScale,
            agentCli: this.agentCli,
            agentModel: this.agentModel,
            resultsCli: this.resultsCli,
            resultsModel: this.resultsModel,
            allowExternalResultsResources: this.allowExternalResultsResources
        });
    }

    protected resultsDocumentHtml(html: string): string {
        const sanitized = html
            .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
            .replace(/<script\b[^>]*\/\s*>/gi, '')
            .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
        const policy = this.allowExternalResultsResources
            ? ''
            : `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">`;
        const bridge = `<script data-poiesis-results-bridge="v1">
(function () {
  function send(message) { window.parent.postMessage(message, '*'); }
  document.addEventListener('click', function (event) {
    var target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    var action = target.closest('[data-poiesis-action="retry-ai-results"]');
    if (action) {
      event.preventDefault();
      send({ type: 'poiesis:retry-ai-results' });
      return;
    }
    var citationNode = target.closest('[data-poiesis-citation]');
    var citation = citationNode && citationNode.getAttribute('data-poiesis-citation');
    if (!citation) {
      var plainNode = target.closest('a, cite, code');
      var match = plainNode && (plainNode.textContent || '').match(/((?:[^\\s:()]+[\\\\/])*[^\\s:()]+\\.[A-Za-z0-9_-]+):(\\d+)(?:\\s*[-–—]\\s*(\\d+))?/);
      if (match) citation = match[1] + ':' + match[2] + (match[3] ? '-' + match[3] : '');
    }
    if (!citation) return;
    event.preventDefault();
    send({ type: 'poiesis:open-citation', citation: citation });
  }, true);
})();
</script>`;
        const withPolicy = policy && /<head(?:\s[^>]*)?>/i.test(sanitized)
            ? sanitized.replace(/<head(?:\s[^>]*)?>/i, match => `${match}\n  ${policy}`)
            : `${policy}\n${sanitized}`;
        return /<\/body\s*>/i.test(withPolicy)
            ? withPolicy.replace(/<\/body\s*>/i, `${bridge}\n</body>`)
            : `${withPolicy}\n${bridge}`;
    }

    protected handleResultsFrameMessage(event: MessageEvent): void {
        const frame = this.node.querySelector<HTMLIFrameElement>('.poiesis-results__document');
        if (!frame?.contentWindow || event.source !== frame.contentWindow || !event.data || typeof event.data !== 'object') {
            return;
        }
        const message = event.data as Partial<ResultsFrameMessage>;
        if (message.type === 'poiesis:retry-ai-results') {
            const session = this.selectedSession();
            const task = [...this.finishedTasks(session)].reverse().find(candidate => candidate.id === session?.selectedResultsTaskId)
                ?? [...this.finishedTasks(session)].reverse()[0];
            if (task) {
                void this.retryResults(task.id);
            }
        } else if (message.type === 'poiesis:open-citation' && typeof message.citation === 'string') {
            void this.openResultsCitation(message.citation);
        }
    }

    protected async openResultsCitation(rawCitation: string): Promise<void> {
        const match = rawCitation.trim().match(/^(.*):(\d+)(?:\s*[-–—]\s*(\d+))?$/);
        const path = match?.[1].trim().replace(/^`|`$/g, '').replace(/\\/g, '/');
        const startLine = Number(match?.[2]);
        const endLine = Number(match?.[3] ?? match?.[2]);
        const invalidPath = !path
            || path.startsWith('/')
            || /^[A-Za-z]:/.test(path)
            || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)
            || path.split('/').some(segment => !segment || segment === '.' || segment === '..');
        if (invalidPath || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
            || startLine < 1 || endLine < startLine || endLine > 10_000_000) {
            this.messageService.error('引用先を開けません。Workspace 内のファイルと行番号を確認してください。');
            return;
        }
        const workspace = this.workspaceRoot()?.resource.normalizePath();
        const file = workspace?.resolve(path).normalizePath();
        try {
            if (!workspace || !file || !workspace.isEqualOrParent(file, false) || !await this.fileService.exists(file)) {
                this.messageService.error('引用先のファイルが Workspace 内に見つかりません。');
                return;
            }
            const stat = await this.fileService.resolve(file);
            if (!stat.isFile) {
                this.messageService.error('引用先はファイルではありません。');
                return;
            }
            await this.openCodeCitation(file, startLine, endLine);
        } catch (error) {
            console.warn(`[Poiesis] Could not open Results citation: ${rawCitation}`, error);
            this.messageService.error('引用先を Editor で開けませんでした。');
        }
    }

    protected async openCodeCitation(file: URI, startLine: number, endLine: number): Promise<void> {
        this.closeCustomize(false);
        if (!this.codeMode) {
            this.ensureCodeFileIcons();
            this.codeMode = true;
            this.update();
            requestAnimationFrame(() => void this.ensureCodeTerminal());
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
        const uriKey = file.toString();
        this.pendingPinnedEditorUris.add(uriKey);
        try {
            await this.editorManager.open(file, {
                mode: 'activate',
                selection: {
                    start: { line: startLine - 1, character: 0 },
                    end: { line: endLine - 1, character: 0 }
                }
            });
            const opened = this.codeCenterWidgets.find(candidate => candidate instanceof EditorWidget
                && candidate.editor.uri.toString() === uriKey);
            if (opened) {
                this.pinCodeCenterWidget(opened);
                this.selectCodeCenterWidget(opened);
            }
        } finally {
            this.pendingPinnedEditorUris.delete(uriKey);
        }
    }

    protected async clearSavedSessionData(): Promise<void> {
        if (!this.clearDataConfirmation) {
            return;
        }
        for (const session of [...this.sessions]) {
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
            this.disposeAgentRichContentForSession(session.id);
        }
        this.sessions.splice(0, this.sessions.length);
        this.selectedSessionId = undefined;
        this.deleteSessionConfirmationId = undefined;
        this.clearDataConfirmation = false;
        await this.createSession();
    }

    protected onBeforeDetach(message: Message): void {
        this.railResizeCleanup?.dispose();
        this.railResizeCleanup = undefined;
        this.codeSidebarResizeCleanup?.dispose();
        this.codeSidebarResizeCleanup = undefined;
        this.codePanelResizeCleanup?.dispose();
        this.codePanelResizeCleanup = undefined;
        if (this.codeWidgetAttachmentFrame !== undefined) {
            cancelAnimationFrame(this.codeWidgetAttachmentFrame);
            this.codeWidgetAttachmentFrame = undefined;
        }
        this.codeSidebarResizeObserver?.disconnect();
        this.codeEditorResizeObserver?.disconnect();
        this.codeTerminalResizeObserver?.disconnect();
        this.detachCodeWidgets();
        super.onBeforeDetach(message);
    }

    protected selectedSession(): WindowAgentSession | undefined {
        return this.sessions.find(session => session.id === this.selectedSessionId);
    }

    protected findSessionByAgentId(sessionId: string): WindowAgentSession | undefined {
        return this.sessions.find(session => session.agentSession?.id === sessionId);
    }

    protected findSessionForTask(task: ExecutionTask): WindowAgentSession | undefined {
        return this.sessions.find(session => session.id === task.sessionId)
            ?? this.findSessionByAgentId(task.sessionId);
    }

    protected selectSession(sessionId: string): void {
        const session = this.sessions.find(candidate => candidate.id === sessionId && !candidate.archived);
        if (!session) {
            return;
        }
        this.closeCustomize(false);
        this.selectedSessionId = sessionId;
        session.unreadTaskCompletion = false;
        session.updatedAt = Date.now();
        this.openSessionMenuId = undefined;
        const currentWorkspaceUri = this.workspaceRoot()?.resource.toString();
        if (session.workspaceUri && !this.sameWorkspaceUri(session.workspaceUri, currentWorkspaceUri)) {
            this.persistWindowState();
            this.update();
            this.workspaceService.open(new URI(session.workspaceUri), { preserveWindow: true });
            return;
        }
        if (session.hasUserMessage) {
            void this.ensureProviderSession(session);
        }
        this.persistWindowState();
        this.update();
    }

    protected workspaceRoot() {
        return this.workspaceService.tryGetRoots()[0]
            ?? (this.workspaceService.workspace?.isDirectory ? this.workspaceService.workspace : undefined);
    }

    protected workspaceFolderName(): string {
        return this.workspaceRoot()?.resource.path.base || 'ワークスペースなし';
    }

    protected workspaceContextLabel(session = this.selectedSession()): string {
        const workspace = session?.workspaceUri ? this.repositoryLabel(session.workspaceUri) : this.workspaceFolderName();
        const branch = session?.branch ?? this.gitBranchForWorkspace(session?.workspaceUri) ?? this.currentGitBranch();
        return branch ? `${workspace} / ${branch}` : workspace;
    }

    protected gitBranchForWorkspace(workspaceUri: string | undefined): string | undefined {
        if (!workspaceUri) {
            return undefined;
        }
        const repository = this.scmService.findRepository(new URI(workspaceUri));
        const provider = repository?.provider;
        if (provider?.id.toLowerCase() !== 'git') {
            return undefined;
        }
        const ref = provider.historyProvider?.currentHistoryItemRef;
        return ref?.id.startsWith('refs/heads/') ? ref.name.trim() || undefined : undefined;
    }

    protected currentGitBranch(): string | undefined {
        const root = this.workspaceRoot();
        return this.gitBranchForWorkspace(root?.resource.toString());
    }

    protected watchScmProvider(provider: ScmProvider): void {
        if (this.watchedScmProviders.has(provider)) {
            return;
        }
        this.watchedScmProviders.add(provider);
        this.watchScmHistoryProvider(provider.historyProvider);
        this.toDispose.push(provider.onDidChange(() => {
            this.watchScmHistoryProvider(provider.historyProvider);
            queueMicrotask(() => this.update());
        }));
    }

    protected watchScmHistoryProvider(historyProvider: ScmHistoryProvider | undefined): void {
        if (!historyProvider || this.watchedScmHistoryProviders.has(historyProvider)) {
            return;
        }
        this.watchedScmHistoryProviders.add(historyProvider);
        this.toDispose.push(historyProvider.onDidChangeCurrentHistoryItemRefs(() => this.update()));
    }

    protected async createSession(): Promise<void> {
        const id = `window-session-${Date.now()}-${++this.sessionSequence}`;
        const now = Date.now();
        const session: WindowAgentSession = {
            id,
            createdAt: now,
            updatedAt: now,
            workspaceUri: this.workspaceRoot()?.resource.toString(),
            branch: this.currentGitBranch() ?? 'main',
            runTarget: 'local',
            title: NEW_SESSION_TITLE,
            hasUserMessage: false,
            pinned: false,
            archived: false,
            activeTab: 'agent',
            agentDraft: '',
            messages: [],
            taskIds: [],
            resultsDrafts: new Map<string, string>(),
            resultsNotices: new Map<string, ResultsNotice>(),
            resultsQaExpanded: new Map<string, boolean>()
        };
        this.sessions.push(session);
        this.selectedSessionId = session.id;
        this.openSessionMenuId = undefined;
        this.persistWindowState();
        this.persistResultsQaPanelState();
        this.update();
    }

    protected async ensureProviderSession(
        session: WindowAgentSession,
        replaceStatus = false,
        silent = false
    ): Promise<boolean> {
        if (session.agentSession) {
            return true;
        }
        try {
            session.agentSession = await this.agentProvider.createSession({
                workspaceUri: session.workspaceUri,
                providerId: this.agentCli,
                model: this.agentModel.trim() || undefined
            });
            this.providerPreparationErrors.delete(session.id);
            if (!silent && (replaceStatus || session.messages.length === 0 || session.messages.every(message => message.id.startsWith('provider-')))) {
                session.messages = [{
                    id: `provider-ready-${session.id}`,
                    role: 'agent',
                    content: '準備ができました。変更したい内容を入力してください。',
                    complete: true
                }];
            }
            this.persistWindowState();
            this.update();
            return true;
        } catch (error) {
            this.providerPreparationErrors.set(session.id, error instanceof Error ? error.message : String(error));
            if (replaceStatus || session.messages.length === 0 || session.messages.every(message => message.id.startsWith('provider-'))) {
                session.messages = [{
                    id: `provider-error-${session.id}`,
                    role: 'agent',
                    content: `エージェントを準備できませんでした: ${error instanceof Error ? error.message : String(error)}`,
                    complete: true
                }];
            }
            this.persistWindowState();
            this.update();
            return false;
        }
    }

    protected async restoreWindowState(): Promise<boolean> {
        try {
            const state = await this.loadGlobalWindowState();
            if (!state) {
                return false;
            }
            if (state.version !== 1 || !Array.isArray(state.sessions) || state.sessions.length === 0) {
                return false;
            }
            this.sessions.splice(0, this.sessions.length, ...state.sessions.flatMap(candidate => {
                if (!candidate || typeof candidate.id !== 'string' || typeof candidate.title !== 'string') {
                    return [];
                }
                const createdAt = Number(candidate.createdAt) || Date.now();
                const restoredTasks = this.taskService.restore(Array.isArray(candidate.tasks) ? candidate.tasks : []);
                const taskIds = restoredTasks.map(task => task.id);
                const resultsTaskIds = new Set(restoredTasks
                    .filter(task => this.isResultsTask(task))
                    .map(task => task.id));
                const embeddedResultsDocuments = restoredTasks.flatMap(task =>
                    task.resultsDocument ? [task.resultsDocument] : []
                );
                this.resultsService.restore(
                    [
                        ...(Array.isArray(candidate.resultsDocuments) ? candidate.resultsDocuments : []),
                        ...embeddedResultsDocuments
                    ],
                    resultsTaskIds
                );
                const taskById = new Map(restoredTasks.map(task => [task.id, task]));
                const restoredMessages = (Array.isArray(candidate.messages) ? candidate.messages.filter(message =>
                    message && typeof message.id === 'string'
                    && (message.role === 'user' || message.role === 'agent')
                    && typeof message.content === 'string'
                ).map(message => this.migrateLegacyCliErrorMessage({
                    ...message,
                    complete: Boolean(message.complete)
                })) : []).map(message => {
                    const task = message.taskId ? taskById.get(message.taskId) : undefined;
                    if (message.complete || task?.status !== 'failed') {
                        return message;
                    }
                    return {
                        ...message,
                        content: task.failure?.summary ?? 'タスクの実行に失敗しました。',
                        complete: true,
                        error: true,
                        errorDetails: task.failure?.details
                    };
                });
                const latestTask = restoredTasks[restoredTasks.length - 1];
                const restored: WindowAgentSession = {
                    id: candidate.id,
                    createdAt,
                    updatedAt: Number(candidate.updatedAt) || createdAt,
                    workspaceUri: typeof candidate.workspaceUri === 'string'
                        ? this.canonicalWorkspaceUri(candidate.workspaceUri)
                        : this.workspaceRoot()?.resource.toString(),
                    branch: typeof candidate.branch === 'string' ? candidate.branch : this.currentGitBranch() ?? 'main',
                    runTarget: 'local',
                    title: candidate.title || NEW_SESSION_TITLE,
                    hasUserMessage: Boolean(candidate.hasUserMessage),
                    lastTaskStatus: latestTask?.status === 'completed'
                        || latestTask?.status === 'failed'
                        || latestTask?.status === 'cancelled'
                        ? latestTask.status
                        : candidate.lastTaskStatus === 'completed'
                        || candidate.lastTaskStatus === 'failed'
                        || candidate.lastTaskStatus === 'cancelled'
                        ? candidate.lastTaskStatus
                        : undefined,
                    unreadTaskCompletion: Boolean(candidate.unreadTaskCompletion),
                    pinned: Boolean(candidate.pinned),
                    archived: Boolean(candidate.archived),
                    activeTab: candidate.activeTab === 'results' ? 'results' : 'agent',
                    agentDraft: typeof candidate.agentDraft === 'string' ? candidate.agentDraft : '',
                    messages: restoredMessages,
                    taskIds,
                    selectedResultsTaskId: typeof candidate.selectedResultsTaskId === 'string'
                        && resultsTaskIds.has(candidate.selectedResultsTaskId)
                        ? candidate.selectedResultsTaskId
                        : undefined,
                    resultsDrafts: new Map(Array.isArray(candidate.resultsDrafts) ? candidate.resultsDrafts : []),
                    resultsNotices: new Map<string, ResultsNotice>(),
                    resultsQaExpanded: new Map<string, boolean>()
                };
                return [restored];
            }));
            this.selectedSessionId = typeof state.selectedSessionId === 'string' ? state.selectedSessionId : undefined;
            this.railWidth = this.clampRailWidth(Number(state.railWidth) || DEFAULT_RAIL_WIDTH);
            this.railCollapsed = Boolean(state.railCollapsed);
            this.sessionSequence = this.sessions.length;
            if (this.legacyErrorMessagesMigrated) {
                await this.persistWindowState();
            }
            return this.sessions.length > 0;
        } catch (error) {
            console.warn('[Poiesis] Could not restore Agent Window sessions.', error);
            return false;
        }
    }

    protected migrateLegacyCliErrorMessage(message: ChatMessage): ChatMessage {
        if (message.role !== 'agent' || message.error || !message.complete) {
            return message;
        }
        const content = message.content.trim();
        const hasRawCliEvidence = /(?:^|\n)\s*(?:error|usage):|\b(?:codex|claude|grok|gemini)\b[^\n]{0,160}(?:exited with code|終了コード)|(?:unknown|unexpected|invalid)\s+(?:argument|option)/i.test(content);
        const hasExplicitFailure = /実行に失敗しました。?\s*$/u.test(content)
            || /(?:^|\n)\s*usage:\s*\S+/im.test(content)
            || /\b(?:codex|claude|grok|gemini)\b[^\n]{0,160}(?:exited with code|終了コード)/i.test(content);
        if (!hasRawCliEvidence || !hasExplicitFailure) {
            return message;
        }
        this.legacyErrorMessagesMigrated = true;
        const optionFailure = /(?:argument|option)|--[a-z][\w-]*/i.test(content);
        return {
            ...message,
            content: optionFailure
                ? 'Agent CLI の起動オプションに問題があり、実行に失敗しました。'
                : 'Agent CLI が異常終了し、実行に失敗しました。',
            error: true,
            errorDetails: content
        };
    }

    protected async loadGlobalWindowState(): Promise<Partial<PersistedAgentWindowState> | undefined> {
        const globalState = await this.globalStorageService.getData<Partial<PersistedAgentWindowState>>(GLOBAL_SESSION_STORAGE_KEY);
        const migrated = await this.globalStorageService.getData<boolean>(SESSION_MIGRATION_MARKER_KEY);
        if (migrated) {
            return globalState;
        }
        const legacyStates = await this.globalStorageService.getWorkspaceData<Partial<PersistedAgentWindowState>>(SESSION_STORAGE_KEY);
        const currentLegacyState = await this.storageService.getData<Partial<PersistedAgentWindowState>>(SESSION_STORAGE_KEY);
        if (currentLegacyState) {
            legacyStates.push(currentLegacyState);
        }
        const merged = this.mergePersistedWindowStates([globalState, ...legacyStates]);
        if (merged) {
            await this.globalStorageService.setData(GLOBAL_SESSION_STORAGE_KEY, merged);
        }
        await this.globalStorageService.setData(SESSION_MIGRATION_MARKER_KEY, true);
        return merged;
    }

    protected mergePersistedWindowStates(
        states: Array<Partial<PersistedAgentWindowState> | undefined>
    ): PersistedAgentWindowState | undefined {
        const valid = states.filter((state): state is Partial<PersistedAgentWindowState> =>
            state?.version === 1 && Array.isArray(state.sessions)
        );
        if (!valid.length) {
            return undefined;
        }
        const mergedSessions = new Map<string, PersistedAgentWindowState['sessions'][number]>();
        for (const state of valid) {
            for (const session of state.sessions ?? []) {
                if (!session || typeof session.id !== 'string') {
                    continue;
                }
                const existing = mergedSessions.get(session.id);
                if (!existing || Number(session.updatedAt) >= Number(existing.updatedAt)) {
                    mergedSessions.set(session.id, session);
                }
            }
        }
        const preferred = valid.find(state => typeof state.selectedSessionId === 'string') ?? valid[0];
        return {
            version: 1,
            selectedSessionId: preferred.selectedSessionId,
            railWidth: Number(preferred.railWidth) || DEFAULT_RAIL_WIDTH,
            railCollapsed: Boolean(preferred.railCollapsed),
            sessions: [...mergedSessions.values()]
        };
    }

    protected async restoreResultsQaPanelState(): Promise<void> {
        try {
            const state = await this.storageService.getData<Partial<PersistedResultsQaPanelState>>(
                RESULTS_QA_PANEL_STORAGE_KEY,
                {}
            );
            if (state?.version !== 1 || !state.sessions || typeof state.sessions !== 'object') {
                return;
            }
            this.resultsTaskRailCollapsed = state.taskRailCollapsed === true;
            for (const session of this.sessions) {
                const persisted = state.sessions[session.id];
                if (!persisted) {
                    continue;
                }
                const resultsTaskIds = new Set(this.finishedTasks(session).map(task => task.id));
                if (typeof persisted.selectedTaskId === 'string' && resultsTaskIds.has(persisted.selectedTaskId)) {
                    session.selectedResultsTaskId = persisted.selectedTaskId;
                }
                session.resultsQaExpanded.clear();
                if (Array.isArray(persisted.expandedTaskIds)) {
                    for (const taskId of persisted.expandedTaskIds) {
                        if (typeof taskId === 'string' && resultsTaskIds.has(taskId)) {
                            session.resultsQaExpanded.set(taskId, true);
                        }
                    }
                }
            }
        } catch (error) {
            console.warn('[Poiesis] Could not restore Results Q&A panel state.', error);
        }
    }

    protected persistResultsQaPanelState(): Promise<void> {
        try {
            const state: PersistedResultsQaPanelState = {
                version: 1,
                taskRailCollapsed: this.resultsTaskRailCollapsed,
                sessions: Object.fromEntries(this.sessions.map(session => {
                    const resultsTaskIds = new Set(this.finishedTasks(session).map(task => task.id));
                    return [session.id, {
                        selectedTaskId: session.selectedResultsTaskId && resultsTaskIds.has(session.selectedResultsTaskId)
                            ? session.selectedResultsTaskId
                            : undefined,
                        expandedTaskIds: [...session.resultsQaExpanded]
                            .filter(([taskId, expanded]) => expanded && resultsTaskIds.has(taskId))
                            .map(([taskId]) => taskId)
                    }];
                }))
            };
            this.resultsQaPanelStatePersistence = this.resultsQaPanelStatePersistence
                .catch(() => undefined)
                .then(() => this.storageService.setData(RESULTS_QA_PANEL_STORAGE_KEY, state))
                .catch(error => {
                    console.warn('[Poiesis] Could not persist Results Q&A panel state.', error);
                });
        } catch (error) {
            console.warn('[Poiesis] Could not persist Results Q&A panel state.', error);
        }
        return this.resultsQaPanelStatePersistence;
    }

    protected persistWindowState(): Promise<void> {
        try {
            const state: PersistedAgentWindowState = {
                version: 1,
                selectedSessionId: this.selectedSessionId,
                railWidth: this.railWidth,
                railCollapsed: this.railCollapsed,
                sessions: this.sessions.map(session => {
                    const tasks = this.persistedTasks(session);
                    const {
                        agentSession: _agentSession,
                        taskIds: _taskIds,
                        resultsDrafts,
                        resultsNotices: _resultsNotices,
                        resultsQaExpanded: _resultsQaExpanded,
                        ...persisted
                    } = session;
                    return {
                        ...persisted,
                        resultsDrafts: [...resultsDrafts.entries()],
                        tasks
                    };
                })
            };
            this.windowStatePersistence = this.windowStatePersistence
                .catch(() => undefined)
                .then(() => this.globalStorageService.setData(GLOBAL_SESSION_STORAGE_KEY, state))
                .catch(error => {
                    console.warn('[Poiesis] Could not persist Agent Window sessions.', error);
                });
        } catch (error) {
            console.warn('[Poiesis] Could not persist Agent Window sessions.', error);
        }
        return this.windowStatePersistence;
    }

    protected titleForSession(message: string): string {
        return taskTitleForRequest(message);
    }

    protected persistedTasks(session: WindowAgentSession): ExecutionTask[] {
        return session.taskIds
            .map(taskId => this.taskService.get(taskId))
            .filter((task): task is ExecutionTask => Boolean(task))
            .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
            .slice(-MAX_PERSISTED_TASKS_PER_SESSION)
            .map(task => {
                const persistedTask: ExecutionTask = task.status === 'running' ? {
                    ...task,
                    status: 'failed',
                    endedAt: new Date().toISOString(),
                    failure: { summary: 'アプリ終了により中断されました' }
                } : task;
                return persistedTask.resultsDocument ? {
                    ...persistedTask,
                    resultsDocument: {
                        ...persistedTask.resultsDocument,
                        html: persistedTask.resultsDocument.html?.slice(0, MAX_PERSISTED_RESULTS_HTML_CHARS)
                    }
                } : persistedTask;
            });
    }

    protected async initializeSessions(): Promise<void> {
        await this.workspaceService.roots;
        const restored = await this.restoreWindowState();
        await this.restoreResultsQaPanelState();
        const currentWorkspaceKey = this.workspaceGroupKey(this.workspaceRoot()?.resource.toString());
        this.expandedWorkspaceGroups.add(currentWorkspaceKey);
        if (!restored) {
            await this.createSession();
            return;
        }
        const activeSessions = this.filteredSessions(false);
        const currentWorkspaceUri = this.workspaceRoot()?.resource.toString();
        const selected = activeSessions.find(session =>
            session.id === this.selectedSessionId && this.sameWorkspaceUri(session.workspaceUri, currentWorkspaceUri)
        ) ?? activeSessions.find(session => this.sameWorkspaceUri(session.workspaceUri, currentWorkspaceUri));
        if (!selected) {
            await this.createSession();
            return;
        }
        this.selectedSessionId = selected.id;
        this.update();
        if (selected.hasUserMessage) {
            await this.ensureProviderSession(selected);
        }
    }

    protected async sendAgentMessage(): Promise<void> {
        await this.sessionsInitialization;
        const session = this.selectedSession();
        const content = session?.agentDraft.trim() ?? '';
        if (!session || !session.workspaceUri || !content || this.runningTask(session)) {
            return;
        }
        session.agentDraft = '';
        const sentAt = Date.now();
        session.messages.push({ id: `user-${sentAt}`, role: 'user', content, complete: true });
        session.updatedAt = sentAt;
        if (!session.hasUserMessage) {
            session.createdAt = sentAt;
            session.title = this.titleForSession(content);
            session.hasUserMessage = true;
        }
        this.update();
        await this.persistWindowState();
        if (session.agentSession?.providerId && (session.agentSession.providerId !== this.agentCli
            || (session.agentSession.model ?? '') !== this.agentModel.trim())) {
            session.agentSession = undefined;
        }
        if (!session.agentSession && !await this.ensureProviderSession(session, false, true)) {
            await this.recordPreSpawnFailure(
                session,
                content,
                'Agentを開始できませんでした。',
                this.providerPreparationErrors.get(session.id)
            );
            return;
        }
        if (!session.agentSession) {
            await this.recordPreSpawnFailure(session, content, 'Agentを開始できませんでした。');
            return;
        }
        try {
            await this.agentProvider.sendMessage(session.agentSession.id, {
                role: 'user',
                content,
                ownerSessionId: session.id
            });
        } catch (error) {
            await this.recordPreSpawnFailure(
                session,
                content,
                'Agentを開始できませんでした。',
                error instanceof Error ? error.message : String(error)
            );
        }
    }

    protected async recordPreSpawnFailure(
        session: WindowAgentSession,
        request: string,
        summary: string,
        details?: string
    ): Promise<void> {
        const task = await this.taskService.failBeforeStart(session.id, request, { summary, details });
        session.messages.push({
            id: `agent-${task.id}`,
            role: 'agent',
            content: summary,
            complete: true,
            taskId: task.id,
            error: true,
            errorDetails: details
        });
        session.updatedAt = Date.now();
        await this.persistWindowState();
        this.update();
    }

    protected async cancelRun(): Promise<void> {
        const session = this.selectedSession()?.agentSession;
        if (session) {
            await this.agentProvider.cancel(session.id);
        }
    }

    protected handleAgentEvent(event: AgentEvent): void {
        const session = this.findSessionByAgentId(event.sessionId);
        if (!session) {
            return;
        }
        if (event.type === 'task-started') {
            session.messages.push({ id: `agent-${event.taskId}`, role: 'agent', content: '', complete: false, taskId: event.taskId });
        } else if (event.type === 'message-delta') {
            this.updateAgentMessage(session, event.taskId, message => ({ ...message, content: message.content + event.delta }));
        } else if (event.type === 'message-completed') {
            this.updateAgentMessage(session, event.taskId, message => ({ ...message, complete: true }));
        } else if (event.type === 'task-cancelled') {
            this.updateAgentMessage(session, event.taskId, message => ({
                ...message,
                content: `${message.content} 実行をキャンセルしました。`.trim(),
                complete: true
            }));
        } else if (event.type === 'task-failed') {
            this.updateAgentMessage(session, event.taskId, message => ({
                ...message,
                content: event.summary,
                complete: true,
                error: true,
                errorDetails: event.details
            }));
        }
        session.updatedAt = Date.now();
        this.persistWindowState();
        this.update();
    }

    protected updateAgentMessage(session: WindowAgentSession, taskId: string, update: (message: ChatMessage) => ChatMessage): void {
        const id = `agent-${taskId}`;
        session.messages = session.messages.map(message => message.id === id ? update(message) : message);
    }

    protected runningTask(session = this.selectedSession()): ExecutionTask | undefined {
        return session?.taskIds
            .map(taskId => this.taskService.get(taskId))
            .find(task => task?.status === 'running' || task && this.taskService.isFinalizing(task.id));
    }

    protected finishedTasks(session = this.selectedSession()): ExecutionTask[] {
        return session?.taskIds
            .map(taskId => this.taskService.get(taskId))
            .filter((task): task is ExecutionTask => task !== undefined && this.isResultsTask(task))
            ?? [];
    }

    protected isResultsTask(task: ExecutionTask): boolean {
        return task.status !== 'running';
    }

    protected taskFinishedTime(task: ExecutionTask): string {
        const endedAt = task.endedAt ? new Date(task.endedAt) : undefined;
        if (!endedAt || Number.isNaN(endedAt.getTime())) {
            return '';
        }
        const hours = endedAt.getHours().toString().padStart(2, '0');
        const minutes = endedAt.getMinutes().toString().padStart(2, '0');
        return `${hours}:${minutes}`;
    }

    protected toggleCodeMode(): void {
        if (this.codeMode) {
            this.detachCodeWidgets();
            this.codeMode = false;
        } else {
            this.closeCustomize(false);
            this.ensureCodeFileIcons();
            this.codeMode = true;
            requestAnimationFrame(() => void this.ensureCodeTerminal());
        }
        this.update();
    }

    protected selectTab(tab: AgentWindowTab): void {
        const session = this.selectedSession();
        if (session) {
            session.activeTab = tab;
            if (tab === 'results' && !this.finishedTasks(session)
                .some(task => task.id === session.selectedResultsTaskId)) {
                session.selectedResultsTaskId = this.finishedTasks(session).at(-1)?.id;
                this.persistResultsQaPanelState();
            }
            this.persistWindowState();
        }
        this.update();
    }

    protected async newChat(): Promise<void> {
        await this.sessionsInitialization;
        this.closeCustomize(false);
        this.detachCodeWidgets();
        this.codeMode = false;
        this.sessionSearchVisible = false;
        this.sessionSearchQuery = '';
        this.repositoryPickerVisible = false;
        this.repositoryPickerAnchor = undefined;
        this.repositorySearchQuery = '';
        const current = this.selectedSession();
        if (current && !current.archived && !current.hasUserMessage) {
            current.activeTab = 'agent';
            this.persistWindowState();
            this.update();
            requestAnimationFrame(() => this.agentComposerInput?.focus());
            return;
        }
        const creation = this.createSession();
        requestAnimationFrame(() => this.agentComposerInput?.focus());
        await creation;
        requestAnimationFrame(() => this.agentComposerInput?.focus());
    }

    protected setAgentDraft(sessionId: string | undefined, value: string): void {
        const session = this.selectedSession();
        if (!sessionId || session?.id !== sessionId) {
            return;
        }
        session.agentDraft = value;
        this.persistWindowState();
        this.update();
    }

    protected selectResultsTask(taskId: string): void {
        const session = this.selectedSession();
        if (session) {
            session.selectedResultsTaskId = taskId;
            this.deleteTaskConfirmationId = undefined;
            this.persistWindowState();
            this.persistResultsQaPanelState();
        }
        this.update();
    }

    protected setResultsQuestionPanelExpanded(taskId: string, expanded: boolean, revealLatest = false): void {
        const session = this.selectedSession();
        if (!session || session.selectedResultsTaskId !== taskId
            || !this.finishedTasks(session).some(task => task.id === taskId)) {
            return;
        }
        if (expanded) {
            session.resultsQaExpanded.set(taskId, true);
        } else {
            session.resultsQaExpanded.delete(taskId);
        }
        this.persistResultsQaPanelState();
        this.update();
        if (expanded && revealLatest) {
            requestAnimationFrame(() => {
                if (this.selectedSessionId !== session.id || this.selectedSession()?.selectedResultsTaskId !== taskId) {
                    return;
                }
                const history = this.node.querySelector<HTMLElement>('.poiesis-results__qa-history');
                if (history) {
                    history.scrollTop = history.scrollHeight;
                }
            });
        }
    }

    protected beginDeleteResultsTask(taskId: string): void {
        if (!this.finishedTasks().some(task => task.id === taskId)) {
            return;
        }
        this.deleteTaskConfirmationId = taskId;
        this.update();
    }

    protected cancelDeleteResultsTask(): void {
        this.deleteTaskConfirmationId = undefined;
        this.update();
    }

    protected async deleteResultsTask(taskId: string): Promise<void> {
        const session = this.selectedSession();
        if (!session
            || this.deleteTaskConfirmationId !== taskId
            || !this.finishedTasks(session).some(task => task.id === taskId)) {
            return;
        }
        const deletedWasSelected = session.selectedResultsTaskId === taskId;
        session.taskIds = session.taskIds.filter(candidate => candidate !== taskId);
        session.resultsDrafts.delete(taskId);
        session.resultsNotices.delete(taskId);
        session.resultsQaExpanded.delete(taskId);
        this.resultsService.remove([taskId]);
        this.taskService.remove([taskId]);
        const newestRemainingTask = this.finishedTasks(session).at(-1);
        if (deletedWasSelected) {
            session.selectedResultsTaskId = newestRemainingTask?.id;
        }
        session.lastTaskStatus = newestRemainingTask?.status === 'running'
            ? undefined
            : newestRemainingTask?.status;
        if (!newestRemainingTask) {
            session.unreadTaskCompletion = false;
        }
        session.updatedAt = Date.now();
        this.deleteTaskConfirmationId = undefined;
        await Promise.all([this.persistWindowState(), this.persistResultsQaPanelState()]);
        this.update();
    }

    protected setResultsDraft(taskId: string, value: string): void {
        const session = this.selectedSession();
        session?.resultsDrafts.set(taskId, value);
        session?.resultsNotices.delete(taskId);
        this.persistWindowState();
        this.update();
    }

    protected async submitResultsQuestion(taskId: string, retryQuestion?: string): Promise<void> {
        const session = this.selectedSession();
        const task = this.taskService.get(taskId);
        const document = this.resultsService.get(taskId);
        const question = retryQuestion?.trim() || session?.resultsDrafts.get(taskId)?.trim();
        const currentNotice = session?.resultsNotices.get(taskId);
        if (!session
            || !session.workspaceUri
            || !task
            || task.status === 'running'
            || !this.finishedTasks(session).some(candidate => candidate.id === taskId)
            || document?.status !== 'ready'
            || !document.html
            || !question
            || question.length > 4_000
            || currentNotice?.status === 'sending') {
            return;
        }
        session.selectedResultsTaskId = taskId;
        session.resultsDrafts.set(taskId, '');
        session.resultsNotices.set(taskId, { question, status: 'sending', text: '' });
        session.resultsQaExpanded.set(taskId, true);
        this.persistWindowState();
        this.persistResultsQaPanelState();
        this.update();
        requestAnimationFrame(() => {
            const history = this.node.querySelector<HTMLElement>('.poiesis-results__qa-history');
            if (this.selectedSessionId === session.id && session.selectedResultsTaskId === taskId && history) {
                history.scrollTop = history.scrollHeight;
            }
        });
        try {
            const result = await this.resultsQuestionService.ask(question, {
                taskId,
                providerId: this.resultsCli,
                model: this.resultsModel.trim() || undefined,
                workspaceUri: session.workspaceUri,
                taskMetadata: {
                    title: task.title,
                    request: task.request,
                    status: task.status,
                    startedAt: task.startedAt,
                    endedAt: task.endedAt
                },
                changeSetSummary: task.changeSet?.diff
                    || task.changeSet?.error
                    || 'No changes were recorded.',
                resultsHtml: document.html,
                history: (task.resultsQuestions ?? []).slice(-6)
            });
            if (result.status === 'answered') {
                this.taskService.recordResultsQuestion(taskId, {
                    question,
                    answer: result.answer,
                    timestamp: new Date().toISOString()
                });
                session.resultsNotices.set(taskId, {
                    question,
                    status: 'answered',
                    text: result.answer
                });
                session.resultsQaExpanded.set(taskId, true);
            } else if (result.status === 'failed') {
                const history = this.taskService.recordResultsQuestion(taskId, {
                    question,
                    error: result.error.message,
                    timestamp: new Date().toISOString()
                });
                session.resultsNotices.set(taskId, {
                    question,
                    status: 'failed',
                    text: result.error.message,
                    historyTimestamp: history?.timestamp
                });
                session.resultsQaExpanded.set(taskId, true);
            } else {
                session.resultsDrafts.set(taskId, question);
                session.resultsNotices.delete(taskId);
            }
        } catch {
            const text = '回答を作成できませんでした。もう一度お試しください。';
            const history = this.taskService.recordResultsQuestion(taskId, {
                question,
                error: text,
                timestamp: new Date().toISOString()
            });
            session.resultsNotices.set(taskId, {
                question,
                status: 'failed',
                text,
                historyTimestamp: history?.timestamp
            });
            session.resultsQaExpanded.set(taskId, true);
        }
        this.persistWindowState();
        this.persistResultsQaPanelState();
        this.update();
        requestAnimationFrame(() => {
            const history = this.node.querySelector<HTMLElement>('.poiesis-results__qa-history');
            if (this.selectedSessionId === session.id && session.selectedResultsTaskId === taskId && history) {
                history.scrollTop = history.scrollHeight;
            }
        });
    }

    protected async retryResults(taskId: string): Promise<void> {
        await this.resultsService.retry(taskId);
    }

    protected async retryTask(taskId: string): Promise<void> {
        const task = this.taskService.get(taskId);
        const session = task ? this.sessions.find(candidate => candidate.taskIds.includes(task.id)) : undefined;
        if (!task || !session || this.runningTask(session)) {
            return;
        }
        this.detachCodeWidgets();
        this.closeCustomize(false);
        this.codeMode = false;
        this.selectedSessionId = session.id;
        session.activeTab = 'agent';
        session.selectedResultsTaskId = undefined;
        this.persistResultsQaPanelState();
        session.agentDraft = task.request;
        this.persistWindowState();
        this.update();
        await this.sendAgentMessage();
    }
}
