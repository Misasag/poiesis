import {
    AiRole,
    CLI_EFFORT_LEVELS,
    CliDetectionReport,
    CliModelCatalog,
    CliModelCatalogSource,
    CliModelOption,
    KnownCliId
} from '../common/agent-runtime-protocol';
import { CliDetectionPhase, cliRoleAvailability } from '../common/cli-detection-lifecycle';

export interface ModelPickerChoice extends CliModelOption {
    providerId: KnownCliId;
    providerName: string;
    custom?: boolean;
}

export interface ModelPickerProvider {
    id: KnownCliId;
    name: string;
    source: CliModelCatalogSource;
    error?: string;
    choices: ModelPickerChoice[];
}

export interface CustomModelDraft {
    providerId: KnownCliId;
    value: string;
}

export interface CustomModelValidation {
    model?: string;
    error?: string;
}

export interface ModelPickerPlacement {
    left: number;
    width: number;
    maxHeight: number;
    top?: number;
    bottom?: number;
}

export interface ModelPickerAnchorRect {
    left: number;
    top: number;
    bottom: number;
}

/** Turn an OpenRouter vendor/model slug into a compact display label. */
export function openRouterModelLabel(slug: string): string {
    const model = slug.split('/').pop() ?? slug;
    const words = model.split('-').filter(Boolean).map(word => {
        const lower = word.toLowerCase();
        if (lower === 'glm' || lower === 'gpt') { return lower.toUpperCase(); }
        if (lower === 'kimi') { return 'Kimi'; }
        if (lower === 'deepseek') { return 'DeepSeek'; }
        return word.charAt(0).toUpperCase() + word.slice(1);
    });
    if (words.length > 1 && (words[0] === 'GLM' || words[0] === 'GPT') && /^\d/.test(words[1])) {
        return `${words[0]}-${words.slice(1).join(' ')}`;
    }
    return words.join(' ');
}

export function modelPickerPlacement(
    rect: ModelPickerAnchorRect,
    viewportWidth: number,
    viewportHeight: number
): ModelPickerPlacement {
    const margin = 8;
    const gap = 6;
    const width = Math.max(0, Math.min(392, viewportWidth - margin * 2));
    const left = Math.min(Math.max(margin, rect.left), Math.max(margin, viewportWidth - width - margin));
    const below = Math.max(0, viewportHeight - rect.bottom - gap - margin);
    const above = Math.max(0, rect.top - gap - margin);
    const flipAbove = below < 320 && above > below;
    const available = flipAbove ? above : below;
    const maxHeight = Math.min(520, available);
    return flipAbove
        ? { left, width, maxHeight, bottom: Math.max(margin, viewportHeight - rect.top + gap) }
        : { left, width, maxHeight, top: rect.bottom + gap };
}

