export const DOCUMENT_DB_VERSION = 3;
export const DOCUMENT_TRASH_STORE = "trash";

export function extractActualDocumentFilename(key) {
    const value = String(key || "");
    if (!value.startsWith("file::")) return value;
    return value.split("::")[1] || value;
}

export function createDocumentTrashId(key, docType = "pdf") {
    return `${docType === "epub" ? "epub" : "pdf"}::${String(key || "")}`;
}

export function createLocalTrashEntry({
    key,
    docType = "pdf",
    documentRecord,
    progressEntries = {},
    highlights = null,
    title = "",
    filename = "",
    pendingServerDelete = false,
    serverBacked = false,
    googleDriveBacked = false,
    deletedAt = new Date().toISOString(),
} = {}) {
    const format = docType === "epub" ? "epub" : "pdf";
    const trashId = createDocumentTrashId(key, format);
    const progress = progressEntries[`${format}::${key}`] || progressEntries[key] || null;
    const resolvedFilename =
        String(filename || documentRecord?.name || extractActualDocumentFilename(key) || "Untitled").trim() ||
        "Untitled";
    return {
        trashId,
        storageKey: key,
        filename: resolvedFilename,
        title: String(title || progress?.title || resolvedFilename).trim() || resolvedFilename,
        format,
        deletedAt,
        size: Number(documentRecord?.blob?.size ?? documentRecord?.size ?? 0) || 0,
        document: documentRecord,
        progressEntries,
        highlights,
        pendingServerDelete: !!pendingServerDelete,
        serverBacked: !!serverBacked,
        googleDriveBacked: !!googleDriveBacked,
    };
}

export class ProgressManager {
    constructor(app) {
        this.app = app;
    }

    _progressKey(docType, key) {
        return `${docType}::${key}`;
    }

    getProgressMap() {
        const { config } = this.app;
        try {
            return JSON.parse(localStorage.getItem(config.PROGRESS_STORAGE_KEY) || "{}");
        } catch {
            return {};
        }
    }

    setProgressMap(map) {
        const { config } = this.app;
        try {
            localStorage.setItem(config.PROGRESS_STORAGE_KEY, JSON.stringify(map));
        } catch (e) {
            console.warn("Failed to write progress map:", e);
        }
    }

    loadSavedPosition(key, docType = "pdf") {
        if (!key) return null;
        const map = this.getProgressMap();
        const compoundKey = this._progressKey(docType, key);
        if (compoundKey in map) {
            return map[compoundKey];
        }

        if (docType === "pdf" && key in map) {
            return map[key];
        }
        return null;
    }

    canSyncCurrentPosition() {
        const { state } = this.app;
        if (state.currentDocumentType !== "pdf") return true;
        const currentPage = Number(state.currentSentence?.pageNumber);
        if (!Number.isInteger(currentPage) || currentPage < 1) return false;
        if (!(state.parsedPdfPages instanceof Set)) return false;
        for (let pageNumber = 1; pageNumber <= currentPage; pageNumber++) {
            if (!state.parsedPdfPages.has(pageNumber)) return false;
        }
        return true;
    }

