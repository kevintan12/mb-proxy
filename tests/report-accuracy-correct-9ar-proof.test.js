'use strict';

// Step 9AR Build 2 strict proof. Made-up data only; no saved packages.
//
// The independent checker below writes its own expected results from the
// decision text alone (the approved word table and the "never swapped" rules).
// It has its own package, its own numbers and its own word table, and it never
// uses the Build 1 tests or the corrector's own table to decide what is right.
// Planted mistakes prove the checker catches broken correctors. The fuzzer
// generates sentences from a fixed seed, so every run sees the same sentences.

const test = require('node:test');
const assert = require('node:assert/strict');
const {buildFactLookup, findFigureClaims} = require('../lib/report-accuracy-facts');
const {correctDirectionWords} = require('../lib/report-accuracy-correct');

// ---- The checker's own package -------------------------------------------
const DATES = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
const SUBJECTS = [
  {symbol: '^GSPC', name: 'S&P 500', say: 'The S&P 500', kind: 'index',
    changes: [[12.5, 0.23], [-8.4, -0.16], [20.2, 0.37], [-15.1, -0.28], [6.3, 0.12]]},
  {symbol: '^DJI', name: 'Dow Jones Industrial Average', say: 'The Dow', kind: 'index',
    changes: [[150.25, 0.35], [-210.75, -0.49], [95.5, 0.22], [-60.4, -0.14], [300.8, 0.71]]},
  {symbol: 'NOVA', name: 'Novatek Systems Inc.', say: 'Novatek', kind: 'stock',
    changes: [[1.25, 2.31], [-0.85, -1.57], [0.42, 0.78], [-1.9, -3.44], [0.66, 1.19]]},
  {symbol: 'BLUE', name: 'Bluefin Energy Corp', say: 'Bluefin', kind: 'stock',
    changes: [[-0.33, -0.81], [0.58, 1.42], [-0.27, -0.66], [0.91, 2.24], [-0.15, -0.37]]}
];

function packageOf(subjects) {
  const entry = subject => ({
    reference: `P:${subject.symbol}`,
    snapshot: {
      symbol: subject.symbol,
      instrumentName: subject.name,
      completedSessions: subject.changes.map(([absoluteChange, percentChange], i) => ({
        sessionDate: DATES[i], close: 500 + i, absoluteChange, percentChange
      }))
    }
  });
  return {marketPackages: [{telemetry: {
    benchmarkSnapshots: subjects.filter(s => s.kind === 'index').map(entry),
    stockSnapshots: subjects.filter(s => s.kind === 'stock').map(entry)
  }}]};
}
const lookup = buildFactLookup(packageOf(SUBJECTS));

// Every change figure the checker can write, with its true direction.
function figuresOf(subject) {
  const list = [];
  subject.changes.forEach(([absolute, percent]) => {
    list.push({text: `${Math.abs(percent).toFixed(2)}%`, up: percent > 0});
    list.push(subject.kind === 'index'
      ? {text: `${Math.abs(absolute)} points`, up: absolute > 0}
      : {text: `$${Math.abs(absolute).toFixed(2)}`, up: absolute > 0});
  });
  return list;
}

// ---- The decision text, typed in by the checker --------------------------
const DOWN_FOR_UP = {rose: 'dropped', gained: 'fell', added: 'fell', climbed: 'fell', rebounded: 'fell',
  rising: 'falling', gaining: 'losing', adding: 'losing', climbing: 'falling', rebounding: 'falling', up: 'down'};
const UP_FOR_DOWN = {fell: 'rose', dropped: 'rose', lost: 'gained', declined: 'rose', slipped: 'climbed',
  falling: 'rising', dropping: 'rising', losing: 'gaining', declining: 'rising', slipping: 'climbing', down: 'up'};
const NEVER_UP = ['rise', 'rises', 'gain', 'gains', 'add', 'adds', 'climb', 'climbs', 'rebound', 'rebounds'];
const NEVER_DOWN = ['fall', 'falls', 'drop', 'drops', 'slip', 'slips', 'lose', 'loses', 'decline', 'declines'];
const isUp = word => word in DOWN_FOR_UP || NEVER_UP.includes(word);
const swapFor = word => DOWN_FOR_UP[word] || UP_FOR_DOWN[word] || null;

