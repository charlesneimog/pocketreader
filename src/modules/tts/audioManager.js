import { delay, waitFor, hasUsableSpeechText, isIOSLike } from "../utils/helpers.js";
import { EVENTS } from "../../constants/events.js";

const SENTENCE_OVERLAP_SECONDS = 0.02;

export class AudioManager {
    constructor(app) {
        this.app = app;
        this._playPromise = null;
        this._playbackContext = null;
        this._playbackContextId = 0;
        this._playbackBlocks = new Set();
        this._mediaBridgeAudio = null;
        this._mediaBridgeObjectUrl = null;
        this._overlappingMediaElements = new Set();
        this._preparedMediaBridge = null;
        this._mediaBridgeSyncing = false;
        this._mediaElementUnlocked = false;
        this._mediaUnlockPromise = null;
        this._waitingForAudioNoticeKey = null;
        this._setupMediaBridge();
        this._setupMediaSession();
    }

    async playCurrentSentence() {
        const { state } = this.app;
        if (this._playbackBlocks.size) {
            return;
        }
        if (state.isPlaying) {
            return;
        }
        if (this._playPromise) {
            return this._playPromise;
        }

        const context = {
            id: this._playbackContextId++,
            sentenceIndex: state.currentSentenceIndex,
            continuesReading: !!state.autoAdvanceActive,
        };
        this._beginPlaybackPreparationForStart(context);
        state.stopRequested = false;

        this._playbackContext = context;
        this._clearWaitingForAudio();

        const playPromise = this._playCurrentSentence(context);
        const trackedPromise = playPromise.finally(() => {
            if (this._playPromise === trackedPromise) {
                this._playPromise = null;
            }
            if (!state.isPlaying && this._isContextActive(context)) {
                this.app.ui.finishPlaybackPreparation();
            }
        });
        this._playPromise = trackedPromise;
        return this._playPromise;
    }

