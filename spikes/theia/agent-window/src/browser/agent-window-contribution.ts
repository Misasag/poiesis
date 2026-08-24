import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, WidgetManager } from '@theia/core/lib/browser';
import { DisposableCollection } from '@theia/core/lib/common';
import { Widget } from '@theia/core/shared/@lumino/widgets';
import { EditorManager } from '@theia/editor/lib/browser';
import { AgentWindowWidget } from './agent-window-widget';

@injectable()
export class AgentWindowContribution implements FrontendApplicationContribution {
    protected host?: HTMLElement;
    protected readonly toDispose = new DisposableCollection();

    constructor(
        @inject(AgentWindowWidget) protected readonly agentWindowWidget: AgentWindowWidget,
        @inject(WidgetManager) protected readonly widgetManager: WidgetManager,
        @inject(EditorManager) protected readonly editorManager: EditorManager
    ) { }

    initialize(): void {
        this.toDispose.push(this.editorManager.onCreated(widget => {
            const factoryId = this.widgetManager.getDescription(widget)?.factoryId
                ?? AgentWindowWidget.EDITOR_WIDGET_FACTORY_ID;
            this.agentWindowWidget.registerCodeWidget(factoryId, widget);
        }));
        this.toDispose.push(this.widgetManager.onDidCreateWidget(({ factoryId, widget }) => {
            this.agentWindowWidget.registerCodeWidget(factoryId, widget);
        }));
    }

    async onDidInitializeLayout(): Promise<void> {
        const [files, search, git, gitGraph] = await Promise.all([
            this.widgetManager.getOrCreateWidget(AgentWindowWidget.FILES_WIDGET_FACTORY_ID),
            this.widgetManager.getOrCreateWidget(AgentWindowWidget.SEARCH_WIDGET_FACTORY_ID),
            this.widgetManager.getOrCreateWidget(AgentWindowWidget.GIT_WIDGET_FACTORY_ID),
            this.widgetManager.getOrCreateWidget(AgentWindowWidget.GIT_GRAPH_WIDGET_FACTORY_ID)
        ]);
        this.agentWindowWidget.registerCodeWidget(AgentWindowWidget.FILES_WIDGET_FACTORY_ID, files);
        this.agentWindowWidget.registerCodeWidget(AgentWindowWidget.SEARCH_WIDGET_FACTORY_ID, search);
        this.agentWindowWidget.registerCodeWidget(AgentWindowWidget.GIT_WIDGET_FACTORY_ID, git);
        this.agentWindowWidget.registerCodeWidget(AgentWindowWidget.GIT_GRAPH_WIDGET_FACTORY_ID, gitGraph);
        for (const editor of this.editorManager.all) {
            const factoryId = this.widgetManager.getDescription(editor)?.factoryId
                ?? AgentWindowWidget.EDITOR_WIDGET_FACTORY_ID;
            this.agentWindowWidget.registerCodeWidget(factoryId, editor, true);
        }
        for (const settings of this.widgetManager.getWidgets(AgentWindowWidget.SETTINGS_WIDGET_FACTORY_ID)) {
            this.agentWindowWidget.registerCodeWidget(AgentWindowWidget.SETTINGS_WIDGET_FACTORY_ID, settings);
        }

        const host = document.createElement('div');
        host.id = 'poiesis-window-host';
        host.setAttribute('aria-label', 'Poiesis');
        // Theia keeps its preload node in the document after startup. Appending
        // Poiesis after it prevents the transparent preload layer from intercepting
        // controls near the bottom edge of the window.
        document.body.appendChild(host);
        Widget.attach(this.agentWindowWidget, host);
        this.host = host;
    }

    onStop(): void {
        this.toDispose.dispose();
        if (this.agentWindowWidget.isAttached) {
            Widget.detach(this.agentWindowWidget);
        }
        this.host?.remove();
        this.host = undefined;
    }
}
