// Step 9AO: an uncited Further Readings link is not listed when its only market signal is a
// loose word (futures, dollar, bonds) and it has no second signal. Cited links and recaps are
// never touched; scoring, reading and the writer request are not touched. Made-up items only:
// no network, no paid call.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {resolvedFurtherReadingReferences} = require('../lib/claude-analysis-contract');
const {hasOnlyLooseMarketSignal} = require('../lib/headline-matching');

const yahoo = (slug, title) => ({
  sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news', title,
  canonicalUrl: `https://finance.yahoo.com/news/${slug}.html`, symbols: []
});

// A minimal input: only what the resolver reads. readings = [[ref, kind?]].
function buildInput(titles, readings, marketState = 'WEEKEND') {
  return {
    analysisRequest: {selectedScope: 'US', generatedAt: '2026-09-06T10:00:00.000Z'},
    marketPackages: [{
      market: 'US',
      marketContext: {marketState},
      evidenceContext: {
        evidence: titles.map((title, index) => ({reference: `e${index + 1}`, item: yahoo(`a${index + 1}`, title)})),
        furtherReadings: readings.map(([evidenceRef, kind]) => kind === undefined
          ? {evidenceRef, sessionDate: '2026-09-04'} : {evidenceRef, sessionDate: '2026-09-04', kind})
      }
    }]
  };
}
function outputCiting(refs) {
  const sections = Array.from({length: 8}, () => ({content: null, evidenceRefs: [], telemetryRefs: []}));
  if (refs.length) sections[0] = {content: 'Stocks moved.', evidenceRefs: refs, telemetryRefs: []};
  return {sections};
}

test('Step 9AO: each loose word alone removes an uncited link', () => {
  for (const title of [
    'TSX futures edged lower amid fallout from AI-driven stock rout',
    'Polymarket wins approval as a futures broker',
    'Rupee slips against the dollar again',
    'Investors pile into bonds'
  ]) {
    assert.equal(hasOnlyLooseMarketSignal(title), true, title);
    const input = buildInput([title, 'Fed holds rates steady as inflation cools'], [['e1'], ['e2']]);
    assert.deepEqual(resolvedFurtherReadingReferences(outputCiting([]), input), ['e2'], title);
  }
});

test('Step 9AO: a loose word with a second signal is kept', () => {
  for (const title of [
    'Japanese investors snap up foreign long-term bonds as tech stocks slide',   // tier 3a: stocks
    'Futures fall as the Fed signals a rate hike',                                // other macro terms
    'Dollar steadies as oil climbs',                                              // other macro term: oil
    'Bonds rally in Europe as the FTSE slides',                                   // Asia/Europe word
    'Futures point lower ahead of the market open'                                // tier 3a: market
  ]) {
    assert.equal(hasOnlyLooseMarketSignal(title), false, title);
    const input = buildInput([title], [['e1']]);
    assert.deepEqual(resolvedFurtherReadingReferences(outputCiting([]), input), ['e1'], title);
  }
});

test('Step 9AO: an AI-theme word is not a second signal', () => {
  for (const title of ['Nvidia drags futures lower', 'AI fears hit bonds', 'OpenAI news moves the dollar']) {
    assert.equal(hasOnlyLooseMarketSignal(title), true, title);
  }
  const input = buildInput(['Nvidia drags futures lower'], [['e1']]);
  assert.deepEqual(resolvedFurtherReadingReferences(outputCiting([]), input), []);
});

test('Step 9AO: a headline with no loose word is not touched by this rule', () => {
  assert.equal(hasOnlyLooseMarketSignal('A quiet day for a small retailer'), false);
  assert.equal(hasOnlyLooseMarketSignal('Dollar General opens new stores'), false);
  assert.equal(hasOnlyLooseMarketSignal(undefined), false);
  const input = buildInput(['A quiet day for a small retailer'], [['e1']]);
  assert.deepEqual(resolvedFurtherReadingReferences(outputCiting([]), input), ['e1']);
});

test('Step 9AO: a cited link is never removed, and an uncited twin is', () => {
  const input = buildInput([
    'Dollar climbs as stock rout spreads', 'TSX futures edged lower amid fallout from AI-driven stock rout'
  ], [['e1'], ['e2']]);
  assert.deepEqual(resolvedFurtherReadingReferences(outputCiting(['e1']), input), ['e1']);
  assert.deepEqual(resolvedFurtherReadingReferences(outputCiting(['e1', 'e2']), input), ['e1', 'e2']);
  // Cited by the writer even though the package did not offer it as a reading.
  const unoffered = buildInput(['Rupee slips against the dollar again'], []);
  assert.deepEqual(resolvedFurtherReadingReferences(outputCiting(['e1']), unoffered), ['e1']);
});

test('Step 9AO: a recap with only a loose word is never removed', () => {
  const input = buildInput(['Dollar slips as futures wobble'], [['e1', 'RECAP']]);
  assert.deepEqual(resolvedFurtherReadingReferences(outputCiting([]), input), ['e1']);
});

test('Step 9AO: the output and the package are not changed by the resolver', () => {
  const input = buildInput(['Rupee slips against the dollar again', 'Fed holds rates steady'], [['e1'], ['e2']]);
  const output = outputCiting(['e2']);
  const inputBefore = structuredClone(input);
  const outputBefore = structuredClone(output);
  resolvedFurtherReadingReferences(output, input);
  assert.deepEqual(input, inputBefore);
  assert.deepEqual(output, outputBefore);
});

test('Step 9AO: the singular "stock" next to "futures" is a second signal', () => {
  for (const title of [
    'U.S. stock futures edge higher after bruising Oct; earnings, elections in focus',
    'Stock futures open a monster week after a $5 trillion AI wipeout'
  ]) {
    assert.equal(hasOnlyLooseMarketSignal(title), false, title);
    const input = buildInput([title], [['e1']]);
    assert.deepEqual(resolvedFurtherReadingReferences(outputCiting([]), input), ['e1'], title);
  }
  // "stock" does not rescue dollar or bonds, and futures without "stock futures" is still loose.
  assert.equal(hasOnlyLooseMarketSignal('Rupee slips against the dollar as stock picks lag'), true);
  assert.equal(hasOnlyLooseMarketSignal('Cattle futures slip'), true);
});

test('Step 9AO: "stock" only beside "futures" counts; the TSX futures headline is removed', () => {
  assert.equal(hasOnlyLooseMarketSignal('TSX futures edged lower amid fallout from AI-driven stock rout'), true);
  assert.equal(hasOnlyLooseMarketSignal('Wall Street stocks futures slip'), false);
  assert.equal(hasOnlyLooseMarketSignal('Rupee slips against the dollar as stock picks lag'), true);
  const input = buildInput(['TSX futures edged lower amid fallout from AI-driven stock rout', 'Fed holds rates steady'], [['e1'], ['e2']]);
  assert.deepEqual(resolvedFurtherReadingReferences(outputCiting([]), input), ['e2']);
});
