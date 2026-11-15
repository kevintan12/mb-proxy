// Step 9AB.1: the Further Readings topic rule (two or more shared companies = one topic) applies
// ONLY to links read but not cited. A cited article is always listed, in section order, up to the
// furtherReadingMaxLinks ceiling. Recaps, order, scoring, reading and the writer request are not
// touched. Made-up items only: no network, no paid call.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {resolvedFurtherReadingReferences, resolveFurtherReadings} = require('../lib/claude-analysis-contract');

const yahoo = (slug, title, symbols) => ({
  sourceId: 'us.yahoo-finance', market: 'US', evidenceCategory: 'news', title,
  canonicalUrl: `https://finance.yahoo.com/news/${slug}.html`, symbols
});

// items = [[title, symbols]]; readings = [[ref, kind?]]. Only what the resolver reads.
function buildInput(items, readings, marketState = 'WEEKEND') {
  return {
    analysisRequest: {selectedScope: 'US', generatedAt: '2026-09-06T10:00:00.000Z'},
    marketPackages: [{
      market: 'US',
      marketContext: {marketState},
      evidenceContext: {
        evidence: items.map(([title, symbols], index) => ({reference: `e${index + 1}`, item: yahoo(`a${index + 1}`, title, symbols)})),
        furtherReadings: readings.map(([evidenceRef, kind]) => kind === undefined
          ? {evidenceRef, sessionDate: '2026-09-04'} : {evidenceRef, sessionDate: '2026-09-04', kind})
      }
    }]
  };
}
// citing = {sectionIndex: [refs]}
function outputCiting(citing) {
  const sections = Array.from({length: 8}, () => ({content: null, evidenceRefs: [], telemetryRefs: []}));
  for (const [index, refs] of Object.entries(citing)) {
    sections[index] = {content: `Section ${Number(index) + 1} text.`, evidenceRefs: refs, telemetryRefs: []};
  }
  return {sections};
}

const MICRON_AMD_NVDA = ['MU', 'AMD', 'NVDA'];

test('Step 9AB.1: a cited article sharing two companies with another cited article is listed', () => {
  const input = buildInput([
    ['Micron, AMD and Nvidia Lead AI Stocks Rebound After Historic Selloff', MICRON_AMD_NVDA],
    ['Nvidia, AMD, and Micron stocks lead chip sector higher following worst sell-off since 2020', MICRON_AMD_NVDA]
  ], [['e1', 'READ'], ['e2', 'READ']], 'REGULAR');
  const output = outputCiting({2: ['e1', 'e2']});
  // the live-day filter only drops uncited, non-current articles; cited ones are always eligible
  assert.deepEqual(resolvedFurtherReadingReferences(output, input), ['e1', 'e2']);
});

test('Step 9AB.1: a cited article is listed even when it shares two companies with an uncited one read first in the package', () => {
  const input = buildInput([
    ['Chip stocks bounce', MICRON_AMD_NVDA],
    ['Micron, AMD and Nvidia rebound', MICRON_AMD_NVDA]
  ], [['e1', 'READ'], ['e2', 'READ']]);
  // e2 is cited, e1 is only read: cited group goes first, so e2 is listed and e1 folds into it
  assert.deepEqual(resolvedFurtherReadingReferences(outputCiting({0: ['e2']}), input), ['e2']);
});

test('Step 9AB.1: an uncited article sharing two companies with a listed one is still folded', () => {
  const input = buildInput([
    ['Micron, AMD and Nvidia rebound', MICRON_AMD_NVDA],
    ['Chip stocks lead the market higher', ['NVDA', 'AMD']],
    ['Another chip rebound story', ['MU', 'NVDA']],
    ['Apple earnings preview', ['AAPL']]
  ], [['e1', 'READ'], ['e2', 'READ'], ['e3', 'READ'], ['e4', 'READ']]);
  // e1 cited and listed; e2 and e3 are uncited look-alikes (two shared companies) and fold;
  // e4 shares none and stays
  assert.deepEqual(resolvedFurtherReadingReferences(outputCiting({0: ['e1']}), input), ['e1', 'e4']);
  // two uncited look-alikes with nothing cited: the first stays, the second folds
  assert.deepEqual(resolvedFurtherReadingReferences(outputCiting({}), input), ['e1', 'e4']);
});

