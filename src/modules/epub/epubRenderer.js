import "./../../../thirdparty/foliate-js/view.js";
import { Overlayer } from "./../../../thirdparty/foliate-js/overlayer.js";
import { EVENTS } from "../../constants/events.js";

const ACTIVE_SENTENCE_COLOR = "rgb(120, 190, 255)";
const HOVER_SENTENCE_COLOR = "rgb(148, 206, 255)";
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

export class EPUBRenderer {
    constructor(app, loader) {
        this.app = app;
        this.loader = loader;

        this.view = null;
        this._container = null;
        this._viewWrapper = null;

        this._boundResize = this._resizeContainer.bind(this);
        this._boundAmoledModeChange = () => {
            this._applyContentStyles();
            this.updateHighlightDisplay().catch((error) => {
                console.debug("[EPUBRenderer] Failed to refresh AMOLED highlights", error);
            });
        };
        this._boundRelocate = null;
        this._boundHighlight = null;
        this._boundLoad = null;
        this._boundDrawAnnotation = null;
        this._highlightRefreshTimer = null;
        this._contentCSS = "";

        this._activeDocs = new Set();
        this._docListeners = [];

        this._onKeydown = this._handleDirectionalKeydown.bind(this);
        this._globalKeysBound = false;

        this._activeAnnotationValue = null;
        this._hoverAnnotationValue = null;
        this._activePhraseActionsEl = null;
        this._activeHighlightColor = ACTIVE_SENTENCE_COLOR;
        this._hoverHighlightColor = HOVER_SENTENCE_COLOR;

        const DEFAULT_READER_SETTINGS = Object.freeze({
            spacing: 1.5,
            justify: true,
            hyphenate: true,
        });
        this._readerSettings = { ...DEFAULT_READER_SETTINGS };

        this._playbarRoot = null;
        this._playbarOriginalParent = null;
        this._playbarOriginalNextSibling = null;
        this._playbarOriginalStyles = null;

        // Track persistent annotation values we created for saved highlights
        this._persistentAnnotationValues = new Set();

        window.addEventListener("resize", this._boundResize, { passive: true });
        window.addEventListener("amoled-mode-change", this._boundAmoledModeChange, { passive: true });
    }

    /**
     * Update persistent and hover highlights for EPUB view.
     * This mirrors PDFRenderer.updateHighlightDisplay by rendering saved highlights
     * and hover highlights. Also keep a backward-compatible alias `pdateHighlightDisplay`.
     */
    async updateHighlightDisplay() {
        const { state } = this.app;
        if (!this.view || !state) return;

        // Remove any previously created persistent annotations
        if (this._persistentAnnotationValues && this._persistentAnnotationValues.size) {
            for (const val of Array.from(this._persistentAnnotationValues)) {
                try {
                    // view.deleteAnnotation may reject; ignore errors
                    this.view.deleteAnnotation({ value: val }).catch(() => {});
                } catch (e) {
                    /* ignore */
                }
            }
            this._persistentAnnotationValues.clear();
        }

        // Render saved highlights from application state
        try {
            const saved = state.savedHighlights ?? new Map();
            for (const [sentenceIndex, highlightData] of saved.entries()) {
                try {
                    const sentence = state.sentences?.[sentenceIndex];
                    const cfi = sentence?.cfi;
                    if (!cfi) continue;
                    const color = highlightData?.color || null;
                    // Add annotation for saved highlight; don't await to keep UI responsive
                    this.view.addAnnotation({ value: cfi, color }).catch(() => {});
                    // Track it so we can remove later
                    this._persistentAnnotationValues.add(cfi);
                } catch (e) {
                    console.debug("[EPUBRenderer] Failed to apply saved highlight", e);
                }
            }
        } catch (e) {
            console.debug("[EPUBRenderer] updateHighlightDisplay failed to render saved highlights", e);
        }

        // Re-apply hover/active highlights
        try {
            // Prefer to update active sentence highlight first
            const activeIdx = state.playingSentenceIndex >= 0 ? state.playingSentenceIndex : state.currentSentenceIndex;
            const active = activeIdx >= 0 ? state.sentences?.[activeIdx] : null;
            if (active && active.cfi) await this.updateHighlightFullDoc(active);
        } catch (e) {
            // non-fatal
        }

        try {
            this.renderHoverHighlightFullDoc();
        } catch (e) {
            // non-fatal
        }
    }

