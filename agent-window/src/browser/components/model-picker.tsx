import * as React from '@theia/core/shared/react';
import * as ReactDOM from '@theia/core/shared/react-dom';
import {
    AiRole,
    CLI_DISPLAY_NAMES,
    CliDetectionReport,
    CliModelCatalog,
    KnownCliId
} from '../../common/agent-runtime-protocol';
import { CliDetectionPhase, cliRoleAvailability } from '../../common/cli-detection-lifecycle';
import {
    beginCustomModelDraft,
    CustomModelDraft,
    filterModelPickerProviders,
    modelChoiceKey,
    modelEffortIsUnsupported,
    ModelPickerPlacement,
    modelPickerPlacement,
    modelPickerProviders,
    modelSupportedEfforts,
    validateCustomModelDraft
} from '../model-picker-state';
import { PoiesisSelect } from './poiesis-select';

export interface ModelPickerProps {
    role: AiRole;
    compact?: boolean;
    detectionPhase: CliDetectionPhase;
    detectionReport?: CliDetectionReport;
    catalogs: Partial<Record<KnownCliId, CliModelCatalog>>;
    selectedProvider: KnownCliId;
    selectedModel: string;
    selectedEffort: string;
    onSelect: (providerId: KnownCliId, model: string) => void;
    onEffortChange: (effort: string) => void;
    onOpenSettings: () => void;
}

function effortLabel(value: string): string {
    switch (value) {
        case 'minimal': return '最小';
        case 'low': return '軽め';
        case 'medium': return '標準';
        case 'high': return '深め';
        case 'xhigh': return 'かなり深く';
        case 'max': return '最大';
        case 'ultra': return '最長';
        default: return value;
    }
}

function catalogSourceLabel(source: 'live' | 'cached' | 'fallback' | 'failed'): string {
    switch (source) {
        case 'live': return 'CLIから取得';
        case 'cached': return '前回取得';
        case 'fallback': return '同梱一覧';
        case 'failed': return '取得失敗';
    }
}

