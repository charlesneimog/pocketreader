function actualFilename(value) {
    const text = String(value || "").trim();
    if (!text.startsWith("file::")) return text;
    return text.split("::")[1] || text;
}

function normalizedFormat(value, filename = "") {
    if (String(value).toLowerCase() === "epub" || /\.epub$/i.test(filename)) return "epub";
    return "pdf";
}

function mergeKey(filename, format) {
    return `${format}:${String(filename || "").trim().normalize("NFC")}`;
}

function timestamp(value) {
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : 0;
}

export function mergeTrashEntries(localEntries = [], serverEntries = []) {
    const merged = new Map();

    for (const entry of Array.isArray(localEntries) ? localEntries : []) {
        const localKey = String(entry?.storageKey || "").trim();
        if (!localKey) continue;
        const filename = String(entry?.filename || entry?.document?.name || actualFilename(localKey)).trim();
        const format = normalizedFormat(entry?.format, filename);
        const localTrashId = String(entry?.trashId || `${format}::${localKey}`);
        const key = mergeKey(filename || localKey, format);
        merged.set(key, {
            key,
            filename: filename || actualFilename(localKey) || "Untitled",
            title: String(entry?.title || filename || actualFilename(localKey) || "Untitled"),
            format,
            deletedAt: entry?.deletedAt || entry?.deleted_at || "",
            size: Number(entry?.size || entry?.document?.blob?.size || 0) || 0,
            hasLocal: true,
            hasServer: false,
            serverBacked: !!entry?.serverBacked,
            pendingServerDelete: !!entry?.pendingServerDelete,
            googleDriveBacked: !!entry?.googleDriveBacked,
            localKey,
            localTrashId,
            serverId: "",
            local: entry,
            server: null,
        });
    }

    for (const entry of Array.isArray(serverEntries) ? serverEntries : []) {
        const serverId = String(entry?.file_id || entry?.id || entry?.filename || "").trim();
        if (!serverId) continue;
        const filename = String(entry?.filename || actualFilename(serverId)).trim();
        const format = normalizedFormat(entry?.format, filename);
        const key = mergeKey(filename || serverId, format);
        const existing = merged.get(key);
        const deletedAt = entry?.deleted_at || entry?.deletedAt || "";
        if (existing) {
            existing.hasServer = true;
            existing.serverBacked = true;
            existing.serverId = serverId;
            existing.server = entry;
            existing.title = String(entry?.title || existing.title || filename || "Untitled");
            existing.size = Math.max(existing.size, Number(entry?.size || 0) || 0);
            if (timestamp(deletedAt) >= timestamp(existing.deletedAt)) existing.deletedAt = deletedAt;
        } else {
            merged.set(key, {
                key,
                filename: filename || actualFilename(serverId) || "Untitled",
                title: String(entry?.title || filename || actualFilename(serverId) || "Untitled"),
                format,
                deletedAt,
                size: Number(entry?.size || 0) || 0,
                hasLocal: false,
                hasServer: true,
                serverBacked: true,
                pendingServerDelete: false,
                googleDriveBacked: false,
                localKey: "",
                localTrashId: "",
                serverId,
                local: null,
                server: entry,
            });
        }
    }

    return [...merged.values()].sort((a, b) => {
        const dateDifference = timestamp(b.deletedAt) - timestamp(a.deletedAt);
        return dateDifference || a.title.localeCompare(b.title);
    });
}

export function formatTrashDate(value, locales = undefined) {
    const date = new Date(value || "");
    if (!Number.isFinite(date.getTime())) return "Date unavailable";
    try {
        return new Intl.DateTimeFormat(locales, { dateStyle: "medium", timeStyle: "short" }).format(date);
    } catch {
        return date.toLocaleString();
    }
}

