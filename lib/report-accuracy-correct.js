'use strict';

// Step 9AR Build 2: correct a wrong up or down word in one sentence, using the
// package's own price data through Build 1 (lib/report-accuracy-facts.js).
// Decision (Kevin): a wrong direction word is corrected from the data, never
// removed. Pure function. It is NOT connected to the pipeline.
//
// Only the one direction word is replaced, by a word of the same tense and
// form, so nothing else in the sentence has to change. Figures, names and
// dates are never touched. When a swap is not clearly safe the sentence is
// returned unchanged and the reason is counted.

const {findFigureClaims} = require('./report-accuracy-facts');

// Every new word is on Build 1's opposite list, so Build 1 reads the
// corrected sentence as agreeing.
const SWAP = Object.freeze({
  // up word found, data says down
  rose: 'dropped', gained: 'fell', added: 'fell', climbed: 'fell', rebounded: 'fell',
  rising: 'falling', gaining: 'losing', adding: 'losing', climbing: 'falling', rebounding: 'falling',
  up: 'down',
  // down word found, data says up
  fell: 'rose', dropped: 'rose', lost: 'gained', declined: 'rose', slipped: 'climbed',
  falling: 'rising', dropping: 'rising', losing: 'gaining', declining: 'rising', slipping: 'climbing',
  down: 'up'
});

// Build 1's direction words (both lists): used to spot a second direction
// word in the same window.
const DIRECTION_WORDS = new Set([
  'rose', 'rise', 'rises', 'rising', 'gained', 'gain', 'gains', 'gaining',
  'up', 'added', 'add', 'adds', 'adding', 'climbed', 'climb', 'climbs', 'climbing',
  'rebounded', 'rebound', 'rebounds', 'rebounding',
  'fell', 'fall', 'falls', 'falling', 'dropped', 'drop', 'drops', 'dropping',
  'down', 'slipped', 'slip', 'slips', 'slipping', 'lost', 'lose', 'loses', 'losing',
  'declined', 'decline', 'declines', 'declining'
]);

// Words that would make the corrected sentence contradict itself.
const ODD_WORDS = new Set([...DIRECTION_WORDS,
  'higher', 'lower', 'advance', 'advanced', 'advances', 'retreat', 'retreated',
  'rally', 'rallied', 'slide', 'slid', 'jumped', 'surged', 'tumbled', 'plunged',
  'sank', 'soared', 'loss', 'losses'
]);