function withCase(word, like) {
  if (like === like.toUpperCase() && like.length > 1) return word.toUpperCase();
  if (like[0] === like[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
}

// One clause: "<subject> [was ]<word> <figure><tail>". Returns the text and
// what the checker expects the corrector to do with it.
function clause(subject, word, figure, options = {}) {
  const lower = word.toLowerCase();
  const prefix = options.prefix ?? ((lower === 'up' || lower === 'down') ? 'was ' : '');
  const tail = options.tail ?? '';
  const text = `${subject.say} ${prefix}${word} ${figure.text}${tail}`;
  const wrong = isUp(lower) !== figure.up;
  const blocked = options.blocked || !swapFor(lower);
  const fixedWord = wrong && !blocked ? withCase(swapFor(lower), word) : word;
  return {
    text,
    expected: `${subject.say} ${prefix}${fixedWord} ${figure.text}${tail}`,
    corrected: wrong && !blocked ? [{symbol: subject.symbol, oldWord: lower, newWord: swapFor(lower)}] : [],
    reasons: wrong && options.reason ? [options.reason] : []
  };
}

function sentenceOf(clauses, joiner = ', while ') {
  const body = clauses.map(c => c.text).join(joiner);
  const expected = clauses.map(c => c.expected).join(joiner);
  return {sentence: `${body}.`, expected: `${expected}.`, corrected: clauses.flatMap(c => c.corrected),
    reasons: clauses.flatMap(c => c.reasons)};
}

const [SPX, DOW, NOVA, BLUE] = SUBJECTS;
const pick = (subject, up, unitIndex = 0) => figuresOf(subject).filter(f => f.up === up)[unitIndex];

function independentCases() {
  const cases = [];
  // Every swappable word, once wrong and once right.
  for (const word of [...Object.keys(DOWN_FOR_UP), ...Object.keys(UP_FOR_DOWN)]) {
    const up = isUp(word);
    cases.push({name: `${word} wrong`, ...sentenceOf([clause(NOVA, word, pick(NOVA, !up))])});
    cases.push({name: `${word} right`, ...sentenceOf([clause(BLUE, word, pick(BLUE, up, 1))])});
  }
  // Base and -s forms: never swapped, even when wrong.
  for (const word of [...NEVER_UP, ...NEVER_DOWN]) {
    cases.push({name: `${word} never`, ...sentenceOf([clause(SPX, word, pick(SPX, !isUp(word)), {reason: 'nounOrBaseForm'})])});
  }
  // The decision's named sentences.
  cases.push({name: 'stock gained a dollar figure when it fell',
    ...sentenceOf([clause(NOVA, 'gained', {text: '$0.85', up: false}, {tail: ' on Tuesday'})])});
  cases.push({name: 'three indices, one wrong word', ...sentenceOf([
    clause(SPX, 'rose', {text: '0.37%', up: true}),
    clause(DOW, 'fell', {text: '0.22%', up: true}),
    clause(NOVA, 'gained', {text: '0.78%', up: true})
  ], ', and ')});
  // Rules from the decision text.
  cases.push({name: 'phrasal up', ...sentenceOf([clause(BLUE, 'up', {text: '$0.27', up: false}, {prefix: 'picked ', blocked: true, reason: 'upDownPhraseNotSafe'})])});
  cases.push({name: 'phrasal down', ...sentenceOf([clause(BLUE, 'down', {text: '$0.58', up: true}, {prefix: 'shot ', blocked: true, reason: 'upDownPhraseNotSafe'})])});
  cases.push({name: 'up after a comma', ...sentenceOf([clause(BLUE, 'up', {text: '$0.27', up: false}, {prefix: ', '})])});
  cases.push({name: 'reads oddly', ...sentenceOf([clause(NOVA, 'gained', {text: '$0.85', up: false}, {tail: ', its first gain this week', blocked: true, reason: 'wouldReadOddly'})])});
  cases.push({name: 'two direction words', ...sentenceOf([clause(NOVA, 'adding', {text: '$0.85', up: false}, {prefix: 'rebounded, ', blocked: true, reason: 'severalDirectionWords'})])});
  cases.push({name: 'determiner before -ing', ...sentenceOf([clause(NOVA, 'rising', {text: '$0.85', up: false}, {prefix: 'saw the ', blocked: true, reason: 'determinerBefore'})])});
  cases.push({name: 'word joined by a hyphen', ...sentenceOf([clause(NOVA, 'gained', {text: '$0.85', up: false}, {prefix: 'ever-', blocked: true, reason: 'joinedWord'})])});
  cases.push({name: 'text Build 1 reads differently before the word',
    ...sentenceOf([clause(NOVA, 'gained', {text: '$0.85', up: false}, {prefix: '… ', blocked: true, reason: 'textMismatch'})])});
  cases.push({name: 'Title case kept', ...sentenceOf([clause(NOVA, 'Gained', {text: '$0.85', up: false}, {prefix: ': '})])});
  cases.push({name: 'ALL CAPS kept', ...sentenceOf([clause(NOVA, 'GAINED', {text: '$0.85', up: false})])});
  cases.push({name: 'hedged figure is not a claim', ...sentenceOf([clause(NOVA, 'gained', {text: 'about $0.85', up: true})])});
  cases.push({name: 'same word twice, second wrong', ...sentenceOf([
    clause(SPX, 'rose', {text: '0.37%', up: true}), clause(BLUE, 'rose', {text: '$0.27', up: false})
  ], ' and ')});
  return cases;
}

const CASES = independentCases();
const DIGITS = text => JSON.stringify(text.match(/\d[\d,.]*/g) || []);

// The checker: compares a corrector's answers with its own expectations.
function checkCorrector(corrector) {
  const problems = [];
  for (const item of CASES) {
    const {sentence, record} = corrector(item.sentence, lookup);
    if (sentence !== item.expected) problems.push(`${item.name}: sentence`);
    if (DIGITS(sentence) !== DIGITS(item.sentence)) problems.push(`${item.name}: figures`);
    if (record.corrected.length !== item.corrected.length) problems.push(`${item.name}: count`);
    for (const reason of item.reasons) {
      if (!record.skipped.some(entry => entry.reason === reason)) problems.push(`${item.name}: reason ${reason}`);
    }
    record.corrected.forEach((entry, i) => {
      const want = item.corrected[i];
      if (Object.keys(entry).sort().join() !== 'newWord,oldWord,sessionDate,subject,symbol') problems.push(`${item.name}: fields`);
      if (want && (entry.symbol !== want.symbol || entry.oldWord !== want.oldWord || entry.newWord !== want.newWord)) {
        problems.push(`${item.name}: record`);
      }
    });
  }
  return problems;
}

test('independent checker: the corrector meets every expectation written from the decision text', () => {
  assert.ok(CASES.length >= 60, `cases ${CASES.length}`);
  assert.deepEqual(checkCorrector(correctDirectionWords), []);
});

// ---- Planted mistakes -----------------------------------------------------
const real = correctDirectionWords;
const changed = (input, out) => input !== out.sentence;
const ALL_WORDS = /\b[A-Za-z]+\b/g;

const PLANTED = {
  'swaps a word even when it agrees': sentence => {
    const result = real(sentence, lookup);
    const out = result.sentence.replace(ALL_WORDS, word => {
      const swap = swapFor(word.toLowerCase());
      return swap && !changed(sentence, result) ? withCase(swap, word) : word;
    });
    return {sentence: out, record: result.record};
  },
  'changes a figure': sentence => {
    const result = real(sentence, lookup);
    return changed(sentence, result)
      ? {...result, sentence: result.sentence.replace(/\d/, d => (d === '9' ? '8' : '9'))} : result;
  },
  'loses the capital letter': sentence => {
    const result = real(sentence, lookup);
    let out = result.sentence;
    for (const entry of result.record.corrected) {
      out = out.split(withCase(entry.newWord, 'X')).join(entry.newWord).split(entry.newWord.toUpperCase()).join(entry.newWord);
    }
    return {...result, sentence: out};
  },
  'uses a word Build 1 does not know': sentence => {
    const result = real(sentence, lookup);
    return {...result, sentence: result.sentence.replace(/\bfell\b/, 'shed')};
  },
  'removes the word instead of swapping': sentence => {
    const result = real(sentence, lookup);
    let out = sentence;
    for (const claim of findFigureClaims(sentence, lookup).filter(c => c.disagrees).reverse()) {
      out = out.slice(0, claim.wordStart) + out.slice(claim.wordEnd + 1);
    }
    return {...result, sentence: out};
  },
  'swaps the first copy of a repeated word': sentence => {
    const result = real(sentence, lookup);
    let out = sentence;
    for (const entry of result.record.corrected) {
      out = out.replace(new RegExp(`\\b${entry.oldWord}\\b`, 'i'), word => withCase(entry.newWord, word));
    }
    return {...result, sentence: out};
  },
  'ignores the noun rule': sentence => {
    const result = real(sentence, lookup);
    if (!result.record.skipped.some(s => s.reason === 'nounOrBaseForm')) return result;
    const out = sentence.replace(ALL_WORDS, word => (NEVER_UP.includes(word) ? 'falls'
      : NEVER_DOWN.includes(word) ? 'rises' : word));
    return {...result, sentence: out};
  },
  'leaks sentence text into the record': sentence => {
    const result = real(sentence, lookup);
    return {...result, record: {...result.record, corrected: result.record.corrected.map(e => ({...e, text: sentence}))}};
  },
  'reports no correction after correcting': sentence => {
    const result = real(sentence, lookup);
    return {...result, record: {...result.record, corrected: []}};
  },
  'touches the name': sentence => {
    const result = real(sentence, lookup);
    return changed(sentence, result) ? {...result, sentence: result.sentence.replace('Novatek', 'NOVATEK')} : result;
  },
  'ignores the up/down phrase rule': sentence => {
    const result = real(sentence, lookup);
    return {...result, sentence: result.sentence.replace('picked up', 'picked down').replace('shot down', 'shot up')};
  },
  'ignores the reads-oddly rule': sentence => {
    const result = real(sentence, lookup);
    return {...result, sentence: result.sentence.replace('gained $0.85, its first gain', 'fell $0.85, its first gain')};
  }
};

for (const [name, corrector] of Object.entries(PLANTED)) {
  test(`planted mistake caught by the independent checker: ${name}`, () => {
    assert.ok(checkCorrector(corrector).length > 0, name);
  });
}

// ---- Fuzzer -----------------------------------------------------------------
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_WORDS = [...Object.keys(DOWN_FOR_UP), ...Object.keys(UP_FOR_DOWN), ...NEVER_UP, ...NEVER_DOWN];
const TAILS = ['', ' on the day', ' in late trade', ' by the close'];

function fuzzSentence(random) {
  const choose = list => list[Math.floor(random() * list.length)];
  const count = 1 + Math.floor(random() * 3);
  const subjects = [...SUBJECTS].sort(() => random() - 0.5).slice(0, count);
  const clauses = subjects.map(subject => {
    let word = choose(FUZZ_WORDS);
    if (random() < 0.15) word = word[0].toUpperCase() + word.slice(1);
    const figure = choose(figuresOf(subject));
    const variant = random();
    if (variant < 0.08) return clause(subject, word, figure, {tail: ' as shares rallied', blocked: true});
    if (variant < 0.14 && ['up', 'down'].includes(word.toLowerCase())) {
      return clause(subject, word, figure, {prefix: 'picked ', blocked: true});
    }
    return clause(subject, word, figure, {tail: choose(TAILS)});
  });
  return sentenceOf(clauses, choose([', while ', '; ', ', and ']));
}

test('fuzzer: 120 generated sentences meet the checker and every safety property', () => {
  const random = seeded(9020);
  const failures = [];
  let corrections = 0;
  for (let i = 0; i < 120; i += 1) {
    const item = fuzzSentence(random);
    const {sentence, record} = correctDirectionWords(item.sentence, lookup);
    const fail = why => failures.push(`${i} ${why}: ${item.sentence}`);
    // Checker's own expectation.
    if (sentence !== item.expected) fail('expected');
    if (record.corrected.length !== item.corrected.length) fail('count');
    corrections += record.corrected.length;
    // (a) only word spans change: same words in the same places otherwise.
    const before = item.sentence.split(/\b/);
    const after = sentence.split(/\b/);
    if (before.length !== after.length) fail('shape');
    const swapped = before.filter((part, k) => part !== after[k]);
    if (swapped.some(part => !swapFor(part.toLowerCase()))) fail('non-direction text changed');
    // (b) figures, names and dates byte-identical.
    if (DIGITS(sentence) !== DIGITS(item.sentence)) fail('figures');
    for (const subject of SUBJECTS) {
      if (item.sentence.includes(subject.say) !== sentence.includes(subject.say)) fail('name');
    }
    // (c) Build 1 sees no disagreement where a correction was made.
    const claimsAfter = findFigureClaims(sentence, lookup);
    const correctedSymbols = new Set(record.corrected.map(e => e.symbol));
    if (claimsAfter.some(c => correctedSymbols.has(c.symbol) && c.disagrees)) fail('still disagrees');
    // (d) running it twice changes nothing more.
    if (correctDirectionWords(sentence, lookup).sentence !== sentence) fail('not stable');
    // (e) nothing corrected means byte-identical.
    if (!record.corrected.length && sentence !== item.sentence) fail('changed without a correction');
    // (f) counts-only record.
    for (const entry of [...record.corrected, ...record.skipped]) {
      if (Object.values(entry).some(value => typeof value === 'string' && value.length > 40)) fail('record text');
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(corrections >= 30, `corrections ${corrections}`);
});
