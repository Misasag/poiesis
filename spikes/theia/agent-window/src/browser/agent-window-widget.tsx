import * as React from '@theia/core/shared/react';
import { injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';

@injectable()
export class AgentWindowWidget extends ReactWidget {
    static readonly ID = 'lens-agent-window';
    static readonly LABEL = 'Agent Window';

    protected questionVisible = false;

    @postConstruct()
    protected init(): void {
        this.id = AgentWindowWidget.ID;
        this.title.label = AgentWindowWidget.LABEL;
        this.title.caption = 'Lens Agent Window technical spike';
        this.title.iconClass = 'codicon codicon-hubot';
        this.title.closable = true;
        this.addClass('lens-agent-window');
        this.update();
    }

    protected render(): React.ReactNode {
        return (
            <div className='lens-agent-window__content'>
                <section className='lens-agent-window__message' aria-label='Mock agent message'>
                    <div className='lens-agent-window__speaker'>AI</div>
                    <p>認証処理を変更しました。</p>
                    <ul>
                        <li>Refresh Token の保存先を Redis へ変更</li>
                        <li>TokenStore を追加</li>
                        <li>Logout 時の失効処理を変更</li>
                    </ul>
                    <div className='lens-agent-window__actions'>
                        <button className='theia-button secondary' onClick={() => this.showQuestion()}>
                            質問
                        </button>
                    </div>
                </section>

                {this.questionVisible && this.renderQuestion()}
            </div>
        );
    }

    protected renderQuestion(): React.ReactNode {
        return (
            <section className='lens-agent-window__question' aria-label='Mock follow-up question'>
                <label htmlFor='lens-agent-question'>この Task について質問</label>
                <div className='lens-agent-window__question-row'>
                    <input
                        id='lens-agent-question'
                        className='theia-input'
                        value='なぜ Redis に変更したの？'
                        readOnly
                    />
                    <button className='theia-button secondary' onClick={() => this.hideQuestion()}>
                        閉じる
                    </button>
                </div>
                <small>Spike のため送信処理はモックです。</small>
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