    // Alias requested: pdateHighlightDisplay
    pdateHighlightDisplay() {
        return this.updateHighlightDisplay();
    }
    setReaderSettings(settings = {}) {
        this._readerSettings = { ...DEFAULT_READER_SETTINGS, ...settings };
    }

    getReaderSettings() {
        return { ...this._readerSettings };
    }

    async open(source) {
        this.reset();

        const container = this._ensureContainer();
        container.style.display = "block";
        container.style.height = "";
        container.innerHTML = "";

        const wrapper = document.createElement("div");
        wrapper.classList.add("relative", "flex-1", "w-full");
        wrapper.style.position = "relative";
        wrapper.style.height = "100%";
        wrapper.style.width = "100%";
        wrapper.style.flex = "1 1 auto";
        container.appendChild(wrapper);
        this._viewWrapper = wrapper;

        const view = document.createElement("foliate-view");
        view.classList.add("flex-1");
        view.style.width = "100%";
        view.style.height = "100%";
        view.style.display = "block";
        view.style.flex = "1 1 auto";
        wrapper.appendChild(view);

        this.view = view;

        this._boundLoad = (event) => this._handleViewLoad(event);
        this._boundRelocate = (event) => {
            const detail = event?.detail ?? {};
            if (this.app?.state) {
                this.app.state.epubProgress = detail;
            }
            this.app?.eventBus?.emit?.(EVENTS.EPUB_LOCATION_CHANGED, detail);
        };
        this._boundHighlight = (event) => {
            console.debug("foliate highlight", event?.detail);
        };
        this._boundDrawAnnotation = (event) => this._handleDrawAnnotation(event);

        view.addEventListener("load", this._boundLoad);
        view.addEventListener("relocate", this._boundRelocate);
        view.addEventListener("highlight", this._boundHighlight);
        view.addEventListener("draw-annotation", this._boundDrawAnnotation);

        this._bindGlobalKeys();

        await view.open(source);

        this._applyReaderStyles();
        this._resizeContainer();

        return view;
    }

    reset() {
        this._unbindGlobalKeys();

        for (const doc of this._activeDocs) {
            try {
                doc.removeEventListener("keydown", this._onKeydown);
            } catch (error) {
                console.debug("[EPUBRenderer] Unable to remove doc keydown listener", error);
            }
        }
        this._activeDocs.clear();

        this._detachInteractionListeners();

        if (this.view && this._activeAnnotationValue) {
            try {
                this.view.deleteAnnotation({ value: this._activeAnnotationValue });
            } catch (error) {
                console.debug("[EPUBRenderer] Unable to remove active annotation", error);
            }
        }
        this._activeAnnotationValue = null;

        if (this.view && this._hoverAnnotationValue) {
            try {
                this.view.deleteAnnotation({ value: this._hoverAnnotationValue });
            } catch (error) {
                console.debug("[EPUBRenderer] Unable to remove hover annotation", error);
            }
        }
        this._hoverAnnotationValue = null;
        this._removeActivePhraseActions();

        if (this.view) {
            if (this._boundLoad) {
                this.view.removeEventListener("load", this._boundLoad);
                this._boundLoad = null;
            }
            if (this._boundRelocate) {
                this.view.removeEventListener("relocate", this._boundRelocate);
                this._boundRelocate = null;
            }
            if (this._boundHighlight) {
                this.view.removeEventListener("highlight", this._boundHighlight);
                this._boundHighlight = null;
            }
            if (this._boundDrawAnnotation) {
                this.view.removeEventListener("draw-annotation", this._boundDrawAnnotation);
                this._boundDrawAnnotation = null;
            }
            this.view.remove();
            this.view = null;
        }

        if (this._viewWrapper) {
            this._viewWrapper.remove();
            this._viewWrapper = null;
        }

        if (this._container) {
            this._container.innerHTML = "";
            this._container.style.display = "none";
            this._container.style.height = "";
        }
        if (this._highlightRefreshTimer) {
            clearTimeout(this._highlightRefreshTimer);
            this._highlightRefreshTimer = null;
        }
    }

