const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_NAME = "PocketReader";
const SESSION_TOKEN_KEY = "pocketreader.googleDriveSession";
const REWARDS_RECORD_ID = "__reading_rewards__";

export class GoogleDriveSync {
    constructor(app) {
        this.app = app;
        this.accessToken = "";
        this.tokenExpiresAt = 0;
        this.tokenClient = null;
        this.folderId = "";
        this.records = new Map();
        this.indexLoaded = false;
        this.isSyncing = false;
        this.lastSyncTime = 0;
        this.autoSyncListeners = [];
        this.positionTimers = new Map();
        this.voiceTimers = new Map();
        this.mutationQueue = Promise.resolve();
        this.rewardsTimer = null;
        this._restoreSessionToken();
    }

    getClientId() { return String(this.app.config?.GOOGLE_DRIVE_CLIENT_ID || "").trim(); }
    isConnected() {
        const connected = !!this.accessToken && Date.now() < this.tokenExpiresAt;
        if (!connected && this.accessToken) {
            this.accessToken = "";
            this.tokenExpiresAt = 0;
            this._clearSessionToken();
        }
        return connected;
    }
    isEnabled() { return this.isConnected(); }

    _restoreSessionToken() {
        try {
            if (typeof sessionStorage === "undefined") return;
            const saved = JSON.parse(sessionStorage.getItem(SESSION_TOKEN_KEY) || "null");
            const expiresAt = Number(saved?.expiresAt || 0);
            if (typeof saved?.accessToken === "string" && saved.accessToken && expiresAt > Date.now()) {
                this.accessToken = saved.accessToken;
                this.tokenExpiresAt = expiresAt;
            } else {
                sessionStorage.removeItem(SESSION_TOKEN_KEY);
            }
        } catch {
            this.accessToken = "";
            this.tokenExpiresAt = 0;
        }
    }

    _saveSessionToken() {
        try {
            if (typeof sessionStorage === "undefined") return;
            sessionStorage.setItem(
                SESSION_TOKEN_KEY,
                JSON.stringify({ accessToken: this.accessToken, expiresAt: this.tokenExpiresAt }),
            );
        } catch {
            // Private browsing or storage policy can disable sessionStorage.
        }
    }

    _clearSessionToken() {
        try {
            if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(SESSION_TOKEN_KEY);
        } catch {
            // ignore storage policy failures
        }
    }

    async _loadIdentityLibrary() {
        if (globalThis.google?.accounts?.oauth2) return;
        await new Promise((resolve, reject) => {
            const existing = document.querySelector('script[data-pocketreader-google-identity="true"]');
            if (existing) {
                existing.addEventListener("load", resolve, { once: true });
                existing.addEventListener("error", reject, { once: true });
                return;
            }
            const script = document.createElement("script");
            script.src = "https://accounts.google.com/gsi/client";
            script.async = true;
            script.defer = true;
            script.dataset.pocketreaderGoogleIdentity = "true";
            script.onload = resolve;
            script.onerror = () => reject(new Error("Unable to load Google Identity Services"));
            document.head.appendChild(script);
        });
    }