export function formatTrashSize(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function sourceLabel(item) {
    if (item.hasLocal && item.hasServer) return "This device and server";
    return item.hasServer ? "Server" : "This device";
}

function errorMessage(error, fallback) {
    return String(error?.message || fallback || "Something went wrong");
}

export function initTrashDialog({ app, documentRef = globalThis.document, windowRef = globalThis.window } = {}) {
    const openButton = documentRef?.getElementById?.("trash-button");
    const overlay = documentRef?.getElementById?.("trash-overlay");
    const closeButton = documentRef?.getElementById?.("trash-close");
    const list = documentRef?.getElementById?.("trash-list");
    const emptyState = documentRef?.getElementById?.("trash-empty-state");
    const status = documentRef?.getElementById?.("trash-status");
    const emptyButton = documentRef?.getElementById?.("trash-empty-button");
    if (!app || !openButton || !overlay || !closeButton || !list || !emptyState || !status || !emptyButton) {
        return null;
    }

    let items = [];
    let busy = false;

    const serverTrashAvailable = () => !!app.serverSync?.isServerTrashAvailable?.();
    const driveConnected = () => !!app.serverSync?.isGoogleDriveConnected?.();
    const restoreBlockReason = (item) => {
        if (item?.serverBacked && !serverTrashAvailable()) {
            return "Reconnect to the self-hosted server before restoring this synced document";
        }
        if (item?.googleDriveBacked && !driveConnected()) {
            return "Reconnect Google Drive before restoring this synced document";
        }
        return "";
    };
    const deleteBlockReason = (item) => {
        if ((item?.serverBacked || item?.pendingServerDelete) && !serverTrashAvailable()) {
            return "Reconnect to the self-hosted server before deleting this synced document forever";
        }
        return "";
    };

    const setStatus = (message, isError = false) => {
        status.textContent = message || "";
        status.classList.toggle("trash-status-error", !!isError);
    };

    const setBusy = (value) => {
        busy = !!value;
        emptyButton.disabled = busy || items.length === 0;
        for (const button of list.querySelectorAll("button")) button.disabled = busy || button.dataset.blocked === "true";
        overlay.setAttribute("aria-busy", busy ? "true" : "false");
    };

    const refreshLibraryIfVisible = async () => {
        const library = documentRef.getElementById("previous-pdf-header");
        if (library && !library.classList.contains("hidden")) await app.showSavedPDFs?.();
    };

    const restoreItem = async (item) => {
        const blocked = restoreBlockReason(item);
        if (blocked) throw new Error(blocked);
        setBusy(true);
        setStatus(`Restoring ${item.title}…`);
        const warnings = [];

        if (item.hasServer || item.serverBacked) {
            await app.serverSync.restoreTrashFile(item.serverId || item.localKey);
        } else if (item.hasLocal && serverTrashAvailable()) {
            try {
                await app.serverSync.restoreTrashFile(item.localKey);
            } catch (error) {
                if (!/404|not found|not in trash/i.test(errorMessage(error))) {
                    warnings.push(`server Trash was not cleared: ${errorMessage(error)}`);
                }
            }
        }

        if (item.hasLocal && !item.hasServer && !item.serverBacked && serverTrashAvailable()) {
            const uploaded = await app.serverSync.uploadRestoredTrashFile(item.local);
            if (!uploaded) warnings.push("the server copy could not be re-uploaded");
        }

        if (item.googleDriveBacked && item.hasLocal) {
            await app.serverSync.restoreGoogleDriveFile({
                fileId: item.localKey,
                filename: item.filename,
                format: item.format,
                title: item.title,
                document: item.local?.document,
                progressEntries: item.local?.progressEntries || {},
            });
        }

        if (item.hasLocal) {
            await app.progressManager.restoreDocumentFromTrash(item.localTrashId);
        } else if (item.hasServer) {
            await app.serverSync.syncRestoredTrashFromServer();
        }

        await refreshLibraryIfVisible();
        return warnings.length
            ? `Restored ${item.title} on this device; ${warnings.join("; ")}.`
            : `Restored ${item.title}.`;
    };

    const deleteItem = async (item) => {
        const blocked = deleteBlockReason(item);
        if (blocked) throw new Error(blocked);
        if (!windowRef.confirm(`Delete "${item.title}" forever? This cannot be undone.`)) return null;
        setBusy(true);
        setStatus(`Deleting ${item.title} forever…`);
        if (item.hasServer) await app.serverSync.deleteTrashFile(item.serverId);
        if (item.hasLocal) await app.progressManager.deleteTrashDocument(item.localTrashId);
        return `Deleted ${item.title} forever.`;
    };

    const createActionButton = (label, className, handler, { blocked = false, title = "" } = {}) => {
        const button = documentRef.createElement("button");
        button.type = "button";
        button.className = className;
        button.textContent = label;
        button.dataset.blocked = blocked ? "true" : "false";
        button.disabled = busy || blocked;
        if (title) button.title = title;
        button.addEventListener("click", handler);
        return button;
    };

    const render = (nextItems) => {
        items = nextItems;
        list.replaceChildren();
        emptyState.hidden = items.length > 0;
        emptyButton.hidden = items.length === 0;
        emptyButton.disabled = busy || items.length === 0;

        for (const item of items) {
            const row = documentRef.createElement("li");
            row.className = "trash-item";

            const details = documentRef.createElement("div");
            details.className = "trash-item-details";
            const name = documentRef.createElement("p");
            name.className = "trash-item-title";
            name.textContent = item.title;
            name.title = item.filename;
            const metadata = documentRef.createElement("p");
            metadata.className = "trash-item-metadata";
            const size = formatTrashSize(item.size);
            metadata.textContent = [item.format.toUpperCase(), formatTrashDate(item.deletedAt), size, sourceLabel(item)]
                .filter(Boolean)
                .join(" · ");
            details.append(name, metadata);

            const actions = documentRef.createElement("div");
            actions.className = "trash-item-actions";
            const restoreBlockedReason = restoreBlockReason(item);
            const restore = createActionButton(
                "Restore",
                "trash-action trash-action-restore",
                async () => {
                    try {
                        const message = await restoreItem(item);
                        await refresh(message);
                    } catch (error) {
                        await refresh(`Could not restore ${item.title}: ${errorMessage(error)}`, true);
                    }
                },
                {
                    blocked: !!restoreBlockedReason,
                    title: restoreBlockedReason || `Restore ${item.title}`,
                },
            );
            const remove = createActionButton(
                "Delete forever",
                "trash-action trash-action-delete",
                async () => {
                    try {
                        const message = await deleteItem(item);
                        if (message) await refresh(message);
                    } catch (error) {
                        await refresh(`Could not delete ${item.title}: ${errorMessage(error)}`, true);
                    }
                },
                {
                    blocked: !!deleteBlockReason(item),
                    title: deleteBlockReason(item) || `Delete ${item.title} forever`,
                },
            );
            actions.append(restore, remove);
            row.append(details, actions);
            list.appendChild(row);
        }
    };

    async function refresh(message = "", messageIsError = false) {
        setBusy(true);
        setStatus("Loading Trash…");
        let localEntries = [];
        let serverEntries = [];
        let localError = null;
        let serverError = null;

        try {
            localEntries = await app.progressManager.listTrashDocuments();
        } catch (error) {
            localError = error;
        }
        if (serverTrashAvailable()) {
            try {
                serverEntries = await app.serverSync.listTrash();
            } catch (error) {
                serverError = error;
            }
        }

        render(mergeTrashEntries(localEntries, serverEntries));
        setBusy(false);
        if (message) {
            setStatus(message, messageIsError);
        } else if (localError) {
            setStatus(`Device Trash is unavailable: ${errorMessage(localError)}`, true);
        } else if (serverError) {
            setStatus(`Showing device Trash. Server Trash is unavailable: ${errorMessage(serverError)}`, true);
        } else if (!serverTrashAvailable()) {
            setStatus("Showing device Trash. Sign in to your self-hosted server to see synced items.");
        } else if (items.some((item) => restoreBlockReason(item))) {
            setStatus("Reconnect the relevant sync service before restoring synced items.");
        } else {
            setStatus(items.length ? `${items.length} item${items.length === 1 ? "" : "s"} in Trash.` : "Trash is empty.");
        }
        return items;
    }

    const open = async () => {
        overlay.classList.remove("hidden");
        overlay.setAttribute("aria-hidden", "false");
        closeButton.focus();
        await refresh();
    };

    const close = () => {
        overlay.classList.add("hidden");
        overlay.setAttribute("aria-hidden", "true");
        openButton.focus();
    };

    openButton.addEventListener("click", () => void open());
    closeButton.addEventListener("click", close);
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) close();
    });
    documentRef.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !overlay.classList.contains("hidden")) close();
    });
    emptyButton.addEventListener("click", async () => {
        if (!items.length) return;
        if (items.some((item) => deleteBlockReason(item))) {
            setStatus("Reconnect the self-hosted server before emptying synced Trash items.", true);
            return;
        }
        if (!windowRef.confirm("Delete everything in Trash forever? This cannot be undone.")) return;
        setBusy(true);
        setStatus("Emptying Trash…");
        try {
            if (items.some((item) => item.hasServer)) await app.serverSync.emptyServerTrash();
            await app.progressManager.emptyTrash();
            await refresh("Trash emptied.");
        } catch (error) {
            await refresh(`Could not empty Trash: ${errorMessage(error)}`, true);
        }
    });

    return { open, close, refresh };
}