    destroy() {
        window.removeEventListener("resize", this._boundResize);
        window.removeEventListener("amoled-mode-change", this._boundAmoledModeChange);
        this.reset();
        this._container = null;
    }

    async applyContentCSS(url) {
        try {
            const response = await fetch(url);
            this._contentCSS = response.ok ? await response.text() : "";
        } catch {
            this._contentCSS = "";
        }
        this._applyContentStyles();
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

    _buildContentStyles() {
        const amoledTextColor = this._getAmoledTextColor();
        const amoledCSS = this._isAmoledModeEnabled()
            ? `
:root {
    --bg: #000000 !important;
    --bg-dark: #000000 !important;
    --fg: ${amoledTextColor} !important;
}
	html,
	body,
	body *,
	section,
	article,
	main,
	div,
	p,
	span,
	li,
	blockquote {
	    background: #000000 !important;
	    background-color: #000000 !important;
	    color: ${amoledTextColor} !important;
	}
	a,
	a *,
	em,
	strong,
	i,
	b {
	    color: ${amoledTextColor} !important;
	}
	`
            : "";
        return `${this._contentCSS || ""}\n${amoledCSS}`;
    }

    _applyContentStyles() {
        if (!this.view?.renderer || typeof this.view.renderer.setStyles !== "function") return;
        this.view.renderer.setStyles(this._buildContentStyles());
    }

    setupInteractionListeners() {
        this._detachInteractionListeners();
        if (!this.view?.renderer?.getContents) return;
        const contents = this.view.renderer.getContents();
        for (const entry of contents) {
            const doc = entry?.doc;
            if (!doc) continue;
            const clickHandler = (event) => this._handleDocumentClick(event, entry.index);
            const mouseMoveHandler = (event) => this._handleDocumentPointerMove(event, entry.index);
            const mouseLeaveHandler = () => {
                this._setDocumentPointerCursor(doc, false);
                this._setHoveredSentence(-1);
            };
            const touchStartHandler = (event) => this._handleDocumentTouchMove(event, entry.index, doc);
            const touchMoveHandler = (event) => this._handleDocumentTouchMove(event, entry.index, doc);
            const touchEndHandler = () => this._setHoveredSentence(-1);
            const hoverSurface = doc.documentElement || doc;

            doc.addEventListener("click", clickHandler, { passive: false });
            doc.addEventListener("mousemove", mouseMoveHandler, { passive: true });
            hoverSurface.addEventListener("mouseleave", mouseLeaveHandler, { passive: true });
            doc.addEventListener("touchstart", touchStartHandler, { passive: true });
            doc.addEventListener("touchmove", touchMoveHandler, { passive: true });
            doc.addEventListener("touchend", touchEndHandler, { passive: true });
            doc.addEventListener("touchcancel", touchEndHandler, { passive: true });

            this._docListeners.push({ doc, type: "click", handler: clickHandler, options: { passive: false } });
            this._docListeners.push({ doc, type: "mousemove", handler: mouseMoveHandler, options: { passive: true } });
            this._docListeners.push({
                doc: hoverSurface,
                type: "mouseleave",
                handler: mouseLeaveHandler,
                options: { passive: true },
            });
            this._docListeners.push({
                doc,
                type: "touchstart",
                handler: touchStartHandler,
                options: { passive: true },
            });
            this._docListeners.push({ doc, type: "touchmove", handler: touchMoveHandler, options: { passive: true } });
            this._docListeners.push({ doc, type: "touchend", handler: touchEndHandler, options: { passive: true } });
            this._docListeners.push({ doc, type: "touchcancel", handler: touchEndHandler, options: { passive: true } });
        }
    }

    renderHoverHighlightFullDoc() {
        const { state } = this.app;
        if (!this.view || !state?.sentences?.length) {
            this._applyHoverHighlight(null);
            return;
        }

        const hoveredIdx = state.hoveredSentenceIndex;
        const activeIdx = state.playingSentenceIndex >= 0 ? state.playingSentenceIndex : state.currentSentenceIndex;

        if (hoveredIdx == null || hoveredIdx < 0 || hoveredIdx >= state.sentences.length || hoveredIdx === activeIdx) {
            this._applyHoverHighlight(null);
            return;
        }

        const sentence = state.sentences[hoveredIdx];
        if (!sentence?.cfi) {
            this._applyHoverHighlight(null);
            return;
        }

        this._applyHoverHighlight(sentence.cfi);
    }

    updateHighlightFullDoc(sentence) {
        const targetSentence = sentence || this.app?.state?.currentSentence || null;
        const targetCfi = targetSentence?.cfi || this._activeAnnotationValue;
        if (targetCfi) {
            this._applySentenceHighlight(targetCfi);
        }
        this.renderHoverHighlightFullDoc();
        this._renderActivePhraseActions(targetSentence);
    }

    async renderSentence(idx, options = {}) {
        const { state } = this.app;
        if (!state?.sentences?.length) return null;
        if (idx == null || idx < 0 || idx >= state.sentences.length) return null;

        const sentence = state.sentences[idx];
        state.currentSentenceIndex = idx;

        if (sentence?.cfi && this.view) {
            try {
                await this.view.goTo(sentence.cfi);
            } catch (error) {
                console.warn("[EPUBRenderer] Navigation error", error);
            }
            await this._applySentenceHighlight(sentence.cfi);
            this._clearTextSelections();
            this._renderActivePhraseActions(sentence);
        }

        if (!options?.autoAdvance && state.generationEnabled) {
            this.app.ttsQueue.add(idx, true);
            const ahead = this.app.config?.PREFETCH_AHEAD ?? 0;
            for (let i = 1; i <= ahead; i++) {
                const target = idx + i;
                if (target < state.sentences.length) this.app.ttsQueue.add(target);
            }
            this.app.ttsQueue.run();
        }

        this.app.progressManager.saveProgress();
        this.app.eventBus?.emit?.(EVENTS.SENTENCE_CHANGED, { index: idx, sentence });

        return sentence;
    }

    scrollSentenceIntoView(sentence) {
        if (!sentence?.cfi || !this.view?.resolveCFI || !this.view?.renderer?.scrollToAnchor) return;
        try {
            const resolved = this.view.resolveCFI(sentence.cfi);
            if (!resolved?.anchor) return;
            const contents = this.view.renderer.getContents?.() ?? [];
            const target = contents.find((entry) => entry.index === resolved.index);
            const doc = target?.doc;
            if (!doc) return;
            const range = resolved.anchor(doc);
            if (range) {
                this.view.renderer.scrollToAnchor(range, true);
                this._clearTextSelections();
            }
        } catch (error) {
            console.debug("[EPUBRenderer] Unable to scroll into view", error);
        }
    }

    handleViewportHeightChange() {
        this._resizeContainer();
        const current = this.app?.state?.currentSentence;
        if (current) this.scrollSentenceIntoView(current);
    }

    _ensureContainer() {
        if (!this._container || !document.body.contains(this._container)) {
            this._container = document.getElementById("epub-doc-container");
        }
        if (!this._container) {
            throw new Error("EPUB container element not found.");
        }
        this._container.classList.add("relative", "flex", "flex-col", "w-full");
        this._container.classList.remove("hidden");
        this._container.style.position = this._container.style.position || "relative";
        return this._container;
    }

    _resizeContainer() {
        if (!this._container) return;
        const rect = this._container.getBoundingClientRect();
        const availableHeight = Math.max(window.innerHeight - rect.top, 0);
        this._container.style.height = `${availableHeight}px`;
        if (this._viewWrapper) {
            this._viewWrapper.style.height = "100%";
        }
        if (this.view) {
            this.view.style.height = "100%";
        }
    }

    _bindGlobalKeys() {
        if (this._globalKeysBound) return;
        window.addEventListener("keydown", this._onKeydown, { passive: false });
        this._globalKeysBound = true;
    }

    _unbindGlobalKeys() {
        if (!this._globalKeysBound) return;
        window.removeEventListener("keydown", this._onKeydown);
        this._globalKeysBound = false;
    }

    _handleDirectionalKeydown(event) {
        if (!this.view) return;
        const tag = event.target?.tagName || "";
        if (/^(INPUT|TEXTAREA|SELECT)$/i.test(tag)) return;

        if (event.key === "ArrowLeft") {
            event.preventDefault();
            this.view.goLeft();
        } else if (event.key === "ArrowRight") {
            event.preventDefault();
            this.view.goRight();
        }
    }

    _handleViewLoad(event) {
        const doc = event?.detail?.doc;
        if (!doc || this._activeDocs.has(doc)) return;
        doc.addEventListener("keydown", this._onKeydown, { passive: false });
        this._activeDocs.add(doc);
        this.setupInteractionListeners();
        this._scheduleHighlightDisplayRefresh();
    }

    _handleDrawAnnotation(event) {
        const detail = event?.detail;
        if (!detail?.draw) return;
        const annotationColor = detail.annotation?.color;
        const color = annotationColor || this._activeHighlightColor;
        let opacity = null;
        if (annotationColor === this._activeHighlightColor) {
            opacity = this._scaleHighlightOpacity(0.18, 0.045).toFixed(3);
        } else if (annotationColor === this._hoverHighlightColor) {
            opacity = this._scaleHighlightOpacity(0.12, 0.03).toFixed(3);
        } else if (annotationColor && this._isAmoledModeEnabled()) {
            opacity = this._scaleHighlightOpacity(0.22, 0.055).toFixed(3);
        }
        const drawHighlight = (rects, options = {}) => {
            const el = Overlayer.highlight(rects, options);
            if (opacity !== null) {
                el.style.opacity = opacity;
            }
            return el;
        };
        try {
            detail.draw(drawHighlight, { color });
        } catch (error) {
            console.warn("[EPUBRenderer] Failed to draw annotation", error);
        }
    }

    _clearTextSelections() {
        if (typeof this.view?.deselect === "function") {
            try {
                this.view.deselect();
            } catch (error) {
                console.debug("[EPUBRenderer] Unable to use view.deselect", error);
            }
        }
        if (!this.view?.renderer?.getContents) return;
        const contents = this.view.renderer.getContents();
        for (const entry of contents) {
            const doc = entry?.doc;
            if (!doc) continue;
            try {
                const winSelection = doc.defaultView?.getSelection?.();
                if (winSelection?.rangeCount) winSelection.removeAllRanges();
            } catch (error) {
                console.debug("[EPUBRenderer] Unable to clear window selection", error);
            }
            try {
                const docSelection = doc.getSelection?.();
                if (docSelection?.rangeCount) docSelection.removeAllRanges();
            } catch (error) {
                console.debug("[EPUBRenderer] Unable to clear document selection", error);
            }
        }
    }

    _removeActivePhraseActions() {
        if (this._activePhraseActionsEl) {
            this._activePhraseActionsEl.remove();
            this._activePhraseActionsEl = null;
        }
    }

    _renderActivePhraseActions(sentence) {
        this._removeActivePhraseActions();
        if (!sentence?.cfi || !this.view?.resolveCFI) return;

        let doc = null;
        let range = null;
        try {
            const resolved = this.view.resolveCFI(sentence.cfi);
            const contents = this.view.renderer?.getContents?.() ?? [];
            const target = contents.find((entry) => entry.index === resolved?.index);
            doc = target?.doc || null;
            range = resolved?.anchor?.(doc);
        } catch (error) {
            console.debug("[EPUBRenderer] Unable to resolve active phrase actions", error);
            return;
        }

        if (!doc || !range) return;
        const rect = range.getBoundingClientRect?.();
        if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return;

        const stopBubble = (event) => {
            event.preventDefault();
            event.stopPropagation();
        };
        const stopToolbarPointerEvent = (event) => {
            event.stopPropagation();
        };

        const panel = document.createElement("div");
        panel.className = "pdf-active-phrase-actions epub-active-phrase-actions";
        panel.dataset.keepTranslatePopup = "true";
        panel.style.position = "fixed";
        panel.style.zIndex = "10000";

        const makeButton = ({ title, label, icon, color = "" }) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "pdf-active-phrase-btn";
            button.title = title;
            button.setAttribute("aria-label", label);

            const span = document.createElement("span");
            span.className = "material-symbols-outlined";
            span.textContent = icon;
            if (color) span.style.color = color;
            button.appendChild(span);
            button.addEventListener("mousedown", stopBubble);
            return button;
        };

        const copyBtn = makeButton({
            title: "Copy current phrase",
            label: "Copy current phrase",
            icon: "content_copy",
        });
        copyBtn.addEventListener("click", async (event) => {
            stopBubble(event);
            await this.app.interactionHandler?.copyCurrentPhraseToClipboard?.({ successMessage: "Current phrase copied" });
        });
        panel.appendChild(copyBtn);

        const activeColor = this.app?.state?.savedHighlights?.get?.(sentence.index)?.color || "";
        for (const { label, value } of [
            { label: "Yellow", value: "#ffda76" },
            { label: "Red", value: "#F44336" },
            { label: "Green", value: "#81C784" },
            { label: "Blue", value: "#4FC3F7" },
        ]) {
            const highlightBtn = makeButton({
                title: `Highlight ${label.toLowerCase()}`,
                label: `Highlight current phrase ${label.toLowerCase()}`,
                icon: "format_ink_highlighter",
                color: value,
            });
            const isActive = String(activeColor).toLowerCase() === value.toLowerCase();
            highlightBtn.setAttribute("aria-pressed", isActive ? "true" : "false");
            if (isActive) highlightBtn.style.borderColor = value;
            highlightBtn.addEventListener("click", (event) => {
                stopBubble(event);
                this.app.highlightManager?.saveCurrentSentenceHighlight?.(value);
            });
            panel.appendChild(highlightBtn);
        }

        const commentBtn = makeButton({
            title: "Add comment",
            label: "Add comment",
            icon: "comment",
        });
        commentBtn.setAttribute("aria-pressed", "false");
        commentBtn.addEventListener("click", async (event) => {
            stopBubble(event);
            await this.app.highlightManager?.editCurrentSentenceComment?.();
        });
        panel.appendChild(commentBtn);

        // Keep taps entirely in the parent-document toolbar instead of letting
        // touch/pointer handling reach the EPUB iframe below it.
        for (const type of ["pointerdown", "pointerup", "touchstart", "touchmove", "touchend"]) {
            panel.addEventListener(type, stopToolbarPointerEvent);
        }
        panel.addEventListener("mousedown", stopBubble);
        panel.addEventListener("click", stopToolbarPointerEvent);
        panel.addEventListener("dblclick", stopToolbarPointerEvent);
        document.body.appendChild(panel);

        const frame = doc.defaultView?.frameElement || null;
        const frameRect = frame?.getBoundingClientRect?.() || null;
        const containerRect = this._container?.getBoundingClientRect?.() || null;
        const offsetLeft = frameRect?.left || 0;
        const offsetTop = frameRect?.top || 0;
        const viewportLeft = rect.left + offsetLeft;
        const viewportTop = rect.top + offsetTop;
        const boundsLeft = frameRect?.left ?? containerRect?.left ?? 0;
        const boundsRight = frameRect?.right ?? containerRect?.right ?? window.innerWidth;
        const panelWidth = panel.offsetWidth || 0;
        const leftMin = boundsLeft + 6;
        const leftMax = Math.max(leftMin, boundsRight - panelWidth - 6);
        const left = Math.min(Math.max(leftMin, viewportLeft), leftMax);
        const top = Math.max(6, viewportTop - 34);

        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        this._activePhraseActionsEl = panel;
    }

