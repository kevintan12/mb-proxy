// 9AV Build 3 (log only): the carrier check (A2) looks back one sentence for a "That reading ..." opening,
// and counts a skipped check whose figures or names exist only outside the cited articles. Free tests only:
// made-up text, fake fetch. No report text ever changes.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {checkSourceCarrier} = require('../lib/report-accuracy-source');
const {createEvidenceItem} = require('../lib/evidence-items');
const {invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const F = require('./fixtures/market-state-cases');

const yahoo = {publisher: 'Yahoo Finance', title: 'Wholesale prices', summary: 'Wholesale prices rose 0.3% in October, below the 0.4% expected.'};
const cnbc = {publisher: 'CNBC', title: 'Market recap', summary: 'Stocks closed mixed.'};
const FIGURES = 'Wholesale prices rose 0.3% in October, below the 0.4% expected.';
const POINTER = "That reading, from CNBC's market recap, did not change views.";

test('9AV Build 3 look-back: "That reading" takes the anchors of the sentence before it (R-52 shape)', () => {
  // Without the look-back there is nothing to anchor on.
  assert.deepEqual(checkSourceCarrier(POINTER, 'CNBC', [yahoo, cnbc]), {verdict: 'skipped', reason: 'noAnchor'});
  // With it, the only article holding the figures is Yahoo, which does not carry CNBC.
  assert.deepEqual(checkSourceCarrier(POINTER, 'CNBC', [yahoo, cnbc], {previousSentence: FIGURES}),
    {verdict: 'mismatch', reason: 'carrierLacksSource'});
  // When the figures are in a CNBC article it passes.
  const own = {publisher: 'CNBC', title: 'Wholesale', summary: FIGURES};
  assert.equal(checkSourceCarrier(POINTER, 'CNBC', [own], {previousSentence: FIGURES}).verdict, 'pass');
  // Other openings, or a sentence with its own figures, never look back.
  assert.equal(checkSourceCarrier("The reading, from CNBC's market recap, held.", 'CNBC', [yahoo, cnbc], {previousSentence: FIGURES}).reason, 'noAnchor');
  assert.equal(checkSourceCarrier("It, from CNBC's market recap, held.", 'CNBC', [yahoo, cnbc], {previousSentence: FIGURES}).reason, 'noAnchor');
  assert.equal(checkSourceCarrier("That reading of 9.9%, from CNBC's market recap, held.", 'CNBC', [yahoo, cnbc], {previousSentence: FIGURES}).reason, 'noCarrier');
  // A previous sentence with no figures or names gives nothing to anchor on.
  assert.equal(checkSourceCarrier(POINTER, 'CNBC', [yahoo, cnbc], {previousSentence: 'Stocks were quiet.'}).reason, 'noAnchor');
});

test('9AV Build 3 outside-cited: a noCarrier skip says whether the anchors exist elsewhere in the package', () => {
  const sentence = 'Reuters reported that Jane Roe joined the board.';
  const reuters = {publisher: 'Reuters', title: 'Other story', summary: 'Stocks fell.'};
  const elsewhere = {publisher: 'Yahoo Finance', title: 'Board news', summary: 'Jane Roe joined the board.'};
  assert.deepEqual(checkSourceCarrier(sentence, 'Reuters', [reuters]), {verdict: 'skipped', reason: 'noCarrier'});
  assert.deepEqual(checkSourceCarrier(sentence, 'Reuters', [reuters], {packageArticles: [reuters]}), {verdict: 'skipped', reason: 'noCarrier'});
  assert.deepEqual(checkSourceCarrier(sentence, 'Reuters', [reuters], {packageArticles: [reuters, elsewhere]}),
    {verdict: 'skipped', reason: 'noCarrier', outsideCited: true});
  // Never turns a skip into a mismatch, and a found carrier is unaffected.
  const own = {publisher: 'Reuters', title: 'Board', summary: 'Jane Roe joined the board.'};
  assert.equal(checkSourceCarrier(sentence, 'Reuters', [own], {packageArticles: [own, elsewhere]}).verdict, 'pass');
});

const ACTIVE = [['PRE', '2026-09-08T12:00:00.000Z', '2026-09-08T11:55:00.000Z', '2026-09-08T11:30:00.000Z'],
  ['REGULAR', '2026-09-08T15:00:00.000Z', '2026-09-08T14:55:00.000Z', '2026-09-08T14:30:00.000Z'],
  ['POST', '2026-09-08T21:00:00.000Z', '2026-09-08T20:55:00.000Z', '2026-09-08T20:30:00.000Z']];
const ITEMS = [
  ['Reuters', 'Zorblax Quentin joins board', 'Zorblax Quentin joined the board of a chip company.', '2026-09-08T10:15:00.000Z', 'a'],
  ['Yahoo Finance', 'Wholesale prices', FIGURES, '2026-09-08T10:30:00.000Z', 'b'],
  ['CNBC', 'Market recap', 'Stocks closed mixed.', '2026-09-08T10:45:00.000Z', 'c']
];
const SENTENCES = 'Yahoo Finance reported that Zorblax Quentin joined the board. '
  + `${FIGURES} ${POINTER}`;
const NAMES = ['SOURCE_MATCHES_ARTICLE_ENABLED', 'SAME_EVENT_DAY_CHECK_ENABLED', 'CLOSE_MARKER_ORDER_ENABLED'];

async function run(env, input, output) {
  const saved = Object.fromEntries(NAMES.map(name => [name, process.env[name]]));
  for (const name of NAMES) { if (env === 'off') process.env[name] = 'off'; else delete process.env[name]; }
  const diagnostics = [];
  try {
    const result = await invokeClaudeAnalysis({input, apiKey: 'test-key', fetchImpl: async () => F.anthropicResponse(output),
      onDiagnostics: value => diagnostics.push(value)});
    return {result, source: diagnostics.filter(d => d.violationCategory === 'SOURCE_ARTICLE_MISMATCH')};
  } finally {
    for (const name of NAMES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  }
}

test('9AV Build 3 wiring: look-back and outside-cited counts in the log; no text change; off logs nothing', async () => {
  for (const [state, generatedAt, overlayAsOf, publishedAt] of ACTIVE) {
    const additionalItems = ITEMS.map(([publisher, title, summary, at, key]) => createEvidenceItem({
      sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news', title, summary,
      canonicalUrl: `https://finance.yahoo.com/news/build3-${key}.html`, publishedAt: at, symbols: [], publisher
    }));
    const input = F.activeUsInput({marketState: state, generatedAt, overlayAsOf, currentPublishedAt: publishedAt, additionalItems});
    const output = F.normalOutput(input, {furtherReadings: ['e1']});
    // e3 = Reuters (uncited), e4 = Yahoo wholesale, e5 = CNBC recap: Section 2 cites the last two (and e1).
    const planted = structuredClone(output);
    planted.sections[1].content += ` ${SENTENCES}`;
    planted.sections[1].evidenceRefs = [...new Set([...planted.sections[1].evidenceRefs, 'e4', 'e5'])];
    planted.evidenceReferences = [...new Set(planted.sections.flatMap(section => section.evidenceRefs))];

    const on = await run('on', input, planted);
    const off = await run('off', input, planted);
    assert.equal(on.result.ok, true, state);
    const event = on.source.find(entry => entry.sectionIndex === 1);
    assert.ok(event, `${state}: an event for Section 2`);
    assert.deepEqual([event.carrierMismatchCount, event.anchorOutsideCitedCount, event.droppedSourceCount,
      event.shortenedSentenceCount, event.removedSentenceCount, event.action], [1, 1, 0, 0, 0, 'TRIMMED'], state);
    // Log only: the report text is the same with the switch on and off, and nothing is logged with it off.
    assert.deepEqual(on.result.output.sections, off.result.output.sections, state);
    assert.deepEqual(off.source, [], state);
    assert.ok(on.result.output.sections[1].content.includes(POINTER), state);
    assert.ok(!/Zorblax|Wholesale|CNBC/.test(JSON.stringify(event)), `${state}: counts only`);
  }
});
