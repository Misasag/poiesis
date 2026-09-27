'use strict';

/** Only the app-owned direct srcdoc child is restricted; Theia and plugin frames keep their own navigation. */
function shouldBlockResultsFrameNavigation(details, mainFrame) {
    const frame = details.frame;
    return !details.isMainFrame && frame?.name === 'poiesis-results-document'
        && frame.parent === mainFrame && details.url !== 'about:srcdoc';
}

module.exports = { shouldBlockResultsFrameNavigation };
