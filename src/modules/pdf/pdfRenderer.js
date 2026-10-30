import { isMobile, isIOSLike, clamp, hexToRgb } from "../utils/helpers.js";
import { getPageDisplayScale } from "../utils/responsive.js";
import { EVENTS } from "../../constants/events.js";
import {
    calculateHorizontalTextFit,
    getFocusedReadableWords,
    TEXT_WIDTH_FIT_PADDING_PX,
} from "./pdfTextWidthFit.js";

const AMOLED_TEXT_COLORS = [
    "#f5f5f5",
    "#dddddd",
    "#c6c6c6",
    "#adadad",
    "#949494",
    "#7c7c7c",
    "#646464",
    "#4d4d4d",
    "#383838",
    "#282828",
];

export class PDFRenderer {
    constructor(app) {
        this.app = app;
        this.pageCoordinateSystems = new Map();
        this._pageRenderPromises = new Map();
        this._renderedPdf = null;
        this._fullDocumentObserver = null;
        this._nearbyPageWrappers = new Set();
        this._pageTextFocusTimer = null;
        this._activePhraseActionsEl = null;
        this._boundAmoledModeChange = () => {
            this.refreshAmoledRendering().catch((error) => {
                console.debug("[PDFRenderer] Failed to refresh AMOLED rendering", error);
            });
        };
        window.addEventListener("amoled-mode-change", this._boundAmoledModeChange, { passive: true });
    }

    _isAmoledModeEnabled() {
        try {
            return (
                document.documentElement.classList.contains("amoled-mode") ||
                localStorage.getItem("config.amoledMode") === "1"
            );
        } catch {
            return document.documentElement.classList.contains("amoled-mode");
        }
    }

    _getRenderOptions() {
        if (!this._isAmoledModeEnabled()) return {};
        return {
            pageColors: {
                background: "#000000",
                foreground: this._getAmoledTextColor(),
            },
        };
    }

    _getMaxRenderedPages() {
        return isIOSLike() ? 2 : 5;
    }

    _getRenderDeviceScale(viewportDisplay) {
        const rawScale = window.devicePixelRatio || 1;
        if (!isIOSLike()) return rawScale;

        // Keep a rendered iOS page near 12 MB (RGBA) at most. This still allows
        // Retina rendering for small pages while avoiding Safari tab termination.
        const cssPixels = Math.max(1, viewportDisplay.width * viewportDisplay.height);
        const pixelBudgetScale = Math.sqrt(3_000_000 / cssPixels);
        return Math.max(1, Math.min(rawScale, pixelBudgetScale));
    }

    releaseCanvas(canvas) {
        if (!canvas) return;
        canvas.remove?.();
        // Merely removing a canvas does not reliably release its backing store in
        // WebKit. Resizing it does, and is safe after it leaves the render cache.
        canvas.width = 0;
        canvas.height = 0;
    }

    acquireCanvas() {
        return document.createElement("canvas");
    }

    _removeCachedPage(pageNumber, container = null) {
        const { state } = this.app;
        const canvas = state.fullPageRenderCache.get(pageNumber);
        const wrapper = container?.querySelector?.(`.pdf-page-wrapper[data-page-number="${pageNumber}"]`);
        const mounted = wrapper?.querySelector?.("canvas.page-canvas");
        state.fullPageRenderCache.delete(pageNumber);
        if (mounted && mounted !== canvas) this.releaseCanvas(mounted);
        this.releaseCanvas(canvas);
    }

    _cacheFullPageCanvas(pageNumber, canvas) {
        const { state } = this.app;
        if (state.fullPageRenderCache.has(pageNumber)) {
            state.fullPageRenderCache.delete(pageNumber);
        }
        state.fullPageRenderCache.set(pageNumber, canvas);

        const container = document.getElementById("pdf-doc-container");
        while (state.fullPageRenderCache.size > this._getMaxRenderedPages()) {
            const oldest = state.fullPageRenderCache.keys().next().value;
            if (oldest === undefined) break;
            this._removeCachedPage(oldest, container);
        }
    }

    clearRenderedPageCache() {
        const { state } = this.app;
        for (const canvas of state.fullPageRenderCache.values()) this.releaseCanvas(canvas);
        state.fullPageRenderCache.clear();
    }

    disconnectFullDocumentObserver() {
        this._fullDocumentObserver?.disconnect();
        this._fullDocumentObserver = null;
        this._nearbyPageWrappers.clear();
        if (this._pageTextFocusTimer) {
            clearTimeout(this._pageTextFocusTimer);
            this._pageTextFocusTimer = null;
        }
    }

    _scheduleFocusedPageTextParsing(pageNumber, wrapper) {
        if (this._pageTextFocusTimer) clearTimeout(this._pageTextFocusTimer);
        this._pageTextFocusTimer = setTimeout(() => {
            this._pageTextFocusTimer = null;
            if (!wrapper?.isConnected || this.app.state.currentPdfPage !== pageNumber) return;
            this.app.pdfLoader
                ?.ensurePageParsed?.(pageNumber, { prefetchNext: true })
                .then(() => {
                    if (!wrapper.isConnected) return;
                    this.updateHighlightDisplay();
                    this.app.interactionHandler?.setupInteractionListeners?.();
                })
                .catch((error) => {
                    console.warn(`[PDFRenderer] Text extraction failed for page ${pageNumber}`, error);
                });
        }, 250);
    }

    _getAmoledTextColor() {
        try {
            return AMOLED_TEXT_COLORS[this._getAmoledTextLevel()];
        } catch {
            // fall through to default
        }
        return AMOLED_TEXT_COLORS[0];
    }

    _getAmoledTextLevel() {
        try {
            const level = Number.parseInt(localStorage.getItem("config.amoledTextLevel") || "0", 10);
            if (Number.isFinite(level)) {
                return Math.min(AMOLED_TEXT_COLORS.length - 1, Math.max(0, level));
            }
        } catch {
            // fall through to default
        }
        return 0;
    }

    _scaleHighlightOpacity(baseOpacity, minOpacity) {
        if (!this._isAmoledModeEnabled()) return baseOpacity;
        const maxLevel = Math.max(1, AMOLED_TEXT_COLORS.length - 1);
        const progress = this._getAmoledTextLevel() / maxLevel;
        return minOpacity + (baseOpacity - minOpacity) * (1 - progress);
    }

    _getActiveHighlightColor() {
        const opacity = this._scaleHighlightOpacity(0.3, 0.06);
        return `rgba(12, 163, 223, ${opacity.toFixed(3)})`;
    }

    async refreshAmoledRendering() {
        const { state } = this.app;
        if (!state?.pdf || state.currentDocumentType !== "pdf") return;

        this.clearRenderedPageCache();

        const container = document.getElementById("pdf-doc-container");
        if (container) {
            container.querySelectorAll("canvas.page-canvas").forEach((canvas) => this.releaseCanvas(canvas));
        }
        this.clearFullDocHighlights?.();

        const currentPage = state.currentSentence?.pageNumber;
        if (Number.isFinite(currentPage)) {
            await this.ensurePageCanvasMounted(currentPage);
            this.updateHighlightFullDoc(state.currentSentence);
            return;
        }

        const firstVisiblePage = container?.querySelector?.(".pdf-page-wrapper[data-page-number]")?.dataset?.pageNumber;
        const pageNumber = Number.parseInt(firstVisiblePage, 10);
        if (Number.isFinite(pageNumber)) {
            await this.ensurePageCanvasMounted(pageNumber);
        }
    }

    async ensureViewportDisplay(pageNumber) {
        const { state, config } = this.app;
        if (!Number.isFinite(pageNumber) || pageNumber <= 0) return null;
        const existing = state.viewportDisplayByPage?.get?.(pageNumber);
        if (existing && Number.isFinite(existing.width) && Number.isFinite(existing.height)) {
            return existing;
        }

        if (!state.pdf) return null;
        const pdfDocument = state.pdf;

        try {
            const page = state.pagesCache.get(pageNumber) || (await pdfDocument.getPage(pageNumber));
            if (state.pdf !== pdfDocument) return null;
            if (page && !state.pagesCache.has(pageNumber)) state.pagesCache.set(pageNumber, page);

            const unscaled = page.getViewport({ scale: 1 });
            const baseWidthCss =
                typeof config.BASE_WIDTH_CSS === "function" ? config.BASE_WIDTH_CSS() : window.innerWidth;
            const displayScale = baseWidthCss / Math.max(1, unscaled.width);
            const viewportDisplay = page.getViewport({ scale: displayScale });

            // Keep page scaling metadata in sync when possible
            page.unscaledWidth = page.unscaledWidth || unscaled.width;
            page.unscaledHeight = page.unscaledHeight || unscaled.height;
            page.baseDisplayScale = displayScale;
            page.currentDisplayScale = displayScale;

            if (state.pdf !== pdfDocument) return null;
            state.viewportDisplayByPage.set(pageNumber, viewportDisplay);
            return viewportDisplay;
        } catch {
            return null;
        }
    }

