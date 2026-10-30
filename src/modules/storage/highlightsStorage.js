import {
    CURRENT_PHRASE_SPLIT_VERSION,
    LEGACY_PHRASE_SPLIT_VERSION,
    normalizePhraseSplitVersion,
} from "../phrases/phraseSplitVersions.js";
import { EVENTS } from "../../constants/events.js";

export class HighlightsStorage {
    constructor(app) {
        this.app = app;
    }

    getHighlightsMap() {
        const { config } = this.app;
        try {
            return JSON.parse(localStorage.getItem(config.HIGHLIGHTS_STORAGE_KEY) || "{}");
        } catch {
            return {};
        }
    }
    setHighlightsMap(map) {
        const { config } = this.app;
        try {
            localStorage.setItem(config.HIGHLIGHTS_STORAGE_KEY, JSON.stringify(map));
        } catch (e) {
            console.warn("Failed to write highlights:", e);
        }
    }
    loadSavedHighlights(pdfKey) {
        if (!pdfKey) return new Map();
        const all = this.getHighlightsMap();
        const pdfHighlights = all[pdfKey] || {};
        const highlightsMap = new Map();
        if (pdfHighlights?.version === 2 && pdfHighlights.pages) {
            let temporaryIndex = -1;
            for (const [pageIndex, pageHighlights] of Object.entries(pdfHighlights.pages)) {
                if (!Array.isArray(pageHighlights)) continue;
                for (const data of pageHighlights) {
                    const sentenceIndex = Number.parseInt(data?.sentenceIndex, 10);
                    const runtimeIndex = Number.isFinite(sentenceIndex)
                        ? sentenceIndex
                        : temporaryIndex--;
                    highlightsMap.set(runtimeIndex, {
                        ...data,
                        pageIndex: Number.parseInt(pageIndex, 10),
                    });
                }
            }
            return highlightsMap;
        }
        for (const [sentenceIndex, data] of Object.entries(pdfHighlights)) {
            highlightsMap.set(parseInt(sentenceIndex), data);
        }
        return highlightsMap;
    }
    getPhraseSplitVersion(pdfKey, highlights = null) {
        const saved = highlights instanceof Map ? highlights : this.loadSavedHighlights(pdfKey);
        if (!saved.size) return CURRENT_PHRASE_SPLIT_VERSION;
        let version = CURRENT_PHRASE_SPLIT_VERSION;
        for (const data of saved.values()) {
            if (Number.isFinite(Number(data?.pageIndex)) && Array.isArray(data?.words) && data.words.length) {
                continue;
            }
            if (!data || data.phraseSplitVersion == null) return LEGACY_PHRASE_SPLIT_VERSION;
            version = Math.min(
                version,
                normalizePhraseSplitVersion(data.phraseSplitVersion, LEGACY_PHRASE_SPLIT_VERSION),
            );
        }
        return version;
    }
    _stampPhraseSplitVersion(highlights) {
        const version = normalizePhraseSplitVersion(this.app.state?.phraseSplitVersion);
        if (!(highlights instanceof Map)) return highlights;
        for (const [sentenceIndex, data] of highlights.entries()) {
            highlights.set(sentenceIndex, { ...(data || {}), phraseSplitVersion: version });
        }
        return highlights;
    }
    _normalizeWord(value) {
        return String(value || "")
            .trim()
            .replace(/\s+/g, " ");
    }
    _sentenceWords(sentence) {
        if (!sentence) return [];
        const readable =
            Array.isArray(sentence.readableWords) && sentence.readableWords.length
                ? sentence.readableWords
                : sentence.words;
        return Array.isArray(readable) ? readable : [];
    }
    _highlightedPdfWords(sentence) {
        const renderer = this.app.pdfRenderer;
        const playing = renderer?.getPlayingPhraseWords?.(sentence);
        if (Array.isArray(playing) && playing.length) return playing;
        const hovered = renderer?.getHoverPhraseWords?.(sentence);
        if (Array.isArray(hovered) && hovered.length) return hovered;
        return this._sentenceWords(sentence);
    }
    _hasPdfWordAnchor(data) {
        return (
            Number.isFinite(Number(data?.pageIndex)) &&
            Array.isArray(data?.words) &&
            data.words.length > 0
        );
    }
    _withPdfWordAnchor(sentenceIndex, data) {
        if (this._hasPdfWordAnchor(data)) {
            const anchored = { ...(data || {}), sentenceIndex };
            delete anchored.phraseSplitVersion;
            return anchored;
        }
        const { state } = this.app;
        const sentence = state?.sentences?.[sentenceIndex];
        if (!sentence || !Number.isFinite(sentence.pageNumber)) return data;

        const pageWords = state.pagesCache?.get?.(sentence.pageNumber)?.pageWords;
        const words = this._highlightedPdfWords(sentence);
        const wordStart =
            Array.isArray(pageWords) && words.length ? pageWords.indexOf(words[0]) : -1;

        const anchored = {
            ...(data || {}),
            sentenceIndex,
            pageIndex: sentence.pageNumber - 1,
            words: words
                .map((word) => this._normalizeWord(word?.str))
                .filter(Boolean),
            ...(wordStart >= 0 ? { wordStart } : {}),
        };
        delete anchored.phraseSplitVersion;
        return anchored;
    }
    _stampPdfWordAnchors(highlights) {
        if (!(highlights instanceof Map)) return highlights;
        for (const [sentenceIndex, data] of highlights.entries()) {
            if (!Number.isFinite(Number(sentenceIndex))) continue;
            highlights.set(
                sentenceIndex,
                this._withPdfWordAnchor(Number(sentenceIndex), data),
            );
        }
        return highlights;
    }
    ensurePdfWordAnchors(highlights) {
        return this._stampPdfWordAnchors(highlights);
    }
    _serializePdfHighlights(highlights) {
        const pages = {};
        for (const [sentenceIndex, original] of highlights.entries()) {
            const data = this._withPdfWordAnchor(Number(sentenceIndex), original);
            const pageIndex = Number(data?.pageIndex);
            if (!Number.isFinite(pageIndex) || !Array.isArray(data?.words) || !data.words.length) {
                continue;
            }
            const key = String(pageIndex);
            if (!pages[key]) pages[key] = [];
            const { pageIndex: _pageIndex, sentenceIndex: _sentenceIndex, ...stored } = data;
            pages[key].push(stored);
        }
        return { version: 2, pages };
    }
    _findAnchoredPageWords(data) {
        const pageIndex = Number(data?.pageIndex);
        const savedWords = Array.isArray(data?.words)
            ? data.words.map((word) => this._normalizeWord(word)).filter(Boolean)
            : [];
        if (!Number.isFinite(pageIndex) || !savedWords.length) return [];

        const pageWords = this.app.state?.pagesCache?.get?.(pageIndex + 1)?.pageWords;
        if (!Array.isArray(pageWords) || pageWords.length < savedWords.length) return [];
        const normalizedPageWords = pageWords.map((word) => this._normalizeWord(word?.str));
        const matchesAt = (start) =>
            start >= 0 &&
            start + savedWords.length <= normalizedPageWords.length &&
            savedWords.every((word, offset) => normalizedPageWords[start + offset] === word);

        const savedStart = Number(data?.wordStart);
        if (Number.isInteger(savedStart) && matchesAt(savedStart)) {
            return pageWords.slice(savedStart, savedStart + savedWords.length);
        }
        for (let start = 0; start <= pageWords.length - savedWords.length; start++) {
            if (matchesAt(start)) return pageWords.slice(start, start + savedWords.length);
        }
        return [];
    }
    getHighlightWords(highlightData, fallbackSentence = null) {
        const anchored = this._findAnchoredPageWords(highlightData);
        if (this._hasPdfWordAnchor(highlightData)) return anchored;
        return this._sentenceWords(fallbackSentence);
    }
    remapPdfHighlights(highlights) {
        if (!(highlights instanceof Map) || !highlights.size) return highlights || new Map();
        const { state } = this.app;
        const remapped = new Map();
        let unmatchedIndex = -1;

        for (const [fallbackIndex, data] of highlights.entries()) {
            const anchoredWords = this._findAnchoredPageWords(data);
            if (!anchoredWords.length) {
                if (this._hasPdfWordAnchor(data)) {
                    while (remapped.has(unmatchedIndex)) unmatchedIndex--;
                    remapped.set(unmatchedIndex--, data);
                } else {
                    remapped.set(fallbackIndex, data);
                }
                continue;
            }

            const pageNumber = Number(data.pageIndex) + 1;
            const candidates = state.pageSentencesIndex?.get?.(pageNumber) || [];
            const anchoredSet = new Set(anchoredWords);
            let bestIndex = -1;
            let bestOverlap = 0;
            for (const sentenceIndex of candidates) {
                const overlap = this._sentenceWords(state.sentences?.[sentenceIndex]).reduce(
                    (count, word) => count + (anchoredSet.has(word) ? 1 : 0),
                    0,
                );
                if (overlap > bestOverlap) {
                    bestOverlap = overlap;
                    bestIndex = sentenceIndex;
                }
            }
            let runtimeIndex = bestIndex >= 0 ? bestIndex : Number(fallbackIndex);
            if (bestIndex >= 0 && remapped.has(bestIndex)) {
                while (remapped.has(unmatchedIndex)) unmatchedIndex--;
                runtimeIndex = unmatchedIndex--;
            }
            const remappedData = {
                ...(data || {}),
                sentenceIndex: runtimeIndex,
            };
            delete remappedData.phraseSplitVersion;
            remapped.set(runtimeIndex, remappedData);
        }
        return remapped;
    }
    _getCurrentDocumentKey() {
        const { state } = this.app;
        return state.currentDocumentType === "epub" ? state.currentEpubKey : state.currentPdfKey;
    }
    saveHighlightsForPdf({ allowEmpty = false } = {}) {
        const { state } = this.app;
        const key = this._getCurrentDocumentKey();
        if (!key) return;

        const all = this.getHighlightsMap();
        const existing = all[key] || {};
        const existingCount =
            existing?.version === 2 && existing.pages
                ? Object.values(existing.pages).reduce(
                      (count, items) => count + (Array.isArray(items) ? items.length : 0),
                      0,
                  )
                : Object.keys(existing).length;
        const hasExisting = existingCount > 0;

        if (!allowEmpty && state.savedHighlights.size === 0 && hasExisting) {
            state.savedHighlights = this.loadSavedHighlights(key);
            if (state.currentDocumentType === "pdf") {
                state.savedHighlights = this.remapPdfHighlights(state.savedHighlights);
            }
            if (state.currentDocumentType === "epub") {
                this.app.epubRenderer?.updateHighlightDisplay?.();
            } else {
                this.app.pdfRenderer?.updateHighlightDisplay?.();
            }
            return;
        }

        // A document/sentence anchor is stable across deletion and recreation,
        // preventing a note from minting engagement rewards repeatedly.
        for (const [sentenceIndex, data] of state.savedHighlights.entries()) {
            if (!data || typeof data !== "object") continue;
            if (!data.annotationId) {
                data.annotationId = `${state.currentDocumentType}:${key}:${sentenceIndex}`;
            }
        }

        if (state.currentDocumentType === "pdf") {
            this._stampPdfWordAnchors(state.savedHighlights);
        } else {
            this._stampPhraseSplitVersion(state.savedHighlights);
        }
        const pdfHighlights =
            state.currentDocumentType === "pdf"
                ? this._serializePdfHighlights(state.savedHighlights)
                : Object.fromEntries(state.savedHighlights.entries());

        const savedCount =
            pdfHighlights?.version === 2
                ? Object.values(pdfHighlights.pages).reduce((count, items) => count + items.length, 0)
                : Object.keys(pdfHighlights).length;
        if (!allowEmpty && hasExisting && savedCount === 0) {
            return;
        }

        all[key] = pdfHighlights;
        this.setHighlightsMap(all);

        for (const [sentenceIndex, data] of state.savedHighlights.entries()) {
            this.app.eventBus?.emit?.(EVENTS.HIGHLIGHT_ADDED, {
                documentId: key,
                documentType: state.currentDocumentType,
                sentenceIndex,
                annotationId: data.annotationId,
                comment: typeof data.comment === "string" ? data.comment.trim() : "",
            });
        }

        //console.log("[HighlightsStorage] Saved highlights locally", {
        //    key,
        //    count: this.app.state?.savedHighlights?.size ?? 0,
        //});

        // Sync to server if enabled
        if (this.app.serverSync?.isEnabled()) {
            this.app.serverSync
                .syncHighlights(key, this.app.state.savedHighlights)
                .then((ok) => {
                    if (!ok) {
                        console.warn("[HighlightsStorage] Server highlights sync returned false", { key });
                    }
                })
                .catch((err) => {
                    console.warn("[HighlightsStorage] Server sync failed:", err);
                });
        }
    }

