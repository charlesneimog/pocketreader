import { hexToRgb } from "../utils/helpers.js";

export class ExportManager {
    constructor(app) {
        this.app = app;
    }

    async exportPdfWithHighlights() {
        const { state, config } = this.app;
        const treeNotes = this._getTreeNotesForCurrentPdf();
        if (!state.currentPdfDescriptor || (state.savedHighlights.size === 0 && treeNotes.length === 0)) {
            alert("No highlights or Reading Tree notes to export, or no PDF is loaded.");
            return;
        }
        try {
            this.app.ui.showInfo("Preparing PDF export...");
            const highlightedPages = new Set();
            for (const highlight of state.savedHighlights.values()) {
                const pageIndex = Number(highlight?.pageIndex);
                if (Number.isFinite(pageIndex)) highlightedPages.add(pageIndex + 1);
            }
            for (const pageNumber of Array.from(highlightedPages).sort((a, b) => a - b)) {
                await this.app.pdfLoader?.ensurePageParsed?.(pageNumber);
            }
            let pdfBytes;
            if (state.currentPdfDescriptor.type === "file") {
                if (state.currentPdfDescriptor.fileObject) {
                    pdfBytes = await state.currentPdfDescriptor.fileObject.arrayBuffer();
                } else {
                    throw new Error("Original file object not available for export");
                }
            } else if (state.currentPdfDescriptor.type === "url") {
                const response = await fetch(state.currentPdfDescriptor.url);
                pdfBytes = await response.arrayBuffer();
            } else {
                throw new Error("Cannot export: unsupported PDF source");
            }

            const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes);
            const pages = pdfDoc.getPages();
            const { PDFName, PDFString, PDFHexString, PDFNumber, PDFArray } = PDFLib;

            const appendAnnotation = (page, annotationDict) => {
                const annotationRef = pdfDoc.context.register(annotationDict);
                const annotsKey = PDFName.of("Annots");
                let annots = page.node.get(annotsKey);
                let annotsArray;

                if (!annots) {
                    annotsArray = PDFArray.withContext(pdfDoc.context);
                    const annotsRef = pdfDoc.context.register(annotsArray);
                    page.node.set(annotsKey, annotsRef);
                } else if (annots instanceof PDFArray) {
                    annotsArray = annots;
                } else {
                    annotsArray = pdfDoc.context.lookup(annots, PDFArray);
                }
                annotsArray.push(annotationRef);
            };

            const clamp01 = (n) => Math.min(1, Math.max(0, n));
            const highlightOpacity = clamp01(
                Number.isFinite(config?.EXPORT_HIGHLIGHT_OPACITY) ? config.EXPORT_HIGHLIGHT_OPACITY : 0.35
            );

            // For each saved highlight (by sentence index), create a single Highlight annotation
            for (const [sentenceIndex, highlightData] of state.savedHighlights.entries()) {
                const sentence = state.sentences[sentenceIndex];
                if (!sentence || !sentence.words || sentence.words.length === 0) continue;
                const pageNum = sentence.pageNumber;
                if (pageNum > pages.length) continue;
                const page = pages[pageNum - 1];
                const viewportDisplay = state.viewportDisplayByPage.get(pageNum);
                if (!viewportDisplay) continue;

                const { width, height } = page.getSize();

                const scaleX = width / viewportDisplay.width;
                const scaleY = height / viewportDisplay.height;

                const toPdfPoint = (xDisplay, yDisplay) => {
                    if (viewportDisplay && typeof viewportDisplay.convertToPdfPoint === "function") {
                        return viewportDisplay.convertToPdfPoint(xDisplay, yDisplay);
                    }
                    // Fallback (top-left display coords -> bottom-left PDF coords)
                    return [xDisplay * scaleX, height - yDisplay * scaleY];
                };

                // Convert hex color to rgb 0-1 values
                const rgb = hexToRgb(highlightData.color) || { r: 255, g: 255, b: 0 };
                const colorArray = [rgb.r / 255, rgb.g / 255, rgb.b / 255];

                // Collect QuadPoints for all words in the sentence
                // PDF QuadPoints are arrays of numbers in user space: [x1,y1, x2,y2, x3,y3, x4,y4] per rectangle
                const quadPoints = [];
                const wordsToAnnotate =
                    this.app.highlightsStorage?.getHighlightWords?.(highlightData, sentence) ||
                    (Array.isArray(sentence.readableWords) && sentence.readableWords.length
                        ? sentence.readableWords
                        : sentence.words);

                // Detect the coordinate reference used for this page so we can convert to PDF space (origin bottom-left)
                const renderer = this.app?.pdfRenderer;
                let coordSystem = renderer?.pageCoordinateSystems?.get(pageNum) || null;
                if (!coordSystem && renderer && typeof renderer.detectPageCoordinateSystem === "function") {
                    coordSystem = renderer.detectPageCoordinateSystem(pageNum, wordsToAnnotate) || null;
                    if (coordSystem && renderer.pageCoordinateSystems) {
                        renderer.pageCoordinateSystems.set(pageNum, coordSystem);
                    }
                }
                coordSystem = coordSystem || "baseline";

                // Prefer exporting merged per-line highlights (matches on-screen rendering)
                let lineRects = [];
                if (renderer && typeof renderer.getMergedLineRects === "function") {
                    // Use a slightly looser tolerance for export to avoid splitting a single visual line.
                    lineRects = renderer.getMergedLineRects(wordsToAnnotate, pageNum, { offsetYDisplay: 1, yTolerance: 3 }) || [];
                }

                if (Array.isArray(lineRects) && lineRects.length) {
                    for (const r of lineRects) {
                        const left = r.x;
                        const right = r.x + r.width;
                        const top = r.y;
                        const bottom = r.y + r.height;

                        const [x1, y1] = toPdfPoint(left, top);
                        const [x2, y2] = toPdfPoint(right, top);
                        const [x3, y3] = toPdfPoint(left, bottom);
                        const [x4, y4] = toPdfPoint(right, bottom);

                        // PDF spec ordering for QuadPoints: top-left, top-right, bottom-left, bottom-right
                        quadPoints.push(x1, y1, x2, y2, x3, y3, x4, y4);
                    }
                } else {
                    // Fallback: per-word quads (older behavior)
                    for (const word of wordsToAnnotate) {
                        const left = word.x;
                        const right = word.x + word.width;
                        const top = coordSystem === "top-based" ? word.y : word.y - word.height;
                        const bottom = top + word.height;

                        const [x1, y1] = toPdfPoint(left, top);
                        const [x2, y2] = toPdfPoint(right, top);
                        const [x3, y3] = toPdfPoint(left, bottom);
                        const [x4, y4] = toPdfPoint(right, bottom);

                        // PDF spec ordering for QuadPoints: top-left, top-right, bottom-left, bottom-right
                        quadPoints.push(x1, y1, x2, y2, x3, y3, x4, y4);
                    }
                }

                if (quadPoints.length === 0) continue;

                // Compute bounding rect for the annotation: [xMin, yMin, xMax, yMax]
                const xs = quadPoints.filter((_, i) => i % 2 === 0);
                const ys = quadPoints.filter((_, i) => i % 2 === 1);
                const xMin = Math.min(...xs);
                const xMax = Math.max(...xs);
                const yMin = Math.min(...ys);
                const yMax = Math.max(...ys);

                const createdAt = highlightData?.timestamp ? new Date(highlightData.timestamp) : new Date();
                const modifiedAt = new Date();
                const hasComment = typeof highlightData?.comment === "string" && highlightData.comment.trim().length > 0;
                const annotationContents = hasComment
                    ? highlightData.comment.trim().slice(0, 2048)
                    : sentence?.text
                        ? sentence.text.slice(0, 1024)
                        : "";

                // TODO: Add login userName or identifier here
                const annotationAuthor = "LocalReader";
                const uniqueId = `hl-${pageNum}-${sentenceIndex}-${createdAt.getTime()}`;

                const highlightDict = pdfDoc.context.obj({
                    Type: PDFName.of("Annot"),
                    Subtype: PDFName.of("Highlight"),
                    P: page.ref,
                    Rect: pdfDoc.context.obj([xMin, yMin, xMax, yMax]),
                    QuadPoints: pdfDoc.context.obj(quadPoints),
                    C: pdfDoc.context.obj(colorArray),
                    F: PDFNumber.of(4),
                    CA: PDFNumber.of(highlightOpacity),
                    NM: PDFString.of(uniqueId),
                    T: PDFString.of(annotationAuthor),
                    Contents: PDFString.of(annotationContents),
                    Subj: PDFString.of(hasComment ? "Comment" : "Highlight"),
                    Border: pdfDoc.context.obj([0, 0, 0]),
                    CreationDate: PDFString.fromDate(createdAt),
                    M: PDFString.fromDate(modifiedAt),
                });

                appendAnnotation(page, highlightDict);
            }

            // Tree reflections become ordinary PDF Text annotations. PDF
            // readers display these as note icons and open the saved paragraph
            // when the icon is selected.
            const noteRowsByPage = new Map();
            for (const note of treeNotes) {
                const sentence = this._resolveTreeNoteSentence(note);
                const pageNum = Number(sentence?.pageNumber || note.anchor?.pageNumber);
                if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > pages.length) continue;
                const page = pages[pageNum - 1];
                const rect = this._getTreeNoteRect(page, pageNum, sentence, noteRowsByPage);
                const createdAt = note.createdAt ? new Date(note.createdAt) : new Date();
                const treeLabel = note.speciesId
                    ? `Reading Tree — ${String(note.speciesId)
                        .replace(/-/g, " ")
                        .replace(/\b\w/g, (character) => character.toUpperCase())}`
                    : "Reading Tree note";
                const uniqueId = `tree-note-${note.id || `${pageNum}-${createdAt.getTime()}`}`;
                const noteDict = pdfDoc.context.obj({
                    Type: PDFName.of("Annot"),
                    Subtype: PDFName.of("Text"),
                    P: page.ref,
                    Rect: pdfDoc.context.obj(rect),
                    F: PDFNumber.of(4),
                    Name: PDFName.of("Note"),
                    NM: PDFString.of(uniqueId),
                    // UTF-16 hex strings preserve accents, non-Latin scripts,
                    // and emoji in user-authored reading notes.
                    T: PDFHexString.fromText(treeLabel),
                    Contents: PDFHexString.fromText(String(note.text).slice(0, 4096)),
                    Subj: PDFString.of("Reading Tree note"),
                    CreationDate: PDFString.fromDate(createdAt),
                    M: PDFString.fromDate(new Date(note.updatedAt || note.createdAt || Date.now())),
                });
                appendAnnotation(page, noteDict);
            }

