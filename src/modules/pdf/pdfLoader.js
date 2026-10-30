import { EVENTS } from "../../constants/events.js";
import { normalizeText, cooperativeYield, isIOSLike } from "../utils/helpers.js";

function getTextItemSegmentGeometry(item, viewport, startFraction = 0, endFraction = 1) {
    const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const directionLength = Math.hypot(transform[0], transform[1]);
    const directionX = directionLength > 0 ? transform[0] / directionLength : 1;
    const directionY = directionLength > 0 ? transform[1] / directionLength : 0;
    const itemWidth = Number(item.width);
    const totalWidth =
        Number.isFinite(itemWidth) && itemWidth !== 0 ? Math.abs(itemWidth * viewport.scale) : directionLength;
    const startOffset = totalWidth * startFraction;
    const endOffset = totalWidth * endFraction;

    const baselineStart = {
        x: transform[4] + directionX * startOffset,
        y: transform[5] + directionY * startOffset,
    };
    const baselineEnd = {
        x: transform[4] + directionX * endOffset,
        y: transform[5] + directionY * endOffset,
    };
    const heightVector = { x: transform[2], y: transform[3] };
    const corners = [
        baselineStart,
        baselineEnd,
        { x: baselineStart.x + heightVector.x, y: baselineStart.y + heightVector.y },
        { x: baselineEnd.x + heightVector.x, y: baselineEnd.y + heightVector.y },
    ];

    const x1 = Math.min(...corners.map((point) => point.x));
    const y1 = Math.min(...corners.map((point) => point.y));
    const x2 = Math.max(...corners.map((point) => point.x));
    const y2 = Math.max(...corners.map((point) => point.y));
    return { x1, y1, x2, y2, width: x2 - x1, height: y2 - y1 };
}

export class PDFLoader {
    constructor(app) {
        this.app = app;
        this._headerFooterStylesInjected = false;
        this._pdfParseGeneration = 0;
    }

    computePdfKeyFromSource(source) {
        if (!source) return null;
        if (source.type === "url") return `url::${source.name}`;
        if (source.type === "file") {
            const { name, size = 0, lastModified = 0 } = source;
            return `file::${name}::${size}::${lastModified}`;
        }
        return null;
    }

    _parseFileKeyParts(key) {
        if (typeof key !== "string") return null;
        if (!key.startsWith("file::")) return null;
        const parts = key.split("::");
        if (parts.length < 4) return null;
        const name = parts[1] ?? "";
        const size = Number(parts[2] ?? 0);
        return { name, size: Number.isFinite(size) ? size : 0 };
    }

    _ensureLazyPageState() {
        const { state } = this.app;
        if (!(state.pagesCache instanceof Map)) state.pagesCache = new Map();
        if (!(state.viewportDisplayByPage instanceof Map)) state.viewportDisplayByPage = new Map();
        if (!(state.pdfSentencesByPage instanceof Map)) state.pdfSentencesByPage = new Map();
        if (!(state.parsedPdfPages instanceof Set)) state.parsedPdfPages = new Set();
        if (!(state.pdfPageParsePromises instanceof Map)) state.pdfPageParsePromises = new Map();
        if (!(state.pageSentencesIndex instanceof Map)) state.pageSentencesIndex = new Map();
        if (!Array.isArray(state.sentences)) state.sentences = [];
    }

    _isCurrentParse(pdfDocument, generation) {
        return this.app.state.pdf === pdfDocument && this._pdfParseGeneration === generation;
    }