    saveHighlights(key, highlights, { merge = false } = {}) {
        if (!key) return;

        const all = this.getHighlightsMap();
        const existing = all[key] || {};
        const next = merge ? { ...existing } : {};

        if (highlights instanceof Map) {
            for (const [sentenceIndex, data] of highlights.entries()) {
                next[String(sentenceIndex)] = data;
            }
        } else if (highlights && typeof highlights === "object") {
            // Accept plain object maps too.
            for (const [sentenceIndex, data] of Object.entries(highlights)) {
                next[String(sentenceIndex)] = data;
            }
        }

        const isCurrentPdf =
            this.app.state?.currentDocumentType === "pdf" &&
            key === this.app.state?.currentPdfKey;
        const hasPdfAnchors =
            highlights instanceof Map &&
            Array.from(highlights.values()).some((data) => this._hasPdfWordAnchor(data));
        all[key] = (isCurrentPdf || hasPdfAnchors) && highlights instanceof Map
            ? this._serializePdfHighlights(highlights)
            : next;
        this.setHighlightsMap(all);
    }
    listSavedHighlights() {
        return this.getHighlightsMap();
    }
    clearPdfHighlights(key) {
        const map = this.getHighlightsMap();
        if (map[key]) {
            delete map[key];
            this.setHighlightsMap(map);
            if (key === this._getCurrentDocumentKey()) {
                this.app.state.savedHighlights.clear();
                if (this.app.state.currentDocumentType === "epub") {
                    this.app.epubRenderer?.updateHighlightDisplay?.();
                } else {
                    this.app.pdfRenderer?.updateHighlightDisplay?.();
                }
            }
        }
    }
}