    saveProgress() {
        const { state } = this.app;
        if (!state.sentences.length || state.currentSentenceIndex < 0) return;

        const docType = state.currentDocumentType === "epub" ? "epub" : "pdf";
        const storageKey = docType === "epub" ? state.currentEpubKey : state.currentPdfKey;
        if (!storageKey) return;

        const map = this.getProgressMap();
        const compoundKey = this._progressKey(docType, storageKey);
        const existingEntry = map[compoundKey] || {};

        let coverData = null;
        if (docType === "epub") {
            if (typeof state.bookCoverDataUrl === "string" && state.bookCoverDataUrl.startsWith("data:")) {
                coverData = state.bookCoverDataUrl;
            } else if (typeof state.bookCover === "string" && state.bookCover.startsWith("data:")) {
                coverData = state.bookCover;
            } else if (typeof existingEntry.cover === "string" && existingEntry.cover.startsWith("data:")) {
                coverData = existingEntry.cover;
            }
        }

        map[compoundKey] = {
            ...existingEntry,
            sentenceIndex: state.currentSentenceIndex,
            totalSentences: state.sentences.length,
            ...(docType === "pdf"
                ? {
                      currentPage: Number.isFinite(state.currentSentence?.pageNumber)
                          ? state.currentSentence.pageNumber
                          : 0,
                      pageSentenceIndex: Number.isFinite(state.currentSentence?.pageSentenceIndex)
                          ? state.currentSentence.pageSentenceIndex
                          : 0,
                      totalPages: Number.isFinite(state.pdf?.numPages) ? state.pdf.numPages : 0,
                  }
                : {}),
            updated: Date.now(),
            voice: state.currentPiperVoice,
            title: state.bookTitle || existingEntry.title || null,
            cover: coverData,
            docType,
        };
        if (docType === "pdf" && storageKey in map) {
            delete map[storageKey];
        }
        this.setProgressMap(map);

        // Sync to server if enabled
        if (this.app.serverSync?.isEnabled()) {
            const fileId = docType === "epub" ? state.currentEpubKey : state.currentPdfKey;
            if (fileId && this.canSyncCurrentPosition()) {
                this.app.serverSync.queuePositionSync(fileId, state.currentSentenceIndex);
            }
            if (fileId && state.currentPiperVoice) this.app.serverSync.queueVoiceSync(fileId, state.currentPiperVoice);
        }
    }

    listSavedProgress() {
        return this.getProgressMap();
    }

    clearPdfProgress(key) {
        this.clearDocumentProgress("pdf", key);
    }

    clearEpubProgress(key) {
        this.clearDocumentProgress("epub", key);
    }

    clearDocumentProgress(docType, key) {
        if (!key) return;
        const map = this.getProgressMap();
        const compoundKey = this._progressKey(docType, key);
        let modified = false;
        if (compoundKey in map) {
            delete map[compoundKey];
            modified = true;
        }
        if (docType === "pdf" && key in map) {
            delete map[key];
            modified = true;
        }
        if (modified) {
            this.setProgressMap(map);
        }
    }