    _applyReaderStyles() {
        if (!this.view?.renderer) return;
        if (typeof this.view.renderer.setStyles === "function") {
            // this.view.renderer.setStyles(buildReaderCSS(this._readerSettings));
        }
        if (!this.view.renderer.hasAttribute("flow")) {
            this.view.renderer.setAttribute("flow", "scrolled");
        }
        if (typeof this.view.renderer.next === "function") {
            this.view.renderer.next();
        }
    }

    _detachInteractionListeners() {
        if (!Array.isArray(this._docListeners) || !this._docListeners.length) return;
        for (const { doc, type, handler, options } of this._docListeners) {
            try {
                this._setDocumentPointerCursor(doc?.ownerDocument || doc, false);
                doc?.removeEventListener(type, handler, options);
            } catch (error) {
                console.debug("[EPUBRenderer] Unable to remove document listener", error);
            }
        }
        this._docListeners = [];
    }

    async _handleDocumentClick(event, sectionIndex) {
        if (!this.app?.state?.sentences?.length) return;
        const doc = event.currentTarget;
        if (event.defaultPrevented) return;
        if (event.target?.closest?.(".pdf-active-phrase-actions")) return;
        if (event.target?.closest?.("a[href]")) return;

        const sentenceIndex = this._resolveSentenceIndexFromEvent(doc, event, sectionIndex);
        if (sentenceIndex < 0) return;

        const wasPlaying = !!this.app?.audioManager?.hasPlaybackIntent?.();
        try {
            await this.app?.audioManager?.stopPlayback?.(true);
        } catch (error) {
            console.debug("[EPUBRenderer] Failed to stop playback", error);
        }
        if (this.app?.state) {
            this.app.state.autoAdvanceActive = false;
        }

        await this.renderSentence(sentenceIndex);

        if (wasPlaying) {
            await this.app.audioManager.playCurrentSentence();
        }

        event.preventDefault();
        event.stopPropagation();
    }