    async preprocessPage(
        pageNumber,
        { pdfDocument = this.app.state.pdf, generation = this._pdfParseGeneration } = {},
    ) {
        const { app } = this;
        const { state } = app;
        this._ensureLazyPageState();

        const cachedPage = state.pagesCache.get(pageNumber);
        if (cachedPage && Array.isArray(cachedPage.pageWords)) return cachedPage;
        if (!pdfDocument || !this._isCurrentParse(pdfDocument, generation)) return null;

        const page = cachedPage || (await pdfDocument.getPage(pageNumber));
        if (!this._isCurrentParse(pdfDocument, generation)) return null;

        const unscaled = page.getViewport({ scale: 1 });
        const BASE_WIDTH_CSS =
            typeof app.config?.BASE_WIDTH_CSS === "function" ? app.config.BASE_WIDTH_CSS() : unscaled.width;
        const displayScale = BASE_WIDTH_CSS / unscaled.width;
        const viewportDisplay = page.getViewport({ scale: displayScale });

        const textContent = await page.getTextContent();
        if (!this._isCurrentParse(pdfDocument, generation)) return null;
        const pageWords = [];

        for (const item of textContent.items) {
            if (!item?.transform || !item.str) continue;
            if (!item.str.trim()) continue;

            // Compose the PDF text matrix with the page viewport. This accounts for
            // page rotation, CropBox/MediaBox offsets, and rotated text runs so the
            // extracted word boxes share coordinates with the rendered page/model.
            const itemGeometry = getTextItemSegmentGeometry(item, viewportDisplay);

            const tokens = item.str.split(/(\s+)/).filter((t) => t.trim().length > 0);
            const markLineBreak = !!item.hasEOL;

            const createWord = ({ str, geometry, lineBreak }) => {
                const { x1, y1, x2, y2, width, height } = geometry;
                const word = {
                    pageNumber,
                    str: str.trim(),
                    x: x1,
                    y: y2,
                    width,
                    height,
                    lineBreak: !!lineBreak,
                    font: item.fontName,
                    bbox: {
                        x: x1,
                        y: y1,
                        width,
                        height,
                        x1,
                        y1,
                        x2,
                        y2,
                    },
                    isReadable: null,

                    // Canonical display geometry at viewport scale 1. The renderer
                    // can safely rescale these values without losing rotation/crop
                    // offsets already applied by the viewport transform.
                    _baseX: x1 / displayScale,
                    _baseYDisplay: y2 / displayScale,
                    _baseWidth: width / displayScale,
                    _baseHeight: height / displayScale,
                };
                pageWords.push(word);
                return word;
            };

            if (tokens.length <= 1) {
                createWord({ str: item.str, geometry: itemGeometry, lineBreak: markLineBreak });
            } else {
                const totalChars = tokens.reduce((acc, t) => acc + t.length, 0) || 1;
                let consumedChars = 0;
                for (const tk of tokens) {
                    const startFraction = consumedChars / totalChars;
                    consumedChars += tk.length;
                    const endFraction = consumedChars / totalChars;
                    createWord({
                        str: tk,
                        geometry: getTextItemSegmentGeometry(item, viewportDisplay, startFraction, endFraction),
                        lineBreak: false,
                    });
                }
                if (markLineBreak && pageWords.length) {
                    pageWords[pageWords.length - 1].lineBreak = true;
                }
            }
        }

        // Commit only after extraction completes. An old PDF.js task may resolve
        // after another document has opened, and must not populate the new caches.
        state.pagesCache.set(pageNumber, page);
        state.viewportDisplayByPage.set(pageNumber, viewportDisplay);
        // Store base/unscaled metrics to support lazy rescaling later.
        page.unscaledWidth = unscaled.width;
        page.unscaledHeight = unscaled.height;
        page.baseDisplayScale = displayScale;
        page.currentDisplayScale = displayScale;
        page.needsWordRescale = false;
        page.pageWords = pageWords;
        return page;
    }

    async ensurePageParsed(pageNumber, { prefetchNext = false } = {}) {
        const { app } = this;
        const { state } = app;
        this._ensureLazyPageState();

        const normalizedPage = Number.parseInt(pageNumber, 10);
        const pdfDocument = state.pdf;
        if (
            !pdfDocument ||
            !Number.isFinite(normalizedPage) ||
            normalizedPage < 1 ||
            normalizedPage > pdfDocument.numPages
        ) {
            return null;
        }

        if (state.parsedPdfPages.has(normalizedPage)) {
            const parsedPage = state.pagesCache.get(normalizedPage) || null;
            if (prefetchNext) void this.prefetchNextPage(normalizedPage);
            return parsedPage;
        }
        const pending = state.pdfPageParsePromises.get(normalizedPage);
        if (pending) {
            const parsedPage = await pending;
            if (prefetchNext) void this.prefetchNextPage(normalizedPage);
            return parsedPage;
        }

        const generation = this._pdfParseGeneration;
        const parsePromise = (async () => {
            const page = await this.preprocessPage(normalizedPage, { pdfDocument, generation });
            if (!page || !this._isCurrentParse(pdfDocument, generation)) return null;

            await app.sentenceParser.parsePageWords(normalizedPage, page, {
                expectedPdf: pdfDocument,
                isCurrent: () => this._isCurrentParse(pdfDocument, generation),
                skipLayoutDetection: true,
            });
            if (!this._isCurrentParse(pdfDocument, generation)) return null;

            state.parsedPdfPages.add(normalizedPage);
            if (state.savedHighlights instanceof Map && state.savedHighlights.size) {
                state.savedHighlights = app.highlightsStorage.remapPdfHighlights(state.savedHighlights);
            }
            app.interactionHandler?.setupInteractionListeners?.();
            app.pdfRenderer?.updateHighlightDisplay?.();
            if (state.generationEnabled && state.currentSentenceIndex >= 0) {
                app.ttsEngine?.schedulePrefetch?.();
            }
            return page;
        })();

        state.pdfPageParsePromises.set(normalizedPage, parsePromise);
        try {
            const page = await parsePromise;
            if (prefetchNext && page) void this.prefetchNextPage(normalizedPage);
            return page;
        } finally {
            if (state.pdfPageParsePromises.get(normalizedPage) === parsePromise) {
                state.pdfPageParsePromises.delete(normalizedPage);
            }
        }
    }