    ensurePageWordsScaled(pageNumber) {
        const { state } = this.app;
        const page = state.pagesCache.get(pageNumber);
        if (!page || !page.pageWords) return;
        if (!page.needsWordRescale) return;

        const s = page.currentDisplayScale || page.baseDisplayScale || 1;
        if (!Number.isFinite(s) || s <= 0) return;

        for (const w of page.pageWords) {
            // Recompute from canonical geometry captured during preprocessing
            if (w && typeof w._baseX === "number") {
                const x = w._baseX * s;
                const y = w._baseYDisplay * s;
                const width = w._baseWidth * s;
                const height = w._baseHeight * s;

                w.x = x;
                w.y = y;
                w.width = width;
                w.height = height;
                if (!w.bbox) w.bbox = {};
                const bboxTop = y - height;
                w.bbox.x = x;
                w.bbox.y = bboxTop;
                w.bbox.width = width;
                w.bbox.height = height;
                w.bbox.x1 = x;
                w.bbox.y1 = bboxTop;
                w.bbox.x2 = x + width;
                w.bbox.y2 = bboxTop + height;
            }
        }
        page.needsWordRescale = false;
    }

    getReadableWords(sentence) {
        if (!sentence) return [];
        if (Array.isArray(sentence.readableWords) && sentence.readableWords.length) {
            return sentence.readableWords;
        }
        if (sentence?.layoutProcessed) {
            return [];
        }
        return Array.isArray(sentence.words) ? sentence.words : [];
    }

    _getWordBoxViewport(word) {
        if (word?.bbox && Number.isFinite(word.bbox.x1) && Number.isFinite(word.bbox.y1)) {
            return { x1: word.bbox.x1, y1: word.bbox.y1, x2: word.bbox.x2, y2: word.bbox.y2 };
        }
        const x1 = Number(word?.x) || 0;
        const y2 = Number(word?.y) || 0;
        const width = Number(word?.width) || 0;
        const height = Number(word?.height) || 0;
        return { x1, y1: y2 - height, x2: x1 + width, y2 };
    }

    _boxesOverlap(a, b) {
        const overlapX = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
        const overlapY = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
        return overlapX > 0 && overlapY > 0;
    }

    _getCachedReadableLayoutBoxes(pageNumber) {
        const { state } = this.app;
        const viewportDisplay = state.viewportDisplayByPage.get(pageNumber);
        const cacheEntry = state.layoutDetectionCache?.get?.(pageNumber);
        const detections = cacheEntry?.detections;
        if (!viewportDisplay || !Array.isArray(detections) || !detections.length) return [];

        const detector = this.app.getPdfHeaderFooterDetector?.();
        const regions = detector?._buildRegionsFromDetections?.(detections, viewportDisplay);
        return Array.isArray(regions?.readableBoxes) ? regions.readableBoxes : [];
    }

    _isTextWidthFitActive() {
        const { state } = this.app;
        return (
            state.currentDocumentType === "pdf" &&
            state.viewMode === "full" &&
            state.textWidthFitEnabled &&
            state.generationEnabled
        );
    }

    _getTextWidthFitBlockKey(sentence) {
        const { state } = this.app;
        if (state.playingSentenceIndex === sentence?.index && state.playingPhraseBlockKey) {
            return state.playingPhraseBlockKey;
        }
        return sentence?.layoutBlockKey || null;
    }

    _restoreTextWidthFitWrapper(wrapper) {
        if (!wrapper) return;
        const pageNumber = Number.parseInt(wrapper.dataset.pageNumber, 10);
        const viewportDisplay = this.app.state.viewportDisplayByPage.get(pageNumber);
        delete wrapper.dataset.textWidthFit;
        delete wrapper.dataset.textWidthFitLeft;
        delete wrapper.dataset.textWidthFitRight;
        wrapper.style.marginLeft = "auto";
        wrapper.style.marginRight = "auto";
        if (viewportDisplay) this.applyPageScale(wrapper, viewportDisplay);
    }

    applyTextWidthFit(sentence, { restoreOthers = true } = {}) {
        const container = document.getElementById("pdf-doc-container");
        if (!container) return null;

        const targetPage = Number(sentence?.pageNumber);
        if (restoreOthers) {
            container.querySelectorAll('.pdf-page-wrapper[data-text-width-fit="1"]').forEach((wrapper) => {
                if (!this._isTextWidthFitActive() || Number(wrapper.dataset.pageNumber) !== targetPage) {
                    this._restoreTextWidthFitWrapper(wrapper);
                }
            });
        }

        // Layout processing is deliberately a hard prerequisite. This prevents
        // headers, footers, figures, and any other unclassified page content from
        // affecting the horizontal word extrema.
        if (!this._isTextWidthFitActive() || !sentence?.layoutProcessed) return null;
        const cacheEntry = this.app.state.layoutDetectionCache?.get?.(targetPage);
        if (cacheEntry?.readabilityVersion !== this.app.state.layoutCacheVersion) return null;

        const wrapper = container.querySelector(`.pdf-page-wrapper[data-page-number="${targetPage}"]`);
        const viewportDisplay = this.app.state.viewportDisplayByPage.get(targetPage);
        const page = this.app.state.pagesCache.get(targetPage);
        if (!wrapper || !viewportDisplay || !page?.pageWords) return null;

        this.ensurePageWordsScaled(targetPage);
        const readableBoxes = this._getCachedReadableLayoutBoxes(targetPage);
        const focusBlockKey = this._getTextWidthFitBlockKey(sentence);
        const focusedWords = getFocusedReadableWords(page.pageWords, readableBoxes, focusBlockKey);
        const fit = calculateHorizontalTextFit(
            focusedWords,
            viewportDisplay.width,
            container.clientWidth || window.innerWidth,
            TEXT_WIDTH_FIT_PADDING_PX,
        );
        if (!fit) {
            this._restoreTextWidthFitWrapper(wrapper);
            return null;
        }

        const scaledHeight = viewportDisplay.height * fit.scale;
        wrapper.dataset.scale = String(fit.scale);
        wrapper.dataset.textWidthFit = "1";
        wrapper.dataset.textWidthFitBlock = focusBlockKey || "page";
        wrapper.dataset.textWidthFitLeft = String(fit.fittedTextLeft);
        wrapper.dataset.textWidthFitRight = String(fit.fittedTextRight);
        wrapper.style.width = `${fit.pageWidth}px`;
        wrapper.style.height = `${scaledHeight}px`;
        wrapper.style.minHeight = `${scaledHeight}px`;
        wrapper.style.marginLeft = `${fit.offsetLeft}px`;
        wrapper.style.marginRight = "0px";

        const canvas = wrapper.querySelector("canvas.page-canvas");
        if (canvas) {
            canvas.style.width = "100%";
            canvas.style.height = "100%";
        }
        return fit;
    }

    refreshTextWidthFit({ scrollToFocus = false } = {}) {
        const { state } = this.app;
        const container = document.getElementById("pdf-doc-container");
        if (!container) return;
        const sentence = state.currentSentence;

        if (!this._isTextWidthFitActive() || !sentence) {
            container.querySelectorAll('.pdf-page-wrapper[data-text-width-fit="1"]').forEach((wrapper) => {
                this._restoreTextWidthFitWrapper(wrapper);
            });
            this.updatePhraseHighlightsAndListeners({ sentence });
            return;
        }

        this.applyTextWidthFit(sentence);
        this.updatePhraseHighlightsAndListeners({ sentence });
        if (scrollToFocus) this.scrollSentenceIntoView(sentence);
    }

    getLayoutBlockKeyAtPoint(pageNumber, xDisplay, yDisplay) {
        if (!this.app.config.SPLIT_PDF_AUDIO_ON_LAYOUT_BLOCKS) return null;
        const readableBoxes = this._getCachedReadableLayoutBoxes(pageNumber);
        if (readableBoxes.length < 2) return null;

        for (let i = 0; i < readableBoxes.length; i++) {
            const box = readableBoxes[i];
            if (xDisplay >= box.x1 && xDisplay <= box.x2 && yDisplay >= box.y1 && yDisplay <= box.y2) {
                return `readable:${i}`;
            }
        }
        return null;
    }

    getLayoutPhraseWordsForBlock(sentence, blockKey) {
        if (!sentence || !blockKey || !this.app.config.SPLIT_PDF_AUDIO_ON_LAYOUT_BLOCKS) return [];
        const match = /^readable:(\d+)$/.exec(String(blockKey));
        if (!match) return [];

        const readableBoxes = this._getCachedReadableLayoutBoxes(sentence.pageNumber);
        const blockIndex = Number(match[1]);
        const block = readableBoxes[blockIndex];
        if (!block || readableBoxes.length < 2) return [];

        const words = this.getReadableWords(sentence);
        return words.filter((word) => this._boxesOverlap(this._getWordBoxViewport(word), block));
    }

