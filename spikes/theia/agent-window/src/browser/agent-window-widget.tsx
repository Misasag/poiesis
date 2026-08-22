import * as React from '@theia/core/shared/react';
import { injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { getDesignVariant, isDesignVariant } from './design-variant';

@injectable()
export class AgentWindowWidget extends ReactWidget {
    static readonly ID = 'lens-agent-window';
    static readonly LABEL = 'Agent Window';

    protected questionVisible = false;

    @postConstruct()
    protected init(): void {
        getDesignVariant();
        this.id = AgentWindowWidget.ID;
        this.title.label = AgentWindowWidget.LABEL;
        this.title.caption = 'Lens Agent Window technical spike';
        this.title.iconClass = 'codicon codicon-hubot';
        this.title.closable = true;
        this.addClass('lens-agent-window');
        this.questionVisible = isDesignVariant('d6-a', 'd6-b');
        this.update();
    }

    protected render(): React.ReactNode {
        return (
            <div className='lens-agent-window__content'>
                <header className='lens-agent-window__header'>
                    <div>
                        <div className='lens-agent-window__speaker'>LENS AGENT</div>
                        <strong>lens</strong>
                    </div>
                    <span className='lens-agent-window__ready'>● Ready</span>
                </header>
                <section className='lens-agent-window__user-message' aria-label='Mock user message'>
                    <div className='lens-agent-window__speaker'>YOU</div>
                    <p>認証を Redis 方式へ変更して</p>
                </section>
                <section className='lens-agent-window__message' aria-label='Mock agent message'>
                    <div className='lens-agent-window__result-heading'>
                        <div className='lens-agent-window__speaker'>AGENT · TASK RESULT</div>
                        <span className='lens-agent-window__complete'>✓ 完了</span>
                    </div>
                    <p>認証処理を Redis 方式へ変更しました。</p>
                    <ul>
                        <li>TokenStore へ保存責務を分離</li>
                        <li>Refresh / Logout の処理を更新</li>
                        <li>関連テストを追加</li>
                    </ul>
                    <div className='lens-agent-window__verification'>
                        <span className='codicon codicon-pass-filled' aria-hidden='true' />
                        <span>検証: 24 tests passed</span>
                    </div>
                    {!isDesignVariant('d4-b') && <div className='lens-agent-window__unresolved'>未解決: なし</div>}
                    {isDesignVariant('d4-b') && (
                        <div className='lens-agent-window__file-count'>
                            <span className='codicon codicon-files' aria-hidden='true' />
                            3 files changed · +83 −9
                        </div>
                    )}
                    <div className='lens-agent-window__actions'>
                        <button className='theia-button secondary' onClick={() => this.showQuestion()}>
                            質問
                        </button>
                    </div>
                </section>

                {this.questionVisible && this.renderQuestion()}
                {!isDesignVariant('d6-b') && this.renderComposer()}
            </div>
        );
    }

    protected renderQuestion(): React.ReactNode {
        if (isDesignVariant('d6-b')) {
            return (
                <section className='lens-agent-window__question lens-agent-window__question--inline' aria-label='Mock follow-up question'>
                    <label htmlFor='lens-agent-inline-question'>この Task について質問</label>
                    <div className='lens-agent-window__question-row'>
                        <input
                            id='lens-agent-inline-question'
                            className='theia-input'
                            value='なぜ TokenStore を分けたの？'
                            readOnly
                        />
                        <button className='theia-button' aria-label='Send mock inline question'>
                            <span className='codicon codicon-send' aria-hidden='true' />
                        </button>
                    </div>
                    <small>Task result直下の入力欄</small>
                </section>
            );
        }

        return (
            <section className='lens-agent-window__question lens-agent-window__question--context' aria-label='Mock follow-up question'>
                <span>質問: 認証を Redis 方式へ変更</span>
                <button aria-label='Clear task context' onClick={() => this.hideQuestion()}>×</button>
            </section>
        );
    }

    protected renderComposer(): React.ReactNode {
        return (
            <section className='lens-agent-window__composer' aria-label='Agent message composer'>
                <textarea
                    className='theia-input'
                    value={this.questionVisible ? 'なぜ TokenStore を分けたの？' : ''}
                    placeholder='依頼を入力…'
                    readOnly
                    rows={3}
                />
                <button className='theia-button lens-agent-window__send' aria-label='Send mock agent message'>
                    <span className='codicon codicon-send' aria-hidden='true' />
                </button>
            </section>
        );
    }

    protected showQuestion(): void {
        this.questionVisible = true;
        this.update();
    }

    protected hideQuestion(): void {
        this.questionVisible = false;
        this.update();
    }
}