/** Builds only executable provider groups and retains an already-saved custom selection. */
export function modelPickerProviders(
    phase: CliDetectionPhase,
    report: CliDetectionReport | undefined,
    catalogs: Partial<Record<KnownCliId, CliModelCatalog>>,
    role: AiRole,
    selectedProvider: KnownCliId,
    selectedModel: string
): ModelPickerProvider[] {
    return (report?.detections ?? []).flatMap(detection => {
        if (cliRoleAvailability(phase, report, detection.id, role) !== 'available') {
            return [];
        }
        const catalog = catalogs[detection.id];
        const source = catalog?.source ?? 'fallback';
        const catalogModels = catalog ? catalog.models : detection.models;
        const models = catalogModels.some(model => model.id === '')
            ? catalogModels
            : [{ id: '', label: '既定' }, ...catalogModels];
        const choices: ModelPickerChoice[] = models.map(model => ({
            ...model,
            label: detection.id === 'pi' && model.id.startsWith('openrouter/')
                ? openRouterModelLabel(model.id.slice('openrouter/'.length)) : model.label,
            providerId: detection.id,
            providerName: detection.name
        }));
        if (detection.id === selectedProvider && selectedModel
            && !choices.some(choice => choice.id === selectedModel)) {
            choices.unshift({
                id: selectedModel,
                label: selectedModel,
                providerId: detection.id,
                providerName: detection.name,
                custom: true
            });
        }
        if (detection.id === 'pi') {
            const groups = new Map<string, ModelPickerChoice[]>();
            for (const choice of choices.filter(choice => choice.id !== '')) {
                const piProvider = choice.piProvider ?? choice.id.split('/')[0];
                const label = piProvider === 'openrouter' ? 'OpenRouter'
                    : piProvider === 'openai-codex' ? 'ChatGPT（pi 経由）' : `${piProvider}（pi 経由）`;
                choice.providerName = label;
                groups.set(label, [...(groups.get(label) ?? []), choice]);
            }
            // The CLI default belongs to pi, but does not need a duplicate group/chip.
            const defaultChoice = choices.find(choice => choice.id === '');
            if (defaultChoice) {
                const firstGroup = groups.keys().next().value ?? 'pi';
                defaultChoice.providerName = firstGroup;
                groups.set(firstGroup, [defaultChoice, ...(groups.get(firstGroup) ?? [])]);
            }
            return [...groups].map(([name, groupChoices]) => ({
                id: detection.id, name, source, error: catalog?.error, choices: groupChoices
            }));
        }
        return [{ id: detection.id, name: detection.id === 'claude' ? 'Claude' : detection.name,
            source, error: catalog?.error, choices }];
    });
}

export function filterModelPickerProviders(
    providers: readonly ModelPickerProvider[],
    providerFilter: string,
    query: string
): ModelPickerProvider[] {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return providers.flatMap(provider => {
        if (providerFilter !== 'all' && provider.name !== providerFilter) {
            return [];
        }
        const choices = normalizedQuery
            ? provider.choices.filter(choice => [choice.label, choice.id]
                .some(value => value.toLocaleLowerCase().includes(normalizedQuery)))
            : provider.choices;
        return choices.length ? [{ ...provider, choices }] : [];
    });
}

export function modelChoiceKey(providerId: KnownCliId, model: string): string {
    return `${providerId}:${model}`;
}

export function beginCustomModelDraft(
    providers: readonly ModelPickerProvider[],
    selectedProvider: KnownCliId,
    selectedModel: string,
    prefill = ''
): CustomModelDraft | undefined {
    const provider = providers.find(candidate => candidate.id === selectedProvider) ?? providers[0];
    if (!provider) {
        return undefined;
    }
    const selectedIsCustom = provider.id === selectedProvider && Boolean(selectedModel)
        && provider.choices.some(choice => choice.id === selectedModel && choice.custom);
    return {
        providerId: provider.id,
        value: prefill.trim() || (selectedIsCustom ? selectedModel : '')
    };
}

export function validateCustomModelDraft(draft: CustomModelDraft): CustomModelValidation {
    const model = draft.value.trim();
    if (!model) {
        return { error: 'モデルIDを入力してください。' };
    }
    if (model.length > 160) {
        return { error: 'モデルIDは160文字以内で入力してください。' };
    }
    return { model };
}

export function modelSupportedEfforts(
    providerId: KnownCliId,
    model: string,
    providers: readonly ModelPickerProvider[]
): string[] {
    const metadata = providers.find(provider => provider.id === providerId)?.choices
        .find(choice => choice.id === model);
    const advertised = metadata?.supportedReasoningEfforts;
    return advertised
        ? advertised.filter(effort => CLI_EFFORT_LEVELS[providerId].includes(effort))
        : [...CLI_EFFORT_LEVELS[providerId]];
}

export function modelEffortIsUnsupported(
    providerId: KnownCliId,
    model: string,
    effort: string,
    providers: readonly ModelPickerProvider[]
): boolean {
    if (!model || !effort) {
        return false;
    }
    const metadata = providers.find(provider => provider.id === providerId)?.choices
        .find(choice => choice.id === model);
    return Boolean(metadata?.supportedReasoningEfforts
        && !metadata.supportedReasoningEfforts.includes(effort));
}
