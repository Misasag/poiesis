export const RESULTS_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const RESULTS_IMAGES_MAX_BYTES = 8 * 1024 * 1024;
export const RESULTS_IMAGES_MAX_COUNT = 40;

export interface ResultsImageResolution {
    images: { path: string; dataUrl: string }[];
    diagnostics: string[];
}