    async prefetchNextPage(pageNumber) {
        const nextPage = Number.parseInt(pageNumber, 10) + 1;
        const pageCount = Number(this.app.state.pdf?.numPages) || 0;
        if (nextPage < 1 || nextPage > pageCount) return null;
        try {
            return await this.ensurePageParsed(nextPage);
        } catch (error) {
            console.warn(`[PDFLoader] Could not pre-parse page ${nextPage}`, error);
            return null;
        }
    }

    async getFirstSentenceIndexForPage(pageNumber) {
        const { state } = this.app;
        const pageCount = Number(state.pdf?.numPages) || 0;
        const pdfDocument = state.pdf;
        const normalizedPage = Math.min(Math.max(Number.parseInt(pageNumber, 10) || 1, 1), pageCount);
        await this.ensurePageParsed(normalizedPage, { prefetchNext: true });
        if (state.pdf !== pdfDocument) return -1;
        const indices = state.pageSentencesIndex.get(normalizedPage) || [];
        return indices.length ? indices[0] : -1;
    }

    async getAdjacentSentenceIndex(sentence, direction = 1) {
        const { state } = this.app;
        if (!sentence || !state.pdf) return -1;
        const pdfDocument = state.pdf;
        const step = direction < 0 ? -1 : 1;
        const currentPage = Number(sentence.pageNumber);
        const pageIndices = state.pageSentencesIndex.get(currentPage) || [];
        const currentOffset = pageIndices.indexOf(sentence.index);
        const adjacentOffset = currentOffset + step;
        if (currentOffset >= 0 && adjacentOffset >= 0 && adjacentOffset < pageIndices.length) {
            return pageIndices[adjacentOffset];
        }

        for (
            let pageNumber = currentPage + step;
            pageNumber >= 1 && pageNumber <= state.pdf.numPages;
            pageNumber += step
        ) {
            await this.ensurePageParsed(pageNumber, { prefetchNext: step > 0 });
            if (state.pdf !== pdfDocument || !state.sentences.includes(sentence)) return -1;
            const indices = state.pageSentencesIndex.get(pageNumber) || [];
            if (indices.length) return step > 0 ? indices[0] : indices[indices.length - 1];
        }
        return -1;
    }

    async _preprocessPages(pageCount) {
        // PDF.js can extract independent pages concurrently. Keep the pool small so
        // large documents load faster without creating a large memory/CPU spike.
        // WebKit on iPad has a comparatively low per-tab memory ceiling, and each
        // concurrent PDF.js page can temporarily retain fonts, operators and text.
        const workerCount = Math.min(isIOSLike() ? 1 : 4, pageCount);
        let nextPage = 1;
        const worker = async () => {
            while (nextPage <= pageCount) {
                const pageNumber = nextPage++;
                await this.ensurePageParsed(pageNumber);
                await cooperativeYield();
            }
        };
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
    }

    _hasLegacyIndexedHighlights(highlights) {
        if (!(highlights instanceof Map) || !highlights.size) return false;
        for (const data of highlights.values()) {
            if (
                !Number.isFinite(Number(data?.pageIndex)) ||
                !Array.isArray(data?.words) ||
                data.words.length === 0
            ) {
                return true;
            }
        }
        return false;
    }

    _resolvePageSentenceIndex(pageNumber, pageSentenceIndex = 0, fallbackIndex = 0) {
        const { state } = this.app;
        const indices = state.pageSentencesIndex?.get?.(pageNumber) || [];
        if (indices.length) {
            const offset = Math.min(
                Math.max(Number.parseInt(pageSentenceIndex, 10) || 0, 0),
                indices.length - 1,
            );
            return indices[offset];
        }
        const fallback = Number.parseInt(fallbackIndex, 10);
        if (Number.isFinite(fallback) && fallback >= 0 && fallback < state.sentences.length) {
            return fallback;
        }
        return state.sentences.length ? 0 : -1;
    }

    async _ensurePageWithSentences(startPageNumber) {
        const { state } = this.app;
        const pageCount = Number(state.pdf?.numPages) || 0;
        const currentPage = Math.min(Math.max(1, startPageNumber), pageCount);
        await this.ensurePageParsed(currentPage);
        if (state.pageSentencesIndex.get(currentPage)?.length) return currentPage;

        const nextPage = currentPage + 1;
        if (nextPage <= pageCount) {
            await this.ensurePageParsed(nextPage);
            if (state.pageSentencesIndex.get(nextPage)?.length) return nextPage;
        }
        return currentPage;
    }

