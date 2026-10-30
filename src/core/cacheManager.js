export class CacheManager {
    constructor(state) {
        this.state = state;
    }

    clearAll() {
        for (const canvas of this.state.fullPageRenderCache.values()) {
            canvas?.remove?.();
            // Force WebKit to discard the canvas backing store immediately.
            if (canvas) {
                canvas.width = 0;
                canvas.height = 0;
            }
        }
        this.state.pagesCache.clear();
        this.state.viewportDisplayByPage.clear();
        this.state.fullPageRenderCache.clear();
        this.state.audioCache.clear();
        this.state.pdfSentencesByPage?.clear?.();
        this.state.parsedPdfPages?.clear?.();
        this.state.pdfPageParsePromises?.clear?.();
        if (this.state.chapterCache?.clear) this.state.chapterCache.clear();
        if (this.state.prefetchedChapters?.clear) this.state.prefetchedChapters.clear();
    }
    clearAllAudioCache() {
        this.state.audioCache.clear();
        for (let i = 0; i < this.state.sentences.length; i++) {
            const s = this.state.sentences[i];
            if (!s) continue;
            s.audioBlob = null;
            s.wavBlob = null;
            s.audioBuffer = null;
            s.audioReady = false;
            s.audioError = null;
            s.audioInProgress = false;
            s.prefetchQueued = false;
            s.lastVoice = null;
            s.lastSpeed = null;
            s.normalizedText = null;
            s.wordBoundaries = [];
            s.ttsPhraseTimings = [];
            s.playbackWordTimers = [];
        }
    }

    clearAudioFrom(index) {
        for (let i = index; i < this.state.sentences.length; i++) {
            const s = this.state.sentences[i];
            if (!s) continue;
            s.audioBlob = null;
            s.wavBlob = null;
            s.audioBuffer = null;
            s.audioReady = false;
            s.audioError = null;
            s.audioInProgress = false;
            s.prefetchQueued = false;
            s.lastVoice = null;
            s.lastSpeed = null;
            s.normalizedText = null;
            s.wordBoundaries = [];
            s.ttsPhraseTimings = [];
            s.playbackWordTimers = [];
        }
    }
}