    getLayoutPhraseEntriesForSentence(sentence) {
        if (!sentence) return [];
        const readableBoxes = this._getCachedReadableLayoutBoxes(sentence.pageNumber);
        if (readableBoxes.length < 2) return [];

        const entries = [];
        let currentBlockKey = null;
        let currentWords = [];
        const flush = () => {
            if (!currentWords.length || !currentBlockKey) return;
            const text =
                this.app.sentenceParser?.joinWords?.(currentWords) ||
                currentWords
                    .map((word) => word?.str || "")
                    .filter(Boolean)
                    .join(" ");
            if (String(text || "").trim()) {
                entries.push({ blockKey: currentBlockKey, text: String(text).trim(), words: currentWords });
            }
            currentWords = [];
        };

        // Preserve the PDF text stream's reading order. Detection arrays are not
        // guaranteed to be top-to-bottom and must only identify boundaries.
        for (const word of this.getReadableWords(sentence)) {
            const wordBox = this._getWordBoxViewport(word);
            const blockIndex = readableBoxes.findIndex((box) => this._boxesOverlap(wordBox, box));
            if (blockIndex < 0) continue;
            const blockKey = `readable:${blockIndex}`;
            if (currentBlockKey !== null && blockKey !== currentBlockKey) flush();
            currentBlockKey = blockKey;
            currentWords.push(word);
        }
        flush();
        return entries;
    }

    getNearestSentenceIndexForLayoutBlock(pageNumber, blockKey, xDisplay, yDisplay) {
        if (!blockKey) return -1;
        const { state } = this.app;
        const indices = state.pageSentencesIndex.get(pageNumber);
        if (!Array.isArray(indices) || !indices.length) return -1;

        let nearestIndex = -1;
        let nearestDistanceSquared = Infinity;
        for (const index of indices) {
            const sentence = state.sentences[index];
            if (!sentence) continue;
            const phraseWords = this.getLayoutPhraseWordsForBlock(sentence, blockKey);
            for (const word of phraseWords) {
                const box = this._getWordBoxViewport(word);
                const dx = xDisplay < box.x1 ? box.x1 - xDisplay : xDisplay > box.x2 ? xDisplay - box.x2 : 0;
                const dy = yDisplay < box.y1 ? box.y1 - yDisplay : yDisplay > box.y2 ? yDisplay - box.y2 : 0;
                const distanceSquared = dx * dx + dy * dy;
                if (distanceSquared < nearestDistanceSquared) {
                    nearestDistanceSquared = distanceSquared;
                    nearestIndex = index;
                }
            }
        }
        return nearestIndex;
    }

    getHoverPhraseWords(sentence) {
        const { state } = this.app;
        if (!sentence || state.currentDocumentType !== "pdf") return [];
        if (state.hoveredSentenceIndex !== sentence.index) return [];
        const point = state.hoveredPhrasePoint;
        if (!point || point.pageNumber !== sentence.pageNumber) return [];
        return this.getLayoutPhraseWordsForBlock(sentence, state.hoveredPhraseBlockKey);
    }

    getPhraseRectsForSentence(sentence, blockKey) {
        if (!sentence) return [];
        const phraseWords = this.getLayoutPhraseWordsForBlock(sentence, blockKey);
        const words = phraseWords.length ? phraseWords : this.getReadableWords(sentence);
        if (!Array.isArray(words) || !words.length) return [];
        if (!this.pageCoordinateSystems.has(sentence.pageNumber)) {
            this.calibratePageCoordinateSystem(sentence.pageNumber, sentence);
        }
        return this.getMergedLineRects(words, sentence.pageNumber);
    }

    isPointInsideHoveredPhrase(mapped, { padding = 3 } = {}) {
        const { state } = this.app;
        if (!mapped || state.currentDocumentType !== "pdf") return false;
        if (state.hoveredSentenceIndex < 0) return false;
        const sentence = state.sentences[state.hoveredSentenceIndex];
        if (!sentence || sentence.pageNumber !== mapped.pageNumber) return false;
        const rects = Array.isArray(state.hoveredPhraseRects) ? state.hoveredPhraseRects : [];
        if (!rects.length) return false;

        return rects.some(
            (rect) =>
                mapped.xDisplay >= rect.x - padding &&
                mapped.xDisplay <= rect.x + rect.width + padding &&
                mapped.yDisplay >= rect.y - padding &&
                mapped.yDisplay <= rect.y + rect.height + padding,
        );
    }

    getPlayingPhraseWords(sentence) {
        const { state } = this.app;
        if (!sentence || state.currentDocumentType !== "pdf") return [];
        if (state.playingSentenceIndex !== sentence.index) return [];
        return this.getLayoutPhraseWordsForBlock(sentence, state.playingPhraseBlockKey);
    }

    getSentenceBoundingBox(sentence) {
        if (!sentence) return null;
        if (sentence.bboxReadable && sentence.bboxReadable.width && sentence.bboxReadable.height) {
            return sentence.bboxReadable;
        }
        return sentence.bbox || null;
    }

    detectPageCoordinateSystem(pageNumber, words) {
        if (!words || words.length === 0) return "baseline";
        const sampleWords = words.slice(0, Math.min(5, words.length));
        const hasTransforms = sampleWords.some((w) => w.transform && Array.isArray(w.transform));
        if (hasTransforms) {
            return "top-based";
        }
        const avgHeight = sampleWords.reduce((sum, w) => sum + w.height, 0) / sampleWords.length;
        const minY = Math.min(...sampleWords.map((w) => w.y));
        if (minY < avgHeight * 2) {
            return "top-based";
        }
        return "baseline";
    }

    getCorrectedVerticalPosition(word, scale = 1, pageNumber) {
        const coordSystem = this.pageCoordinateSystems.get(pageNumber) || "baseline";
        if (coordSystem === "top-based") {
            return word.y * scale;
        } else {
            return (word.y - word.height) * scale;
        }
    }

    getViewportHeight() {
        return (
            this.app.state.viewportHeight || (window.visualViewport ? window.visualViewport.height : window.innerHeight)
        );
    }

    getPageScaleFactors(wrapper, canvas, pageNumber) {
        const { state } = this.app;
        const viewportDisplay = state.viewportDisplayByPage.get(pageNumber);
        const fallbackScale = parseFloat(wrapper?.dataset?.scale) || 1;
        if (!viewportDisplay) {
            return {
                scaleX: fallbackScale,
                scaleY: fallbackScale,
            };
        }

        const canvasRect = canvas ? canvas.getBoundingClientRect() : null;
        const wrapperRect = wrapper ? wrapper.getBoundingClientRect() : null;
        const width = canvasRect?.width || wrapperRect?.width || viewportDisplay.width * fallbackScale;
        const height = canvasRect?.height || wrapperRect?.height || viewportDisplay.height * fallbackScale;

        return {
            scaleX: width / viewportDisplay.width,
            scaleY: height / viewportDisplay.height,
        };
    }

    calibratePageCoordinateSystem(pageNumber, sentence) {
        const words = this.getReadableWords(sentence);
        if (words.length > 0) {
            const detectedSystem = this.detectPageCoordinateSystem(pageNumber, words);
            this.pageCoordinateSystems.set(pageNumber, detectedSystem);
        }
    }

    async findNextReadableSentenceForward(startIdx, visited) {
        const { state } = this.app;
        const seen = visited ?? new Set();
        let current = state.sentences[startIdx];
        while (current) {
            const i = await this.app.pdfLoader.getAdjacentSentenceIndex(current, 1);
            if (i < 0) return -1;
            let candidate = state.sentences[i];
            if (!candidate || seen.has(candidate)) return -1;

            if (state.generationEnabled && !candidate.layoutProcessed) {
                await this.app.getPdfHeaderFooterDetector().ensureReadabilityForPage(candidate.pageNumber);
            }
            const candidateIndex = state.sentences.indexOf(candidate);
            if (candidateIndex < 0) return -1;

            if (!state.generationEnabled || candidate.isTextToRead) {
                return candidateIndex;
            }

            seen.add(candidate);
            current = candidate;
        }
        return -1;
    }

    async ensureFullPageRendered(pageNumber) {
        const { state } = this.app;
        const pdfDocument = state.pdf;
        if (!pdfDocument) throw new Error("No PDF is loaded");
        if (this._renderedPdf !== pdfDocument) {
            this.clearRenderedPageCache();
            this._renderedPdf = pdfDocument;
        }
        if (state.fullPageRenderCache.has(pageNumber)) {
            const cached = state.fullPageRenderCache.get(pageNumber);
            // Refresh insertion order so eviction behaves as an LRU cache.
            state.fullPageRenderCache.delete(pageNumber);
            state.fullPageRenderCache.set(pageNumber, cached);
            return cached;
        }
        const pending = this._pageRenderPromises.get(pageNumber);
        if (pending?.pdfDocument === pdfDocument) return pending.promise;

        const renderPromise = (async () => {
            const page = state.pagesCache.get(pageNumber) || (await pdfDocument.getPage(pageNumber));
            if (state.pdf !== pdfDocument) throw new Error("PDF document changed during page render");
            const viewportDisplay = state.viewportDisplayByPage.get(pageNumber);
            if (!viewportDisplay) throw new Error(`Missing viewport for PDF page ${pageNumber}`);
            const deviceScale = this._getRenderDeviceScale(viewportDisplay);
            const fullW = Math.round(viewportDisplay.width * deviceScale);
            const fullH = Math.round(viewportDisplay.height * deviceScale);
            const scale = (viewportDisplay.width / page.getViewport({ scale: 1 }).width) * deviceScale;
            const viewportRender = page.getViewport({ scale });
            const off = document.createElement("canvas");
            off.width = fullW;
            off.height = fullH;
            const offCtx = off.getContext("2d");
            await page.render({ canvasContext: offCtx, viewport: viewportRender, ...this._getRenderOptions() }).promise;
            if (state.pdf !== pdfDocument) {
                this.releaseCanvas(off);
                throw new Error("PDF document changed during page render");
            }
            this._cacheFullPageCanvas(pageNumber, off);
            return off;
        })();

        const renderEntry = { pdfDocument, promise: renderPromise };
        this._pageRenderPromises.set(pageNumber, renderEntry);
        try {
            return await renderPromise;
        } finally {
            if (this._pageRenderPromises.get(pageNumber) === renderEntry) {
                this._pageRenderPromises.delete(pageNumber);
            }
        }
    }