            const originalName = state.currentPdfDescriptor.name || "document";
            const baseName = originalName.replace(/\.pdf$/i, "");
            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
            const filename = `${baseName}_annotated_${timestamp}.pdf`;

            const highlightedPdfBytes = await pdfDoc.save();
            const blob = new Blob([highlightedPdfBytes], { type: "application/pdf" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
            this.app.ui.showInfo(`Exported: ${filename}`);
        } catch (error) {
            console.error("Export failed:", error);
            this.app.ui.showInfo("Export failed: " + error.message);
            alert("Failed to export PDF: " + error.message);
        }
    }

    _getTreeNotesForCurrentPdf() {
        const { state } = this.app;
        const documentId = state.currentPdfKey;
        const rewards = this.app.rewards?.storage?.getSnapshot?.();
        if (!documentId || !rewards) return [];

        const plantsByReflection = new Map(
            (rewards.plants || [])
                .filter((plant) => plant?.reflectionId)
                .map((plant) => [plant.reflectionId, plant]),
        );
        return (rewards.reflections || []).flatMap((reflection) => {
            if (reflection?.documentId !== documentId || !String(reflection.text || "").trim()) return [];
            const plant = plantsByReflection.get(reflection.id);
            if (plant?.deletedAt) return [];
            return [{
                ...reflection,
                speciesId: plant?.speciesId || null,
            }];
        });
    }

