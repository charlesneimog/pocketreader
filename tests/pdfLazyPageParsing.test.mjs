import assert from "node:assert/strict";
import test from "node:test";

import { PDFLoader } from "../src/modules/pdf/pdfLoader.js";

globalThis.pdfjsLib = {
    Util: {
        transform(viewportTransform, itemTransform) {
            const scale = Number(viewportTransform?.[0]) || 1;
            return [
                (Number(itemTransform?.[0]) || 1) * scale,
                Number(itemTransform?.[1]) || 0,
                Number(itemTransform?.[2]) || 0,
                (Number(itemTransform?.[3]) || 1) * scale,
                (Number(itemTransform?.[4]) || 0) * scale,
                (Number(itemTransform?.[5]) || 0) * scale,
            ];
        },
    },
};

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const textItem = (str) => ({
    str,
    width: Math.max(1, str.length * 6),
    height: 12,
    transform: [1, 0, 0, 12, 10, 20],
    fontName: "TestFont",
    hasEOL: false,
});

function makePage(pageNumber, getTextContent) {
    return {
        pageNumber,
        sourceLabel: `page-${pageNumber}`,
        getViewport({ scale }) {
            return {
                scale,
                width: 600 * scale,
                height: 800 * scale,
                transform: [scale, 0, 0, scale, 0, 0],
            };
        },
        getTextContent,
    };
}

function makePdf(pages) {
    const getPageCalls = [];
    return {
        numPages: pages.length,
        getPageCalls,
        async getPage(pageNumber) {
            getPageCalls.push(pageNumber);
            const page = pages[pageNumber - 1];
            if (!page) throw new Error(`Page ${pageNumber} is out of bounds`);
            return page;
        },
    };
}

function createFixture(pdf) {
    const parseCalls = [];
    const state = {
        pdf,
        pagesCache: new Map(),
        viewportDisplayByPage: new Map(),
        sentences: [],
        pageSentencesIndex: new Map(),
        savedHighlights: new Map(),
        generationEnabled: false,
        currentDocumentType: "pdf",
    };
    const app = {
        config: { BASE_WIDTH_CSS: () => 600 },
        state,
        sentenceParser: {
            async parsePageWords(pageNumber, page) {
                parseCalls.push({ pageNumber, page });
                const index = state.sentences.length;
                state.sentences.push({
                    index,
                    pageNumber,
                    words: page.pageWords,
                    text: page.pageWords.map(({ str }) => str).join(" "),
                });
                state.pageSentencesIndex.set(pageNumber, [index]);
            },
        },
        highlightsStorage: {
            remapPdfHighlights: (highlights) => highlights,
        },
    };
    return { app, loader: new PDFLoader(app), parseCalls };
}

test("deduplicates concurrent extraction and sentence parsing for one page", async () => {
    const textContent = deferred();
    let extractionCalls = 0;
    const page = makePage(1, () => {
        extractionCalls += 1;
        return textContent.promise;
    });
    const pdf = makePdf([page]);
    const { loader, parseCalls } = createFixture(pdf);

    const first = loader.ensurePageParsed(1, { prefetchNext: false });
    const second = loader.ensurePageParsed(1, { prefetchNext: false });
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(extractionCalls, 1);
    textContent.resolve({ items: [textItem("Alpha beta.")] });
    await Promise.all([first, second]);

    assert.deepEqual(pdf.getPageCalls, [1]);
    assert.equal(parseCalls.length, 1);
    assert.deepEqual(page.pageWords.map(({ str }) => str), ["Alpha", "beta."]);

    await loader.ensurePageParsed(1, { prefetchNext: false });
    assert.equal(extractionCalls, 1);
    assert.equal(parseCalls.length, 1);
});