const DETERMINER_BEFORE = /(?:^|[^A-Za-z])(?:a|an|the|its|their|this|that|his|her|our)\s+$/i;
const UP_DOWN_SAFE_BEFORE = /(?:^|[^A-Za-z])(?:closed|ended|finished|settled|traded|trading|was|were|is|are|moved|ticked|edged|inched)\s+$/i;
const UP_DOWN_SAFE_PUNCTUATION = /[,(—–:-]\s*$/;
const JOINED = /[\p{L}\p{N}'’-]/u;
const NUMBERS = /\d[\d,.]*/g;

const REASONS = Object.freeze([
  'nounOrBaseForm', 'determinerBefore', 'upDownPhraseNotSafe', 'joinedWord',
  'unusualCapitals', 'severalDirectionWords', 'textMismatch', 'wouldReadOddly',
  'selfCheckFailed'
]);

function tokens(text, offset) {
  const list = [];
  const pattern = /[A-Za-z]+/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    list.push({word: match[0].toLowerCase(), start: offset + match.index, end: offset + match.index + match[0].length});
  }
  return list;
}

function casePattern(text) {
  if (text === text.toLowerCase()) return 'lower';
  if (text.length > 1 && text === text.toUpperCase()) return 'upper';
  if (text[0] === text[0].toUpperCase() && text.slice(1) === text.slice(1).toLowerCase()) return 'title';
  return null;
}

function applyCase(word, pattern) {
  if (pattern === 'upper') return word.toUpperCase();
  if (pattern === 'title') return word[0].toUpperCase() + word.slice(1);
  return word;
}

// Returns {newWord} or {reason}.
function judgeClaim(claim, sentence, normalized, ownWords) {
  const oldWord = claim.sentenceWord;
  if (!Number.isInteger(claim.wordStart) || !Number.isInteger(claim.wordEnd)) return {reason: 'textMismatch'};
  const start = claim.wordStart;
  const end = claim.wordEnd;
  // The text up to the word must line up with what Build 1 read.
  if (sentence.slice(0, end).normalize('NFKC') !== normalized.slice(0, end)) return {reason: 'textMismatch'};
  const original = sentence.slice(start, end);
  if (original.toLowerCase() !== oldWord) return {reason: 'textMismatch'};
  const newWord = SWAP[oldWord];
  if (!newWord) return {reason: 'nounOrBaseForm'};
  if ((start > 0 && JOINED.test(sentence[start - 1])) || (end < sentence.length && JOINED.test(sentence[end]))) {
    return {reason: 'joinedWord'};
  }
  const pattern = casePattern(original);
  if (!pattern) return {reason: 'unusualCapitals'};
  const before = normalized.slice(claim.windowStart, start);
  if (oldWord.endsWith('ing') && DETERMINER_BEFORE.test(normalized.slice(0, start))) {
    return {reason: 'determinerBefore'};
  }
  if (oldWord === 'up' || oldWord === 'down') {
    const safe = !before.trim() || UP_DOWN_SAFE_PUNCTUATION.test(before) || UP_DOWN_SAFE_BEFORE.test(before);
    if (!safe) return {reason: 'upDownPhraseNotSafe'};
  }
  const windowWords = tokens(normalized.slice(claim.windowStart, claim.windowEnd), claim.windowStart)
    .filter(token => DIRECTION_WORDS.has(token.word));
  if (windowWords.length !== 1) return {reason: 'severalDirectionWords'};
  const segmentWords = tokens(normalized.slice(claim.segmentStart, claim.segmentEnd), claim.segmentStart)
    .filter(token => ODD_WORDS.has(token.word) && !ownWords.has(token.start));
  if (segmentWords.length) return {reason: 'wouldReadOddly'};
  return {newWord: applyCase(newWord, pattern)};
}

function entry(claim) {
  return {subject: claim.subject, symbol: claim.symbol, sessionDate: claim.sessionDate, oldWord: claim.sentenceWord};
}

function sameClaim(a, b) {
  return a.symbol === b.symbol && a.figure === b.figure && a.unit === b.unit && a.sessionDate === b.sessionDate;
}

function selfCheck(sentence, output, swaps, claims, lookup) {
  // Put the old words back, left to right: must give the input exactly. Each
  // restored word puts the text before the next swap back in input positions.
  let restored = output;
  const ascending = [...swaps].sort((a, b) => a.start - b.start);
  for (const swap of ascending) {
    const at = swap.start;
    if (restored.slice(at, at + swap.newText.length) !== swap.newText) return false;
    restored = restored.slice(0, at) + swap.oldText + restored.slice(at + swap.newText.length);
  }
  if (restored !== sentence) return false;
  // Figures and dates unchanged.
  if (JSON.stringify(sentence.match(NUMBERS) || []) !== JSON.stringify(output.match(NUMBERS) || [])) return false;
  // Build 1 on the output: same claims, corrected ones now agree, the rest as before.
  const after = findFigureClaims(output, lookup);
  if (after.length !== claims.length) return false;
  const corrected = new Set(swaps.map(swap => swap.claimIndex));
  return claims.every((claim, i) => sameClaim(claim, after[i])
    && after[i].disagrees === (corrected.has(i) ? false : claim.disagrees));
}

function correctDirectionWords(sentence, lookup) {
  const record = {claims: 0, agreed: 0, corrected: [], skipped: []};
  if (typeof sentence !== 'string' || !sentence) return {sentence, record};
  const claims = findFigureClaims(sentence, lookup);
  record.claims = claims.length;
  if (!claims.length) return {sentence, record};
  const normalized = sentence.normalize('NFKC');
  const ownWords = new Set(claims.filter(claim => Number.isInteger(claim.wordStart)).map(claim => claim.wordStart));
  const swaps = [];
  claims.forEach((claim, claimIndex) => {
    if (!claim.disagrees) {
      record.agreed += 1;
      return;
    }
    const verdict = judgeClaim(claim, sentence, normalized, ownWords);
    if (verdict.reason) {
      record.skipped.push({...entry(claim), reason: verdict.reason});
      return;
    }
    swaps.push({claimIndex, claim, start: claim.wordStart, end: claim.wordEnd,
      oldText: sentence.slice(claim.wordStart, claim.wordEnd), newText: verdict.newWord});
  });
  if (!swaps.length) return {sentence, record};
  let output = sentence;
  for (const swap of [...swaps].sort((a, b) => b.start - a.start)) {
    output = output.slice(0, swap.start) + swap.newText + output.slice(swap.end);
  }
  if (!selfCheck(sentence, output, swaps, claims, lookup)) {
    for (const swap of swaps) record.skipped.push({...entry(swap.claim), reason: 'selfCheckFailed'});
    return {sentence, record};
  }
  for (const swap of swaps) {
    record.corrected.push({...entry(swap.claim), newWord: swap.newText.toLowerCase()});
  }
  return {sentence: output, record};
}

module.exports = {correctDirectionWords, SWAP_WORDS: SWAP, SKIP_REASONS: REASONS};