    _resolveTreeNoteSentence(note) {
        const sentences = this.app.state.sentences || [];
        const anchor = note.anchor || {};
        const candidates = [anchor.sentenceIndex, note.sentenceIndex]
            .map(Number)
            .filter(Number.isInteger);
        for (const index of candidates) {
            const sentence = sentences[index];
            if (!sentence) continue;
            const pageMatches = !anchor.pageNumber || Number(sentence.pageNumber) === Number(anchor.pageNumber);
            const textMatches = !anchor.text || String(sentence.text || "").trim().startsWith(anchor.text);
            if (pageMatches && textMatches) return sentence;
        }

        if (anchor.pageNumber && anchor.text) {
            const exactPageMatch = sentences.find((sentence) =>
                Number(sentence?.pageNumber) === Number(anchor.pageNumber) &&
                String(sentence?.text || "").trim().startsWith(anchor.text),
            );
            if (exactPageMatch) return exactPageMatch;
        }
        return null;
    }

    _getTreeNoteRect(page, pageNum, sentence, noteRowsByPage) {
        const { width, height } = page.getSize();
        const viewport = this.app.state.viewportDisplayByPage.get(pageNum);
        const renderer = this.app.pdfRenderer;
        let anchorY = null;
        if (sentence && viewport) {
            const words = Array.isArray(sentence.readableWords) && sentence.readableWords.length
                ? sentence.readableWords
                : sentence.words;
            const lineRects = renderer?.getMergedLineRects?.(words || [], pageNum, {
                offsetYDisplay: 0,
                yTolerance: 3,
            }) || [];
            const lastLine = [...lineRects].sort((left, right) => left.y - right.y || left.x - right.x).at(-1);
            if (lastLine) {
                const point = typeof viewport.convertToPdfPoint === "function"
                    ? viewport.convertToPdfPoint(lastLine.x + lastLine.width, lastLine.y)
                    : [0, height - (lastLine.y * height / viewport.height)];
                anchorY = Number(point?.[1]);
            }
        }
        if (!Number.isFinite(anchorY)) anchorY = height - 40;

        const iconSize = 18;
        const margin = 8;
        let bottom = Math.max(margin, Math.min(height - margin - iconSize, anchorY - iconSize));
        const usedRows = noteRowsByPage.get(pageNum) || [];
        while (usedRows.some((used) => Math.abs(used - bottom) < iconSize + 3) && bottom > margin) {
            bottom = Math.max(margin, bottom - iconSize - 3);
        }
        usedRows.push(bottom);
        noteRowsByPage.set(pageNum, usedRows);
        return [width - margin - iconSize, bottom, width - margin, bottom + iconSize];
    }
}