    _rangeFromPoint(doc, event) {
        if (!doc) return null;
        const point = event.touches?.[0] ?? event;
        const x = point?.clientX;
        const y = point?.clientY;
        if (typeof x !== "number" || typeof y !== "number") return null;

        let range = null;
        if (typeof doc.caretRangeFromPoint === "function") {
            range = doc.caretRangeFromPoint(x, y);
        }
        if (!range && typeof doc.caretPositionFromPoint === "function") {
            const pos = doc.caretPositionFromPoint(x, y);
            if (pos) {
                range = doc.createRange();
                range.setStart(pos.offsetNode, pos.offset);
            }
        }
        if (!range) return null;

        if (range.collapsed) {
            const node = range.startContainer;
            if (node?.nodeType === Node.TEXT_NODE) {
                const length = node.nodeValue?.length ?? 0;
                const start = range.startOffset;
                const end = start < length ? start + 1 : start;
                range.setEnd(node, Math.min(length, end));
            }
        }
        return range;
    }

    _resolveSentenceIndexFromEvent(doc, event, sectionIndex) {
        if (!this.view || !doc) return -1;
        const selection = doc.defaultView?.getSelection?.();
        if (selection && selection.toString().length) return -1;

        const range = this._rangeFromPoint(doc, event);
        if (!range) return -1;

        let cfi;
        try {
            cfi = this.view.getCFI(sectionIndex, range);
        } catch (error) {
            console.debug("[EPUBRenderer] CFI resolution error", error);
            return -1;
        }

        return this.loader?.findSentenceIndexInSection(sectionIndex, cfi) ?? -1;
    }

