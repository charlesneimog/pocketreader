/**
 * PDFThumbnailCache - Manages PDF thumbnail rendering and caching
 *
 * Provides high-performance thumbnail generation for saved PDFs with:
 * - Progressive rendering using requestIdleCallback
 * - Canvas reuse from PDFRenderer pool
 * - High-resolution rendering for crisp thumbnails
 * - Error handling and retry mechanisms
 */

export function calculatePdfReadingPercentage(currentPage, totalPages) {
    const page = Number(currentPage);
    const total = Number(totalPages);
    if (!Number.isFinite(page) || !Number.isFinite(total) || total <= 0 || page <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((page / total) * 100)));
}

export class PDFThumbnailCache {
    constructor(app) {
        this.app = app;
        this.width = 200;
        this.height = 250;
        this.proportionWidthHeight = this.width / this.height;

        // Thumbnail configuration
        this.config = {
            cardWidth: 250,
            displayWidth: this.width,
            displayHeight: this.height,
            placeholderWidth: this.width,
            placeholderHeight: this.height,
            qualityMultiplier: 2, // Extra sharpness multiplier
        };

        // Active render queue
        this.renderQueue = [];
        this.isProcessingQueue = false;

        this.header = document.getElementById("previous-pdf-header");
        this.container = document.getElementById("previous-pdf-container");
        this.overlay = document.getElementById("pdf-previous-list");
        this.noPdfOverlay = document.getElementById("no-pdf-overlay");

        // iOS Safari can lack requestIdleCallback or provide limited IdleDeadline.
        // Provide a safe fallback so thumbnails/titles/sizes always render.
        const g = globalThis;
        this._requestIdle =
            typeof g.requestIdleCallback === "function"
                ? (cb, opts) => g.requestIdleCallback(cb, opts)
                : (cb, _opts) => g.setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 50 }), 1);
        this._cancelIdle =
            typeof g.cancelIdleCallback === "function" ? (id) => g.cancelIdleCallback(id) : (id) => g.clearTimeout(id);
        this._idleHandle = null;

        this._serverPresenceRefreshInFlight = null;
        this._isSmartphoneDevice = null;
    }

    _extractActualFilename(key) {
        if (typeof key !== "string") return "";
        if (!key.startsWith("file::")) return key;
        const parts = key.split("::");
        return parts.length >= 2 ? parts[1] : key;
    }

    _setServerBadge(cardElement, show) {
        if (!cardElement) return;
        const existing = cardElement.querySelector('[data-server-badge="true"]');
        if (!show) {
            if (existing) existing.remove();
            return;
        }
        if (existing) return;

        // Ensure absolute positioning is relative to the card.
        if (!cardElement.style.position) {
            cardElement.style.position = "relative";
        }

        const badge = document.createElement("span");
        badge.dataset.serverBadge = "true";
        badge.className = "absolute z-10 p-1 material-symbols-outlined text-primary dark:text-primary !text-lg pointer-events-none";
        // Use inline positioning to avoid relying on Tailwind utilities being present in output.css.
        badge.style.top = "6px";
        badge.style.left = "6px";
        badge.title = "Synced remotely";
        badge.setAttribute("aria-label", "Synced remotely");
        badge.textContent = "cloud";

        cardElement.appendChild(badge);
    }

    async _refreshServerBadges() {
        const serverSync = this.app?.serverSync;
        const container = this.container;
        if (!serverSync?.isEnabled?.() || !container) return;

        // Coalesce concurrent refreshes.
        if (this._serverPresenceRefreshInFlight) return;
        this._serverPresenceRefreshInFlight = (async () => {
            try {
                const serverFiles = await serverSync.listRemoteFiles();

                const actualOnServer = new Set();
                for (const f of serverFiles) {
                    if (!f || f.deleted) continue;
                    const name = this._extractActualFilename(f.filename);
                    if (name) actualOnServer.add(name);
                }

                for (const child of Array.from(container.children || [])) {
                    const key = child?.dataset?.docKey;
                    const actual = this._extractActualFilename(key);
                    this._setServerBadge(child, !!actual && actualOnServer.has(actual));
                }
            } catch (e) {
                // No auth / offline / server unreachable; just omit badges.
            } finally {
                this._serverPresenceRefreshInFlight = null;
            }
        })();
    }

    _scheduleIdle(cb, timeout = 2000) {
        // Cancel any prior scheduled callback to avoid piling up on slow devices.
        if (this._idleHandle != null) {
            this._cancelIdle(this._idleHandle);
            this._idleHandle = null;
        }
        this._idleHandle = this._requestIdle(cb, { timeout });
    }

    _timeRemaining(deadline) {
        try {
            if (deadline && typeof deadline.timeRemaining === "function") {
                const remaining = deadline.timeRemaining();
                return Number.isFinite(remaining) ? remaining : 0;
            }
        } catch {
            // ignore
        }
        // Fallback budget (~one frame)
        return 16;
    }

    /**
     * Show saved PDFs with progressive thumbnail loading
     */
    async showSavedPDFs() {
        if (this.header) this.header.classList.remove("hidden");

        if (this.container) this.container.innerHTML = ""; // Clear previous content

        try {
            const serverSync = this.app?.serverSync;
            if (serverSync?.isEnabled?.()) {
                await serverSync.pullServerStateUpdates?.();
            }
        } catch {
            // Library rendering should still work offline or when auth expires.
        }

        const [savedPDFs, savedEPUBs] = await Promise.all([
            this.app.progressManager.listSavedPDFs(),
            this.app.progressManager.listSavedEPUBs(),
        ]);

        // Sort thumbnails by most recently opened document.
        // Progress entries are stored under compound keys like "pdf::${key}" / "epub::${key}".
        // PDFs may also have legacy entries keyed directly by `key`.
        const progressMap =
            typeof this.app.progressManager.getProgressMap === "function"
                ? this.app.progressManager.getProgressMap()
                : this.app.progressManager.listSavedProgress?.() || {};

        const getUpdated = (docType, key) => {
            if (!key) return 0;
            const compoundKey = `${docType}::${key}`;
            const entry = progressMap?.[compoundKey] || (docType === "pdf" ? progressMap?.[key] : null);
            const updated = entry?.updated;
            return Number.isFinite(updated) ? updated : 0;
        };

        const documents = [
            ...savedPDFs.map((key) => ({ key, docType: "pdf", updated: getUpdated("pdf", key) })),
            ...savedEPUBs.map((key) => ({ key, docType: "epub", updated: getUpdated("epub", key) })),
        ].sort((a, b) => {
            const diff = (b.updated || 0) - (a.updated || 0);
            if (diff) return diff;
            // Stable fallback: group by type then key.
            const typeDiff = String(a.docType).localeCompare(String(b.docType));
            if (typeDiff) return typeDiff;
            return String(a.key).localeCompare(String(b.key));
        });

        if (!documents.length) {
            if (this.overlay) this.overlay.classList.add("hidden");
            if (this.header) this.header.classList.add("hidden");
            if (this.noPdfOverlay) this.noPdfOverlay.classList.remove("hidden");
            return;
        }

        if (this.overlay) this.overlay.classList.remove("hidden");
        if (this.noPdfOverlay) this.noPdfOverlay.classList.add("hidden");

        this.renderQueue = documents.map((entry, index) => ({ ...entry, index }));

        for (const entry of documents) {
            const card = this.createPlaceholderCard(entry);
            if (this.container) this.container.appendChild(card);
        }

        // Best-effort: show a small cloud badge for files present on server.
        this._refreshServerBadges();
        this.startProgressiveRendering(this.container);
    }

    startProgressiveRendering(container) {
        if (this.isProcessingQueue) return;

        this.isProcessingQueue = true;

        const renderBatch = async (deadline) => {
            // Always process at least one item per batch; on some browsers timeRemaining() can be 0.
            let processed = 0;
            while (this.renderQueue.length > 0) {
                const remaining = this._timeRemaining(deadline);
                if (processed > 0 && remaining <= 0) break;

                const { key, docType, index } = this.renderQueue.shift();
                try {
                    if (container && container.children[index]) {
                        if (docType === "pdf") {
                            await this.renderPdfCard(key, container.children[index]);
                        } else if (docType === "epub") {
                            await this.renderEpubCard(key, container.children[index]);
                        }
                    }
                } catch (error) {
                    console.warn(`[PDFThumbnailCache] Failed to render card for ${docType}:${key}:`, error);
                    if (this.container && this.container.children[index]) {
                        this.markCardAsError(this.container.children[index], key, docType);
                    }
                }

                processed++;
            }

            // Continue processing remaining items
            if (this.renderQueue.length > 0) {
                this._scheduleIdle(renderBatch, 2000);
            } else {
                this.isProcessingQueue = false;
                this._idleHandle = null;
            }
        };

        this._scheduleIdle(renderBatch, 2000);
    }

    createPlaceholderCard({ key, docType }) {
        const card = document.createElement("div");
        card.className =
            "flex flex-col items-center gap-1 p-1 bg-white dark:bg-slate-800 rounded-md shadow-sm border border-slate-200 dark:border-slate-700 relative cursor-pointer min-w-0 box-border";
        card.dataset.docKey = key;
        card.dataset.docType = docType;

        // Thumbnail placeholder with loading animation
        const thumbDiv = document.createElement("div");
        thumbDiv.className = `lr-document-thumbnail lr-${docType}-thumbnail w-full rounded-md flex items-center justify-center bg-slate-100 dark:bg-slate-700`;
        thumbDiv.style.width = "100%";
        thumbDiv.style.aspectRatio = `${this.width} / ${this.height}`;
        const iconName = docType === "epub" ? "menu_book" : "description";
        thumbDiv.innerHTML = `
            <span class="material-symbols-outlined text-4xl text-slate-400 animate-pulse">${iconName}</span>
        `;
        card.appendChild(thumbDiv);

        // Title placeholder
        const title = document.createElement("p");
        title.textContent = "Loading...";
        title.className = "text-xs font-medium truncate text-center max-w-full px-1 text-slate-400";
        card.appendChild(title);

        // Size placeholder
        const size = document.createElement("p");
        size.textContent = "-- MB";
        size.className = "text-[9px] text-text-secondary dark:text-slate-400 text-center";
        card.appendChild(size);

        return card;
    }

    async renderPdfCard(pdfKey, cardElement) {
        const pdfData = await this.app.progressManager.loadPdfFromIndexedDB(pdfKey);
        if (!pdfData) {
            throw new Error(`No PDF data found for key: ${pdfKey}`);
        }

        const pdfBlob = pdfData.blob;
        const pdfName = pdfData.name || pdfKey;

        // Load PDF and render first page thumbnail
        const arrayBuffer = await pdfBlob.arrayBuffer();
        const pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
        const page = await pdfDoc.getPage(1);

        // Calculate scale for high-quality rendering
        const devicePixelRatio = window.devicePixelRatio || 1;
        const pageViewport = page.getViewport({ scale: 1 });

        const baseScale = this.config.displayWidth / pageViewport.width;
        const renderScale = baseScale * devicePixelRatio * this.config.qualityMultiplier;

        const viewport = page.getViewport({ scale: renderScale });

        // Reuse canvas from renderer's pool if available
        const canvas = this.app.pdfRenderer?.acquireCanvas?.() || document.createElement("canvas");
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        canvas.className = "lr-pdf-thumbnail-canvas rounded-md";

        // Set display size (CSS) smaller than render size for crisp rendering
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.objectFit = "contain";
        canvas.style.objectPosition = "top center";

        const context = canvas.getContext("2d", {
            alpha: false, // Opaque rendering is faster
            desynchronized: true,
        });

        context.save();
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.restore();

        await page.render({ canvasContext: context, viewport }).promise;

        this.populatePdfCard(cardElement, canvas, pdfBlob, pdfName, pdfKey, pdfDoc.numPages);

        // Setup cleanup observer
        this.setupCanvasCleanup(cardElement, canvas);
    }

    populatePdfCard(cardElement, canvas, pdfBlob, pdfName, pdfKey, totalPages) {
        // Update card styling
        cardElement.className =
            "group flex flex-col items-center gap-1 p-1 bg-white dark:bg-slate-800 rounded-md shadow-sm hover:shadow-md border border-slate-200 dark:border-slate-700 relative cursor-pointer min-w-0 box-border transition-shadow duration-200";

        // Replace placeholder thumbnail with actual canvas
        const thumbDiv = cardElement.querySelector("div");
        thumbDiv.className =
            "lr-document-thumbnail lr-pdf-thumbnail w-full rounded-md flex justify-center overflow-hidden bg-slate-50 dark:bg-slate-900";
        thumbDiv.style.width = "100%";
        thumbDiv.style.aspectRatio = `${this.width} / ${this.height}`;
        thumbDiv.innerHTML = "";
        thumbDiv.appendChild(canvas);
        thumbDiv.setAttribute("data-alt", `Page 1 of ${pdfName}`);

        // Update title
        const title = cardElement.querySelector("p:nth-of-type(1)");
        title.textContent = pdfName;
        title.className = "text-xs font-medium truncate text-center max-w-full px-1 text-slate-800 dark:text-slate-200";
        title.title = pdfName; // Tooltip for long names

        // Update size
        const size = cardElement.querySelector("p:nth-of-type(2)");
        const sizeMB = (pdfBlob.size / (1024 * 1024)).toFixed(1);
        size.textContent = `${sizeMB} MB`;
        size.className = "text-[9px] text-text-secondary dark:text-slate-400 text-center";

        const saved = this.app.progressManager.loadSavedPosition(pdfKey, "pdf");
        const progressPercent = calculatePdfReadingPercentage(saved?.currentPage, totalPages);
        let progressLabel = cardElement.querySelector("p[data-progress]");
        if (!progressLabel) {
            progressLabel = document.createElement("p");
            progressLabel.dataset.progress = "true";
            progressLabel.className = "text-[9px] text-primary dark:text-primary text-center";
            cardElement.appendChild(progressLabel);
        }
        progressLabel.textContent = `Progress: ${progressPercent}%`;
        progressLabel.title = saved?.currentPage
            ? `Page ${Math.min(saved.currentPage, totalPages)} of ${totalPages}`
            : `${totalPages} pages`;

        // Add close button (visible on hover)
        this.addCloseButton(cardElement, pdfKey, pdfName, canvas, "pdf");

        // Add click handler to open PDF (pass key to avoid duplicate IndexedDB entries)
        this.addOpenHandler(cardElement, pdfBlob, pdfName, canvas, "pdf", pdfKey);
    }

    async renderEpubCard(epubKey, cardElement) {
        const epubData = await this.app.progressManager.loadEpubFromIndexedDB(epubKey);
        if (!epubData) {
            throw new Error(`No EPUB data found for key: ${epubKey}`);
        }

        const epubBlob = epubData.blob;
        const epubName = epubData.name || epubKey;
        const coverDataUrl = epubData.cover || null;

        this.populateEpubCard(cardElement, epubBlob, epubName, epubKey, coverDataUrl);
    }

    populateEpubCard(cardElement, epubBlob, epubName, epubKey, coverDataUrl) {
        const saved = this.app.progressManager.loadSavedPosition(epubKey, "epub");
        const coverFromProgress =
            typeof saved?.cover === "string" && saved.cover.startsWith("data:") ? saved.cover : null;
        const effectiveCover = coverDataUrl || coverFromProgress;

        cardElement.className =
            "group flex flex-col items-center gap-1 p-1 bg-white dark:bg-slate-800 rounded-md shadow-sm hover:shadow-md border border-slate-200 dark:border-slate-700 relative cursor-pointer min-w-0 box-border transition-shadow duration-200";

        const thumbDiv = cardElement.querySelector("div");
        thumbDiv.className =
            "lr-document-thumbnail lr-epub-thumbnail w-full rounded-md flex items-center justify-center overflow-hidden bg-slate-100 dark:bg-slate-900";
        thumbDiv.style.width = "100%";
        thumbDiv.style.aspectRatio = `${this.width} / ${this.height}`;

        const applyFallbackIcon = () => {
            thumbDiv.innerHTML = `
                <span class="material-symbols-outlined text-5xl text-slate-400 dark:text-slate-500">menu_book</span>
            `;
        };

        if (effectiveCover) {
            thumbDiv.innerHTML = "";
            const img = document.createElement("img");
            img.src = effectiveCover;
            img.alt = `${epubName} cover`;
            img.loading = "lazy";
            img.className = "w-full h-full object-cover";
            img.onerror = applyFallbackIcon;
            thumbDiv.appendChild(img);
        } else {
            applyFallbackIcon();
        }

        const title = cardElement.querySelector("p:nth-of-type(1)");
        const displayTitle = typeof saved?.title === "string" && saved.title.trim() ? saved.title.trim() : epubName;
        title.textContent = displayTitle;
        title.className = "text-xs font-medium truncate text-center max-w-full px-1 text-slate-800 dark:text-slate-200";
        title.title = displayTitle;

        const size = cardElement.querySelector("p:nth-of-type(2)");
        const sizeMB = epubBlob?.size ? (epubBlob.size / (1024 * 1024)).toFixed(1) : "--";
        size.textContent = `${sizeMB} MB`;
        size.className = "text-[9px] text-text-secondary dark:text-slate-400 text-center";

        if (saved && typeof saved.sentenceIndex === "number" && typeof saved.totalSentences === "number") {
            const progressRatio = saved.totalSentences > 0 ? saved.sentenceIndex / saved.totalSentences : 0;
            const progressPercent = Math.max(0, Math.min(100, Math.round(progressRatio * 100)));
            let progressLabel = cardElement.querySelector("p[data-progress]");
            if (!progressLabel) {
                progressLabel = document.createElement("p");
                progressLabel.dataset.progress = "true";
                progressLabel.className = "text-[9px] text-primary dark:text-primary text-center";
                cardElement.appendChild(progressLabel);
            }
            progressLabel.textContent = `Progress: ${progressPercent}%`;
        }

        this.addCloseButton(cardElement, epubKey, epubName, null, "epub");
        this.addOpenHandler(cardElement, epubBlob, epubName, null, "epub", epubKey);
    }

    /**
     * Add close button to card
     */
    addCloseButton(cardElement, pdfKey, pdfName, canvas, docType = "pdf") {
        const closeBtn = document.createElement("button");
        // closeBtn.className =
        //     "absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-full bg-slate-200/80 dark:bg-slate-900/80 hover:bg-slate-300 dark:hover:bg-slate-700";
        closeBtn.className =
            "absolute top-1 right-1 flex items-center justify-center w-6 h-6 rounded-lg bg-slate-200/80 dark:bg-slate-900/80 hover:bg-slate-300 dark:hover:bg-slate-700 transition-opacity opacity-0 group-hover:opacity-100";

        closeBtn.innerHTML = `<span class="material-symbols-outlined text-text-secondary dark:text-slate-400 !text-sm">close</span>`;
        closeBtn.setAttribute("aria-label", `Move ${pdfName} to Trash`);

        closeBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            await this.deleteCardDocument(cardElement, pdfKey, pdfName, canvas, docType);
        });

        cardElement.appendChild(closeBtn);
        this.addSmartphoneLongPressDelete(cardElement, pdfKey, pdfName, canvas, docType);
    }

    async deleteCardDocument(cardElement, pdfKey, pdfName, canvas, docType = "pdf") {
        if (cardElement?.dataset?.deleting === "true") return;

        const syncManager = this.app.serverSync;
        const googleDriveSelected = syncManager?.getBackend?.() === "google-drive";
        const selfHostedTrashAvailable = !!syncManager?.isServerTrashAvailable?.();
        const selfHostedServerConfigured =
            !googleDriveSelected && !!syncManager?.hasSelfHostedServerConfigured?.();
        let pendingServerDelete = false;

        const prompt = googleDriveSelected
            ? `Move "${pdfName}" to Trash on this device and delete its Google Drive copy?`
            : `Move "${pdfName}" to Trash?`;
        if (!confirm(prompt)) return;

        if (cardElement?.dataset) cardElement.dataset.deleting = "true";

        // Delete/soft-delete the selected remote copy first. Keeping the local
        // copy active when a remote mutation fails prevents the next sync from
        // unexpectedly undoing the user's action.
        if (googleDriveSelected) {
            if (!syncManager?.isEnabled?.()) {
                this.app.ui?.showInfo?.("Reconnect Google Drive before deleting this file");
                if (cardElement?.dataset) delete cardElement.dataset.deleting;
                return;
            }

            this.app.ui?.showInfo?.(`Deleting from Google Drive: ${pdfName}`);
            let deletedRemotely = false;
            try {
                deletedRemotely = await syncManager.deleteFileOnServer(pdfKey);
            } catch (error) {
                console.warn("[PDFThumbnailCache] Google Drive deletion failed", error);
            }
            if (!deletedRemotely) {
                this.app.ui?.showInfo?.(`Google Drive deletion failed: ${pdfName}`);
                if (cardElement?.dataset) delete cardElement.dataset.deleting;
                return;
            }
        }

        if (selfHostedServerConfigured) {
            if (selfHostedTrashAvailable) {
                const ok = await syncManager.deleteFileOnServer(pdfKey);
                pendingServerDelete = !ok;
                if (!ok) console.warn("[PDFThumbnailCache] Server Trash move queued", { key: pdfKey });
            } else {
                pendingServerDelete = true;
            }
        }

        try {
            await this.app.progressManager.moveDocumentToTrash(pdfKey, docType, {
                title: pdfName,
                filename: pdfName,
                pendingServerDelete,
                serverBacked: selfHostedServerConfigured,
                googleDriveBacked: googleDriveSelected,
            });
        } catch (error) {
            console.warn("[PDFThumbnailCache] Failed to move local file to Trash", error);
            this.app.ui?.showInfo?.(`Could not move to Trash: ${pdfName}`);
            if (cardElement?.dataset) delete cardElement.dataset.deleting;
            return;
        }

        this.app.ui?.showInfo?.(
            googleDriveSelected
                ? `Moved to device Trash and deleted from Google Drive: ${pdfName}`
                : pendingServerDelete
                  ? `Moved to device Trash; server move queued: ${pdfName}`
                  : selfHostedServerConfigured
                    ? `Moved to Trash: ${pdfName}`
                  : `Moved to Trash on this device: ${pdfName}`,
        );

        // Animate removal
        cardElement.style.transition = "opacity 200ms, transform 200ms";
        cardElement.style.opacity = "0";
        cardElement.style.transform = "scale(0.95)";

        setTimeout(() => {
            cardElement.remove();

            // Return canvas to pool
            if (canvas && this.app.pdfRenderer?.releaseCanvas) {
                this.app.pdfRenderer.releaseCanvas(canvas);
            }

            // Check if no PDFs left
            this.checkIfEmpty();
        }, 200);
    }

    isSmartphoneDevice() {
        if (this._isSmartphoneDevice !== null) return this._isSmartphoneDevice;
        const ua = navigator.userAgent || "";
        const phoneUserAgent = /Mobi|Android.*Mobile|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
        const narrowTouch =
            window.matchMedia?.("(pointer: coarse)")?.matches &&
            window.matchMedia?.("(max-width: 767px)")?.matches;
        this._isSmartphoneDevice = phoneUserAgent || narrowTouch;
        return this._isSmartphoneDevice;
    }

    addSmartphoneLongPressDelete(cardElement, pdfKey, pdfName, canvas, docType = "pdf") {
        if (!cardElement || cardElement.dataset.longPressDeleteReady === "true" || !this.isSmartphoneDevice()) return;
        cardElement.dataset.longPressDeleteReady = "true";

        const LONG_PRESS_MS = 650;
        const MOVE_CANCEL_PX = 12;
        let timer = null;
        let startX = 0;
        let startY = 0;
        let longPressTriggered = false;

        const clearTimer = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        };

        const skipOnlyImmediateClick = () => {
            cardElement.dataset.skipNextOpen = "true";
            setTimeout(() => {
                if (cardElement.dataset.skipNextOpen === "true") {
                    delete cardElement.dataset.skipNextOpen;
                }
            }, 1000);
        };

        const cancel = () => {
            clearTimer();
        };

        cardElement.addEventListener("pointerdown", (e) => {
            if (e.pointerType !== "touch" || e.target?.closest?.("button")) return;

            startX = e.clientX;
            startY = e.clientY;
            longPressTriggered = false;

            clearTimer();
            timer = setTimeout(async () => {
                timer = null;
                longPressTriggered = true;
                skipOnlyImmediateClick();
                await this.deleteCardDocument(cardElement, pdfKey, pdfName, canvas, docType);
            }, LONG_PRESS_MS);
        });

        cardElement.addEventListener("pointermove", (e) => {
            if (!timer) return;
            const dx = Math.abs(e.clientX - startX);
            const dy = Math.abs(e.clientY - startY);
            if (dx > MOVE_CANCEL_PX || dy > MOVE_CANCEL_PX) cancel();
        });

        cardElement.addEventListener("pointerup", () => {
            cancel();
            if (longPressTriggered) skipOnlyImmediateClick();
        });

        cardElement.addEventListener("pointercancel", cancel);
        cardElement.addEventListener("pointerleave", cancel);
        cardElement.addEventListener("contextmenu", (e) => {
            if (!this.isSmartphoneDevice()) return;
            e.preventDefault();
        });
    }

    /**
     * Add click handler to open PDF
     */
    addOpenHandler(cardElement, pdfBlob, pdfName, canvas, docType = "pdf", storageKey = null) {
        cardElement.addEventListener("click", async () => {
            if (cardElement.dataset.skipNextOpen === "true") {
                delete cardElement.dataset.skipNextOpen;
                return;
            }

            try {
                await this.app.controlsManager?.requestSmartphoneReaderLock?.();
                this.app.ui?.beginBookLoading?.("Loading book and AI models…");

                let loadResult = null;
                if (docType === "epub") {
                    const epubFile =
                        pdfBlob instanceof File
                            ? pdfBlob
                            : new File([pdfBlob], pdfName, { type: pdfBlob.type || "application/epub+zip" });

                    loadResult = await this.app.loadEPUB(epubFile, { resume: true, existingKey: storageKey });
                } else {
                    const pdfFile =
                        pdfBlob instanceof File
                            ? pdfBlob
                            : new File([pdfBlob], pdfName, { type: pdfBlob.type || "application/pdf" });

                    loadResult = await this.app.loadPDF(pdfFile, { resume: true, existingKey: storageKey });
                }
                if (loadResult === null) {
                    return;
                }

                // Hide overlay after successful load
                const overlay = this.overlay;
                const header = this.header;
                if (overlay) overlay.classList.add("hidden");
                if (header) header.classList.add("hidden");
                if (this.noPdfOverlay) this.noPdfOverlay.classList.add("hidden");

                // Return canvas to pool
                if (canvas && this.app.pdfRenderer?.releaseCanvas) {
                    this.app.pdfRenderer.releaseCanvas(canvas);
                }
            } catch (error) {
                this.app.cancelBookOpenPlaybackTimer?.("book opening failed");
                const docLabel = docType === "epub" ? "EPUB" : "PDF";
                console.error(`[PDFThumbnailCache] Failed to load ${docLabel} ${pdfName}:`, error);
                this.app.ui?.showInfo?.(`Failed to load ${docLabel}: ${error.message}`);
            } finally {
                this.app.ui?.finishBookLoading?.();
            }
        });
    }

    /**
     * Setup canvas cleanup observer
     */
    setupCanvasCleanup(cardElement, canvas) {
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.removedNodes) {
                    if (node === cardElement) {
                        if (this.app.pdfRenderer?.releaseCanvas) {
                            this.app.pdfRenderer.releaseCanvas(canvas);
                        }
                        observer.disconnect();
                    }
                }
            }
        });

        const container = document.getElementById("previous-pdf-container");
        if (container) {
            observer.observe(container, { childList: true });
        }
    }

    /**
     * Mark card as error state with retry option
     */
    markCardAsError(cardElement, pdfKey) {
        const thumbDiv = cardElement.querySelector("div");
        if (thumbDiv) {
            thumbDiv.innerHTML = '<span class="material-symbols-outlined text-4xl text-red-400">error</span>';
        }

        const title = cardElement.querySelector("p:nth-of-type(1)");
        if (title) {
            title.textContent = "Failed to load";
            title.className = "text-xs font-medium truncate text-center max-w-full px-1 text-red-500 dark:text-red-400";
        }

        // Add retry button
        const retryBtn = document.createElement("button");
        retryBtn.className = "text-xs text-primary hover:underline mt-1";
        retryBtn.textContent = "Retry";
        retryBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            try {
                await this.renderCard(pdfKey, cardElement);
            } catch (err) {
                console.error(`[PDFThumbnailCache] Retry failed for ${pdfKey}:`, err);
            }
        });
        cardElement.appendChild(retryBtn);
    }

    /**
     * Check if container is empty and update UI accordingly
     */
    checkIfEmpty() {
        const container = document.getElementById("previous-pdf-container");
        if (container && container.children.length === 0) {
            const overlay = document.getElementById("pdf-previous-list");
            const noPdfOverlay = document.getElementById("no-pdf-overlay");
            if (overlay) overlay.classList.add("hidden");
            if (noPdfOverlay) noPdfOverlay.classList.remove("hidden");
        }
    }

    /**
     * Clear render queue (call when unmounting)
     */
    clearQueue() {
        this.renderQueue = [];
        this.isProcessingQueue = false;
    }

    /**
     * Update configuration
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
    }
}