    async _playEPUBSentence(context) {
        const { state } = this.app;

        await this.app.epubLoader.ensureLayoutFilteringReady();
        if (!this._isContextActive(context)) return;

        if (!state.sentences.length) {
            this.app.ui.showInfo("No readable sentences available in EPUB.");
            return;
        }

        if (state.currentSentenceIndex < 0) {
            await this.app.pdfRenderer.renderSentence(0, { suppressScroll: true });
            if (!this._isContextActive(context)) return;
        }

        let sentence = state.currentSentence || state.sentences[state.currentSentenceIndex];
        if (!sentence) {
            this.app.ui.showInfo("No readable sentences available.");
            return;
        }

        const ensuredSentence = await this._ensureSentenceHasSpeech(sentence);
        if (!this._isContextActive(context)) return;
        if (!ensuredSentence) {
            this.app.ui.showInfo("No readable sentences available.");
            return;
        }

        sentence = ensuredSentence;
        context.sentenceIndex = state.currentSentenceIndex;

        await this.app.ttsEngine.ensureAudioContext();
        if (!this._isContextActive(context)) return;

        if (!state.generationEnabled) {
            state.generationEnabled = true;
        }

        let attempts = 0;
        while ((!sentence.audioReady || !sentence.audioBuffer) && !sentence.audioError) {
            if (!this._isContextActive(context)) return;
            if (attempts === 0) {
                this.app.ttsQueue.add(state.currentSentenceIndex, true);
                this.app.ttsQueue.run();
            }
            this._showWaitingForAudio(sentence);
            attempts += 1;
            try {
                await waitFor(() => sentence.audioReady || sentence.audioError, 5000);
            } catch {}
            if (!this._isContextActive(context)) return;
            if (sentence.audioReady && sentence.audioBuffer) break;
            if (sentence.audioError || state.stopRequested || attempts >= 3) {
                break;
            }
        }

        if (!sentence.audioReady || sentence.audioError || !sentence.audioBuffer) {
            this._clearWaitingForAudio();
            if (!sentence.audioError && !state.stopRequested && this._isContextActive(context)) {
                await delay(300);
                if (this._isContextActive(context) && !state.stopRequested) {
                    return this._playCurrentSentence(context);
                }
            }
            return;
        }

        if (!this._isContextActive(context)) return;
        if (!(await this._waitForStartupBuffer(context))) return;
        if (!this._isContextActive(context)) return;

        await this.stopPlayback(false, { clearContext: false, emitEvent: false, preserveMediaElement: true });
        if (!this._isContextActive(context)) return;

        state.stopRequested = false;

        let shouldRetry = false;
        try {
            state.currentSource = null;
            state.currentGain = null;
            state.playingSentenceIndex = state.currentSentenceIndex;

            this.setupWordBoundaryTimers(sentence);

            if (!this._isContextActive(context) || state.stopRequested) {
                state.playingSentenceIndex = -1;
                state.playingPhraseBlockKey = null;
                return;
            }

            state.isPlaying = true;
            state.autoAdvanceActive = true;
            state.playingSentenceIndex = state.currentSentenceIndex;
            await this._activateMediaBridge(sentence, context);
            this.app.finishBookOpenPlaybackTimer?.({ sentenceIndex: state.currentSentenceIndex });
            this._clearWaitingForAudio();
            this._finishPlaybackPreparationForStart(context);
            this.app.ui.updatePlayButton(state.playerState.PLAY);
            this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_START, { index: state.currentSentenceIndex });
            if (!state.stopRequested && this._isContextActive(context)) {
                this.app.ttsEngine.schedulePrefetch();
            }
        } catch (err) {
            console.error("Playback error:", err);
            state.isPlaying = false;
            state.autoAdvanceActive = false;
            state.playingSentenceIndex = -1;
            this.clearWordBoundaryTimers(sentence);
            this._pauseMediaBridge();
            if (this._isContextActive(context)) {
                this.app.ui.showInfo("Playback error; resetting context.");
            }
            try {
                if (state.audioCtx) await state.audioCtx.close();
            } catch {}
            state.audioCtx = null;
            shouldRetry = this._shouldRetryPlayback(context, err);
        } finally {
            if (shouldRetry) {
                await delay(200);
                if (this._isContextActive(context) && !state.stopRequested) {
                    return this._playCurrentSentence(context);
                }
            }
        }
    }

    async _playPDFSentence(context) {
        const { state } = this.app;
        try {
            await this.app.pdfLoader.ensureLayoutFilteringReady();
        } catch (err) {
            console.error("Layout preparation failed:", err);
            if (this._isContextActive(context)) {
                this.app.ui.showInfo("❌ Layout analysis failed. Cannot start playback.");
            }
            return;
        }
        if (!this._isContextActive(context)) return;

        state.stopRequested = false;
        this.app.ui.updatePlaybackPreparation("Phrases are ready. Preparing speech…");

        let sentence = state.currentSentence;
        if (!sentence) {
            this.app.ui.showInfo("No readable sentences available.");
            return;
        }

        if (!sentence.isTextToRead) {
            this.app.ui.showInfo("Selected sentence is outside readable layout regions.");
            return;
        }

        const ensuredSentence = await this._ensureSentenceHasSpeech(sentence);
        if (!this._isContextActive(context)) return;
        if (!ensuredSentence) {
            this.app.ui.showInfo("No readable sentences available.");
            return;
        }

        sentence = ensuredSentence;
        context.sentenceIndex = state.currentSentenceIndex;

        await this.app.ttsEngine.ensureAudioContext();
        if (!this._isContextActive(context)) return;

        if (!state.generationEnabled) {
            state.generationEnabled = true;
        }

        let attempts = 0;
        while ((!sentence.audioReady || !sentence.audioBuffer) && !sentence.audioError) {
            if (!this._isContextActive(context)) return;
            if (attempts === 0) {
                this.app.ttsQueue.add(state.currentSentenceIndex, true);
                this.app.ttsQueue.run();
            }
            this._showWaitingForAudio(sentence);
            attempts += 1;
            try {
                await waitFor(() => sentence.audioReady || sentence.audioError, 5000);
            } catch {}
            if (!this._isContextActive(context)) return;
            if (sentence.audioReady && sentence.audioBuffer) break;
            if (sentence.audioError || state.stopRequested || attempts >= 3) {
                break;
            }
        }

        if (!sentence.audioReady || sentence.audioError || !sentence.audioBuffer) {
            this._clearWaitingForAudio();
            if (!sentence.audioError && !state.stopRequested && this._isContextActive(context)) {
                await delay(300);
                if (this._isContextActive(context) && !state.stopRequested) {
                    return this._playCurrentSentence(context);
                }
            }
            return;
        }

        if (!this._isContextActive(context)) return;
        if (!(await this._waitForStartupBuffer(context))) return;
        if (!this._isContextActive(context)) return;

        this._updatePlaybackPreparationForStart(context);
        await this.stopPlayback(false, { clearContext: false, emitEvent: false, preserveMediaElement: true });
        if (!this._isContextActive(context)) return;

        state.stopRequested = false;

        let shouldRetry = false;
        try {
            state.currentSource = null;
            state.currentGain = null;
            state.playingSentenceIndex = state.currentSentenceIndex;

            this.setupWordBoundaryTimers(sentence);

            if (!this._isContextActive(context) || state.stopRequested) {
                state.playingSentenceIndex = -1;
                state.playingPhraseBlockKey = null;
                return;
            }

            state.isPlaying = true;
            state.autoAdvanceActive = true;
            state.playingSentenceIndex = state.currentSentenceIndex;
            await this._activateMediaBridge(sentence, context);
            this.app.finishBookOpenPlaybackTimer?.({ sentenceIndex: state.currentSentenceIndex });
            this._clearWaitingForAudio();
            this.app.pdfRenderer.updateHighlightFullDoc();
            this._finishPlaybackPreparationForStart(context);
            this.app.ui.updatePlayButton(state.playerState.PLAY);
            this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_START, { index: state.currentSentenceIndex });
            if (!state.stopRequested && this._isContextActive(context)) {
                this.app.ttsEngine.schedulePrefetch();
            }
        } catch (err) {
            console.error("Playback error:", err);
            state.isPlaying = false;
            state.autoAdvanceActive = false;
            state.playingSentenceIndex = -1;
            this.clearWordBoundaryTimers(sentence);
            this._pauseMediaBridge();
            if (this._isContextActive(context)) {
                this.app.ui.showInfo("Playback error; resetting context.");
            }
            try {
                if (state.audioCtx) await state.audioCtx.close();
            } catch {}
            state.audioCtx = null;
            shouldRetry = this._shouldRetryPlayback(context, err);
        } finally {
            if (shouldRetry) {
                await delay(200);
                if (this._isContextActive(context) && !state.stopRequested) {
                    return this._playCurrentSentence(context);
                }
            }
        }
    }

    async _playCurrentSentence(context) {
        const { ui, state } = this.app;

        if (!this._isContextActive(context)) return;

        if (!state.pdf && !state.epub) {
            ui.showInfo("Load a document before playing.");
            return;
        }

        try {
            if (state.currentDocumentType === "pdf") {
                await this._playPDFSentence(context);
            } else if (state.currentDocumentType === "epub") {
                await this._playEPUBSentence(context);
            }
        } catch (err) {
            console.error("Playback error:", err);
            if (this._isContextActive(context)) {
                ui.showInfo("Playback error; resetting context.");
            }
            try {
                if (state.audioCtx) await state.audioCtx.close();
            } catch {}
            state.audioCtx = null;
        }
    }

    _finishPlaybackPreparationForStart(context) {
        this.app.ui.finishPlaybackPreparation(context?.continuesReading ? "" : "Reading started.");
    }

    _beginPlaybackPreparationForStart(context) {
        if (context?.continuesReading) return;
        const documentType = this.app.state.currentDocumentType;
        this.app.ui.beginPlaybackPreparation(
            documentType === "pdf" ? "Checking page layout…" : "Preparing the text for reading…",
        );
    }

    _updatePlaybackPreparationForStart(context) {
        if (!context?.continuesReading) {
            this.app.ui.updatePlaybackPreparation("Starting reading…");
        }
    }

    _startupBufferStatus(targetSize) {
        const { state } = this.app;
        const target = Math.max(1, Number(targetSize) || 1);
        const candidates = [];
        let unresolved = false;

        for (let index = state.currentSentenceIndex; index < state.sentences.length; index++) {
            const sentence = state.sentences[index];
            if (!sentence) continue;

            // PDF layout filtering is ordered. Until the next phrase is classified,
            // a later phrase cannot safely stand in for it in the startup buffer.
            if (!sentence.layoutProcessed) {
                unresolved = true;
                break;
            }
            if (!sentence.isTextToRead || !hasUsableSpeechText(this._extractSpeechText(sentence))) {
                continue;
            }

            candidates.push(sentence);
            if (candidates.length >= target) break;
        }

        const required = unresolved ? target : Math.min(target, candidates.length);
        const ready = candidates.filter(
            (sentence) => sentence.audioReady && sentence.audioBuffer && !sentence.audioError,
        ).length;
        return { ready, required, unresolved };
    }

    async _waitForStartupBuffer(context) {
        if (context?.continuesReading) return true;

        const target = isIOSLike() ? 1 : Math.max(1, Number(this.app.config.TTS_START_BUFFER_PHRASES) || 2);
        this.app.ttsEngine.schedulePrefetch();

        while (this._isContextActive(context) && !this.app.state.stopRequested) {
            const status = this._startupBufferStatus(target);
            if (status.required > 0 && status.ready >= status.required) return true;

            this.app.ui.updatePlaybackPreparation(
                `Preparing speech buffer… ${status.ready}/${status.required || target} phrases ready`,
            );
            try {
                await waitFor(() => {
                    if (!this._isContextActive(context) || this.app.state.stopRequested) return true;
                    const next = this._startupBufferStatus(target);
                    return next.required > 0 && next.ready >= next.required;
                }, 5000);
            } catch {
                // Layout work or a long synthesis may exceed one polling window.
                // Re-assert prefetch so the single worker keeps filling the buffer.
                this.app.ttsEngine.schedulePrefetch();
            }
        }

        return false;
    }

    async stopPlayback(fade = true, options = {}) {
        const { state, config } = this.app;
        const { clearContext = true, emitEvent = true, preserveMediaElement = false } = options;

        state.stopRequested = true;

        const source = state.currentSource;
        const gain = state.currentGain;
        const audioCtx = state.audioCtx;

        if (source) {
            try {
                source.onended = null;
            } catch {}
        }

        if (source && audioCtx) {
            try {
                if (fade && gain && audioCtx.state === "running" && config.FADE_OUT_SEC > 0) {
                    const fadeDuration = Math.max(config.FADE_OUT_SEC, 0.01);
                    const now = audioCtx.currentTime;
                    const currentValue = Math.max(config.MIN_GAIN, gain.gain.value || config.MIN_GAIN);
                    gain.gain.cancelScheduledValues(now);
                    gain.gain.setValueAtTime(currentValue, now);
                    gain.gain.linearRampToValueAtTime(config.MIN_GAIN, now + fadeDuration);

                    const stopDelay = fadeDuration * 1000 + 10;
                    setTimeout(() => {
                        try {
                            source.stop();
                        } catch {}
                        try {
                            source.disconnect();
                        } catch {}
                        if (gain) {
                            try {
                                gain.disconnect();
                            } catch {}
                        }
                    }, stopDelay);
                } else {
                    try {
                        source.stop();
                    } catch {}
                    try {
                        source.disconnect();
                    } catch {}
                    if (gain) {
                        try {
                            gain.disconnect();
                        } catch {}
                    }
                }
            } catch (e) {
                console.warn("Stop error:", e);
            }
        }

        state.currentSource = null;
        state.currentGain = null;
        state.isPlaying = false;
        state.autoAdvanceActive = false;
        state.playingSentenceIndex = -1;
        state.playingPhraseBlockKey = null;
        this._clearWaitingForAudio();
        if (!preserveMediaElement) this._pauseMediaBridge();

        const currentSentence = state.currentSentence;
        if (currentSentence) this.clearWordBoundaryTimers(currentSentence);
        this.app.pdfRenderer.updateHighlightFullDoc();
        this._setMediaSessionPlaybackState("paused");
        if (emitEvent) {
            this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_PAUSE, { index: state.currentSentenceIndex });
        }

        if (clearContext) {
            this._playbackContext = null;
        }
    }

    async addPlaybackBlock(reason, fade = false) {
        this._playbackBlocks.add(String(reason || "unspecified"));
        await this.stopPlayback(fade);
    }

    removePlaybackBlock(reason) {
        this._playbackBlocks.delete(String(reason || "unspecified"));
    }

    togglePlay() {
        const { state } = this.app;
        if (state.isPlaying) {
            this.stopPlayback(true);
            state.autoAdvanceActive = false;
            this.app.ui.updatePlayButton(state.playerState.PAUSE);
        } else {
            // Must run synchronously inside the tap. iPadOS can reject the later
            // play() after layout analysis and speech generation have completed.
            this._primeMediaElementForUserGesture({ keepAlive: true });
            this.playCurrentSentence().catch((error) => {
                console.error("Unable to start playback:", error);
                this.app.ui.finishPlaybackPreparation();
            });
        }
    }

    async _ensureSentenceHasSpeech(sentence) {
        const { state } = this.app;
        if (!sentence) return null;

        let current = sentence;
        const visited = new Set();

        while (current && !visited.has(current)) {
            visited.add(current);
            if (current.isTextToRead && hasUsableSpeechText(this._extractSpeechText(current))) {
                return current;
            }

            if (current.isTextToRead) {
                this._markSentenceAsSilent(current);
            }

            const nextIndex =
                state.currentDocumentType === "pdf"
                    ? await this.app.pdfLoader.getAdjacentSentenceIndex(current, 1)
                    : state.currentSentenceIndex + 1;
            if (nextIndex < 0 || nextIndex >= state.sentences.length) {
                return null;
            }

            await this.app.pdfRenderer.renderSentence(nextIndex, { autoAdvance: true });
            current = state.currentSentence;
        }

        return null;
    }

    _extractSpeechText(sentence) {
        if (!sentence) return "";
        if (sentence.readableText && sentence.readableText.trim()) return sentence.readableText;
        if (sentence.text && sentence.text.trim()) return sentence.text;
        return "";
    }

    _markSentenceAsSilent(sentence) {
        if (!sentence) return;
        sentence.isTextToRead = false;
        sentence.audioReady = false;
        sentence.audioBuffer = null;
        sentence.audioError = null;
        sentence.prefetchQueued = false;
        sentence.wordBoundaries = [];
        sentence.ttsPhraseTimings = [];
    }

    _showWaitingForAudio(sentence) {
        const { state } = this.app;
        const sentenceIndex = Number.isFinite(sentence?.index) ? sentence.index : state.currentSentenceIndex;
        const key = `${state.currentDocumentType || "doc"}:${sentenceIndex}`;

        this.app.ui.updatePlayButton(state.playerState.LOADING);
        if (this._waitingForAudioNoticeKey === key) return;

        this._waitingForAudioNoticeKey = key;
        const friendlyPosition = Number.isFinite(sentenceIndex) && sentenceIndex >= 0 ? sentenceIndex + 1 : null;
        const prefix = state.autoAdvanceActive ? "Generating speech for the next phrase" : "Generating speech";
        const suffix = friendlyPosition ? ` (${friendlyPosition}/${state.sentences.length})` : "";
        const message = `${prefix}${suffix}… Long passages can take a moment.`;
        if (this.app.ui.playbackPreparationActive) {
            this.app.ui.updatePlaybackPreparation(message);
        } else {
            this.app.ui.showMessage(message, 4500);
        }
    }

    _clearWaitingForAudio() {
        this._waitingForAudioNoticeKey = null;
    }

    _isContextActive(context) {
        return !!(context && this._playbackContext && context.id === this._playbackContext.id);
    }

    _shouldRetryPlayback(context, error) {
        context.playbackRetryCount = (context.playbackRetryCount || 0) + 1;
        const browserRejectedPlayback = error?.name === "NotAllowedError" || error?.name === "NotSupportedError";
        if (browserRejectedPlayback && this._isContextActive(context)) {
            this.app.ui.showInfo("iPadOS blocked audio startup. Tap Play once more.");
        }
        return (
            !browserRejectedPlayback &&
            context.playbackRetryCount <= 1 &&
            !this.app.state.stopRequested &&
            this._isContextActive(context)
        );
    }

    _invalidateContext(context) {
        if (context && this._playbackContext && context.id === this._playbackContext.id) {
            this._playbackContext = null;
        }
    }

    handleSentenceReindex(previousSentences, nextSentences) {
        if (!Array.isArray(previousSentences) || !Array.isArray(nextSentences)) return;
        const remapIndex = (index) => {
            if (!Number.isInteger(index) || index < 0) return -1;
            const sentence = previousSentences[index];
            return sentence ? nextSentences.indexOf(sentence) : -1;
        };

        const context = this._playbackContext;
        if (context) {
            const nextIndex = remapIndex(context.sentenceIndex);
            if (nextIndex >= 0) context.sentenceIndex = nextIndex;
            if (context.gaplessTimer) {
                clearTimeout(context.gaplessTimer);
                context.gaplessTimer = null;
            }
        }

        if (this._preparedMediaBridge) {
            const nextPreparedIndex = remapIndex(this._preparedMediaBridge.sentenceIndex);
            if (nextPreparedIndex >= 0) this._preparedMediaBridge.sentenceIndex = nextPreparedIndex;
            else this._releasePreparedMediaBridge();
        }
    }

    _findPreparedNextSentenceIndex(finishedIndex) {
        const { state } = this.app;
        for (let index = finishedIndex + 1; index < state.sentences.length; index++) {
            const sentence = state.sentences[index];
            if (!sentence) continue;
            if (!sentence.layoutProcessed) return -1;
            if (!sentence.isTextToRead || !hasUsableSpeechText(this._extractSpeechText(sentence))) continue;
            return sentence.audioReady && sentence.audioBuffer && !sentence.audioError ? index : -1;
        }
        return -1;
    }

    async _handleSourceEnded(context, sentence, { overlap = false } = {}) {
        const { state } = this.app;
        const finishedIndex =
            typeof context?.sentenceIndex === "number" ? context.sentenceIndex : state.currentSentenceIndex;

        if (!this._isContextActive(context)) {
            return;
        }
        if (context.completionStarted) return;
        context.completionStarted = true;
        if (context.gaplessTimer) {
            clearTimeout(context.gaplessTimer);
            context.gaplessTimer = null;
        }

        this.clearWordBoundaryTimers(sentence);

        if (state.stopRequested) {
            this._invalidateContext(context);
            return;
        }

        if (state.autoHighlightEnabled) {
            this.app.highlightManager.saveCurrentSentenceHighlight();
        }

        state.isPlaying = false;
        state.playingSentenceIndex = -1;
        state.playingPhraseBlockKey = null;
        // During the desktop gapless handoff the outgoing element must be
        // allowed to play its final 20 ms while a second element starts.
        if (!overlap) this._pauseMediaBridge();
        this.app.pdfRenderer.updateHighlightFullDoc();

        const currentFinishedIndex = state.sentences.indexOf(sentence);
        let nextSentenceIndex =
            currentFinishedIndex >= 0 && currentFinishedIndex < state.sentences.length - 1
                ? currentFinishedIndex + 1
                : -1;
        if (state.autoAdvanceActive && state.currentDocumentType === "pdf") {
            try {
                nextSentenceIndex = await this.app.pdfLoader.getAdjacentSentenceIndex(sentence, 1);
            } catch (error) {
                console.warn("Unable to prepare the next PDF page", error);
                nextSentenceIndex = -1;
            }
        }
        const hasNextSentence = nextSentenceIndex >= 0;
        let nextSentence = hasNextSentence ? state.sentences[nextSentenceIndex] : null;

        if (!state.autoAdvanceActive || !hasNextSentence) {
            state.autoAdvanceActive = false;
            this._invalidateContext(context);
            this._setMediaSessionPlaybackState("paused");
            this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_END, { index: state.currentSentenceIndex });
            return;
        }

        if (!this._isContextActive(context) || state.stopRequested) {
            state.autoAdvanceActive = false;
            this._invalidateContext(context);
            this._setMediaSessionPlaybackState("paused");
            this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_END, { index: state.currentSentenceIndex });
            return;
        }

        // A reward interval may finish at the same time as this sentence. Wait
        // for that completion to be persisted and, when required, block TTS and
        // open the reflection dialog before starting the following sentence.
        await this.app.rewards?.handleReadingBoundary?.();
        if (!this._isContextActive(context) || state.stopRequested) return;

        let resolvedFinishedIndex = state.sentences.indexOf(sentence);
        if (resolvedFinishedIndex < 0) resolvedFinishedIndex = finishedIndex;
        nextSentenceIndex = nextSentence ? state.sentences.indexOf(nextSentence) : -1;
        if (nextSentenceIndex < 0 && state.currentDocumentType === "pdf") {
            nextSentenceIndex = await this.app.pdfLoader.getAdjacentSentenceIndex(sentence, 1);
            nextSentence = nextSentenceIndex >= 0 ? state.sentences[nextSentenceIndex] : null;
        }
        if (nextSentenceIndex < 0) {
            state.autoAdvanceActive = false;
            this._invalidateContext(context);
            this._setMediaSessionPlaybackState("paused");
            this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_END, { index: resolvedFinishedIndex });
            return;
        }

        // The next phrase is normally synthesized by prefetch. Start it before
        // canvas mounting, scrolling, and progress persistence so those UI tasks
        // cannot create an audible gap between HTML audio tracks.
        const preparedNextIndex = this._findPreparedNextSentenceIndex(resolvedFinishedIndex);
        if (preparedNextIndex >= 0 && !this._playbackBlocks.size) {
            state.currentSentenceIndex = preparedNextIndex;
            this._invalidateContext(context);
            await this.playCurrentSentence();
            Promise.resolve(
                this.app.pdfRenderer.renderSentence(preparedNextIndex, {
                    autoAdvance: true,
                    skipTTS: true,
                }),
            ).catch((error) => console.warn("Deferred auto-advance render failed", error));
            this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_END, { index: resolvedFinishedIndex });
            return;
        }

        try {
            await this.app.pdfRenderer.renderSentence(nextSentenceIndex, { autoAdvance: true });
        } catch (err) {
            console.warn("Auto-advance render failed", err);
            state.autoAdvanceActive = false;
            this._invalidateContext(context);
            this._setMediaSessionPlaybackState("paused");
            this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_END, { index: state.currentSentenceIndex });
            return;
        }

        const advancedSentence = state.sentences[state.currentSentenceIndex];
        this._invalidateContext(context);
        if (!state.generationEnabled || advancedSentence?.isTextToRead) {
            await this.playCurrentSentence();
        }
        this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_END, { index: state.currentSentenceIndex });
    }

    _setupMediaBridge() {
        if (typeof document === "undefined") return;

        this._mediaBridgeAudio = this._createMediaBridgeElement();

        // The first gesture may be the tap that opens a document rather than the
        // toolbar Play button. Unlock the same audio element in either case.
        const unlock = (event) =>
            this._primeMediaElementForUserGesture({
                keepAlive: !!event?.target?.closest?.("#play-toggle"),
            });
        document.addEventListener?.("pointerdown", unlock, { capture: true, once: true, passive: true });
        document.addEventListener?.("touchstart", unlock, { capture: true, once: true, passive: true });
    }

    _createMediaBridgeElement() {
        if (typeof document === "undefined") return null;

        const audio = document.createElement("audio");
        if (!this._mediaBridgeAudio) audio.id = "localreader-media-bridge";
        audio.preload = "auto";
        audio.setAttribute("aria-hidden", "true");
        audio.tabIndex = -1;
        audio.controls = false;
        audio.defaultMuted = false;
        audio.muted = false;
        audio.volume = 1;
        audio.setAttribute("playsinline", "");
        audio.style.display = "none";

        audio.addEventListener("play", () => {
            if (audio !== this._mediaBridgeAudio || this._mediaBridgeSyncing || this.app.state.isPlaying) return;
            this.playCurrentSentence().catch((error) => {
                console.warn("[MediaBridge] Failed to resume playback", error);
            });
        });

        audio.addEventListener("pause", () => {
            // Natural completion can emit `pause` immediately before `ended` in
            // WebKit. Let `onended` own auto-advance in that case.
            if (
                audio !== this._mediaBridgeAudio ||
                this._mediaBridgeSyncing ||
                audio.ended ||
                !this.app.state.isPlaying
            ) {
                return;
            }
            this.stopPlayback(true).catch((error) => {
                console.warn("[MediaBridge] Failed to pause playback", error);
            });
        });

        document.body?.appendChild(audio);
        return audio;
    }

    _primeMediaElementForUserGesture({ keepAlive = false } = {}) {
        const audio = this._mediaBridgeAudio;
        if (!audio || this._mediaUnlockPromise) return this._mediaUnlockPromise;
        if (this._mediaElementUnlocked && !keepAlive) return null;

        const blob = this._createSilentWavBlob(0.25);
        this._mediaBridgeSyncing = true;
        try {
            if (this._mediaBridgeObjectUrl) URL.revokeObjectURL(this._mediaBridgeObjectUrl);
            this._mediaBridgeObjectUrl = URL.createObjectURL(blob);
            audio.src = this._mediaBridgeObjectUrl;
            audio.currentTime = 0;
            audio.loop = !!keepAlive;
            audio.defaultMuted = false;
            audio.muted = false;
            audio.volume = 1;

            // Calling play before leaving this stack preserves the user activation.
            const playResult = audio.play();
            this._mediaUnlockPromise = Promise.resolve(playResult)
                .then(() => {
                    this._mediaElementUnlocked = true;
                    if (!keepAlive) {
                        audio.pause();
                        audio.currentTime = 0;
                    }
                })
                .catch((error) => {
                    console.debug("[HTMLAudio] User-gesture unlock failed", error);
                })
                .finally(() => {
                    this._mediaUnlockPromise = null;
                    this._mediaBridgeSyncing = false;
                });
            return this._mediaUnlockPromise;
        } catch (error) {
            this._mediaUnlockPromise = null;
            this._mediaBridgeSyncing = false;
            console.debug("[HTMLAudio] User-gesture unlock failed", error);
            return null;
        }
    }

    _setupMediaSession() {
        if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
        const setHandler = (action, handler) => {
            try {
                navigator.mediaSession.setActionHandler(action, handler);
            } catch {
                // Some browsers expose a partial Media Session implementation.
            }
        };

        setHandler("play", () => {
            this.playCurrentSentence().catch((error) => console.warn("[MediaSession] play failed", error));
        });
        setHandler("pause", () => {
            this.stopPlayback(true).catch((error) => console.warn("[MediaSession] pause failed", error));
        });
        setHandler("stop", () => {
            this.stopPlayback(true).catch((error) => console.warn("[MediaSession] stop failed", error));
        });
        setHandler("previoustrack", () => {
            this._skipSentenceFromMediaControl(-1).catch((error) => {
                console.warn("[MediaSession] previous failed", error);
            });
        });
        setHandler("nexttrack", () => {
            this._skipSentenceFromMediaControl(1).catch((error) => {
                console.warn("[MediaSession] next failed", error);
            });
        });
        setHandler("seekbackward", () => {
            this._skipSentenceFromMediaControl(-1).catch((error) => {
                console.warn("[MediaSession] seek backward failed", error);
            });
        });
        setHandler("seekforward", () => {
            this._skipSentenceFromMediaControl(1).catch((error) => {
                console.warn("[MediaSession] seek forward failed", error);
            });
        });
    }

    async _skipSentenceFromMediaControl(delta) {
        const { state } = this.app;
        if (!state?.sentences?.length) return;

        const wasPlaying = !!state.isPlaying || !!state.autoAdvanceActive;
        const nextIndex = Math.min(Math.max((state.currentSentenceIndex || 0) + delta, 0), state.sentences.length - 1);
        if (nextIndex === state.currentSentenceIndex) return;

        await this.stopPlayback(true);
        state.autoAdvanceActive = false;
        const renderer = this.app.getActiveRenderer?.();
        await renderer?.renderSentence?.(nextIndex);
        if (wasPlaying) await this.playCurrentSentence();
    }

    async _activateMediaBridge(sentence, context) {
        let audio = this._mediaBridgeAudio;
        if (!audio || !sentence?.audioBuffer) throw new Error("HTML audio player is unavailable");

        const prepared = this._preparedMediaBridge;
        const usePrepared = prepared?.sentenceIndex === this.app.state.currentSentenceIndex;

        // A single HTMLAudioElement cannot overlap two sources. On desktop,
        // retain the outgoing element for its final 20 ms and start the next
        // sentence on a fresh element.
        const outgoingAudio = audio.paused === false && !audio.ended && !isIOSLike();
        if (outgoingAudio || usePrepared) {
            const previousAudio = audio;
            this._overlappingMediaElements ||= new Set();
            if (outgoingAudio) this._overlappingMediaElements.add(previousAudio);
            audio = usePrepared ? prepared.audio : this._createMediaBridgeElement();
            if (!audio) throw new Error("Unable to create gapless HTML audio player");
            this._mediaBridgeAudio = audio;
            if (usePrepared) {
                this._preparedMediaBridge = null;
                if (!outgoingAudio) this._releaseOverlappingMediaElement(previousAudio);
            }
        }

        const blob = sentence.audioBlob || sentence.wavBlob || this._audioBufferToWavBlob(sentence.audioBuffer);
        if (!blob) throw new Error("Unable to prepare HTML audio playback");

        this._setMediaSessionMetadata(sentence);
        this._setMediaSessionPlaybackState("playing");

        await this._mediaUnlockPromise?.catch?.(() => {});
        this._mediaBridgeSyncing = true;
        try {
            if (!outgoingAudio && !usePrepared && this._mediaBridgeObjectUrl) {
                URL.revokeObjectURL(this._mediaBridgeObjectUrl);
                this._mediaBridgeObjectUrl = null;
            }

            this._mediaBridgeObjectUrl = usePrepared ? prepared.objectUrl : URL.createObjectURL(blob);
            if (!usePrepared) {
                audio._pocketReaderObjectUrl = this._mediaBridgeObjectUrl;
                audio.src = this._mediaBridgeObjectUrl;
            }
            audio.currentTime = 0;
            audio.loop = false;
            audio.defaultMuted = false;
            audio.muted = false;
            audio.volume = 1;
            audio.removeAttribute("muted");
            audio.onended = async () => {
                try {
                    await this._handleSourceEnded(context, sentence);
                } catch (error) {
                    console.warn("HTML audio completion failed", error);
                } finally {
                    if (audio !== this._mediaBridgeAudio) this._releaseOverlappingMediaElement(audio);
                }
            };
            await audio.play();
            this._scheduleGaplessHandoff(audio, context, sentence);
        } finally {
            this._mediaBridgeSyncing = false;
        }
    }

    _scheduleGaplessHandoff(audio, context, sentence) {
        if (isIOSLike() || !context || !audio) return;
        const duration = Number(sentence?.audioBuffer?.duration || audio.duration);
        if (!Number.isFinite(duration) || duration <= SENTENCE_OVERLAP_SECONDS) return;

        const finishedIndex = context.sentenceIndex;
        const nextIndex = this._findPreparedNextSentenceIndex(finishedIndex);
        if (nextIndex < 0) return;
        this._prepareNextMediaBridge(nextIndex);

        context.gaplessTimer = setTimeout(() => {
            context.gaplessTimer = null;
            if (
                !this._isContextActive(context) ||
                context.completionStarted ||
                this.app.state.stopRequested ||
                this._playbackBlocks.size ||
                this._findPreparedNextSentenceIndex(finishedIndex) < 0
            ) {
                return;
            }
            this._handleSourceEnded(context, sentence, { overlap: true }).catch((error) => {
                console.warn("Gapless HTML audio handoff failed", error);
            });
        }, Math.max(0, (duration - SENTENCE_OVERLAP_SECONDS) * 1000));
    }

    _prepareNextMediaBridge(sentenceIndex) {
        if (isIOSLike() || this._preparedMediaBridge?.sentenceIndex === sentenceIndex) return;
        this._releasePreparedMediaBridge();

        const sentence = this.app.state.sentences[sentenceIndex];
        const blob = sentence?.audioBlob || sentence?.wavBlob || this._audioBufferToWavBlob(sentence?.audioBuffer);
        const audio = blob ? this._createMediaBridgeElement() : null;
        if (!audio) return;

        const objectUrl = URL.createObjectURL(blob);
        audio._pocketReaderObjectUrl = objectUrl;
        audio.src = objectUrl;
        audio.preload = "auto";
        audio.load?.();
        this._preparedMediaBridge = { sentenceIndex, audio, objectUrl };
    }

    _releasePreparedMediaBridge() {
        const prepared = this._preparedMediaBridge;
        this._preparedMediaBridge = null;
        if (!prepared) return;
        try {
            prepared.audio.pause();
        } catch {}
        this._releaseOverlappingMediaElement(prepared.audio);
    }

    _releaseOverlappingMediaElement(audio) {
        if (!audio) return;
        this._overlappingMediaElements?.delete(audio);
        const objectUrl = audio._pocketReaderObjectUrl;
        audio.onended = null;
        audio.remove?.();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
    }

    _pauseMediaBridge() {
        const audio = this._mediaBridgeAudio;
        if (!audio) return;

        this._mediaBridgeSyncing = true;
        try {
            audio.onended = null;
            audio.pause();
            audio.currentTime = 0;
            for (const overlappingAudio of this._overlappingMediaElements || []) {
                try {
                    overlappingAudio.onended = null;
                    overlappingAudio.pause();
                } catch {}
                this._releaseOverlappingMediaElement(overlappingAudio);
            }
            this._releasePreparedMediaBridge();
        } catch {
            // ignore
        } finally {
            this._mediaBridgeSyncing = false;
        }
    }

    _setMediaSessionMetadata(sentence) {
        if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
        const { state } = this.app;
        const sentenceNumber = Number.isFinite(state?.currentSentenceIndex) ? state.currentSentenceIndex + 1 : null;
        const title = sentenceNumber ? `Sentence ${sentenceNumber}` : "Current sentence";
        const artworkSrc =
            typeof state?.bookCoverDataUrl === "string" && state.bookCoverDataUrl.startsWith("data:")
                ? state.bookCoverDataUrl
                : "./assets/icons/icon-512.png";

        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: "PocketReader",
                artist: "PocketReader",
                album: "Document Reader",
                artwork: [
                    {
                        src: artworkSrc,
                        sizes: "512x512",
                        type: artworkSrc.startsWith("data:") ? "image/*" : "image/png",
                    },
                ],
            });
        } catch {
            // ignore
        }
    }

    _setMediaSessionPlaybackState(value) {
        if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
        try {
            navigator.mediaSession.playbackState = value;
        } catch {
            // ignore
        }
    }

    _audioBufferToWavBlob(audioBuffer) {
        if (!audioBuffer) return null;

        const numChannels = audioBuffer.numberOfChannels || 1;
        const sampleRate = audioBuffer.sampleRate;
        const length = audioBuffer.length;
        const bytesPerSample = 2;
        const blockAlign = numChannels * bytesPerSample;
        const dataSize = length * blockAlign;
        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);

        const writeString = (offset, value) => {
            for (let i = 0; i < value.length; i++) {
                view.setUint8(offset + i, value.charCodeAt(i));
            }
        };

        writeString(0, "RIFF");
        view.setUint32(4, 36 + dataSize, true);
        writeString(8, "WAVE");
        writeString(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * blockAlign, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bytesPerSample * 8, true);
        writeString(36, "data");
        view.setUint32(40, dataSize, true);

        let offset = 44;
        const channels = Array.from({ length: numChannels }, (_, index) => audioBuffer.getChannelData(index));
        for (let i = 0; i < length; i++) {
            for (let channel = 0; channel < numChannels; channel++) {
                const sample = Math.max(-1, Math.min(1, channels[channel][i] || 0));
                view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
                offset += bytesPerSample;
            }
        }

        return new Blob([buffer], { type: "audio/wav" });
    }

    _createSilentWavBlob(durationSeconds = 0.25) {
        const sampleRate = 8000;
        const duration = Math.max(0.01, Number(durationSeconds) || 0.25);
        const length = Math.max(1, Math.ceil(duration * sampleRate));
        return this._audioBufferToWavBlob({
            numberOfChannels: 1,
            sampleRate,
            length,
            getChannelData: () => new Float32Array(length),
        });
    }

    setupWordBoundaryTimers(s) {
        const { state, config } = this.app;
        this.clearWordBoundaryTimers(s);
        if (!Array.isArray(s.playbackWordTimers)) {
            s.playbackWordTimers = [];
        }

        const phraseTimings = Array.isArray(s.ttsPhraseTimings) ? s.ttsPhraseTimings : [];
        if (state.currentDocumentType === "pdf" && phraseTimings.length > 1) {
            const setCurrentPhrase = (blockKey) => {
                state.playingPhraseBlockKey = blockKey || null;
                this.app.pdfRenderer?.updateHighlightFullDoc?.();
                this.app.eventBus?.emit?.(EVENTS.AUDIO_PHRASE_CHANGE, {
                    index: s.index ?? state.currentSentenceIndex,
                    blockKey: state.playingPhraseBlockKey,
                });
            };

            setCurrentPhrase(phraseTimings[0]?.blockKey || null);
            for (let i = 1; i < phraseTimings.length; i++) {
                const timing = phraseTimings[i];
                const id = setTimeout(
                    () => {
                        setCurrentPhrase(timing?.blockKey || null);
                    },
                    Math.max(0, timing?.offsetMs || 0),
                );
                s.playbackWordTimers.push(id);
            }
        } else {
            state.playingPhraseBlockKey = null;
        }

        if (!config.ENABLE_WORD_HIGHLIGHT || !s.wordBoundaries?.length) return;
        const liveWord = document.getElementById(config.LIVE_WORD_REGION_ID);
        for (const wb of s.wordBoundaries) {
            const id = setTimeout(() => {
                if (liveWord) liveWord.textContent = wb.text;
            }, wb.offsetMs);
            s.playbackWordTimers.push(id);
        }
    }
    clearWordBoundaryTimers(s) {
        if (!Array.isArray(s?.playbackWordTimers)) {
            if (s) s.playbackWordTimers = [];
            return;
        }
        for (const t of s.playbackWordTimers) clearTimeout(t);
        s.playbackWordTimers = [];
        if (this.app.state.playingSentenceIndex === s.index) {
            this.app.state.playingPhraseBlockKey = null;
        }
    }
}