    _handleDocumentPointerMove(event, sectionIndex, docOverride) {
        if (!this.app?.state?.sentences?.length) return;
        const doc = docOverride || event.currentTarget;
        if (!doc) return;
        if (event?.target?.closest?.(".pdf-active-phrase-actions")) return;
        if (event?.target?.closest?.("a[href]")) {
            if (event?.type === "mousemove") this._setDocumentPointerCursor(doc, false);
            this._setHoveredSentence(-1);
            return;
        }
        const idx = this._resolveSentenceIndexFromEvent(doc, event, sectionIndex);
        if (event?.type === "mousemove") this._setDocumentPointerCursor(doc, idx >= 0);
        if (idx >= 0) this._setHoveredSentence(idx);
        else this._setHoveredSentence(-1);
    }

    _setDocumentPointerCursor(doc, enabled) {
        if (!doc) return;
        const value = enabled ? "pointer" : "";
        try {
            if (doc.documentElement) doc.documentElement.style.cursor = value;
            if (doc.body) doc.body.style.cursor = value;
        } catch (error) {
            console.debug("[EPUBRenderer] Unable to update document cursor", error);
        }
    }

    _handleDocumentTouchMove(event, sectionIndex, doc) {
        const touch = event.touches?.[0] ?? event.changedTouches?.[0];
        if (!touch) return;
        const target = doc?.elementFromPoint?.(touch.clientX, touch.clientY) ?? event.target;
        const syntheticEvent = {
            clientX: touch.clientX,
            clientY: touch.clientY,
            target,
            type: event.type,
        };
        this._handleDocumentPointerMove(syntheticEvent, sectionIndex, doc);
    }