    async renderFullDocumentIfNeeded() {
        const { state, config } = this.app;
        if (state.viewMode !== "full") return;

        const container = document.getElementById("pdf-doc-container");
        if (!container) return;
        this.disconnectFullDocumentObserver();
        container.innerHTML = "";

        const observer = new IntersectionObserver(
            async (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) this._nearbyPageWrappers.add(entry.target);
                    else this._nearbyPageWrappers.delete(entry.target);
                }
                if (state.currentSentenceIndex >= 0) {
                    const viewportRect = container.getBoundingClientRect();
                    let focusedWrapper = null;
                    let largestVisibleArea = 0;
                    for (const candidate of this._nearbyPageWrappers) {
                        if (!candidate.isConnected) {
                            this._nearbyPageWrappers.delete(candidate);
                            continue;
                        }
                        const rect = candidate.getBoundingClientRect();
                        const visibleWidth = Math.max(
                            0,
                            Math.min(rect.right, viewportRect.right) - Math.max(rect.left, viewportRect.left),
                        );
                        const visibleHeight = Math.max(
                            0,
                            Math.min(rect.bottom, viewportRect.bottom) - Math.max(rect.top, viewportRect.top),
                        );
                        const visibleArea = visibleWidth * visibleHeight;
                        if (visibleArea > largestVisibleArea) {
                            largestVisibleArea = visibleArea;
                            focusedWrapper = candidate;
                        }
                    }
                    const focusedPage = Number.parseInt(focusedWrapper?.dataset?.pageNumber, 10);
                    if (Number.isFinite(focusedPage)) {
                        state.currentPdfPage = focusedPage;
                        this._scheduleFocusedPageTextParsing(focusedPage, focusedWrapper);
                    }
                }
                for (const entry of entries) {
                    const pageNumber = parseInt(entry.target.dataset.pageNumber, 10);
                    const wrapper = entry.target;
                    const viewportDisplay =
                        state.viewportDisplayByPage.get(pageNumber) || (await this.ensureViewportDisplay(pageNumber));
                    if (!viewportDisplay) continue;
                    const scale = getPageDisplayScale(viewportDisplay, config);

                    if (entry.isIntersecting) {
                        wrapper._isNearViewport = true;
                        if (wrapper._focusTimer) clearTimeout(wrapper._focusTimer);
                        wrapper._focusTimer = setTimeout(async () => {
                            if (!wrapper.isConnected) return;
                            const cExisting = wrapper.querySelector("canvas.page-canvas");
                            if (!cExisting) {
                                const fullPageCanvas = await this.ensureFullPageRendered(pageNumber);
                                if (!wrapper.isConnected || !wrapper._isNearViewport) return;
                                // Mount the cached canvas itself. Cloning it here used to
                                // double the backing-store memory for every visible page.
                                fullPageCanvas.className = "page-canvas";
                                fullPageCanvas.style.width = "100%";
                                fullPageCanvas.style.height = "100%";
                                wrapper.insertBefore(fullPageCanvas, wrapper.firstChild);
                                this.updateHighlightDisplay();
                            }
                        }, this.app.config.MS_ON_FOCUS_TO_RENDER);
                    } else {
                        wrapper._isNearViewport = false;
                        if (wrapper._focusTimer) {
                            clearTimeout(wrapper._focusTimer);
                            wrapper._focusTimer = null;
                        }
                        this._removeCachedPage(pageNumber, container);
                    }

                    const scaledWidth = viewportDisplay.width * scale;
                    const scaledHeight = viewportDisplay.height * scale;
                    wrapper.dataset.scale = scale.toString();
                    wrapper.style.width = scaledWidth + "px";
                    wrapper.style.height = scaledHeight + "px";
                    wrapper.style.minHeight = scaledHeight + "px";

                    const c = wrapper.querySelector("canvas.page-canvas");
                    if (c) {
                        c.style.width = "100%";
                        c.style.height = "100%";
                    }
                    if (state.currentSentence?.pageNumber === pageNumber) {
                        this.applyTextWidthFit(state.currentSentence, { restoreOthers: false });
                    }
                }
            },
            {
                root: container,
                rootMargin: "300px",
                threshold: 0.1,
            },
        );
        this._fullDocumentObserver = observer;

        // Cria wrappers para todas as páginas
        for (let p = 1; p <= state.pdf.numPages; p++) {
            const viewportDisplay = state.viewportDisplayByPage.get(p) || (await this.ensureViewportDisplay(p));
            if (!viewportDisplay) continue;
            const wrapper = document.createElement("div");
            wrapper.className = "pdf-page-wrapper";
            wrapper.dataset.pageNumber = p;

            // Reserva altura mínima para scroll contínuo
            const scale = getPageDisplayScale(viewportDisplay, config);
            const scaledWidth = viewportDisplay.width * scale;
            const scaledHeight = viewportDisplay.height * scale;
            wrapper.style.position = "relative";
            wrapper.dataset.scale = scale.toString();
            wrapper.style.minHeight = scaledHeight + "px";
            wrapper.style.width = scaledWidth + "px";
            wrapper.style.height = scaledHeight + "px";

            container.appendChild(wrapper);
            observer.observe(wrapper);

            const pageObject = state.pagesCache.get(p);
            if (!pageObject) {
                console.warn(`[renderFullDocumentIfNeeded] No page object found in cache for page ${p}`);
            } else if (this.app.pdfHeaderFooterDetector) {
                this.app.pdfHeaderFooterDetector.registerPageDomElement(pageObject, wrapper);
            }
        }
    }

    async refreshLayoutAfterViewportChange() {
        // TODO: Needs update (do not work on smarpthones orientation change)
        const { state, config } = this.app;
        if (state.viewMode !== "full") return;
        const container = document.getElementById("pdf-doc-container");
        if (!container) return;
        if (!container.querySelector(".pdf-page-wrapper")) {
            return this.renderFullDocumentIfNeeded();
        }
        const wrappers = Array.from(container.querySelectorAll(".pdf-page-wrapper"));
        const viewport = container.getBoundingClientRect();

        // Determine visible and near-visible pages
        const nearMargin = 600;
        const tasks = [];
        for (const wrapper of wrappers) {
            const p = parseInt(wrapper.dataset.pageNumber, 10);
            const viewportDisplay = state.viewportDisplayByPage.get(p);
            if (!viewportDisplay) continue;

            // Apply updated scale/size
            this.applyPageScale(wrapper, viewportDisplay);

            // If intersecting with extended viewport, ensure canvas up to date
            const rect = wrapper.getBoundingClientRect();
            const intersects = rect.bottom >= viewport.top - nearMargin && rect.top <= viewport.bottom + nearMargin;
            if (intersects) {
                tasks.push(
                    (async () => {
                        try {
                            const fullPageCanvas = await this.ensureFullPageRendered(p);
                            let c = wrapper.querySelector("canvas.page-canvas");
                            if (c !== fullPageCanvas) {
                                if (c) this.releaseCanvas(c);
                                c = fullPageCanvas;
                                c.className = "page-canvas";
                                c.style.width = "100%";
                                c.style.height = "100%";
                                wrapper.insertBefore(c, wrapper.firstChild);
                            }
                        } catch (e) {
                            // skip errors per page to keep UI responsive
                        }
                    })(),
                );
            } else {
                // Drop heavy canvas for far pages
                this._removeCachedPage(p, container);
            }
        }

        // Throttle concurrent page draws
        const BATCH = 3;
        for (let i = 0; i < tasks.length; i += BATCH) {
            await Promise.allSettled(tasks.slice(i, i + BATCH));
        }
    }

    async refreshPdfRendering(options = {}) {
        const { state } = this.app;
        if (!state?.pdf) return;

        const { containerWidth = null, forceFullRescale = false } = options;

        const container = document.getElementById("pdf-doc-container");
        const effectiveWidth = Math.max(
            1,
            containerWidth || (container ? container.clientWidth : 0) || window.innerWidth || 1,
        );

        let processed = 0;
        for (const [pageNumber, page] of state.pagesCache.entries()) {
            try {
                const baseViewport = page._baseViewport || page.getViewport({ scale: 1 });
                page._baseViewport = baseViewport;
                const unscaledWidth = page.unscaledWidth || baseViewport.width;
                const unscaledHeight = page.unscaledHeight || baseViewport.height;
                const displayScale = effectiveWidth / Math.max(1, unscaledWidth);
                const viewportDisplay = {
                    width: unscaledWidth * displayScale,
                    height: unscaledHeight * displayScale,
                };

                state.viewportDisplayByPage.set(pageNumber, viewportDisplay);
                page.currentDisplayScale = displayScale;
                page.baseDisplayScale = displayScale;
                page.needsWordRescale = true;

                processed += 1;
                if (processed % 200 === 0) {
                    // Yield to keep UI responsive on very large documents
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise(requestAnimationFrame);
                }
            } catch (err) {
                console.warn("[refreshPdfRendering] Viewport recompute failed for page", pageNumber, err);
            }
        }

        this.clearRenderedPageCache();
        state.deviceScale = window.devicePixelRatio || 1;
        this.pageCoordinateSystems.clear();

        let containerReset = false;
        if (container) {
            container.querySelectorAll(".page-canvas").forEach((canvas) => this.releaseCanvas(canvas));
            container.querySelectorAll(".ignored-overlay").forEach((overlay) => overlay.remove());
            this.clearFullDocHighlights();

            if (state.viewMode === "full" && container.childElementCount) {
                container.innerHTML = "";
                containerReset = true;
            }
        }

        if (state.viewMode === "full") {
            const activeSentence = state.currentSentenceIndex >= 0 ? state.sentences[state.currentSentenceIndex] : null;
            const hoveredSentence =
                state.hoveredSentenceIndex >= 0 && state.hoveredSentenceIndex < state.sentences.length
                    ? state.sentences[state.hoveredSentenceIndex]
                    : null;
            const pagesToRebuild = new Set();

            if (container && (containerReset || !container.querySelector(".pdf-page-wrapper"))) {
                await this.renderFullDocumentIfNeeded();
            }

            if (activeSentence) {
                await this.ensurePageCanvasMounted(activeSentence.pageNumber);
                pagesToRebuild.add(activeSentence.pageNumber);
            } else if (container) {
                const firstWrapper = container.querySelector(".pdf-page-wrapper");
                const fallbackPage = firstWrapper ? parseInt(firstWrapper.dataset.pageNumber, 10) : NaN;
                if (Number.isFinite(fallbackPage)) {
                    await this.ensurePageCanvasMounted(fallbackPage);
                    pagesToRebuild.add(fallbackPage);
                }
            }

            if (hoveredSentence && (!activeSentence || hoveredSentence.pageNumber !== activeSentence.pageNumber)) {
                await this.ensurePageCanvasMounted(hoveredSentence.pageNumber);
                pagesToRebuild.add(hoveredSentence.pageNumber);
            }

            await this.refreshLayoutAfterViewportChange();
            if (pagesToRebuild.size && this.app?.getPdfHeaderFooterDetector) {
                const detector = this.app.getPdfHeaderFooterDetector();
                await Promise.allSettled(
                    Array.from(pagesToRebuild, (pageNumber) =>
                        detector.ensureReadabilityForPage(pageNumber, { force: true }),
                    ),
                );
            }

            this.updatePhraseHighlightsAndListeners({ sentence: activeSentence, forceFullRescale });
            if (activeSentence) this.scrollSentenceIntoView(activeSentence);
            return;
        }

        if (typeof state.currentSentenceIndex === "number" && state.currentSentenceIndex >= 0) {
            await this.renderSentence(state.currentSentenceIndex, { skipTTS: true });
            this.updatePhraseHighlightsAndListeners({ sentence: state.currentSentence, forceFullRescale });
        }
    }

    async ensurePageCanvasMounted(pageNumber) {
        const { state } = this.app;
        const container = document.getElementById("pdf-doc-container");
        if (!container) return null;
        const wrapper = container.querySelector(`.pdf-page-wrapper[data-page-number="${pageNumber}"]`);
        if (!wrapper) return null;

        let canvas = wrapper.querySelector("canvas.page-canvas");
        if (canvas) return canvas;

        try {
            const fullPageCanvas = await this.ensureFullPageRendered(pageNumber);
            canvas = fullPageCanvas;
            canvas.className = "page-canvas";
            canvas.style.width = "100%";
            canvas.style.height = "100%";
            wrapper.insertBefore(canvas, wrapper.firstChild);
        } catch (err) {
            console.warn("[ensurePageCanvasMounted] Failed to prepare canvas for page", pageNumber, err);
            return null;
        }

        return canvas;
    }

    applyPageScale(wrapper, viewportDisplay) {
        const { state, config } = this.app;
        const scale = getPageDisplayScale(viewportDisplay, config);
        const scaledWidth = viewportDisplay.width * scale;
        const scaledHeight = viewportDisplay.height * scale;
        wrapper.dataset.scale = String(scale);
        delete wrapper.dataset.textWidthFit;
        delete wrapper.dataset.textWidthFitBlock;
        delete wrapper.dataset.textWidthFitLeft;
        delete wrapper.dataset.textWidthFitRight;
        wrapper.style.width = scaledWidth + "px";
        wrapper.style.height = scaledHeight + "px";
        wrapper.style.minHeight = scaledHeight + "px";
        const c = wrapper.querySelector("canvas");
        if (c) {
            c.style.width = "100%";
            c.style.height = "100%";
        }
    }

    rescaleAllPages() {
        const { state } = this.app;
        if (state.viewMode !== "full") return;
        const container = document.getElementById("pdf-doc-container");
        if (!container) return;
        container.querySelectorAll(".pdf-page-wrapper").forEach((wrapper) => {
            const p = parseInt(wrapper.dataset.pageNumber, 10);
            const viewportDisplay = state.viewportDisplayByPage.get(p);
            if (viewportDisplay) this.applyPageScale(wrapper, viewportDisplay);
        });
        this.updatePhraseHighlightsAndListeners({ sentence: state.currentSentence });
    }

    scrollSentenceIntoView(sentence) {
        const { state } = this.app;
        if (state.viewMode !== "full") return;
        const container = document.getElementById("pdf-doc-container");
        if (!container) return;
        this.ensurePageWordsScaled(sentence.pageNumber);
        const wrapper = container.querySelector(`.pdf-page-wrapper[data-page-number="${sentence.pageNumber}"]`);
        if (!wrapper) return;

        const bbox = this.recomputeSentenceBBoxIfNeeded(sentence);
        if (!bbox) {
            wrapper.scrollIntoView({ behavior: "smooth", block: "center" });
            return;
        }
        const canvas = wrapper.querySelector("canvas.page-canvas");
        const { scaleY } = this.getPageScaleFactors(wrapper, canvas, sentence.pageNumber);
        const wrapperTop = wrapper.offsetTop;
        const targetY = wrapperTop + bbox.y * scaleY - this.app.config.SCROLL_MARGIN;
        const maxScroll = container.scrollHeight - container.clientHeight;
        container.scrollTo({ top: clamp(targetY, 0, maxScroll), behavior: "smooth" });
    }

    async renderPage(pageNumber) {
        const { state } = this.app;
        if (!state.pdf || pageNumber < 1 || pageNumber > state.pdf.numPages) return;
        const pdfDocument = state.pdf;
        state.currentPdfPage = pageNumber;
        await this.app.pdfLoader.ensurePageParsed(pageNumber, { prefetchNext: true });
        if (state.pdf !== pdfDocument) return;
        await this.ensurePageCanvasMounted(pageNumber);
        if (state.pdf !== pdfDocument) return;
        const container = document.getElementById("pdf-doc-container");
        const wrapper = container?.querySelector?.(`.pdf-page-wrapper[data-page-number="${pageNumber}"]`);
        wrapper?.scrollIntoView?.({ behavior: "smooth", block: "center" });
        this.updateHighlightDisplay();
    }

    // Recompute and cache sentence bbox from current scaled words if existing bbox is stale or missing
    recomputeSentenceBBoxIfNeeded(sentence) {
        if (!sentence) return null;
        const words = this.getReadableWords(sentence);
        if (!Array.isArray(words) || words.length === 0) return this.getSentenceBoundingBox(sentence);
        if (!this.pageCoordinateSystems.has(sentence.pageNumber)) {
            this.calibratePageCoordinateSystem(sentence.pageNumber, sentence);
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        for (const w of words) {
            const x1 = w.x;
            const yTop = this.getCorrectedVerticalPosition(w, 1, sentence.pageNumber);
            const x2 = x1 + w.width;
            const y2 = yTop + w.height;
            if (x1 < minX) minX = x1;
            if (yTop < minY) minY = yTop;
            if (x2 > maxX) maxX = x2;
            if (y2 > maxY) maxY = y2;
        }

        if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
            return this.getSentenceBoundingBox(sentence);
        }

        const bbox = {
            x: minX,
            y: minY,
            width: Math.max(1, maxX - minX),
            height: Math.max(1, maxY - minY),
            x1: minX,
            y1: minY,
            x2: maxX,
            y2: maxY,
            centerX: (minX + maxX) / 2,
            centerY: (minY + maxY) / 2,
        };

        sentence.bboxReadable = bbox;
        sentence.bbox = bbox;
        return bbox;
    }

    clearFullDocHighlights() {
        const container = document.getElementById("pdf-doc-container");
        if (!container) return;
        container
            .querySelectorAll(".pdf-word-highlight,.persistent-highlight,.hover-highlight,.pdf-active-phrase-actions")
            .forEach((n) => n.remove());
        this._activePhraseActionsEl = null;
    }

    getMergedLineRects(words, pageNumber, { offsetYDisplay = 1, yTolerance = 2 } = {}) {
        if (!Array.isArray(words) || !words.length) return [];

        const items = [];
        for (const w of words) {
            if (!w) continue;
            if (
                !Number.isFinite(w.x) ||
                !Number.isFinite(w.y) ||
                !Number.isFinite(w.width) ||
                !Number.isFinite(w.height)
            ) {
                continue;
            }
            const top = this.getCorrectedVerticalPosition(w, offsetYDisplay, pageNumber);
            if (!Number.isFinite(top)) continue;
            const x1 = w.x;
            const x2 = w.x + w.width;
            const bottom = top + w.height;
            items.push({ top, x1, x2, bottom });
        }

        if (!items.length) return [];
        items.sort((a, b) => a.top - b.top || a.x1 - b.x1);

        const lines = [];
        for (const item of items) {
            const last = lines[lines.length - 1];
            if (!last || Math.abs(item.top - last.top) > yTolerance) {
                lines.push({ top: item.top, bottom: item.bottom, x1: item.x1, x2: item.x2 });
            } else {
                last.x1 = Math.min(last.x1, item.x1);
                last.x2 = Math.max(last.x2, item.x2);
                last.bottom = Math.max(last.bottom, item.bottom);
            }
        }

        return lines.map((l) => ({
            x: l.x1,
            y: l.top,
            width: Math.max(1, l.x2 - l.x1),
            height: Math.max(1, l.bottom - l.top),
        }));
    }

    updatePhraseHighlightsAndListeners({ sentence = null, forceFullRescale = false } = {}) {
        const { state } = this.app;
        const activeIndex = state.playingSentenceIndex >= 0 ? state.playingSentenceIndex : state.currentSentenceIndex;
        const targetSentence = sentence || (activeIndex >= 0 ? state.sentences[activeIndex] : null);

        // Reset hover state during layout changes to prevent stale hover highlights
        if (forceFullRescale) {
            state.hoveredSentenceIndex = -1;
        }

        const pagesToProcess = new Set();

        if (forceFullRescale) {
            for (const key of state.pageSentencesIndex.keys()) {
                const pageNumber = Number(key);
                if (Number.isFinite(pageNumber)) pagesToProcess.add(pageNumber);
            }
        } else {
            if (targetSentence?.pageNumber) pagesToProcess.add(targetSentence.pageNumber);

            if (state.hoveredSentenceIndex >= 0 && state.hoveredSentenceIndex < state.sentences.length) {
                const hovered = state.sentences[state.hoveredSentenceIndex];
                if (hovered?.pageNumber) pagesToProcess.add(hovered.pageNumber);
            }

            if (state.savedHighlights?.size) {
                for (const [sentenceIndex] of state.savedHighlights.entries()) {
                    const savedSentence = state.sentences[sentenceIndex];
                    if (savedSentence?.pageNumber) pagesToProcess.add(savedSentence.pageNumber);
                }
            }

            const container = document.getElementById("pdf-doc-container");
            if (container) {
                container.querySelectorAll(".pdf-page-wrapper[data-page-number]").forEach((wrapper) => {
                    const num = parseInt(wrapper.dataset.pageNumber, 10);
                    if (Number.isFinite(num)) pagesToProcess.add(num);
                });
            }
        }

        for (const pageNumber of pagesToProcess) {
            this.ensurePageWordsScaled(pageNumber);
            const indices = state.pageSentencesIndex.get(pageNumber);
            if (!indices) continue;
            for (const idx of indices) {
                const s = state.sentences[idx];
                if (!s) continue;
                this.recomputeSentenceBBoxIfNeeded(s);
            }
        }

        if (state.viewMode === "full") {
            this.clearFullDocHighlights();
            this.updateHighlightFullDoc(targetSentence);
        } else if (targetSentence) {
            this.ensurePageWordsScaled(targetSentence.pageNumber);
            this.recomputeSentenceBBoxIfNeeded(targetSentence);
        }

        this.app.interactionHandler?.setupInteractionListeners?.();
    }

    renderSavedHighlightsFullDoc() {
        const { state } = this.app;
        if (state.viewMode !== "full") return;
        const container = document.getElementById("pdf-doc-container");
        if (!container) return;
        container.querySelectorAll(".persistent-highlight").forEach((n) => n.remove());
        container.querySelectorAll(".pdf-comment-marker").forEach((n) => n.remove());

        for (const [sentenceIndex, highlightData] of state.savedHighlights.entries()) {
            const sentence = state.sentences[sentenceIndex];
            const savedPageIndex = Number(highlightData?.pageIndex);
            const anchoredPageNumber =
                highlightData?.pageIndex != null && Number.isFinite(savedPageIndex)
                    ? savedPageIndex + 1
                    : NaN;
            const pageNumber = Number.isFinite(anchoredPageNumber)
                ? anchoredPageNumber
                : sentence?.pageNumber;
            if (!Number.isFinite(pageNumber)) continue;
            this.ensurePageWordsScaled(pageNumber);
            const wrapper = container.querySelector(`.pdf-page-wrapper[data-page-number="${pageNumber}"]`);
            if (!wrapper) continue;
            const canvas = wrapper.querySelector("canvas.page-canvas");
            if (!canvas) continue;

            // Use getBoundingClientRect for accurate positioning across devices
            const wrapperRect = wrapper.getBoundingClientRect();
            const canvasRect = canvas.getBoundingClientRect();
            const offsetTop = canvasRect.top - wrapperRect.top;
            const offsetLeft = canvasRect.left - wrapperRect.left;
            const { scaleX, scaleY } = this.getPageScaleFactors(wrapper, canvas, pageNumber);

            const wordsToRender =
                this.app.highlightsStorage?.getHighlightWords?.(highlightData, sentence) ||
                this.getReadableWords(sentence);

            if (!Array.isArray(wordsToRender) || !wordsToRender.length) continue;

            // Calibrate coordinate system for this page if not already done
            if (!this.pageCoordinateSystems.has(pageNumber)) {
                if (sentence) {
                    this.calibratePageCoordinateSystem(pageNumber, sentence);
                } else {
                    this.pageCoordinateSystems.set(
                        pageNumber,
                        this.detectPageCoordinateSystem(pageNumber, wordsToRender),
                    );
                }
            }

            const currentIdx =
                state.playingSentenceIndex >= 0 ? state.playingSentenceIndex : state.currentSentenceIndex;
            const isCurrentSentence = sentenceIndex === currentIdx;
            if (isCurrentSentence) {
                continue;
            }

            const lineRects = this.getMergedLineRects(wordsToRender, pageNumber);
            if (!lineRects.length) continue;

            const hasComment = typeof highlightData?.comment === "string" && highlightData.comment.trim().length > 0;
            let firstMarkerRect = null;

            for (const rect of lineRects) {
                const div = document.createElement("div");
                div.className = "persistent-highlight";
                div.style.left = offsetLeft + rect.x * scaleX + "px";
                div.style.top = offsetTop + rect.y * scaleY + "px";
                div.style.width = Math.max(1, rect.width * scaleX) + "px";
                div.style.height = Math.max(1, rect.height * scaleY) + "px";
                const rgb = hexToRgb(highlightData.color);
                const savedOpacity = this._scaleHighlightOpacity(0.8, 0.14);
                const fallbackOpacity = this._scaleHighlightOpacity(0.3, 0.08);
                if (rgb) {
                    div.style.backgroundColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${savedOpacity.toFixed(3)})`;
                    div.style.mixBlendMode = "multiply";
                } else {
                    div.style.backgroundColor = `rgba(255, 235, 59, ${fallbackOpacity.toFixed(3)})`;
                    div.style.mixBlendMode = "multiply";
                }
                div.style.zIndex = "10";
                div.style.borderRadius = "2px";
                const savedText =
                    Array.isArray(highlightData?.words) && highlightData.words.length
                        ? highlightData.words.join(" ")
                        : sentence?.text || "";
                div.title = `Highlighted: ${savedText.substring(0, 50)}...`;
                wrapper.appendChild(div);

                if (!firstMarkerRect) firstMarkerRect = rect;
            }

            if (hasComment && firstMarkerRect) {
                const marker = document.createElement("div");
                marker.className = "pdf-comment-marker";
                marker.style.left = offsetLeft + (firstMarkerRect.x + firstMarkerRect.width) * scaleX + "px";
                marker.style.top = offsetTop + firstMarkerRect.y * scaleY + "px";
                marker.dataset.sentenceIndex = String(sentenceIndex);
                marker.dataset.comment = String(highlightData.comment);
                marker.innerHTML = `<span class="material-symbols-outlined">comment</span>`;

                const show = (e) => {
                    this._showCommentTooltip(marker.dataset.comment || "", e);
                };
                const move = (e) => {
                    this._moveCommentTooltip(e);
                };
                const hide = () => {
                    this._hideCommentTooltip();
                };

                marker.addEventListener("mouseenter", show);
                marker.addEventListener("mousemove", move);
                marker.addEventListener("mouseleave", hide);

                wrapper.appendChild(marker);
            }
        }
    }

    _ensureCommentTooltipEl() {
        if (this._commentTooltipEl && document.body.contains(this._commentTooltipEl)) return;
        const el = document.createElement("div");
        el.className = "pdf-comment-tooltip";
        el.style.display = "none";
        document.body.appendChild(el);
        this._commentTooltipEl = el;
    }

    _showCommentTooltip(text, e) {
        this._ensureCommentTooltipEl();
        if (!this._commentTooltipEl) return;
        const safeText = typeof text === "string" ? text.trim() : "";
        if (!safeText) return;
        this._commentTooltipEl.textContent = safeText;
        this._commentTooltipEl.style.display = "block";
        this._moveCommentTooltip(e);
    }

    _moveCommentTooltip(e) {
        if (!this._commentTooltipEl || this._commentTooltipEl.style.display === "none") return;
        const clientX = e?.clientX ?? 0;
        const clientY = e?.clientY ?? 0;
        const pad = 12;

        // Position near cursor, clamp inside viewport.
        const rect = this._commentTooltipEl.getBoundingClientRect();
        let x = clientX + pad;
        let y = clientY + pad;
        if (x + rect.width + 8 > window.innerWidth) x = Math.max(8, window.innerWidth - rect.width - 8);
        if (y + rect.height + 8 > window.innerHeight) y = Math.max(8, window.innerHeight - rect.height - 8);
        this._commentTooltipEl.style.left = `${x}px`;
        this._commentTooltipEl.style.top = `${y}px`;
    }

    _hideCommentTooltip() {
        if (!this._commentTooltipEl) return;
        this._commentTooltipEl.style.display = "none";
        this._commentTooltipEl.textContent = "";
    }

    renderHoverHighlightFullDoc() {
        const { state } = this.app;
        if (state.viewMode !== "full") return;
        const container = document.getElementById("pdf-doc-container");
        if (!container) return;
        container.querySelectorAll(".hover-highlight").forEach((n) => n.remove());
        if (state.hoveredSentenceIndex < 0 || state.hoveredSentenceIndex >= state.sentences.length) return;
        const s = state.sentences[state.hoveredSentenceIndex];
        if (!s) return;
        const currentIdx = state.playingSentenceIndex >= 0 ? state.playingSentenceIndex : state.currentSentenceIndex;
        if (state.hoveredSentenceIndex === currentIdx) return;
        this.ensurePageWordsScaled(s.pageNumber);
        const wrapper = container.querySelector(`.pdf-page-wrapper[data-page-number="${s.pageNumber}"]`);
        if (!wrapper) return;
        const canvas = wrapper.querySelector("canvas.page-canvas");
        if (!canvas) return;

        // Use getBoundingClientRect for accurate positioning across devices
        const wrapperRect = wrapper.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        const offsetTop = canvasRect.top - wrapperRect.top;
        const offsetLeft = canvasRect.left - wrapperRect.left;
        const { scaleX, scaleY } = this.getPageScaleFactors(wrapper, canvas, s.pageNumber);

        const hoverPhraseWords = this.getHoverPhraseWords(s);
        const highlightWords = hoverPhraseWords.length ? hoverPhraseWords : this.getReadableWords(s);

        // Calibrate coordinate system for this page if not already done
        if (!this.pageCoordinateSystems.has(s.pageNumber) && highlightWords.length > 0) {
            this.calibratePageCoordinateSystem(s.pageNumber, s);
        }

        const lineRects = this.getMergedLineRects(highlightWords, s.pageNumber);
        for (const rect of lineRects) {
            const div = document.createElement("div");
            div.className = "hover-highlight";
            div.style.left = offsetLeft + rect.x * scaleX + "px";
            div.style.top = offsetTop + rect.y * scaleY + "px";
            div.style.width = Math.max(1, rect.width * scaleX) + "px";
            div.style.height = Math.max(1, rect.height * scaleY) + "px";
            div.style.zIndex = "30";
            if (this._isAmoledModeEnabled()) {
                div.style.background = `rgba(0, 150, 255, ${this._scaleHighlightOpacity(0.28, 0.05).toFixed(3)})`;
            }
            wrapper.appendChild(div);
        }
    }

    _removeActivePhraseActions() {
        if (this._activePhraseActionsEl) {
            this._activePhraseActionsEl.remove();
            this._activePhraseActionsEl = null;
        }
    }

    _renderActivePhraseActions({
        wrapper,
        anchorRect,
        offsetLeft,
        offsetTop,
        scaleX,
        scaleY,
        sentenceIndex,
        highlighted,
    }) {
        if (!wrapper || !anchorRect || !Number.isFinite(sentenceIndex)) {
            this._removeActivePhraseActions();
            return;
        }

        this._removeActivePhraseActions();

        const left = offsetLeft + anchorRect.x * scaleX;
        const top = offsetTop + anchorRect.y * scaleY;
        const popupHeight = 34;
        const popupGap = 8; // desired spacing in px

        const panel = document.createElement("div");
        panel.className = "pdf-active-phrase-actions";
        panel.style.left = `${Math.max(6, left)}px`;
        panel.style.top = `${Math.max(6, top - popupHeight - popupGap)}px`;

        const stopBubble = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };
        const stopToolbarPointerEvent = (e) => {
            e.stopPropagation();
        };

        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "pdf-active-phrase-btn";
        copyBtn.title = "Copy current phrase";
        copyBtn.setAttribute("aria-label", "Copy current phrase");
        copyBtn.innerHTML = '<span class="material-symbols-outlined">content_copy</span>';
        copyBtn.addEventListener("mousedown", stopBubble);
        copyBtn.addEventListener("click", async (e) => {
            stopBubble(e);
            await this.app.interactionHandler?.copyCurrentPhraseToClipboard?.({
                successMessage: "Current phrase copied",
            });
        });

        const highlightColors = [
            { label: "Yellow", value: "#ffda76" },
            { label: "Red", value: "#F44336" },
            { label: "Green", value: "#81C784" },
            { label: "Blue", value: "#4FC3F7" },
        ];

        const highlightButtons = highlightColors.map(({ label, value }) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "pdf-active-phrase-btn";
            const isActive = String(highlighted || "").toLowerCase() === value.toLowerCase();
            btn.setAttribute("aria-pressed", isActive ? "true" : "false");
            btn.title = `Highlight ${label.toLowerCase()}`;
            btn.setAttribute("aria-label", `Highlight current phrase ${label.toLowerCase()}`);
            if (isActive) {
                btn.classList.add("is-active");
                btn.style.borderColor = value;
                btn.style.background = "rgba(255, 255, 255, 0.09)";
            }

            const icon = document.createElement("span");
            icon.className = "material-symbols-outlined";
            icon.textContent = "format_ink_highlighter";
            icon.style.color = value;
            btn.appendChild(icon);

            btn.addEventListener("mousedown", stopBubble);
            btn.addEventListener("click", (e) => {
                stopBubble(e);
                this.app.highlightManager?.saveCurrentSentenceHighlight?.(value);
            });
            return btn;
        });

        const commentBtn = document.createElement("button");
        commentBtn.type = "button";
        commentBtn.className = "pdf-active-phrase-btn";
        commentBtn.setAttribute("aria-pressed", "false");
        commentBtn.title = "Add comment";
        commentBtn.setAttribute("aria-label", "Add comment");
        commentBtn.innerHTML = '<span class="material-symbols-outlined">comment</span>';
        commentBtn.addEventListener("mousedown", stopBubble);
        commentBtn.addEventListener("click", async (e) => {
            stopBubble(e);
            await this.app.highlightManager?.editCurrentSentenceComment?.();
        });

        panel.appendChild(copyBtn);
        for (const btn of highlightButtons) panel.appendChild(btn);
        panel.appendChild(commentBtn);
        // In full-document mode the toolbar is a child of the PDF interaction
        // container. Isolate every pointer phase so delegated touch handlers
        // cannot select the phrase behind it. Do not prevent touchstart's
        // default action here: browsers still need it to synthesize the button
        // click.
        for (const type of ["pointerdown", "pointerup", "touchstart", "touchmove", "touchend"]) {
            panel.addEventListener(type, stopToolbarPointerEvent);
        }
        panel.addEventListener("mousedown", stopBubble);
        panel.addEventListener("click", stopToolbarPointerEvent);
        panel.addEventListener("dblclick", stopToolbarPointerEvent);
        wrapper.appendChild(panel);
        const pageWidth = Math.max(1, wrapper.clientWidth || 0);
        const fittedLeft = Number(wrapper.dataset.textWidthFitLeft);
        const fittedRight = Number(wrapper.dataset.textWidthFitRight);
        const hasFittedBounds =
            wrapper.dataset.textWidthFit === "1" &&
            Number.isFinite(fittedLeft) &&
            Number.isFinite(fittedRight) &&
            fittedRight > fittedLeft;
        const minLeft = hasFittedBounds ? fittedLeft : 6;
        const maxRight = hasFittedBounds ? fittedRight : pageWidth - 6;
        const availableWidth = Math.max(1, maxRight - minLeft);
        panel.style.maxWidth = `${availableWidth}px`;
        if ((panel.offsetWidth || 0) > availableWidth) {
            panel.style.width = `${availableWidth}px`;
            panel.style.overflowX = "auto";
        }
        const panelWidth = Math.min(panel.offsetWidth || 0, availableWidth);
        const maxLeft = Math.max(minLeft, maxRight - panelWidth);
        panel.style.left = `${Math.min(Math.max(minLeft, left), maxLeft)}px`;
        this._activePhraseActionsEl = panel;
    }

    updateHighlightFullDoc(sentence) {
        const { state } = this.app;
        if (state.viewMode !== "full") {
            this._removeActivePhraseActions();
            return;
        }
        const container = document.getElementById("pdf-doc-container");
        if (!container) return;

        const activeIndex = state.playingSentenceIndex >= 0 ? state.playingSentenceIndex : state.currentSentenceIndex;
        const targetSentence = sentence || (activeIndex >= 0 ? state.sentences[activeIndex] : null);

        // Clear old highlights
        container.querySelectorAll(".pdf-word-highlight").forEach((n) => n.remove());
        this._removeActivePhraseActions();

        if (!targetSentence) {
            this.renderSavedHighlightsFullDoc();
            this.renderHoverHighlightFullDoc();
            return;
        }

        this.applyTextWidthFit(targetSentence);

        const wrapper = container.querySelector(`.pdf-page-wrapper[data-page-number="${targetSentence.pageNumber}"]`);
        if (!wrapper) return;
        const canvas = wrapper.querySelector("canvas.page-canvas");
        if (!canvas) return;
        this.ensurePageWordsScaled(targetSentence.pageNumber);

        // Ensure position relative on wrapper
        if (getComputedStyle(wrapper).position === "static") wrapper.style.position = "relative";

        // Use getBoundingClientRect for accurate positioning across devices
        const wrapperRect = wrapper.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        const offsetTop = canvasRect.top - wrapperRect.top;
        const offsetLeft = canvasRect.left - wrapperRect.left;
        const { scaleX, scaleY } = this.getPageScaleFactors(wrapper, canvas, targetSentence.pageNumber);

        const playingPhraseWords = this.getPlayingPhraseWords(targetSentence);
        const hoverPhraseWords = playingPhraseWords.length ? [] : this.getHoverPhraseWords(targetSentence);
        const phraseWords = playingPhraseWords.length ? playingPhraseWords : hoverPhraseWords;
        const savedHighlightData =
            targetSentence?.index != null ? state.savedHighlights.get(targetSentence.index) : null;
        const highlightWords = savedHighlightData
            ? this.app.highlightsStorage?.getHighlightWords?.(savedHighlightData, targetSentence)
            : phraseWords.length
              ? phraseWords
              : this.getReadableWords(targetSentence);

        // Calibrate coordinate system for this page if not already done
        if (!this.pageCoordinateSystems.has(targetSentence.pageNumber) && highlightWords.length > 0) {
            this.calibratePageCoordinateSystem(targetSentence.pageNumber, targetSentence);
        }

        const savedOutlineColor = savedHighlightData?.color || "#ff9800";

        const lineRects = this.getMergedLineRects(highlightWords, targetSentence.pageNumber);
        if (lineRects.length) {
            wrapper.querySelectorAll(".pdf-word-highlight").forEach((n) => n.remove());
            const firstRect = lineRects[0];

            for (const rect of lineRects) {
                const div = document.createElement("div");
                div.className = "pdf-word-highlight";
                div.style.position = "absolute";
                div.style.backgroundColor = this._getActiveHighlightColor();
                div.style.left = offsetLeft + rect.x * scaleX + "px";
                div.style.top = offsetTop + rect.y * scaleY + "px";
                div.style.width = Math.max(1, rect.width * scaleX) + "px";
                div.style.height = Math.max(1, rect.height * scaleY) + "px";
                div.style.pointerEvents = "none";
                if (savedHighlightData) {
                    div.classList.add("saved-highlight");
                    const outlineRgb = hexToRgb(savedOutlineColor);
                    const outlineOpacity = this._scaleHighlightOpacity(1, 0.3);
                    div.style.outline = outlineRgb
                        ? `2px solid rgba(${outlineRgb.r}, ${outlineRgb.g}, ${outlineRgb.b}, ${outlineOpacity.toFixed(3)})`
                        : `2px solid ${savedOutlineColor}`;
                    div.style.outlineOffset = "1px";
                    div.style.zIndex = "25";
                } else {
                    div.style.outline = "none";
                    div.style.outlineOffset = "0px";
                    div.style.zIndex = "20";
                }
                wrapper.appendChild(div);
            }

            this._renderActivePhraseActions({
                wrapper,
                anchorRect: firstRect,
                offsetLeft,
                offsetTop,
                scaleX,
                scaleY,
                sentenceIndex: targetSentence.index,
                highlighted: savedHighlightData?.color || "",
            });
        }

        // Maintain original functions
        this.renderSavedHighlightsFullDoc();
        this.renderHoverHighlightFullDoc();
    }

    // NEW: Get corrected vertical position for canvas rendering
    getCanvasVerticalPosition(word, offsetYDisplay, pageNumber) {
        const coordSystem = this.pageCoordinateSystems.get(pageNumber) || "baseline";

        if (coordSystem === "top-based") {
            // For top-based coordinate system
            return word.y - offsetYDisplay;
        } else {
            // For baseline coordinate system
            return word.y - word.height - offsetYDisplay;
        }
    }

    updateHighlightDisplay() {
        this.renderSavedHighlightsFullDoc();
        this.renderHoverHighlightFullDoc();
    }

    handleViewportHeightChange(height) {
        if (this._viewportHeightRaf) cancelAnimationFrame(this._viewportHeightRaf);
        this._viewportHeightRaf = requestAnimationFrame(() => {
            this._viewportHeightRaf = null;
            const { state } = this.app;
            if (window.__freezeViewportUpdates) return;
            if (state.awaitingOrientationDecision) return;
            if (state.viewMode === "full") {
                this.rescaleAllPages();
                if (state.currentSentence) this.scrollSentenceIntoView(state.currentSentence);
            }
        });
    }

    async renderSentence(idx, options = {}) {
        const { state } = this.app;
        const { autoAdvance = false, skipTTS = false } = options;
        const visited = options.visited ?? new Set();

        if (idx < 0 || idx >= state.sentences.length) return;
        let sentence = state.sentences[idx];
        if (!sentence) return;
        if (visited.has(sentence)) return;
        visited.add(sentence);
        const targetSentence = sentence;

        const pageNumber = sentence.pageNumber;
        const pdfCanvas = document.getElementById("pdf-canvas");
        const pdfDocContainer = document.getElementById("pdf-doc-container");

        if (state.generationEnabled && !sentence.layoutProcessed) {
            await this.app.getPdfHeaderFooterDetector().ensureReadabilityForPage(pageNumber);
            idx = state.sentences.indexOf(targetSentence);
            if (idx < 0) return;
            sentence = targetSentence;
        }

        if (state.generationEnabled && !sentence.isTextToRead && autoAdvance) {
            const nextIdx = await this.findNextReadableSentenceForward(idx, visited);
            if (nextIdx >= 0 && nextIdx !== idx) {
                return this.renderSentence(nextIdx, { autoAdvance: true, visited, skipTTS });
            }
        }

        state.currentSentenceIndex = idx;
        state.currentPdfPage = sentence.pageNumber;
        void this.app.pdfLoader?.prefetchNextPage?.(sentence.pageNumber);

        // Calibrar sistema de coordenadas
        if (!this.pageCoordinateSystems.has(sentence.pageNumber)) {
            this.calibratePageCoordinateSystem(sentence.pageNumber, sentence);
        }

        if (pdfCanvas) pdfCanvas.style.display = "none";
        if (pdfDocContainer) pdfDocContainer.style.display = "block";

        // --- Renderização segura da página atual ---
        if (pdfDocContainer) {
            await this.ensurePageCanvasMounted(sentence.pageNumber);
            idx = state.sentences.indexOf(sentence);
            if (idx < 0) return;
            state.currentSentenceIndex = idx;
        }

        // Atualizar destaques e scroll
        this.updateHighlightFullDoc(sentence);
        this.scrollSentenceIntoView(sentence);

        if (state.generationEnabled && !sentence.isTextToRead) {
            this.app.ui.showInfo(
                `Sentence ${sentence.index + 1} is outside readable layout regions. Select another sentence to play.`,
            );
        } else if (!skipTTS) {
            // Always start the selected sentence before scheduling look-ahead.
            // A running prefetch cannot be preempted by a later priority item.
            this.app.ttsQueue.add(state.currentSentenceIndex, true);
            this.app.ttsQueue.run();
        }

        if (!skipTTS) {
            this.app.ttsEngine.schedulePrefetch();
        }
        this.app.progressManager.saveProgress();
        this.app.eventBus.emit(EVENTS.SENTENCE_CHANGED, { index: idx, sentence });
    }
}