/** Search-first model chooser shared by the Agent and Results composer controls. */
export const ModelPicker = ({
    role,
    compact = false,
    detectionPhase,
    detectionReport,
    catalogs,
    selectedProvider,
    selectedModel,
    selectedEffort,
    onSelect,
    onEffortChange,
    onOpenSettings
}: ModelPickerProps): React.ReactElement => {
    const roleLabel = role === 'agent' ? 'Agent' : 'Results';
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const popoverRef = React.useRef<HTMLDivElement>(null);
    const searchRef = React.useRef<HTMLInputElement>(null);
    const activeRowRef = React.useRef<HTMLDivElement>(null);
    const composingRef = React.useRef(false);
    const pickerId = `poiesis-model-picker-${React.useId().replace(/:/g, '')}`;
    const listboxId = `${pickerId}-listbox`;
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const [providerFilter, setProviderFilter] = React.useState<KnownCliId | 'all'>('all');
    const [activeKey, setActiveKey] = React.useState('');
    const [position, setPosition] = React.useState<ModelPickerPlacement>();
    const [customDraft, setCustomDraft] = React.useState<CustomModelDraft>();
    const [customError, setCustomError] = React.useState('');

    const providers = modelPickerProviders(
        detectionPhase,
        detectionReport,
        catalogs,
        role,
        selectedProvider,
        selectedModel
    );
    const filteredProviders = filterModelPickerProviders(providers, providerFilter, query);
    const visibleChoices = filteredProviders.flatMap(provider => provider.choices);
    const selectedKey = modelChoiceKey(selectedProvider, selectedModel);
    const selectedChoice = providers.find(provider => provider.id === selectedProvider)?.choices
        .find(choice => choice.id === selectedModel);
    const selectedLabel = selectedChoice?.label ?? (selectedModel || '既定');
    const availability = cliRoleAvailability(detectionPhase, detectionReport, selectedProvider, role);
    const warning = availability === 'missing' || availability === 'unsupported' || availability === 'error';
    const loading = availability === 'pending';
    const supportedEfforts = modelSupportedEfforts(selectedProvider, selectedModel, providers);
    const effortUnsupported = modelEffortIsUnsupported(
        selectedProvider, selectedModel, selectedEffort, providers
    );

    const updatePosition = React.useCallback((): void => {
        const trigger = triggerRef.current;
        if (!trigger) {
            return;
        }
        const rect = trigger.getBoundingClientRect();
        const next = modelPickerPlacement(rect, window.innerWidth, window.innerHeight);
        setPosition(current => current
            && Math.abs(current.left - next.left) < 0.5
            && Math.abs(current.width - next.width) < 0.5
            && Math.abs(current.maxHeight - next.maxHeight) < 0.5
            && Math.abs((current.top ?? -1) - (next.top ?? -1)) < 0.5
            && Math.abs((current.bottom ?? -1) - (next.bottom ?? -1)) < 0.5
            ? current
            : next);
    }, []);

    const close = React.useCallback((restoreFocus = true): void => {
        setOpen(false);
        setCustomDraft(undefined);
        setCustomError('');
        setQuery('');
        setProviderFilter('all');
        if (restoreFocus) {
            requestAnimationFrame(() => triggerRef.current?.focus());
        }
    }, []);

    const openPicker = React.useCallback((): void => {
        if (detectionPhase !== 'ready' || !providers.length) {
            onOpenSettings();
            return;
        }
        setQuery('');
        setProviderFilter('all');
        setCustomDraft(undefined);
        setCustomError('');
        setActiveKey(selectedKey);
        updatePosition();
        setOpen(true);
        requestAnimationFrame(() => searchRef.current?.focus());
    }, [detectionPhase, onOpenSettings, providers.length, selectedKey, updatePosition]);

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
            const nestedListbox = target instanceof Element ? target.closest<HTMLElement>('.poiesis-model-picker__nested-select') : null;
            if (nestedListbox) {
                return;
            }
            if (target && !triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
                close(false);
            }
        };
        const closeOnFocusLeave = (event: FocusEvent): void => {
            const target = event.target as Node | null;
            if (target instanceof Element && target.closest('.poiesis-model-picker__nested-select')) {
                return;
            }
            if (target && !triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
                close(false);
            }
        };
        const closeOnEscape = (event: KeyboardEvent): void => {
            if (event.key === 'Escape' && !event.isComposing && !composingRef.current) {
                const nestedListbox = document.querySelector<HTMLElement>('.poiesis-model-picker__nested-select');
                const nestedTrigger = nestedListbox?.id
                    ? popoverRef.current?.querySelector(`[aria-controls="${nestedListbox.id}"]`)
                    : undefined;
                if (nestedTrigger) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                close();
            }
        };
        window.addEventListener('resize', reposition);
        window.addEventListener('scroll', reposition, true);
        document.addEventListener('pointerdown', closeOutside, true);
        document.addEventListener('focusin', closeOnFocusLeave);
        document.addEventListener('keydown', closeOnEscape, true);
        return () => {
            window.removeEventListener('resize', reposition);
            window.removeEventListener('scroll', reposition, true);
            document.removeEventListener('pointerdown', closeOutside, true);
            document.removeEventListener('focusin', closeOnFocusLeave);
            document.removeEventListener('keydown', closeOnEscape, true);
            cancelAnimationFrame(trackingFrame);
        };
    }, [close, open, updatePosition]);

    React.useEffect(() => {
        if (!open || customDraft) {
            return;
        }
        const keys = visibleChoices.map(choice => modelChoiceKey(choice.providerId, choice.id));
        if (!keys.includes(activeKey)) {
            setActiveKey(keys.includes(selectedKey) ? selectedKey : keys[0] ?? '');
        }
    }, [activeKey, customDraft, open, selectedKey, visibleChoices]);

    React.useEffect(() => {
        if (open && activeRowRef.current) {
            activeRowRef.current.scrollIntoView({ block: 'nearest' });
        }
    }, [activeKey, open]);

    const choose = (providerId: KnownCliId, model: string): void => {
        onSelect(providerId, model);
        close();
    };

    const moveActive = (movement: 'next' | 'previous' | 'first' | 'last'): void => {
        if (!visibleChoices.length) {
            return;
        }
        const currentIndex = visibleChoices.findIndex(choice => modelChoiceKey(choice.providerId, choice.id) === activeKey);
        let nextIndex: number;
        switch (movement) {
            case 'first': nextIndex = 0; break;
            case 'last': nextIndex = visibleChoices.length - 1; break;
            case 'previous': nextIndex = currentIndex <= 0 ? visibleChoices.length - 1 : currentIndex - 1; break;
            case 'next': nextIndex = currentIndex < 0 || currentIndex >= visibleChoices.length - 1 ? 0 : currentIndex + 1; break;
        }
        setActiveKey(modelChoiceKey(visibleChoices[nextIndex].providerId, visibleChoices[nextIndex].id));
    };

    const openCustomDraft = (prefill = ''): void => {
        const draft = beginCustomModelDraft(providers, selectedProvider, selectedModel, prefill);
        if (draft) {
            setCustomDraft(draft);
            setCustomError('');
        }
    };

    const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
        if (event.nativeEvent.isComposing || composingRef.current) {
            return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            moveActive(event.key === 'ArrowDown' ? 'next' : 'previous');
        } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            moveActive(event.key === 'Home' ? 'first' : 'last');
        } else if (event.key === 'Enter') {
            event.preventDefault();
            const active = visibleChoices.find(choice => modelChoiceKey(choice.providerId, choice.id) === activeKey);
            if (active) {
                choose(active.providerId, active.id);
            } else if (!visibleChoices.length) {
                openCustomDraft(query);
            }
        }
    };

    const startCustom = (): void => openCustomDraft(query);

    const applyCustom = (): void => {
        if (!customDraft) {
            return;
        }
        const validation = validateCustomModelDraft(customDraft);
        if (!validation.model) {
            setCustomError(validation.error ?? 'モデルIDを確認してください。');
            return;
        }
        onSelect(customDraft.providerId, validation.model);
        close();
    };

    const openAiSettings = (): void => {
        close(false);
        requestAnimationFrame(() => {
            triggerRef.current?.focus();
            onOpenSettings();
        });
    };

    const triggerStatus = loading
        ? '確認中'
        : availability === 'missing'
            ? '未検出'
            : availability === 'unsupported'
                ? '実行未対応'
                : availability === 'error'
                    ? '検出失敗'
                    : CLI_DISPLAY_NAMES[selectedProvider];
    const triggerWarning = warning || effortUnsupported;
    const triggerTitle = `${selectedLabel} · ${triggerStatus}`
        + (selectedEffort ? ` · 処理の深さ: ${effortLabel(selectedEffort)}` : '');
    return (
        <div
            className={`poiesis-model-picker${compact ? ' compact' : ''}${triggerWarning ? ' warning' : ''}${loading ? ' loading' : ''}`}
            data-ai-role={role}
            data-provider={selectedProvider}
            data-model={selectedModel}
        >
            <button
                ref={triggerRef}
                type='button'
                className='poiesis-model-picker__trigger'
                aria-label={`${roleLabel} のモデル`}
                aria-haspopup='dialog'
                aria-expanded={open}
                aria-controls={open ? pickerId : undefined}
                title={triggerTitle}
                onClick={() => open ? close(false) : openPicker()}
                onKeyDown={event => {
                    if (!open && ['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
                        event.preventDefault();
                        openPicker();
                    }
                }}
            >
                <span className={`codicon ${triggerWarning ? 'codicon-warning' : 'codicon-sparkle'}`} aria-hidden='true' />
                <span className='poiesis-model-picker__trigger-copy'>
                    <strong>{selectedLabel}</strong>
                    <small>{triggerStatus}</small>
                </span>
                <span className={`codicon codicon-chevron-${open ? 'up' : 'down'}`} aria-hidden='true' />
            </button>
            {open && position && ReactDOM.createPortal(
                <div
                    ref={popoverRef}
                    id={pickerId}
                    className={`poiesis-model-picker__popover${customDraft ? ' custom-mode' : ''}`}
                    role='dialog'
                    aria-modal='false'
                    aria-label={`${roleLabel} のモデルを選択`}
                    style={position}
                >
                    {customDraft ? (
                        <div className='poiesis-model-picker__custom'>
                            <div className='poiesis-model-picker__popover-heading'>一覧にないモデルを指定</div>
                            <label>
                                <span>AI</span>
                                <PoiesisSelect
                                    ariaLabel={`${roleLabel} のカスタムモデルを使うAI`}
                                    value={customDraft.providerId}
                                    options={providers.map(provider => ({ value: provider.id, label: provider.name }))}
                                    popoverClassName='poiesis-model-picker__nested-select'
                                    onChange={value => {
                                        setCustomDraft({ ...customDraft, providerId: value as KnownCliId });
                                        setCustomError('');
                                    }}
                                />
                            </label>
                            <label>
                                <span>モデルID</span>
                                <input
                                    autoFocus
                                    value={customDraft.value}
                                    aria-label={`${roleLabel} のカスタムモデルID`}
                                    aria-invalid={Boolean(customError)}
                                    aria-describedby={customError ? `${pickerId}-custom-error` : undefined}
                                    onCompositionStart={() => composingRef.current = true}
                                    onCompositionEnd={() => composingRef.current = false}
                                    onChange={event => {
                                        setCustomDraft({ ...customDraft, value: event.currentTarget.value });
                                        setCustomError('');
                                    }}
                                    onKeyDown={event => {
                                        if (event.key === 'Enter' && !event.nativeEvent.isComposing && !composingRef.current) {
                                            event.preventDefault();
                                            applyCustom();
                                        }
                                    }}
                                />
                            </label>
                            {customError && <div id={`${pickerId}-custom-error`} className='poiesis-model-picker__error' role='alert'>{customError}</div>}
                            <div className='poiesis-model-picker__custom-actions'>
                                <button type='button' className='primary' onClick={applyCustom}>適用</button>
                                <button type='button' onClick={() => { setCustomDraft(undefined); setCustomError(''); requestAnimationFrame(() => searchRef.current?.focus()); }}>キャンセル</button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className='poiesis-model-picker__search'>
                                <span className='codicon codicon-search' aria-hidden='true' />
                                <input
                                    ref={searchRef}
                                    role='combobox'
                                    aria-label='モデルを検索'
                                    aria-expanded='true'
                                    aria-controls={listboxId}
                                    aria-autocomplete='list'
                                    aria-activedescendant={activeKey ? `${listboxId}-${encodeURIComponent(activeKey)}` : undefined}
                                    placeholder='モデルを検索'
                                    value={query}
                                    onChange={event => setQuery(event.currentTarget.value)}
                                    onKeyDown={handleSearchKeyDown}
                                    onCompositionStart={() => composingRef.current = true}
                                    onCompositionEnd={() => composingRef.current = false}
                                />
                            </div>
                            {providers.length > 1 && (
                                <div className='poiesis-model-picker__filters' role='group' aria-label='AIで絞り込む'>
                                    <button type='button' className={providerFilter === 'all' ? 'active' : ''} aria-pressed={providerFilter === 'all'} onClick={() => setProviderFilter('all')}>すべて</button>
                                    {providers.map(provider => (
                                        <button key={provider.id} type='button' className={providerFilter === provider.id ? 'active' : ''} aria-pressed={providerFilter === provider.id} onClick={() => setProviderFilter(provider.id)}>{provider.name}</button>
                                    ))}
                                </div>
                            )}
                            <div id={listboxId} className='poiesis-model-picker__list' role='listbox' aria-label='利用できるモデル'>
                                {filteredProviders.map(provider => (
                                    <React.Fragment key={provider.id}>
                                        <div className='poiesis-model-picker__group' role='presentation'>
                                            <span>{provider.name}</span>
                                            <small>{catalogSourceLabel(provider.source)}</small>
                                        </div>
                                        {provider.choices.map(choice => {
                                            const key = modelChoiceKey(choice.providerId, choice.id);
                                            const active = key === activeKey;
                                            const selected = key === selectedKey;
                                            const secondary = choice.id === ''
                                                ? `${provider.name} の設定に従う`
                                                : choice.custom
                                                    ? `${provider.name} · 一覧にないモデル`
                                                    : undefined;
                                            return (
                                                <div
                                                    key={key}
                                                    ref={active ? activeRowRef : undefined}
                                                    id={`${listboxId}-${encodeURIComponent(key)}`}
                                                    className={`poiesis-model-picker__option${active ? ' active' : ''}`}
                                                    role='option'
                                                    aria-selected={selected}
                                                    data-provider={choice.providerId}
                                                    data-model={choice.id}
                                                    title={choice.id && choice.id !== choice.label ? choice.id : undefined}
                                                    onMouseMove={() => setActiveKey(key)}
                                                    onMouseDown={event => event.preventDefault()}
                                                    onClick={() => choose(choice.providerId, choice.id)}
                                                >
                                                    <span className='poiesis-model-picker__option-copy'>
                                                        <strong>{choice.id === '' ? '既定' : choice.label}</strong>
                                                        {secondary && <small>{secondary}</small>}
                                                    </span>
                                                    {selected && <span className='codicon codicon-check' aria-hidden='true' />}
                                                </div>
                                            );
                                        })}
                                    </React.Fragment>
                                ))}
                                {!visibleChoices.length && <div className='poiesis-model-picker__empty'>一致するモデルはありません。</div>}
                            </div>
                            <button type='button' className='poiesis-model-picker__custom-entry' onClick={startCustom}>
                                <span className='codicon codicon-edit' aria-hidden='true' />
                                <span>一覧にないモデルを指定</span>
                            </button>
                        </>
                    )}
                    <div className='poiesis-model-picker__footer'>
                        {!customDraft && (
                            <label className='poiesis-model-picker__effort'>
                                <span>処理の深さ</span>
                                <PoiesisSelect
                                    ariaLabel={`${roleLabel}の処理の深さ`}
                                    value={selectedEffort}
                                    options={[
                                        { value: '', label: '既定' },
                                        ...(selectedEffort && !supportedEfforts.includes(selectedEffort)
                                            ? [{ value: selectedEffort, label: `${effortLabel(selectedEffort)}（現在の設定）`, disabled: true }]
                                            : []),
                                        ...supportedEfforts.map(effort => ({ value: effort, label: effortLabel(effort) }))
                                    ]}
                                    popoverClassName='poiesis-model-picker__nested-select'
                                    onChange={onEffortChange}
                                />
                            </label>
                        )}
                        <button type='button' className='poiesis-model-picker__settings' onClick={openAiSettings}>AIを設定</button>
                        {!customDraft && effortUnsupported && (
                            <div className='poiesis-model-picker__effort-warning' role='alert'>
                                現在の処理の深さはこのモデルでは利用できません。既定または対応する値を選択してください。
                            </div>
                        )}
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
};