    async _applySentenceHighlight(cfi) {
        if (!this.view || !cfi) return;
        if (this._activeAnnotationValue) {
            const previous = this._activeAnnotationValue;
            try {
                await this.view.deleteAnnotation({ value: previous });
            } catch (error) {
                console.debug("[EPUBRenderer] Unable to delete previous annotation", error);
            }
            if (previous !== cfi) {
                await this._restorePersistentHighlight(previous);
            }
        }

        try {
            const savedColor = this._getSavedHighlightColorForCfi(cfi);
            await this.view.addAnnotation({ value: cfi, color: savedColor || this._activeHighlightColor });
            this._activeAnnotationValue = cfi;
            this._clearTextSelections();
        } catch (error) {
            console.warn("[EPUBRenderer] Failed to apply highlight", error);
            this._activeAnnotationValue = null;
        }
    }

    _scheduleHighlightDisplayRefresh() {
        if (this._highlightRefreshTimer) clearTimeout(this._highlightRefreshTimer);
        this._highlightRefreshTimer = setTimeout(() => {
            this._highlightRefreshTimer = null;
            this.updateHighlightDisplay().catch((error) => {
                console.debug("[EPUBRenderer] Failed to refresh EPUB highlights", error);
            });
        }, 0);
    }

    _getSavedHighlightColorForCfi(cfi) {
        if (!cfi) return null;
        const { state } = this.app;
        if (!state?.savedHighlights?.size || !state?.sentences?.length) return null;
        for (const [sentenceIndex, highlightData] of state.savedHighlights.entries()) {
            const sentence = state.sentences?.[sentenceIndex];
            if (sentence?.cfi === cfi) return highlightData?.color || null;
        }
        return null;
    }

