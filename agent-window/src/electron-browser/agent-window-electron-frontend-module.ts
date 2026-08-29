import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { ContainerModule } from '@theia/core/shared/inversify';
import { WindowControls } from './window-controls';
import '../../src/electron-browser/window-controls.css';

export default new ContainerModule(bind => {
    bind(WindowControls).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(WindowControls);
});