test("parses only the current page and its bounded next-page prefetch", async () => {
    const extractionCalls = [];
    const pages = [1, 2, 3].map((pageNumber) =>
        makePage(pageNumber, async () => {
            extractionCalls.push(pageNumber);
            return { items: [textItem(`Page ${pageNumber}.`)] };
        }),
    );
    const pdf = makePdf(pages);
    const { loader, parseCalls } = createFixture(pdf);

    await loader.ensurePageParsed(1, { prefetchNext: false });
    await loader.prefetchNextPage(1);

    assert.deepEqual(extractionCalls, [1, 2]);
    assert.deepEqual(
        parseCalls.map(({ pageNumber }) => pageNumber),
        [1, 2],
    );
    assert.equal(pdf.getPageCalls.includes(3), false);

    await loader.ensurePageParsed(3, { prefetchNext: false });
    await loader.prefetchNextPage(3);

    assert.deepEqual(extractionCalls, [1, 2, 3]);
    assert.equal(pdf.getPageCalls.some((pageNumber) => pageNumber > pdf.numPages), false);
});

test("clears a failed page request so extraction can be retried", async () => {
    let extractionCalls = 0;
    const page = makePage(1, async () => {
        extractionCalls += 1;
        if (extractionCalls === 1) throw new Error("transient extraction failure");
        return { items: [textItem("Retry succeeds.")] };
    });
    const { loader, parseCalls } = createFixture(makePdf([page]));

    await assert.rejects(
        loader.ensurePageParsed(1, { prefetchNext: false }),
        /transient extraction failure/,
    );
    await loader.ensurePageParsed(1, { prefetchNext: false });

    assert.equal(extractionCalls, 2);
    assert.equal(parseCalls.length, 1);
    assert.equal(parseCalls[0].page.pageWords[0].str, "Retry");
});

test("caches an empty-text page as successfully parsed", async () => {
    let extractionCalls = 0;
    const page = makePage(1, async () => {
        extractionCalls += 1;
        return { items: [] };
    });
    const { loader, parseCalls } = createFixture(makePdf([page]));

    await loader.ensurePageParsed(1, { prefetchNext: false });
    await loader.ensurePageParsed(1, { prefetchNext: false });

    assert.equal(extractionCalls, 1);
    assert.equal(parseCalls.length, 1);
    assert.deepEqual(page.pageWords, []);
});

test("keeps a failed next-page prefetch retryable", async () => {
    let nextPageAttempts = 0;
    const firstPage = makePage(1, async () => ({ items: [textItem("First page.")] }));
    const nextPage = makePage(2, async () => {
        nextPageAttempts += 1;
        if (nextPageAttempts === 1) throw new Error("temporary prefetch failure");
        return { items: [textItem("Second page.")] };
    });
    const { loader, parseCalls } = createFixture(makePdf([firstPage, nextPage]));

    await loader.ensurePageParsed(1, { prefetchNext: false });
    assert.equal(await loader.prefetchNextPage(1), null);
    await loader.prefetchNextPage(1);

    assert.equal(nextPageAttempts, 2);
    assert.deepEqual(
        parseCalls.map(({ pageNumber }) => pageNumber),
        [1, 2],
    );
});

test("an old in-flight extraction cannot populate a newly selected PDF", async () => {
    const oldTextContent = deferred();
    const oldPage = makePage(1, () => oldTextContent.promise);
    oldPage.sourceLabel = "old";
    const oldPdf = makePdf([oldPage]);

    const newPage = makePage(1, async () => ({ items: [textItem("New document.")] }));
    newPage.sourceLabel = "new";
    const newPdf = makePdf([newPage]);

    const { app, loader, parseCalls } = createFixture(oldPdf);
    const oldRequest = loader.ensurePageParsed(1, { prefetchNext: false });
    await Promise.resolve();
    await Promise.resolve();

    app.state.pdf = newPdf;
    app.state.pagesCache.clear();
    app.state.viewportDisplayByPage.clear();
    // Loading a new document resets page-local in-flight bookkeeping before it
    // begins parsing that document. The old promise may still settle later.
    app.state.pdfPageParsePromises.clear();
    app.state.parsedPdfPages.clear();
    app.state.sentences = [];
    app.state.pageSentencesIndex.clear();

    await loader.ensurePageParsed(1, { prefetchNext: false });
    oldTextContent.resolve({ items: [textItem("Old document.")] });
    await Promise.allSettled([oldRequest]);

    assert.equal(app.state.pagesCache.get(1), newPage);
    assert.deepEqual(
        parseCalls.map(({ page }) => page.sourceLabel),
        ["new"],
    );
    assert.deepEqual(app.state.sentences.map(({ text }) => text), ["New document."]);
});
