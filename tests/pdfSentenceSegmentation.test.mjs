import test from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import { SentenceParser } from "../src/modules/pdf/sentenceParser.js";

const parse = async (text, { version = CONFIG.PHRASE_SPLIT_VERSION, config = {} } = {}) => {
    const app = {
        config: { ...CONFIG, ...config },
        state: {
            sentences: [],
            pageSentencesIndex: new Map(),
            generationEnabled: false,
            phraseSplitVersion: version,
        },
    };
    await new SentenceParser(app).parsePageWords(1, {
        pageWords: text.split(/\s+/u).map((str, index) => ({
            str,
            x: index * 50,
            y: 20,
            width: 40,
            height: 10,
        })),
    });
    return app.state.sentences.map(({ text }) => text);
};

test("keeps the Audio Oracle citation in one PDF phrase", async () => {
    const text = "then to continuous audio descriptors by the Audio Oracle (Dubnov et al. 2007),";
    assert.deepEqual(await parse(text), [text]);
});

test("ignores periods and semicolons inside PDF parentheses across words", async () => {
    const text = "Intro (Alpha. Beta; Gamma) continues. Next phrase; final phrase.";
    assert.deepEqual(await parse(text), [
        "Intro (Alpha. Beta; Gamma) continues.",
        "Next phrase;",
        "final phrase.",
    ]);
});

test("tracks nested PDF parentheses and punctuation inside the closing token", async () => {
    const text = "Intro (Alpha (Beta. Gamma); Delta.) continues. Next phrase.";
    assert.deepEqual(await parse(text), [
        "Intro (Alpha (Beta. Gamma); Delta.) continues.",
        "Next phrase.",
    ]);
    assert.deepEqual(await parse("Intro (Alpha;) continues. Next phrase."), [
        "Intro (Alpha;) continues.",
        "Next phrase.",
    ]);
});

test("splits PDF punctuation after the closing parenthesis", async () => {
    const text = "Intro (Alpha). Next (Beta); final phrase.";
    assert.deepEqual(await parse(text), ["Intro (Alpha).", "Next (Beta);", "final phrase."]);
});

test("handles separate PDF parenthesis tokens and unmatched closing parentheses", async () => {
    assert.deepEqual(await parse("Intro ( Alpha. Beta; Gamma ) continues. Next phrase."), [
        "Intro ( Alpha. Beta; Gamma ) continues.",
        "Next phrase.",
    ]);
    assert.deepEqual(await parse("Intro ) ends. Next phrase."), ["Intro ) ends.", "Next phrase."]);
});

test("retains version 1 and 2 PDF boundaries for saved sentence indexes", async () => {
    const text = "Intro (Alpha. Beta; Gamma) continues. Next phrase.";
    for (const version of [1, 2]) {
        assert.deepEqual(await parse(text, { version }), [
            "Intro (Alpha.",
            ...(version === 1 ? ["Beta; Gamma) continues."] : ["Beta;", "Gamma) continues."]),
            "Next phrase.",
        ]);
    }
});

test("retains PDF layout boundaries and resets unfinished parentheses there", async () => {
    const app = {
        config: CONFIG,
        state: {
            sentences: [],
            pageSentencesIndex: new Map(),
            generationEnabled: true,
        },
        getPdfHeaderFooterDetector: () => ({
            getLayoutRegions: async () => ({
                readableBoxes: [
                    { x1: 0, y1: 0, x2: 500, y2: 20 },
                    { x1: 0, y1: 30, x2: 500, y2: 50 },
                ],
            }),
        }),
    };
    await new SentenceParser(app).parsePageWords(1, {
        pageWords: [
            { str: "Header (", x: 10, y: 15, width: 80, height: 10 },
            { str: "First sentence.", x: 10, y: 45, width: 80, height: 10 },
            { str: "Next sentence.", x: 100, y: 45, width: 80, height: 10 },
        ],
    });
    assert.deepEqual(app.state.sentences.map(({ text }) => text), ["Header (", "First sentence.", "Next sentence."]);
});

test("keeps lazy page sentences in document order when an earlier page is parsed later", async () => {
    const state = {
        sentences: [],
        pdfSentencesByPage: new Map(),
        pageSentencesIndex: new Map(),
        generationEnabled: false,
        currentSentenceIndex: -1,
        playingSentenceIndex: -1,
        hoveredSentenceIndex: -1,
        phraseSplitVersion: CONFIG.PHRASE_SPLIT_VERSION,
        currentDocumentType: "pdf",
    };
    const app = { config: CONFIG, state };
    const parser = new SentenceParser(app);
    const page = (str) => ({
        pageWords: [{ str, x: 10, y: 20, width: 80, height: 10 }],
    });

    await parser.parsePageWords(2, page("Second page."));
    const activeSentence = state.sentences[0];
    state.currentSentenceIndex = 0;

    await parser.parsePageWords(1, page("First page."));

    assert.deepEqual(state.sentences.map(({ pageNumber }) => pageNumber), [1, 2]);
    assert.equal(state.sentences[1], activeSentence);
    assert.equal(state.currentSentenceIndex, 1);
    assert.deepEqual(state.pageSentencesIndex.get(1), [0]);
    assert.deepEqual(state.pageSentencesIndex.get(2), [1]);
});
