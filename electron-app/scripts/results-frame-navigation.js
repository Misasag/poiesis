'use strict';

const RESULTS_FRAME_NAME = 'poiesis-results-document';

/**
 * Only the app-owned direct srcdoc child is restricted; Theia and plugin frames keep their own navigation.
 * The frame is recognised by the frame tree node recorded when it was created: a document can rename
 * its own window (window.name), so the current name is not trusted.
 */
function createResultsFrameNavigationGuard(contents) {
    const resultsFrames = new Set();
    return {
        frameCreated(frame) {
            if (frame?.name === RESULTS_FRAME_NAME && frame.parent === contents.mainFrame) resultsFrames.add(frame.frameTreeNodeId);
        },
        shouldBlock(details) {
            return shouldBlockResultsFrameNavigation(details, resultsFrames);
        }
    };
}

function shouldBlockResultsFrameNavigation(details, resultsFrames) {
    if (details.isMainFrame) return false;
    // A child frame that cannot be identified is refused rather than assumed to be someone else's.
    if (!details.frame) return true;
    return resultsFrames.has(details.frame.frameTreeNodeId) && details.url !== 'about:srcdoc';
}

module.exports = { createResultsFrameNavigationGuard, shouldBlockResultsFrameNavigation };