    async _openDb() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open("PDFStorage", DOCUMENT_DB_VERSION);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains("pdfs")) {
                    db.createObjectStore("pdfs");
                }
                if (!db.objectStoreNames.contains("epubs")) {
                    db.createObjectStore("epubs");
                }
                if (!db.objectStoreNames.contains(DOCUMENT_TRASH_STORE)) {
                    db.createObjectStore(DOCUMENT_TRASH_STORE);
                }
            };
            request.onsuccess = (event) => resolve(event.target.result);
            request.onerror = () => reject(request.error);
        });
    }

    async savePdfToIndexedDB(file, key) {
        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("pdfs", "readwrite");
            const store = tx.objectStore("pdfs");
            store.put({ blob: file, name: file.name }, key);
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => {
                const { error } = tx;
                db.close();
                reject(error);
            };
        });
    }

    async loadPdfFromIndexedDB(key) {
        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("pdfs", "readonly");
            const store = tx.objectStore("pdfs");
            const getRequest = store.get(key);
            getRequest.onsuccess = () => {
                db.close();
                resolve(getRequest.result);
            };
            getRequest.onerror = () => {
                db.close();
                reject(getRequest.error);
            };
        });
    }

    async removePdfFromIndexedDB(key) {
        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("pdfs", "readwrite");
            const store = tx.objectStore("pdfs");
            const deleteRequest = store.delete(key);
            deleteRequest.onsuccess = () => {
                db.close();
                resolve();
            };
            deleteRequest.onerror = () => {
                db.close();
                reject(deleteRequest.error);
            };
        });
    }

    async loadPdfOrFile(file, pdfKey) {
        if (!file) return null;

        let pdfBlob = await this.loadPdfFromIndexedDB(pdfKey);
        if (pdfBlob) {
            this.app.ui.showInfo("PDF loaded from IndexedDB");
        } else {
            this.app.ui.showInfo("Pdf not found in IndexedDB, saving new file...");
            pdfBlob = file;
            await this.savePdfToIndexedDB(file, pdfKey);
        }
        return pdfBlob;
    }

    async listSavedPDFs() {
        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("pdfs", "readonly");
            const store = tx.objectStore("pdfs");
            const keysRequest = store.getAllKeys();
            keysRequest.onsuccess = () => {
                db.close();
                resolve(keysRequest.result);
            };
            keysRequest.onerror = () => {
                db.close();
                reject(keysRequest.error);
            };
        });
    }

    async clearPDFCache() {
        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("pdfs", "readwrite");
            const store = tx.objectStore("pdfs");
            const clearRequest = store.clear();
            clearRequest.onsuccess = () => {
                db.close();
                resolve();
            };
            clearRequest.onerror = () => {
                db.close();
                reject(clearRequest.error);
            };
        });
    }

    async saveEpubToIndexedDB(file, key) {
        let coverDataUrl = null;
        if (file instanceof Blob) {
            try {
                coverDataUrl = await this._extractEpubCoverDataUrl(file);
            } catch (error) {
                console.debug("[ProgressManager] Unable to extract EPUB cover", error);
            }
        }

        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("epubs", "readwrite");
            const store = tx.objectStore("epubs");
            const payload = {
                blob: file,
                name: file?.name || key,
                size: file?.size ?? null,
                lastModified: file?.lastModified ?? Date.now(),
                cover: coverDataUrl,
            };
            store.put(payload, key);
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => {
                const { error } = tx;
                db.close();
                reject(error);
            };
        });
    }

    async loadEpubFromIndexedDB(key) {
        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("epubs", "readonly");
            const store = tx.objectStore("epubs");
            const getRequest = store.get(key);
            getRequest.onsuccess = () => {
                const record = getRequest.result;
                db.close();
                this._postProcessEpubRecord(key, record).then(resolve).catch(reject);
            };
            getRequest.onerror = () => {
                db.close();
                reject(getRequest.error);
            };
        });
    }

    async removeEpubFromIndexedDB(key) {
        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("epubs", "readwrite");
            const store = tx.objectStore("epubs");
            const deleteRequest = store.delete(key);
            deleteRequest.onsuccess = () => {
                db.close();
                resolve();
            };
            deleteRequest.onerror = () => {
                db.close();
                reject(deleteRequest.error);
            };
        });
    }

    _captureProgressEntries(key, docType) {
        const progressMap = this.getProgressMap();
        const entries = {};
        const compoundKey = this._progressKey(docType, key);
        if (Object.hasOwn(progressMap, compoundKey)) entries[compoundKey] = progressMap[compoundKey];
        if (docType === "pdf" && Object.hasOwn(progressMap, key)) entries[key] = progressMap[key];
        return entries;
    }

    _captureHighlights(key) {
        const highlightsMap = this.app.highlightsStorage?.getHighlightsMap?.() || {};
        return Object.hasOwn(highlightsMap, key) ? highlightsMap[key] : null;
    }

    _removeDocumentState(key, docType) {
        this.clearDocumentProgress(docType, key);
        this.app.highlightsStorage?.clearPdfHighlights?.(key);
    }

    _restoreDocumentState(entry) {
        const progressEntries = entry?.progressEntries;
        if (progressEntries && typeof progressEntries === "object") {
            this.setProgressMap({ ...this.getProgressMap(), ...progressEntries });
        }

        if (entry && Object.hasOwn(entry, "highlights") && entry.highlights !== null) {
            const highlightsMap = this.app.highlightsStorage?.getHighlightsMap?.() || {};
            highlightsMap[entry.storageKey] = entry.highlights;
            this.app.highlightsStorage?.setHighlightsMap?.(highlightsMap);
        }
    }

    /**
     * Atomically move a stored PDF/EPUB payload into IndexedDB trash. Reading
     * progress and highlights are copied into the same trash record. Their
     * active localStorage entries are removed after the IndexedDB commit.
     */
    async moveDocumentToTrash(key, docType = "pdf", metadata = {}) {
        if (!key) throw new Error("A document key is required");
        const format = docType === "epub" ? "epub" : "pdf";
        const trashId = createDocumentTrashId(key, format);
        const sourceStoreName = format === "epub" ? "epubs" : "pdfs";
        const progressEntries = this._captureProgressEntries(key, format);
        const highlights = this._captureHighlights(key);
        const db = await this._openDb();

        const entry = await new Promise((resolve, reject) => {
            const tx = db.transaction([sourceStoreName, DOCUMENT_TRASH_STORE], "readwrite");
            const sourceStore = tx.objectStore(sourceStoreName);
            const trashStore = tx.objectStore(DOCUMENT_TRASH_STORE);
            const getRequest = sourceStore.get(key);
            let nextEntry = null;
            let missing = false;

            getRequest.onsuccess = () => {
                if (!getRequest.result) {
                    const existingRequest = trashStore.get(trashId);
                    existingRequest.onsuccess = () => {
                        if (existingRequest.result) {
                            nextEntry = {
                                ...existingRequest.result,
                                serverBacked: !!(existingRequest.result.serverBacked || metadata.serverBacked),
                                googleDriveBacked: !!(
                                    existingRequest.result.googleDriveBacked || metadata.googleDriveBacked
                                ),
                                pendingServerDelete:
                                    metadata.pendingServerDelete === undefined
                                        ? !!existingRequest.result.pendingServerDelete
                                        : !!metadata.pendingServerDelete,
                            };
                            trashStore.put(nextEntry, trashId);
                        }
                        else {
                            missing = true;
                            tx.abort();
                        }
                    };
                    return;
                }
                nextEntry = createLocalTrashEntry({
                    key,
                    docType: format,
                    documentRecord: getRequest.result,
                    progressEntries,
                    highlights,
                    title: metadata.title,
                    filename: metadata.filename,
                    pendingServerDelete: metadata.pendingServerDelete,
                    serverBacked: metadata.serverBacked,
                    googleDriveBacked: metadata.googleDriveBacked,
                });
                trashStore.put(nextEntry, trashId);
                sourceStore.delete(key);
            };
            tx.oncomplete = () => {
                db.close();
                resolve(nextEntry);
            };
            tx.onerror = () => {
                const error = tx.error;
                db.close();
                reject(error);
            };
            tx.onabort = () => {
                const error = missing ? new Error("The local document could not be found") : tx.error;
                db.close();
                reject(error);
            };
        });

        this._removeDocumentState(key, format);
        return entry;
    }

    async listTrashDocuments() {
        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(DOCUMENT_TRASH_STORE, "readonly");
            const request = tx.objectStore(DOCUMENT_TRASH_STORE).getAll();
            request.onsuccess = () => {
                db.close();
                resolve(Array.isArray(request.result) ? request.result : []);
            };
            request.onerror = () => {
                const error = request.error;
                db.close();
                reject(error);
            };
        });
    }

    async restoreDocumentFromTrash(trashId) {
        if (!trashId) throw new Error("A trash id is required");
        const db = await this._openDb();
        const entry = await new Promise((resolve, reject) => {
            const tx = db.transaction(["pdfs", "epubs", DOCUMENT_TRASH_STORE], "readwrite");
            const trashStore = tx.objectStore(DOCUMENT_TRASH_STORE);
            const getRequest = trashStore.get(trashId);
            let restored = null;
            let missing = false;

            getRequest.onsuccess = () => {
                restored = getRequest.result;
                if (!restored?.document) {
                    missing = true;
                    tx.abort();
                    return;
                }
                const destination = restored.format === "epub" ? "epubs" : "pdfs";
                tx.objectStore(destination).put(restored.document, restored.storageKey);
                trashStore.delete(trashId);
            };
            tx.oncomplete = () => {
                db.close();
                resolve(restored);
            };
            tx.onerror = () => {
                const error = tx.error;
                db.close();
                reject(error);
            };
            tx.onabort = () => {
                const error = missing ? new Error("The trashed document could not be found") : tx.error;
                db.close();
                reject(error);
            };
        });
        this._restoreDocumentState(entry);
        return entry;
    }

    async deleteTrashDocument(trashId) {
        if (!trashId) return;
        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(DOCUMENT_TRASH_STORE, "readwrite");
            tx.objectStore(DOCUMENT_TRASH_STORE).delete(trashId);
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => {
                const error = tx.error;
                db.close();
                reject(error);
            };
        });
    }

    async updateTrashDocument(trashId, changes = {}) {
        if (!trashId) throw new Error("A trash id is required");
        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(DOCUMENT_TRASH_STORE, "readwrite");
            const store = tx.objectStore(DOCUMENT_TRASH_STORE);
            const request = store.get(trashId);
            let updated = null;
            request.onsuccess = () => {
                if (!request.result) return;
                updated = { ...request.result, ...changes, trashId };
                store.put(updated, trashId);
            };
            tx.oncomplete = () => {
                db.close();
                resolve(updated);
            };
            tx.onerror = () => {
                const error = tx.error;
                db.close();
                reject(error);
            };
        });
    }

    async emptyTrash() {
        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(DOCUMENT_TRASH_STORE, "readwrite");
            tx.objectStore(DOCUMENT_TRASH_STORE).clear();
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => {
                const error = tx.error;
                db.close();
                reject(error);
            };
        });
    }

    async updateEpubCover(key, coverDataUrl) {
        if (!key || !coverDataUrl) return;

        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("epubs", "readwrite");
            const store = tx.objectStore("epubs");
            const getRequest = store.get(key);

            getRequest.onsuccess = () => {
                const record = getRequest.result;
                if (!record) {
                    return;
                }
                if (record.cover === coverDataUrl) {
                    return;
                }
                record.cover = coverDataUrl;
                store.put(record, key);
            };

            getRequest.onerror = () => {
                db.close();
                reject(getRequest.error);
            };

            tx.oncomplete = () => {
                db.close();
                resolve();
            };

            tx.onerror = () => {
                db.close();
                reject(tx.error);
            };
        });
    }

    _blobToDataURL(blob, fallbackType) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                resolve(reader.result);
            };
            reader.onerror = () => {
                reject(reader.error);
            };
            if (fallbackType) {
                const newBlob = blob.slice(0, blob.size, fallbackType);
                reader.readAsDataURL(newBlob);
            }
            else {
                reader.readAsDataURL(blob);
            }
        });
    }

    async convertBlobToDataURL(blob, fallbackType) {
        if (!(blob instanceof Blob)) return null;
        return this._blobToDataURL(blob, fallbackType);
    }

    async _postProcessEpubRecord(key, record) {
        if (!record) return null;
        if (!record.cover && record.blob instanceof Blob) {
            try {
                const coverDataUrl = await this._extractEpubCoverDataUrl(record.blob);
                if (coverDataUrl) {
                    record.cover = coverDataUrl;
                    await this.updateEpubCover(key, coverDataUrl);
                }
            } catch (error) {
                console.debug("[ProgressManager] Unable to derive cover for stored EPUB", error);
            }
        }
        return record;
    }

    async _extractEpubCoverDataUrl(file) {
        return null;
    }

    async listSavedEPUBs() {
        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("epubs", "readonly");
            const store = tx.objectStore("epubs");
            const keysRequest = store.getAllKeys();
            keysRequest.onsuccess = () => {
                db.close();
                resolve(keysRequest.result);
            };
            keysRequest.onerror = () => {
                db.close();
                reject(keysRequest.error);
            };
        });
    }

    async clearEPUBCache() {
        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("epubs", "readwrite");
            const store = tx.objectStore("epubs");
            const clearRequest = store.clear();
            clearRequest.onsuccess = () => {
                db.close();
                resolve();
            };
            clearRequest.onerror = () => {
                db.close();
                reject(clearRequest.error);
            };
        });
    }
}