    async connect() {
        if (!this.getClientId()) throw new Error("Google Drive is not configured by the app owner");
        await this._loadIdentityLibrary();
        return await new Promise((resolve, reject) => {
            this.tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: this.getClientId(),
                scope: DRIVE_SCOPE,
                callback: async (response) => {
                    if (response?.error || !response?.access_token) {
                        reject(new Error(response?.error_description || response?.error || "Google authorization failed"));
                        return;
                    }
                    this.accessToken = response.access_token;
                    const expiresIn = Math.max(60, Number(response.expires_in) || 3600);
                    this.tokenExpiresAt = Date.now() + (expiresIn - 30) * 1000;
                    this._saveSessionToken();
                    localStorage.setItem("config.googleDriveAuthorized", "1");
                    try {
                        await this._ensureFolder();
                        this.indexLoaded = false;
                        await this.syncFromServer();
                        if (this.app.state?.currentDocumentType) await this.syncAll();
                        this.startAutoSync();
                        resolve(true);
                    } catch (error) { reject(error); }
                },
                error_callback: (error) => reject(new Error(error?.message || error?.type || "Google authorization closed")),
            });
            const prompt = localStorage.getItem("config.googleDriveAuthorized") === "1" ? "" : "consent";
            this.tokenClient.requestAccessToken({ prompt });
        });
    }

    disconnect({ revoke = false, forget = true } = {}) {
        const token = this.accessToken;
        this.stopAutoSync();
        this.accessToken = "";
        this.tokenExpiresAt = 0;
        this._clearSessionToken();
        this.folderId = "";
        this.records.clear();
        this.indexLoaded = false;
        if (forget) localStorage.removeItem("config.googleDriveAuthorized");
        if (revoke && token && globalThis.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {});
    }

    async _request(url, options = {}) {
        if (!this.isConnected()) throw new Error("Google Drive authorization expired. Connect again.");
        const headers = new Headers(options.headers || {});
        headers.set("Authorization", `Bearer ${this.accessToken}`);
        const response = await fetch(url, { ...options, headers });
        if (response.status === 401) {
            this.disconnect({ forget: false });
            throw new Error("Google Drive authorization expired. Connect again.");
        }
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            const error = new Error(data?.error?.message || `Google Drive request failed (${response.status})`);
            error.status = response.status;
            throw error;
        }
        return response;
    }

    _escapeQuery(value) { return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }

    async _ensureFolder() {
        if (this.folderId) return this.folderId;
        const q = encodeURIComponent(`name='${this._escapeQuery(FOLDER_NAME)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
        const response = await this._request(`${DRIVE_API}/files?q=${q}&spaces=drive&fields=files(id,name)&pageSize=10`);
        const data = await response.json();
        if (data.files?.[0]?.id) this.folderId = data.files[0].id;
        if (!this.folderId) {
            const created = await this._request(`${DRIVE_API}/files?fields=id`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
            });
            this.folderId = (await created.json()).id;
        }
        return this.folderId;
    }

    async _listFolderFiles() {
        const folderId = await this._ensureFolder();
        const files = [];
        let pageToken = "";
        do {
            const q = encodeURIComponent(`'${this._escapeQuery(folderId)}' in parents and trashed=false`);
            const token = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
            const response = await this._request(`${DRIVE_API}/files?q=${q}&spaces=drive&fields=nextPageToken,files(id,name,mimeType,modifiedTime,size,appProperties)&pageSize=1000${token}`);
            const data = await response.json();
            files.push(...(data.files || []));
            pageToken = data.nextPageToken || "";
        } while (pageToken);
        return files;
    }

    async _download(driveId) { return await this._request(`${DRIVE_API}/files/${encodeURIComponent(driveId)}?alt=media`); }

    async _loadIndex({ force = false } = {}) {
        if (this.indexLoaded && !force) return this.records;
        this.records.clear();
        const files = await this._listFolderFiles();
        for (const file of files.filter((item) => item.appProperties?.pocketReaderKind === "metadata")) {
            try {
                const response = await this._download(file.id);
                const record = await response.json();
                if (record?.fileId) this.records.set(record.fileId, { ...record, metadataDriveId: file.id });
            } catch (error) { console.warn("[GoogleDriveSync] Invalid metadata file", file.name, error); }
        }
        this.indexLoaded = true;
        return this.records;
    }

    async _multipartUpload(metadata, content, driveId = "") {
        const boundary = `pocketreader_${crypto.randomUUID().replace(/-/g, "")}`;
        const body = new Blob([
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`, JSON.stringify(metadata),
            `\r\n--${boundary}\r\nContent-Type: ${content.type || "application/octet-stream"}\r\n\r\n`, content,
            `\r\n--${boundary}--`,
        ]);
        const url = driveId
            ? `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(driveId)}?uploadType=multipart&fields=id,modifiedTime`
            : `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,modifiedTime`;
        const response = await this._request(url, {
            method: driveId ? "PATCH" : "POST",
            headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
        });
        return await response.json();
    }

    async _createContentFile(metadata, content) {
        if (content.size <= 5 * 1024 * 1024) return await this._multipartUpload(metadata, content);
        const session = await this._request(`${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=id,modifiedTime`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json; charset=UTF-8",
                "X-Upload-Content-Type": content.type || "application/octet-stream",
                "X-Upload-Content-Length": String(content.size),
            },
            body: JSON.stringify(metadata),
        });
        const uploadUrl = session.headers.get("Location");
        if (!uploadUrl) throw new Error("Google Drive did not return a resumable upload URL");
        const uploaded = await this._request(uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": content.type || "application/octet-stream" },
            body: content,
        });
        return await uploaded.json();
    }

    async _saveRecord(record) {
        const folderId = await this._ensureFolder();
        const safeName = (record.actualFilename || "document").replace(/[\\/]/g, "_");
        const metadata = { name: `.${safeName}.pocketreader.json`, mimeType: "application/json", appProperties: { pocketReaderKind: "metadata", pocketReaderVersion: "1" } };
        if (!record.metadataDriveId) metadata.parents = [folderId];
        const serializable = { ...record };
        delete serializable.metadataDriveId;
        const uploaded = await this._multipartUpload(metadata, new Blob([JSON.stringify(serializable)], { type: "application/json" }), record.metadataDriveId || "");
        record.metadataDriveId = uploaded.id;
        this.records.set(record.fileId, record);
        return record;
    }

    _actualFilename(fileId) {
        if (!String(fileId).startsWith("file::")) return String(fileId);
        return String(fileId).split("::")[1] || String(fileId);
    }

    async listRemoteFiles() {
        await this._loadIndex({ force: true });
        return [...this.records.values()].map((r) => ({ filename: r.fileId, title: r.title, format: r.format, deleted: !!r.deleted, reading_position: r.position, voice: r.voice, translation_target: r.translationTarget, translation_mode: r.translationMode, updated_at: r.updatedAt, position_updated_at: r.positionUpdatedAt, highlights_updated_at: r.highlightsUpdatedAt }));
    }

    _relativeFileKey(file) {
        return String(file?.webkitRelativePath || file?.name || "")
            .replace(/\\/g, "/")
            .replace(/^\/+/, "");
    }

    async importConvertedFolder(fileList) {
        if (!this.isEnabled()) throw new Error("Connect Google Drive before importing");

        const selectedFiles = [...(fileList || [])];
        const metadataFiles = selectedFiles.filter((file) => /\.pocketreader\.json$/i.test(file.name));
        if (!metadataFiles.length) {
            throw new Error("No .pocketreader.json files found. Select one exported owner folder.");
        }

        const documentsByPath = new Map();
        const documentsByName = new Map();
        for (const file of selectedFiles.filter((item) => /\.(pdf|epub)$/i.test(item.name))) {
            const relativePath = this._relativeFileKey(file);
            documentsByPath.set(relativePath, file);
            const sameName = documentsByName.get(file.name) || [];
            sameName.push(file);
            documentsByName.set(file.name, sameName);
        }

        await this._loadIndex({ force: true });
        const folderFiles = await this._listFolderFiles();
        const availableDocuments = folderFiles.filter((file) => {
            const kind = file.appProperties?.pocketReaderKind;
            return kind === "document" || (!kind && /\.(pdf|epub)$/i.test(file.name));
        });
        const availableMetadata = folderFiles.filter((file) => {
            const kind = file.appProperties?.pocketReaderKind;
            return kind === "metadata" || (!kind && /\.pocketreader\.json$/i.test(file.name));
        });

        let importedCount = 0;
        let adoptedCount = 0;
        for (const [index, metadataFile] of metadataFiles.entries()) {
            let imported;
            try {
                imported = JSON.parse(await metadataFile.text());
            } catch {
                throw new Error(`Invalid metadata JSON: ${metadataFile.name}`);
            }

            const actualFilename = String(imported?.actualFilename || "").trim();
            const fileId = String(imported?.fileId || "").trim();
            if (!actualFilename || !fileId) {
                throw new Error(`Metadata is missing fileId or actualFilename: ${metadataFile.name}`);
            }

            const metadataPath = this._relativeFileKey(metadataFile);
            const slash = metadataPath.lastIndexOf("/");
            const directory = slash >= 0 ? metadataPath.slice(0, slash + 1) : "";
            const exactDocument = documentsByPath.get(`${directory}${actualFilename}`);
            const nameMatches = documentsByName.get(actualFilename) || [];
            const documentFile = exactDocument || (nameMatches.length === 1 ? nameMatches[0] : null);
            if (!documentFile) throw new Error(`Document not found beside ${metadataFile.name}: ${actualFilename}`);

            this.app.ui?.showInfo?.(
                `Google Drive import ${index + 1}/${metadataFiles.length} — ${actualFilename}`,
            );

            const existing = this.records.get(fileId);
            let documentDriveId = existing?.documentDriveId || null;
            if (!documentDriveId) {
                const candidate = availableDocuments.find(
                    (file) => file.name === actualFilename && ![...this.records.values()].some((record) => record.documentDriveId === file.id),
                );
                if (candidate) {
                    try {
                        await this._request(`${DRIVE_API}/files/${encodeURIComponent(candidate.id)}?fields=id`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ appProperties: { pocketReaderKind: "document", pocketReaderVersion: "1" } }),
                        });
                        documentDriveId = candidate.id;
                        adoptedCount++;
                    } catch (error) {
                        if (![403, 404].includes(error?.status)) throw error;
                    }
                }
                if (!documentDriveId) {
                    const uploaded = await this._createContentFile({
                        name: actualFilename,
                        parents: [await this._ensureFolder()],
                        appProperties: { pocketReaderKind: "document", pocketReaderVersion: "1" },
                    }, documentFile);
                    documentDriveId = uploaded.id;
                }
            }

            const format = String(imported.format).toLowerCase() === "epub" ? "epub" : "pdf";
            const record = {
                ...imported,
                version: 1,
                fileId,
                actualFilename,
                format,
                documentDriveId,
                deleted: false,
                metadataDriveId: existing?.metadataDriveId || null,
            };
            if (!record.metadataDriveId) {
                const metadataCandidate = availableMetadata.find(
                    (file) => file.name === metadataFile.name && ![...this.records.values()].some((item) => item.metadataDriveId === file.id),
                );
                if (metadataCandidate) record.metadataDriveId = metadataCandidate.id;
            }
            try {
                await this._saveRecord(record);
            } catch (error) {
                if (!record.metadataDriveId || ![403, 404].includes(error?.status)) throw error;
                record.metadataDriveId = null;
                await this._saveRecord(record);
            }
            if (format === "epub") await this.app.progressManager.saveEpubToIndexedDB(documentFile, fileId);
            else await this.app.progressManager.savePdfToIndexedDB(documentFile, fileId);
            importedCount++;
        }

        await this.syncFromServer({ showProgress: false });
        const adoptedMessage = adoptedCount ? `; ${adoptedCount} existing Drive file${adoptedCount === 1 ? "" : "s"} adopted` : "";
        this.app.ui?.showInfo?.(`Google Drive import complete: ${importedCount} file${importedCount === 1 ? "" : "s"}${adoptedMessage}`);
        return { importedCount, adoptedCount };
    }

    async _record(fileId, { create = false, format = "pdf" } = {}) {
        await this._loadIndex();
        let record = this.records.get(fileId);
        if (!record) {
            const actualFilename = this._actualFilename(fileId);
            record = [...this.records.values()].find(
                (item) => !item.deleted && item.actualFilename === actualFilename && item.format === format,
            );
        }
        if (!record && create) {
            const now = new Date().toISOString();
            record = { version: 1, fileId, actualFilename: this._actualFilename(fileId), format, title: this.app.state.bookTitle || this._actualFilename(fileId), position: 0, voice: null, translationTarget: null, translationMode: null, highlights: [], documentDriveId: null, deleted: false, createdAt: now, updatedAt: now };
        }
        return record || null;
    }

    async ensureFileOnServer() {
        if (!this.isEnabled()) return false;
        const state = this.app.state;
        const format = state.currentDocumentType === "epub" ? "epub" : "pdf";
        const fileId = format === "epub" ? state.currentEpubKey : state.currentPdfKey;
        if (!fileId) return false;
        const record = await this._record(fileId, { create: true, format });
        if (record.documentDriveId && !record.deleted) return true;
        const stored = format === "epub" ? await this.app.progressManager.loadEpubFromIndexedDB(fileId) : await this.app.progressManager.loadPdfFromIndexedDB(fileId);
        const blob = stored?.blob || (format === "pdf" ? state.currentPdfDescriptor?.fileObject : null);
        if (!(blob instanceof Blob)) return false;
        this.app.ui?.showInfo?.(`Google Drive: uploading ${this._actualFilename(fileId)}...`);
        const uploaded = await this._createContentFile({ name: this._actualFilename(fileId), parents: [await this._ensureFolder()], appProperties: { pocketReaderKind: "document", pocketReaderVersion: "1" } }, blob);
        record.documentDriveId = uploaded.id;
        record.deleted = false;
        record.updatedAt = new Date().toISOString();
        await this._saveRecord(record);
        this.app.ui?.showInfo?.(`Google Drive: uploaded ${this._actualFilename(fileId)}`);
        return true;
    }

    _updateRecord(fileId, update) {
        const operation = this.mutationQueue
            .catch(() => {})
            .then(() => this._updateRecordNow(fileId, update));
        this.mutationQueue = operation;
        return operation;
    }

    async _updateRecordNow(fileId, update) {
        let record = await this._record(fileId);
        if (!record) { await this.ensureFileOnServer(); record = await this._record(fileId); }
        if (!record) return false;
        if (record.metadataDriveId) {
            const metadataDriveId = record.metadataDriveId;
            const response = await this._download(metadataDriveId);
            const remote = await response.json();
            record = { ...record, ...remote, metadataDriveId };
        }
        Object.assign(record, update, { updatedAt: new Date().toISOString() });
        await this._saveRecord(record);
        return true;
    }

    queuePositionSync(fileId, position, { debounceMs = 900 } = {}) {
        if (!this.isEnabled() || !fileId || !Number.isFinite(position)) return;
        clearTimeout(this.positionTimers.get(fileId));
        this.positionTimers.set(fileId, setTimeout(() => this.syncPosition(fileId, position).catch(console.warn), debounceMs));
    }
    queueVoiceSync(fileId, voice, { debounceMs = 900 } = {}) {
        if (!this.isEnabled() || !fileId || !voice) return;
        clearTimeout(this.voiceTimers.get(fileId));
        this.voiceTimers.set(fileId, setTimeout(() => this.syncVoice(fileId, voice).catch(console.warn), debounceMs));
    }
    syncPosition(fileId, position) { return this._updateRecord(fileId, { position, positionUpdatedAt: new Date().toISOString() }); }
    syncVoice(fileId, voice) { return this._updateRecord(fileId, { voice, voiceUpdatedAt: new Date().toISOString() }); }
    syncTranslationSettings(fileId, { target, mode } = {}) { return this._updateRecord(fileId, { translationTarget: target || "pt", translationMode: mode || "off", translationUpdatedAt: new Date().toISOString() }); }
    syncHighlights(fileId, highlights) {
        const values = [];
        for (const [sentenceIndex, data] of highlights.entries()) values.push({ sentenceIndex, pageIndex: data.pageIndex, wordStart: data.wordStart, words: data.words, color: data.color || "#ffda76", text: data.text || data.sentenceText || "", comment: data.comment || "", annotationId: data.annotationId, phraseSplitVersion: data.phraseSplitVersion });
        return this._updateRecord(fileId, { highlights: values, highlightsUpdatedAt: new Date().toISOString() });
    }

    queueRewardsSync(snapshot, { debounceMs = 1000 } = {}) {
        if (!this.isEnabled() || !snapshot) return;
        clearTimeout(this.rewardsTimer);
        this.rewardsTimer = setTimeout(() => this.syncRewards(snapshot).catch((error) => {
            console.warn("[GoogleDriveSync] Reward sync failed", error);
        }), debounceMs);
    }

    async pullRewards() {
        if (!this.isEnabled()) return null;
        await this._loadIndex({ force: true });
        const record = this.records.get(REWARDS_RECORD_ID);
        if (record?.rewardSnapshot) return await this.app.rewards?.mergeRemote?.(record.rewardSnapshot);
        return null;
    }

    async syncRewards(snapshot = this.app.rewards?.getSyncSnapshot?.()) {
        if (!this.isEnabled() || !snapshot) return false;
        await this._loadIndex({ force: true });
        let record = this.records.get(REWARDS_RECORD_ID);
        if (record?.rewardSnapshot) {
            await this.app.rewards?.mergeRemote?.(record.rewardSnapshot);
            snapshot = this.app.rewards?.getSyncSnapshot?.() || snapshot;
        }
        const now = new Date().toISOString();
        record = {
            ...(record || {}),
            version: 1,
            fileId: REWARDS_RECORD_ID,
            actualFilename: "reading-rewards",
            format: "rewards",
            title: "Reading rewards",
            rewardSnapshot: snapshot,
            createdAt: record?.createdAt || now,
            updatedAt: now,
        };
        await this._saveRecord(record);
        return true;
    }

    async loadPositionAndHighlightsFromServer(fileId) {
        const record = await this._record(fileId);
        if (!record || record.deleted) return { position: null, voice: null, highlights: null, translationTarget: null, translationMode: null };
        const highlights = new Map();
        for (const item of record.highlights || []) highlights.set(Number(item.sentenceIndex), { pageIndex: item.pageIndex, wordStart: item.wordStart, words: item.words, color: item.color, text: item.text || "", comment: item.comment || "", annotationId: item.annotationId, phraseSplitVersion: item.phraseSplitVersion });
        return { position: Number.isFinite(Number(record.position)) ? Number(record.position) : null, voice: record.voice || null, highlights, translationTarget: record.translationTarget || null, translationMode: record.translationMode || null };
    }

    async deleteFileOnServer(fileId) {
        try {
            const record = await this._record(fileId);
            if (!record) return true;
            const name = record.actualFilename || this._actualFilename(fileId);
            this.app.ui?.showInfo?.(`Google Drive: deleting ${name}...`);
            if (record.documentDriveId) await this._request(`${DRIVE_API}/files/${encodeURIComponent(record.documentDriveId)}`, { method: "DELETE" });
            record.documentDriveId = null;
            record.deleted = true;
            record.deletedAt = new Date().toISOString();
            await this._saveRecord(record);
            this.app.ui?.showInfo?.(`Google Drive: deleted ${name}`);
            return true;
        } catch (error) {
            console.warn("[GoogleDriveSync] Delete failed", error);
            return false;
        }
    }

    async restoreFile({ fileId, filename, format = "pdf", title = "", document = null, progressEntries = {} } = {}) {
        if (!this.isEnabled()) {
            throw new Error("Reconnect Google Drive before restoring this document");
        }
        if (!fileId) throw new Error("A document id is required for Google Drive restore");

        const normalizedFormat = format === "epub" ? "epub" : "pdf";
        const actualFilename = String(filename || this._actualFilename(fileId)).trim() || this._actualFilename(fileId);
        await this._loadIndex({ force: true });

        let record = this.records.get(fileId) || null;
        if (!record) {
            record = [...this.records.values()].find(
                (item) => item.actualFilename === actualFilename && item.format === normalizedFormat,
            ) || null;
        }

        let storedDocument = document;
        if (!storedDocument) {
            const keys = normalizedFormat === "epub"
                ? await this.app.progressManager.listSavedEPUBs()
                : await this.app.progressManager.listSavedPDFs();
            const matchingKey = keys.find((key) => this._actualFilename(key) === actualFilename);
            if (matchingKey) {
                storedDocument = normalizedFormat === "epub"
                    ? await this.app.progressManager.loadEpubFromIndexedDB(matchingKey)
                    : await this.app.progressManager.loadPdfFromIndexedDB(matchingKey);
            }
        }

        const blob = storedDocument?.blob || storedDocument;
        if (!(blob instanceof Blob)) throw new Error("The restored document data is not available on this device");

        this.app.ui?.showInfo?.(`Google Drive: restoring ${actualFilename}...`);
        const uploaded = await this._createContentFile({
            name: actualFilename,
            parents: [await this._ensureFolder()],
            appProperties: { pocketReaderKind: "document", pocketReaderVersion: "1" },
        }, blob);

        const previousFileId = record?.fileId;
        const progress = progressEntries[`${normalizedFormat}::${fileId}`] || progressEntries[fileId] || null;
        const now = new Date().toISOString();
        record = {
            ...(record || {}),
            version: 1,
            fileId,
            actualFilename,
            format: normalizedFormat,
            title: String(title || record?.title || progress?.title || actualFilename),
            position: Number.isFinite(Number(progress?.sentenceIndex))
                ? Number(progress.sentenceIndex)
                : (record?.position ?? 0),
            voice: progress?.voice || record?.voice || null,
            documentDriveId: uploaded.id,
            deleted: false,
            updatedAt: now,
            createdAt: record?.createdAt || now,
        };
        delete record.deletedAt;
        if (previousFileId && previousFileId !== fileId) this.records.delete(previousFileId);
        await this._saveRecord(record);
        this.app.ui?.showInfo?.(`Google Drive: restored ${actualFilename}`);
        return true;
    }

    async pullServerStateUpdates() { return await this.syncFromServer(); }
    async syncFromServer({ showProgress = true } = {}) {
        if (!this.isEnabled()) return false;
        if (showProgress) this.app.ui?.showInfo?.("Google Drive: checking for updates...");
        await this._loadIndex({ force: true });
        const progressMap = this.app.progressManager.getProgressMap();
        const records = [...this.records.values()];
        let downloadedCount = 0;
        let removedCount = 0;
        if (showProgress) {
            const label = records.length === 1 ? "file" : "files";
            this.app.ui?.showInfo?.(`Google Drive: syncing ${records.length} ${label}...`);
        }
        for (const [index, record] of records.entries()) {
            if (record.fileId === REWARDS_RECORD_ID || record.format === "rewards") {
                if (record.rewardSnapshot) await this.app.rewards?.mergeRemote?.(record.rewardSnapshot);
                continue;
            }
            const fileId = record.fileId;
            const format = record.format === "epub" ? "epub" : "pdf";
            const name = record.actualFilename || this._actualFilename(fileId);
            const compoundKey = `${format}::${fileId}`;
            if (showProgress) this.app.ui?.showInfo?.(`Google Drive: file ${index + 1}/${records.length} — ${name}`);
            if (record.deleted) {
                const stored = format === "epub"
                    ? await this.app.progressManager.loadEpubFromIndexedDB(fileId)
                    : await this.app.progressManager.loadPdfFromIndexedDB(fileId);
                const hadLocalCopy = !!stored || Object.hasOwn(progressMap, compoundKey);
                if (showProgress && hadLocalCopy) this.app.ui?.showInfo?.(`Google Drive: removing local copy — ${name}`);
                if (stored) {
                    try {
                        await this.app.progressManager.moveDocumentToTrash(fileId, format, {
                            filename: name,
                            title: record.title || name,
                            googleDriveBacked: true,
                        });
                    } catch (error) {
                        console.warn("[GoogleDriveSync] Could not move deleted local copy to Trash", error);
                        continue;
                    }
                } else {
                    this.app.progressManager.clearDocumentProgress(format, fileId);
                    this.app.highlightsStorage?.clearPdfHighlights?.(fileId);
                }
                delete progressMap[compoundKey];
                if (format === "pdf") delete progressMap[fileId];
                if (hadLocalCopy) removedCount++;
                continue;
            }
            const stored = format === "epub" ? await this.app.progressManager.loadEpubFromIndexedDB(fileId) : await this.app.progressManager.loadPdfFromIndexedDB(fileId);
            if (!stored && record.documentDriveId) {
                if (showProgress) this.app.ui?.showInfo?.(`Google Drive: downloading ${name}...`);
                const response = await this._download(record.documentDriveId);
                const blob = await response.blob();
                const file = new File([blob], record.actualFilename, { type: blob.type || (format === "epub" ? "application/epub+zip" : "application/pdf"), lastModified: Date.now() });
                if (format === "epub") await this.app.progressManager.saveEpubToIndexedDB(file, fileId);
                else await this.app.progressManager.savePdfToIndexedDB(file, fileId);
                downloadedCount++;
                if (showProgress) this.app.ui?.showInfo?.(`Google Drive: downloaded ${downloadedCount} file${downloadedCount === 1 ? "" : "s"}`);
            }
            const entry = progressMap[compoundKey] || {};
            if (Number.isFinite(Number(record.position))) entry.sentenceIndex = Number(record.position);
            if (record.voice) entry.voice = record.voice;
            if (record.translationTarget) entry.translationTarget = record.translationTarget;
            if (record.translationMode) entry.translationMode = record.translationMode;
            entry.title = record.title || record.actualFilename;
            entry.docType = format;
            entry.updated = Date.parse(record.updatedAt) || Date.now();
            progressMap[compoundKey] = entry;
            const highlights = new Map((record.highlights || []).map((h) => [Number(h.sentenceIndex), { pageIndex: h.pageIndex, wordStart: h.wordStart, words: h.words, color: h.color, text: h.text || "", comment: h.comment || "", annotationId: h.annotationId, phraseSplitVersion: h.phraseSplitVersion }]));
            this.app.highlightsStorage?.saveHighlights?.(fileId, highlights);
        }
        this.app.progressManager.setProgressMap(progressMap);
        if (showProgress) {
            const details = [];
            if (downloadedCount) details.push(`${downloadedCount} downloaded`);
            if (removedCount) details.push(`${removedCount} removed locally`);
            if (!records.length) {
                this.app.ui?.showInfo?.("Google Drive: no registered PocketReader files found");
            } else {
                const suffix = details.length ? ` — ${details.join(", ")}` : " — files are up to date";
                this.app.ui?.showInfo?.(`Google Drive sync complete${suffix}`);
            }
        }
        return true;
    }

    async syncAll() {
        if (this.isSyncing || !this.isEnabled()) return false;
        this.isSyncing = true;
        try {
            if (!(await this.ensureFileOnServer())) return false;
            const state = this.app.state;
            const fileId = state.currentDocumentType === "epub" ? state.currentEpubKey : state.currentPdfKey;
            if (state.currentSentenceIndex >= 0 && this.app.progressManager.canSyncCurrentPosition()) {
                await this.syncPosition(fileId, state.currentSentenceIndex);
            }
            if (state.currentPiperVoice) await this.syncVoice(fileId, state.currentPiperVoice);
            await this.syncHighlights(fileId, state.savedHighlights || new Map());
            await this.syncRewards();
            this.lastSyncTime = Date.now();
            return true;
        } finally { this.isSyncing = false; }
    }
    async checkServerAvailability() { return this.isConnected(); }
    async manualSync() {
        this.app.ui?.showInfo?.("Syncing with Google Drive...");
        await this.syncFromServer({ showProgress: true });
        await this.syncAll();
        await this.pullRewards();
        this.app.ui?.showInfo?.("Google Drive sync complete");
    }
    startAutoSync() {
        this.stopAutoSync();
        if (!this.isEnabled()) return;
        const sync = () => this.syncFromServer().catch((error) => console.warn("[GoogleDriveSync] Pull failed", error));
        for (const [target, event] of [[window, "focus"], [window, "online"]]) { target.addEventListener(event, sync); this.autoSyncListeners.push([target, event, sync]); }
        setTimeout(sync, 600);
    }
    stopAutoSync() {
        for (const [target, event, listener] of this.autoSyncListeners) target.removeEventListener(event, listener);
        this.autoSyncListeners = [];
        clearTimeout(this.rewardsTimer);
        this.rewardsTimer = null;
    }
}