    async _ensureLegacySentenceIndex(sentenceIndex) {
        const { state } = this.app;
        const target = Number.parseInt(sentenceIndex, 10);
        if (!Number.isFinite(target) || target < 0) return false;
        for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber++) {
            await this.ensurePageParsed(pageNumber);
            if (state.sentences.length > target) return true;
            await cooperativeYield();
        }
        return state.sentences.length > target;
    }

    async _reparseLoadedPages() {
        const { app } = this;
        const { state } = app;
        await Promise.allSettled(Array.from(state.pdfPageParsePromises?.values?.() || []));
        const pageNumbers = Array.from(state.parsedPdfPages || [])
            .map(Number)
            .filter(Number.isFinite)
            .sort((a, b) => a - b);
        state.pdfSentencesByPage.clear();
        state.pageSentencesIndex.clear();
        state.sentences = [];
        for (const pageNumber of pageNumbers) {
            const page = state.pagesCache.get(pageNumber);
            if (!page?.pageWords) continue;
            await app.sentenceParser.parsePageWords(pageNumber, page, { expectedPdf: state.pdf });
        }
        if (state.savedHighlights instanceof Map) {
            state.savedHighlights = app.highlightsStorage.remapPdfHighlights(state.savedHighlights);
        }
    }

    async loadPDF(file = null, { resume = true, existingKey = null } = {}) {
        const { app } = this;
        const { state } = app;
        app.ui.updatePlayButton(state.playerState.LOADING);
        document.body.style.cursor = "wait";
        try {
            if (file instanceof File) {
                state.currentPdfDescriptor = {
                    type: "file",
                    name: file.name,
                    size: file.size,
                    lastModified: file.lastModified,
                    fileObject: file,
                };
                document.getElementById("pdf-open")?.classList.remove("fa-beat");
            } else {
                document.getElementById("pdf-open")?.classList.add("fa-beat");
                document.getElementById("play-toggle-icon")?.classList.toggle("disabled");
                return;
            }

            if (existingKey) {
                state.currentPdfKey = existingKey;
            } else {
                state.currentPdfKey = this.computePdfKeyFromSource(state.currentPdfDescriptor);

                // If the same PDF was already saved under a different key (e.g., server timestamp vs File.lastModified),
                // reuse the existing key to avoid duplicates.
                if (file instanceof File && state.currentPdfKey) {
                    const currentParts = this._parseFileKeyParts(state.currentPdfKey);
                    if (currentParts?.name && currentParts.size > 0) {
                        const keys = await app.progressManager.listSavedPDFs();
                        const matches = keys.filter((k) => {
                            const p = this._parseFileKeyParts(k);
                            return p && p.name === currentParts.name && p.size === currentParts.size;
                        });

                        if (matches.length) {
                            // Prefer the key that already has saved highlights, else saved progress,
                            // so reopening via file picker doesn't "lose" highlights.
                            const highlightsByKey = app.highlightsStorage?.getHighlightsMap?.() || {};
                            const hasHighlights = (k) => {
                                const hl = highlightsByKey?.[k];
                                if (hl?.version === 2 && hl.pages) {
                                    return Object.values(hl.pages).some(
                                        (items) => Array.isArray(items) && items.length > 0,
                                    );
                                }
                                return hl && typeof hl === "object" && Object.keys(hl).length > 0;
                            };

                            const withHighlights = matches.find(hasHighlights);
                            const withProgress =
                                withHighlights ||
                                matches.find((k) => {
                                    const saved = app.progressManager?.loadSavedPosition?.(k, "pdf");
                                    return !!saved;
                                });

                            const chosen = withProgress || matches[0];
                            state.currentPdfKey = chosen;

                            // Merge any highlights scattered across duplicate keys into the chosen key.
                            // This avoids the common case where highlights were saved under a sibling duplicate.
                            if (matches.length > 1 && app.highlightsStorage?.saveHighlights) {
                                const merged = new Map();
                                for (const k of matches) {
                                    const highlights = app.highlightsStorage.loadSavedHighlights(k);
                                    for (const [sentenceIndex, data] of highlights.entries()) {
                                        merged.set(sentenceIndex, data);
                                    }
                                }
                                if (merged.size) {
                                    app.highlightsStorage.saveHighlights(chosen, merged, { merge: false });
                                }
                            }
                        }
                    }
                }
            }

            if (file instanceof File) {
                const existingPDF = await app.progressManager.loadPdfFromIndexedDB(state.currentPdfKey);
                if (!existingPDF) {
                    await app.progressManager.savePdfToIndexedDB(file, state.currentPdfKey);
                    this.app.ui.showInfo("PDF saved on IndexedDB!");
                }
            }

            // Invalidate any page extraction that is still resolving for the
            // previous document before replacing its PDF.js worker.
            this._pdfParseGeneration += 1;

            // A newly opened document replaces the previous PDF.js worker and its
            // font/operator caches. Waiting for GC here is unreliable on iPadOS.
            if (state.pdf?.destroy) {
                try {
                    await state.pdf.destroy();
                } catch (error) {
                    console.debug("[PDFLoader] Previous PDF cleanup failed", error);
                }
                state.pdf = null;
            }
            app.cache.clearAll();
            state.layoutDetectionCache.clear();
            state.layoutDetectionInProgress.clear();
            state.layoutCacheVersion += 1;
            state.layoutFilteringReady = false;
            state.layoutFilteringPromise = null;
            state.initialLayoutWarmupPromise = null;
            state.generationEnabled = false;
            state.sentences = [];
            state.savedHighlights = app.highlightsStorage.loadSavedHighlights(state.currentPdfKey);
            state.phraseSplitVersion = app.highlightsStorage.getPhraseSplitVersion(
                state.currentPdfKey,
                state.savedHighlights,
            );
            state.currentSentenceIndex = -1;
            state.hoveredSentenceIndex = -1;
            state.pageSentencesIndex.clear();
            state.prefetchedPages.clear();
            state.bookTitle = file.name;
            app.ttsQueue.reset();

            let arrayBuffer;
            if (file instanceof File) {
                arrayBuffer = await file.arrayBuffer();
            } else {
                return;
            }

            const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
            state.pdf = await loadingTask.promise;
            state.currentDocumentType = "pdf";
            if (!state.pdf.numPages) throw new Error("PDF has no pages.");

            const localSavedPosition = state.currentPdfKey
                ? app.progressManager.loadSavedPosition(state.currentPdfKey, "pdf")
                : null;
            const savedPage = Number.parseInt(localSavedPosition?.currentPage, 10);
            const hasSavedPage = Number.isInteger(savedPage) && savedPage >= 1;
            const requestedPage =
                resume && hasSavedPage
                    ? Math.min(Math.max(savedPage, 1), state.pdf.numPages)
                    : 1;
            state.currentPdfPage = requestedPage;

            if (app.ui.playbackPreparationActive) {
                app.ui.updatePlaybackPreparation(`Extracting text from page ${requestedPage}…`);
            } else {
                app.ui.showMessage(`Extracting text from page ${requestedPage}…`, 0);
            }

            // Model initialization is independent of PDF text extraction. Start it
            // now so opening the document and preparing layout overlap.
            app.getPdfHeaderFooterDetector()
                .prepare()
                .catch((error) => {
                    console.warn("[PDFLoader] Layout model warmup failed", error);
                });

            const requiresLegacyIndexing = this._hasLegacyIndexedHighlights(state.savedHighlights);
            let activeResumePage = requestedPage;
            if (requiresLegacyIndexing) {
                // Old highlight records only contain a global sentence index.
                // Keep their one-time compatibility path eager so those anchors
                // can be migrated without silently attaching to another phrase.
                await this._preprocessPages(state.pdf.numPages);
            } else {
                activeResumePage = await this._ensurePageWithSentences(requestedPage);
            }
            state.savedHighlights = app.highlightsStorage.remapPdfHighlights(state.savedHighlights);
            if (requiresLegacyIndexing && state.savedHighlights.size && state.currentPdfKey) {
                app.highlightsStorage.saveHighlights(state.currentPdfKey, state.savedHighlights);
                state.savedHighlights = app.highlightsStorage.remapPdfHighlights(
                    app.highlightsStorage.loadSavedHighlights(state.currentPdfKey),
                );
            }

            const savedPageSentenceIndex = Number.parseInt(localSavedPosition?.pageSentenceIndex, 10) || 0;
            let startIndex = this._resolvePageSentenceIndex(
                activeResumePage > 0 ? activeResumePage : requestedPage,
                activeResumePage === requestedPage ? savedPageSentenceIndex : 0,
                localSavedPosition?.sentenceIndex,
            );
            let resumeVoiceId =
                resume && typeof localSavedPosition?.voice === "string" && localSavedPosition.voice.trim()
                    ? localSavedPosition.voice.trim()
                    : null;
            let serverPosition = null;

            // First, try to load from server if enabled
            if (app.serverSync?.isEnabled() && state.currentPdfKey) {
                try {
                    const serverData = await app.serverSync.loadPositionAndHighlightsFromServer(state.currentPdfKey);

                    // Update position from server if available
                    if (serverData.position !== null && serverData.position >= 0) {
                        serverPosition = serverData.position;
                        //console.log(`[PDFLoader] Restored position from server: ${startIndex}`);
                    }

                    // Update voice from server if available
                    if (resume && serverData.voice) {
                        resumeVoiceId = serverData.voice;
                        //console.log(`[PDFLoader] Restored voice from server: ${resumeVoiceId}`);
                    }

                    // Update highlights from server if available
                    if (serverData.highlights && serverData.highlights.size > 0) {
                        const serverSplitVersion = app.highlightsStorage.getPhraseSplitVersion(
                            state.currentPdfKey,
                            serverData.highlights,
                        );
                        state.savedHighlights = serverData.highlights;
                        const serverNeedsLegacyIndexing = this._hasLegacyIndexedHighlights(serverData.highlights);
                        if (serverSplitVersion !== state.phraseSplitVersion) {
                            state.phraseSplitVersion = serverSplitVersion;
                            if (serverNeedsLegacyIndexing) await this._preprocessPages(state.pdf.numPages);
                            await this._reparseLoadedPages();
                        } else if (serverNeedsLegacyIndexing && state.parsedPdfPages.size < state.pdf.numPages) {
                            await this._preprocessPages(state.pdf.numPages);
                        }
                        state.savedHighlights = app.highlightsStorage.remapPdfHighlights(
                            state.savedHighlights,
                        );
                        if (serverNeedsLegacyIndexing) {
                            app.highlightsStorage.ensurePdfWordAnchors(state.savedHighlights);
                            app.serverSync
                                ?.syncHighlights?.(state.currentPdfKey, state.savedHighlights)
                                .catch?.((error) => {
                                    console.warn("[PDFLoader] Failed to migrate remote highlight anchors", error);
                                });
                        }
                        //console.log(`[PDFLoader] Restored ${serverData.highlights.size} highlights from server`);

                        // Also save to local storage
                        app.highlightsStorage?.saveHighlights?.(state.currentPdfKey, state.savedHighlights);
                    }

                    // Persist server translation preferences locally for prompt defaults.
                    if (serverData.translationTarget || serverData.translationMode) {
                        const map = app.progressManager.getProgressMap();
                        const compoundKey = `pdf::${state.currentPdfKey}`;
                        const existingEntry = map[compoundKey] || {};
                        map[compoundKey] = {
                            ...existingEntry,
                            translationTarget:
                                typeof serverData.translationTarget === "string" && serverData.translationTarget.trim()
                                    ? serverData.translationTarget.trim()
                                    : existingEntry.translationTarget,
                            translationMode:
                                typeof serverData.translationMode === "string" && serverData.translationMode.trim()
                                    ? serverData.translationMode.trim()
                                    : existingEntry.translationMode,
                            docType: "pdf",
                        };
                        app.progressManager.setProgressMap(map);
                    }
                } catch (error) {
                    console.warn("[PDFLoader] Failed to load from server, using local data:", error);
                }
            }

            // A server-only legacy position is usable when all preceding pages
            // have been parsed. New local progress resumes by page + page offset.
            const hasLocalPageLocator = resume && hasSavedPage;
            if (
                Number.isFinite(serverPosition) &&
                serverPosition >= state.sentences.length &&
                !hasLocalPageLocator
            ) {
                await this._ensureLegacySentenceIndex(serverPosition);
            }
            if (
                Number.isFinite(serverPosition) &&
                (!hasLocalPageLocator || requiresLegacyIndexing) &&
                serverPosition >= 0 &&
                serverPosition < state.sentences.length
            ) {
                startIndex = serverPosition;
            } else {
                startIndex = this._resolvePageSentenceIndex(
                    activeResumePage > 0 ? activeResumePage : requestedPage,
                    activeResumePage === requestedPage ? savedPageSentenceIndex : 0,
                    startIndex,
                );
            }

            if (resume && resumeVoiceId) {
                await this._applySavedVoice(resumeVoiceId);
            }

            const resumeSentence = state.sentences[startIndex] || null;
            if (state.viewMode === "full") {
                await app.pdfRenderer.renderFullDocumentIfNeeded();
            }
            if (resumeSentence) {
                const rebuiltIndex = state.sentences.indexOf(resumeSentence);
                if (rebuiltIndex >= 0) startIndex = rebuiltIndex;
            }

            // Load highlights from local storage if not already loaded from server
            if (!state.savedHighlights || state.savedHighlights.size === 0) {
                state.savedHighlights = app.highlightsStorage.loadSavedHighlights(state.currentPdfKey);
            }
            state.savedHighlights = app.highlightsStorage.remapPdfHighlights(state.savedHighlights);
            if (state.savedHighlights.size) {
                const lastSaved = Array.from(state.savedHighlights.values()).pop();
                if (lastSaved?.color) state.selectedHighlightColor = lastSaved.color;
            }
            const renderPage = state.sentences[startIndex]?.pageNumber || activeResumePage || requestedPage;
            if (app.ui.playbackPreparationActive) {
                app.ui.updatePlaybackPreparation(`Rendering page ${renderPage}…`);
            } else {
                app.ui.showMessage(`Rendering page ${renderPage}…`, 0);
            }
            if (startIndex >= 0) {
                await app.pdfRenderer.renderSentence(startIndex);
            } else {
                await app.pdfRenderer.ensurePageCanvasMounted(renderPage);
            }
            void this.prefetchNextPage(renderPage);
            app.ui.showInfo(`Page ${renderPage} ready`);
            app.interactionHandler.setupInteractionListeners();
            app.controlsManager.reflectSelectedHighlightColor();

            app.eventBus.emit(EVENTS.PDF_LOADED, {
                pages: state.pdf.numPages,
                sentences: state.sentences.length,
                parsedPages: state.parsedPdfPages.size,
            });
            app.eventBus.emit(EVENTS.SENTENCES_PARSED, state.sentences);
            this._warmInitialPageForPlayback();
            const header = document.getElementById("previous-pdf-header");
            header.classList.add("hidden");
        } catch (e) {
            console.error(e);
            app.ui.showInfo("Error: " + e.message);
            throw e;
        } finally {
            document.body.style.cursor = "default";
            this.app.ui.updatePlayButton(state.playerState.DONE);
        }
    }

    async ensureLayoutFilteringReady({ forceRebuild = false, skipAudio = false } = {}) {
        const { app } = this;
        const { state } = app;

        if (!state.pdf) {
            throw new Error("No PDF is loaded.");
        }

        if (state.layoutFilteringReady && !forceRebuild) {
            return;
        }

        if (state.layoutFilteringPromise) {
            app.ui.updatePlaybackPreparation?.("Analyzing page layout…");
            return state.layoutFilteringPromise;
        }

        const promise = this._prepareLayoutFiltering({ forceRebuild, skipAudio });
        state.layoutFilteringPromise = promise;
        try {
            await promise;
        } finally {
            state.layoutFilteringPromise = null;
        }
    }

    async _prepareLayoutFiltering({ forceRebuild = false, skipAudio = false } = {}) {
        const { app } = this;
        const { state } = app;

        await app.audioManager.stopPlayback(true, {
            clearContext: !app.ui.playbackPreparationActive,
        });
        state.autoAdvanceActive = false;
        state.layoutFilteringReady = false;
        state.generationEnabled = true;
        state.audioCache.clear();
        app.ttsQueue.reset();
        state.prefetchedPages.clear();

        for (const sentence of state.sentences) {
            if (!sentence) continue;
            sentence.layoutProcessed = false;
            sentence.isTextToRead = false;
            sentence.readableWords = [];
            sentence.readableText = "";
            if (sentence.originalText) sentence.text = sentence.originalText;
            sentence.layoutProcessingPromise = null;
        }

        if (forceRebuild) {
            state.layoutDetectionCache.clear();
            state.layoutDetectionInProgress.clear();
            state.layoutCacheVersion += 1;
            for (const page of state.pagesCache.values()) {
                if (!page?.pageWords) continue;
                for (const word of page.pageWords) {
                    if (word) word.isReadable = null;
                }
            }
        }

        const prevSentence = state.currentSentence || null;
        const prevIndex = state.currentSentenceIndex;

        app.ui.updatePlayButton(state.playerState.LOADING);
        if (app.ui.playbackPreparationActive) {
            app.ui.updatePlaybackPreparation("Analyzing page layout…");
        } else {
            app.ui.showMessage("Analyzing page layout…", 0);
        }

        const targetPages = new Set();
        if (prevSentence) {
            targetPages.add(prevSentence.pageNumber);
        } else if (state.sentences.length) {
            targetPages.add(state.sentences[0].pageNumber);
        }

        for (const pageNumber of targetPages) {
            await app.pdfRenderer.ensureFullPageRendered(pageNumber);
            await app.getPdfHeaderFooterDetector().ensureReadabilityForPage(pageNumber, { force: forceRebuild });
            await cooperativeYield();
        }

        if (app.ui.playbackPreparationActive) {
            app.ui.updatePlaybackPreparation("Layout detection complete. Building readable phrases…");
        } else {
            app.ui.showMessage("Layout detection complete. Building readable phrases…", 0);
        }

        if (!state.sentences.length) {
            app.ui.showInfo("No sentences available in document.");
            state.currentSentenceIndex = -1;
            state.hoveredSentenceIndex = -1;
            state.layoutFilteringReady = true;
            return;
        }

        const nextIndex = this._resolveResumeIndex(prevSentence, prevIndex);
        const clampedIndex = Math.min(Math.max(nextIndex, 0), state.sentences.length - 1);
        let resolvedIndex = this._findNextReadableSentence(clampedIndex);

        if (resolvedIndex < 0) {
            // Attempt to find the next readable sentence by processing pages on demand
            for (const sentence of [...state.sentences]) {
                if (!sentence || sentence.layoutProcessed) continue;
                await app.pdfRenderer.ensureFullPageRendered(sentence.pageNumber);
                await app.getPdfHeaderFooterDetector().ensureReadabilityForPage(sentence.pageNumber, {
                    force: forceRebuild,
                });
                if (sentence.layoutProcessed && sentence.isTextToRead) {
                    resolvedIndex = state.sentences.indexOf(sentence);
                    break;
                }
                await cooperativeYield();
            }
        }

        if (resolvedIndex < 0) {
            const firstUnparsedPage = Math.max(1, Number(prevSentence?.pageNumber) || 1);
            for (let pageNumber = firstUnparsedPage; pageNumber <= state.pdf.numPages; pageNumber++) {
                if (!state.parsedPdfPages.has(pageNumber)) {
                    await this.ensurePageParsed(pageNumber, { prefetchNext: true });
                }
                const indices = state.pageSentencesIndex.get(pageNumber) || [];
                if (!indices.length) continue;
                const pageSentences = indices.map((index) => state.sentences[index]).filter(Boolean);
                await app.pdfRenderer.ensureFullPageRendered(pageNumber);
                await app.getPdfHeaderFooterDetector().ensureReadabilityForPage(pageNumber, {
                    force: forceRebuild,
                });
                const readableSentence = pageSentences.find((sentence) => sentence.isTextToRead);
                resolvedIndex = readableSentence ? state.sentences.indexOf(readableSentence) : -1;
                if (resolvedIndex >= 0) break;
                await cooperativeYield();
            }
        }

        if (resolvedIndex >= 0) {
            if (app.ui.playbackPreparationActive) {
                app.ui.updatePlaybackPreparation("Rendering readable phrases…");
            } else {
                app.ui.showMessage("Rendering readable phrases…", 0);
            }
            await app.pdfRenderer.renderSentence(resolvedIndex, { skipTTS: skipAudio });
            state.layoutFilteringReady = true;
            if (app.ui.playbackPreparationActive) {
                app.ui.updatePlaybackPreparation("Phrases are ready. Preparing speech…");
            } else {
                app.ui.showMessage(
                    `Layout ready. Sentence ${state.currentSentenceIndex + 1} of ${state.sentences.length} is ready.`,
                    3500,
                );
            }
        } else {
            state.currentSentenceIndex = -1;
            state.hoveredSentenceIndex = -1;
            state.layoutFilteringReady = true;
            app.ui.showInfo("No readable sentences found after layout filtering.");
        }
        // app.ui.updatePlayButton(state.playerState.DONE);
    }

    _warmInitialPageForPlayback() {
        const { state } = this.app;
        if (!state.pdf || state.currentDocumentType !== "pdf" || state.layoutFilteringReady) return;
        if (state.initialLayoutWarmupPromise) return;

        state.initialLayoutWarmupPromise = this.ensureLayoutFilteringReady({ skipAudio: true })
            .catch((error) => {
                console.warn("[PDFLoader] Initial page preparation failed", error);
            })
            .finally(() => {
                state.initialLayoutWarmupPromise = null;
            });
    }

    async _applySavedVoice(voiceId) {
        const { app } = this;
        if (typeof voiceId !== "string") return;

        const trimmedVoiceId = voiceId.trim();
        if (!trimmedVoiceId) return;

        const voiceSelect = document.getElementById("voice-select");
        const selectOptions = voiceSelect ? Array.from(voiceSelect.options || []) : [];
        const voiceAvailable =
            selectOptions.some((opt) => opt.value === trimmedVoiceId) ||
            app.config.PIPER_VOICES.includes(trimmedVoiceId);

        if (!voiceAvailable) {
            console.warn(`Saved voice ${trimmedVoiceId} not available, skipping restore.`);
            return;
        }

        if (voiceSelect && selectOptions.some((opt) => opt.value === trimmedVoiceId)) {
            voiceSelect.value = trimmedVoiceId;
        }

        // Do not overwrite voiceId/currentPiperVoice here: those describe the model
        // actually loaded in the worker. ensurePiper will now see any model mismatch
        // and perform a real voice change before synthesis.
        app.ttsEngine.preferredVoiceId = trimmedVoiceId;
    }

    _resolveResumeIndex(prevSentence, prevIndex) {
        const { state } = this.app;

        if (!prevSentence) {
            return prevIndex >= 0 ? prevIndex : 0;
        }

        const targetText = normalizeText(prevSentence.text);
        const directMatch = state.sentences.findIndex((s) => normalizeText(s.text) === targetText);
        if (directMatch >= 0) {
            return directMatch;
        }

        if (prevSentence.bbox) {
            let bestIdx = -1;
            let bestDelta = Number.POSITIVE_INFINITY;
            for (let i = 0; i < state.sentences.length; i++) {
                const s = state.sentences[i];
                if (s.pageNumber !== prevSentence.pageNumber || !s.bbox) continue;
                const dy = Math.abs(s.bbox.centerY - prevSentence.bbox.centerY);
                const dx = Math.abs(s.bbox.centerX - prevSentence.bbox.centerX);
                const delta = dx + dy;
                if (delta < bestDelta) {
                    bestDelta = delta;
                    bestIdx = i;
                }
            }
            if (bestIdx >= 0) {
                return bestIdx;
            }
        }

        const forwardIdx = state.sentences.findIndex((s) => s.pageNumber >= prevSentence.pageNumber);
        if (forwardIdx >= 0) {
            return forwardIdx;
        }

        return state.sentences.length - 1;
    }

    _findNextReadableSentence(startIndex = 0) {
        const { state } = this.app;
        if (!state.sentences.length) return -1;
        const clampStart = Math.min(Math.max(startIndex, 0), state.sentences.length - 1);

        for (let i = clampStart; i < state.sentences.length; i++) {
            const sentence = state.sentences[i];
            if (sentence?.layoutProcessed && sentence.isTextToRead) {
                return i;
            }
        }

        for (let i = clampStart - 1; i >= 0; i--) {
            const sentence = state.sentences[i];
            if (sentence?.layoutProcessed && sentence.isTextToRead) {
                return i;
            }
        }

        return -1;
    }
}