test('Step 9AB.1: a single shared company never folds, cited or not', () => {
  const input = buildInput([
    ['Nvidia chips', ['NVDA', 'AMD']],
    ['Nvidia earnings', ['NVDA', 'MSFT']]
  ], [['e1', 'READ'], ['e2', 'READ']]);
  assert.deepEqual(resolvedFurtherReadingReferences(outputCiting({}), input), ['e1', 'e2']);
});

test('Step 9AB.1: recaps are unchanged (exempt from the topic rule, listed first on completed days)', () => {
  const input = buildInput([
    ['Stock market today: chips rebound', MICRON_AMD_NVDA],
    ['Stock market today: Nvidia and AMD lead', MICRON_AMD_NVDA],
    ['Uncited look-alike read', MICRON_AMD_NVDA]
  ], [['e1', 'RECAP'], ['e2', 'RECAP'], ['e3', 'READ']]);
  // both recaps listed although they share three companies; recaps never seed the topic list,
  // so the uncited read is listed after them (as before this step)
  assert.deepEqual(resolvedFurtherReadingReferences(outputCiting({}), input), ['e1', 'e2', 'e3']);
  // a cited article is still listed after recaps
  assert.deepEqual(resolvedFurtherReadingReferences(outputCiting({0: ['e3']}), input), ['e1', 'e2', 'e3']);
});

test('Step 9AB.1: cited articles keep section order (1, 2, 3, 5, 6, 7, then 4)', () => {
  const input = buildInput(
    [1, 2, 3, 4, 5, 6].map(n => [`Story ${n}`, []]),
    [['e1', 'READ']]);
  const output = outputCiting({0: ['e6'], 1: ['e5'], 2: ['e4'], 4: ['e3'], 5: ['e2'], 6: ['e1']});
  assert.deepEqual(resolvedFurtherReadingReferences(output, input), ['e6', 'e5', 'e4', 'e3', 'e2', 'e1']);
  const section4First = outputCiting({3: ['e1'], 2: ['e2']});
  assert.deepEqual(resolvedFurtherReadingReferences(section4First, input), ['e2', 'e1']);
});

test('Step 9AB.1: the total ceiling of 15 still holds, with cited articles first', () => {
  const count = 20;
  const items = Array.from({length: count}, (_, i) => [`Story ${i + 1}`, ['MU', 'AMD']]);
  const input = buildInput(items, items.map((_, i) => [`e${i + 1}`, 'READ']));
  // e16..e20 are cited (and share two companies with each other); e1..e15 are uncited reads
  const cited = ['e16', 'e17', 'e18', 'e19', 'e20'];
  const result = resolvedFurtherReadingReferences(outputCiting({2: cited}), input);
  assert.equal(result.length, 5, 'the five cited all list; every uncited read folds into them');
  assert.deepEqual(result, cited);
  // unrelated stories: cited take their places first, then the ceiling stops the rest
  const loose = Array.from({length: count}, (_, i) => [`Story ${i + 1}`, []]);
  const looseInput = buildInput(loose, loose.map((_, i) => [`e${i + 1}`, 'READ']));
  const looseResult = resolvedFurtherReadingReferences(outputCiting({2: cited}), looseInput);
  assert.equal(looseResult.length, 15);
  assert.deepEqual(looseResult.slice(0, 5), cited);
  // twenty cited articles sharing the same companies: the ceiling cuts at 15, in section order
  const allCited = Array.from({length: count}, (_, i) => `e${i + 1}`);
  const capped = resolvedFurtherReadingReferences(outputCiting({2: allCited}), input);
  assert.deepEqual(capped, allCited.slice(0, 15));
});

test('Step 9AB.1: Sections 1 to 7 are returned unchanged; only furtherReadings is added', () => {
  const input = buildInput([
    ['Micron, AMD and Nvidia rebound', MICRON_AMD_NVDA],
    ['Chip sector higher after the sell-off', MICRON_AMD_NVDA]
  ], [['e1', 'READ'], ['e2', 'READ']]);
  const output = outputCiting({2: ['e1', 'e2']});
  const before = structuredClone(output);
  const resolved = resolveFurtherReadings(output, input);
  assert.deepEqual(resolved.sections, before.sections);
  assert.deepEqual(output, before, 'the input output object is not mutated');
  assert.deepEqual(resolved.furtherReadings, ['e1', 'e2']);
});