    async _restorePersistentHighlight(cfi) {
        const color = this._getSavedHighlightColorForCfi(cfi);
        if (!color || !this._persistentAnnotationValues?.has(cfi)) return;
        try {
            await this.view.addAnnotation({ value: cfi, color });
        } catch (error) {
            console.debug("[EPUBRenderer] Unable to restore saved highlight", error);
        }
    }

    _applyHoverHighlight(cfi) {
        if (!this.view) {
            if (!cfi) this._hoverAnnotationValue = null;
            return;
        }
        if (!cfi) {
            if (this._hoverAnnotationValue) {
                const value = this._hoverAnnotationValue;
                this.view.deleteAnnotation({ value }).catch(() => {});
            }
            this._hoverAnnotationValue = null;
            return;
        }

        if (this._hoverAnnotationValue === cfi) return;
        const previous = this._hoverAnnotationValue;
        this._hoverAnnotationValue = cfi;
        if (previous && previous !== cfi) {
            this.view.deleteAnnotation({ value: previous }).catch(() => {});
        }

        this.view.addAnnotation({ value: cfi, color: this._hoverHighlightColor }).catch((error) => {
            console.debug("[EPUBRenderer] Failed to apply hover highlight", error);
            if (this._hoverAnnotationValue === cfi) {
                this._hoverAnnotationValue = null;
            }
        });
    }

    _setHoveredSentence(idx) {
        const { state } = this.app;
        if (!state) return;
        if (state.hoveredSentenceIndex === idx) return;
        state.hoveredSentenceIndex = idx;
        this.renderHoverHighlightFullDoc();
    }
}
