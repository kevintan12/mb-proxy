'use strict';

// Step 9AR Build 1: read-only helpers that find a named index or stock next to
// a change figure in one sentence and compare the direction word with the
// package's own price data. Pure functions. They edit nothing and are NOT
// connected to the pipeline yet.
//
// Package shape read (marketPackages[0].telemetry):
//   benchmarkSnapshots / stockSnapshots: [{reference, snapshot: {symbol,
//   instrumentName, completedSessions: [{sessionDate, close, absoluteChange,
//   percentChange}]}}]

const SESSIONS_KEPT = 5;

// Index aliases by symbol. Case-sensitive entries are listed in CASE_SENSITIVE.
const INDEX_ALIASES = Object.freeze({
  '^GSPC': ['S&P 500', 'S&P'],
  '^IXIC': ['Nasdaq Composite', 'Nasdaq'],
  '^DJI': ['Dow Jones Industrial Average', 'Dow Jones', 'Dow'],
  '^RUT': ['Russell 2000', 'Russell']
});
const CASE_SENSITIVE_ALIASES = new Set(['Dow', 'S&P', 'Russell']);

const COMPANY_SUFFIX = /[,\s]+(?:inc\.?|incorporated|corp\.?|corporation|co\.?|company|ltd\.?|limited|plc|holdings?|group|class\s+[a-c]|n\.?v\.?|s\.?a\.?)\.?$/i;

const UP_WORDS = Object.freeze({
  rose: 1, rise: 1, rises: 1, rising: 1, gained: 1, gain: 1, gains: 1, gaining: 1,
  up: 1, added: 1, add: 1, adds: 1, adding: 1, climbed: 1, climb: 1, climbs: 1, climbing: 1,
  rebounded: 1, rebound: 1, rebounds: 1, rebounding: 1
});
const DOWN_WORDS = Object.freeze({
  fell: 1, fall: 1, falls: 1, falling: 1, dropped: 1, drop: 1, drops: 1, dropping: 1,
  down: 1, slipped: 1, slip: 1, slips: 1, slipping: 1, lost: 1, lose: 1, loses: 1, losing: 1,
  declined: 1, decline: 1, declines: 1, declining: 1
});

const FIGURE = /(\$)?(\d{1,3}(?:,\d{3})+\.\d+|\d+\.\d+)(?!\d)/g;
const HEDGE_BEFORE = /\b(?:about|nearly|almost|roughly|around|approximately|just\s+over|just\s+under|more\s+than|less\s+than|over|under|up\s+to|close\s+to|at\s+least|at\s+most|some)\s*$/i;
const LEVEL_BEFORE = /\b(?:to|at|closed\s+at|ended\s+at|settled\s+at|finished\s+at|from|near|above|below)\s*$/i;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
}

function termPattern(term, caseSensitive) {
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])(${escapeRegex(term.normalize('NFKC'))})(?=$|[^\\p{L}\\p{N}])`,
    caseSensitive ? 'gu' : 'giu');
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sessionsOf(snapshot) {
  const list = Array.isArray(snapshot?.completedSessions) ? snapshot.completedSessions : [];
  return list
    .filter(session => session && typeof session.sessionDate === 'string'
      && (finite(session.absoluteChange) || finite(session.percentChange)))
    .map(session => ({
      date: session.sessionDate,
      close: finite(session.close) ? session.close : null,
      absoluteChange: finite(session.absoluteChange) ? session.absoluteChange : null,
      percentChange: finite(session.percentChange) ? session.percentChange : null
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(-SESSIONS_KEPT);
}

function companyAliases(name) {
  const aliases = [];
  if (typeof name !== 'string' || !name.trim()) return aliases;
  const full = name.trim();
  aliases.push({term: full, caseSensitive: false});
  let stripped = full;
  for (let i = 0; i < 3 && COMPANY_SUFFIX.test(stripped); i += 1) stripped = stripped.replace(COMPANY_SUFFIX, '');
  if (stripped && stripped !== full) aliases.push({term: stripped, caseSensitive: false});
  const first = stripped.replace(/^the\s+/i, '').split(/[\s,]+/)[0];
  if (first && first.length >= 3) aliases.push({term: first, caseSensitive: true});
  return aliases;
}

// lookup: {subjects: [{symbol, name, kind, sessions}], matchers: [{subject, regex}]}
function buildFactLookup(analysisPackage) {
  const telemetry = analysisPackage?.marketPackages?.[0]?.telemetry || {};
  const entries = (Array.isArray(telemetry.benchmarkSnapshots) ? telemetry.benchmarkSnapshots : [])
    .map(entry => ({entry, kind: 'index'}))
    .concat((Array.isArray(telemetry.stockSnapshots) ? telemetry.stockSnapshots : [])
      .map(entry => ({entry, kind: 'stock'})));
  const subjects = [];
  const aliasOwners = new Map();
  for (const {entry, kind} of entries) {
    const snapshot = entry?.snapshot;
    if (!snapshot || typeof snapshot.symbol !== 'string') continue;
    const sessions = sessionsOf(snapshot);
    if (!sessions.length) continue;
    const subject = {
      symbol: snapshot.symbol,
      name: typeof snapshot.instrumentName === 'string' ? snapshot.instrumentName : snapshot.symbol,
      kind,
      sessions
    };
    const aliases = [];
    for (const term of INDEX_ALIASES[snapshot.symbol] || []) {
      aliases.push({term, caseSensitive: CASE_SENSITIVE_ALIASES.has(term)});
    }
    aliases.push(...companyAliases(snapshot.instrumentName));
    const ticker = snapshot.symbol.replace(/^\^/, '');
    if (kind === 'stock' && ticker.length >= 2) aliases.push({term: ticker, caseSensitive: true});
    subjects.push(subject);
    for (const alias of aliases) {
      const key = `${alias.caseSensitive ? 'S' : 'I'}:${alias.term.toLowerCase()}`;
      const owners = aliasOwners.get(key) || {alias, owners: new Set()};
      owners.owners.add(subject);
      aliasOwners.set(key, owners);
    }
  }
  const matchers = [];
  for (const {alias, owners} of aliasOwners.values()) {
    if (owners.size !== 1) continue; // an alias that names two subjects names neither
    matchers.push({subject: [...owners][0], regex: termPattern(alias.term, alias.caseSensitive)});
  }
  return {subjects, matchers};
}

function findMentions(sentence, lookup) {
  const found = [];
  for (const {subject, regex} of lookup.matchers) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(sentence)) !== null) {
      const start = match.index + match[0].length - match[1].length;
      found.push({subject, start, end: start + match[1].length});
      if (match[0].length === 0) regex.lastIndex += 1;
    }
  }
  // Longest first, drop anything overlapping an already kept mention.
  found.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const kept = [];
  for (const mention of found) {
    if (!kept.some(other => mention.start < other.end && other.start < mention.end)) kept.push(mention);
  }
  kept.sort((a, b) => a.start - b.start);
  // Merge back-to-back mentions of the same subject, e.g. "Copart (CPRT)".
  const merged = [];
  for (const mention of kept) {
    const last = merged[merged.length - 1];
    if (last && last.subject === mention.subject
        && /^[\s(),]*$/.test(sentence.slice(last.end, mention.start))) {
      last.end = mention.end;
    } else {
      merged.push({...mention});
    }
  }
  return merged;
}

function directionOfWords(text) {
  const words = text.toLowerCase().match(/[a-z]+/g) || [];
  let up = null;
  let down = null;
  for (const word of words) {
    if (UP_WORDS[word]) up = word;
    if (DOWN_WORDS[word]) down = word;
  }
  if (up && down) return null; // mixed words between name and figure: do not guess
  if (up) return {direction: 'up', word: up};
  if (down) return {direction: 'down', word: down};
  return null;
}

function roundedKey(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round((Math.abs(value) + 1e-9) * factor);
}

function figureUnit(sentence, figureEnd, hasDollar) {
  const after = sentence.slice(figureEnd);
  if (/^\s*(?:percentage\s+points?|ppt?s?\b|basis\s+points?|bps?\b)/i.test(after)) return null;
  if (/^\s*(?:%|percent\b|per\s*cent\b)/i.test(after)) return 'percent';
  if (/^\s*(?:index\s+)?(?:points?|pts?)\b/i.test(after)) return 'points';
  if (hasDollar) return 'dollar';
  return null; // a bare decimal is not a change figure we can read
}

function matchSessions(subject, unit, value, decimals) {
  const want = roundedKey(value, decimals);
  const field = unit === 'percent' ? 'percentChange' : 'absoluteChange';
  return subject.sessions.filter(session => finite(session[field])
    && roundedKey(session[field], decimals) === want);
}

// Step 9AR Build 2: where the last token equal to `word` sits in the window.
function lastWordSpan(windowText, word) {
  const tokens = /[A-Za-z]+/g;
  let span = null;
  let token;
  while ((token = tokens.exec(windowText)) !== null) {
    if (token[0].toLowerCase() === word) span = {start: token.index, end: token.index + token[0].length};
  }
  return span;
}

function claimsInSegment(sentence, mention, segmentEnd) {
  const claims = [];
  const base = mention.end;
  const text = sentence.slice(mention.end, segmentEnd);
  FIGURE.lastIndex = 0;
  let previousEnd = 0;
  let match;
  while ((match = FIGURE.exec(text)) !== null) {
    const figureStart = match.index;
    const figureEnd = figureStart + match[0].length;
    const windowText = text.slice(previousEnd, figureStart);
    const windowStart = previousEnd;
    previousEnd = figureEnd;
    const before = windowText.replace(/\s+$/, '');
    if (HEDGE_BEFORE.test(before) || LEVEL_BEFORE.test(before)) continue;
    const decimals = match[2].split('.')[1].length;
    const unit = figureUnit(text, figureEnd, Boolean(match[1]));
    if (!unit) continue;
    const word = directionOfWords(windowText);
    if (!word) continue;
    const value = Number(match[2].replace(/,/g, ''));
    const matched = matchSessions(mention.subject, unit, value, decimals);
    if (matched.length !== 1) continue; // none (pre-market, foreign listing) or several sessions
    const field = unit === 'percent' ? 'percentChange' : 'absoluteChange';
    const change = matched[0][field];
    if (change === 0) continue;
    const trueDirection = change > 0 ? 'up' : 'down';
    const span = lastWordSpan(windowText, word.word);
    claims.push({
      subject: mention.subject.name,
      symbol: mention.subject.symbol,
      figure: match[0],
      unit,
      sessionDate: matched[0].date,
      trueDirection,
      sentenceDirection: word.direction,
      sentenceWord: word.word,
      disagrees: trueDirection !== word.direction,
      // Step 9AR Build 2: positions in the NFKC-normalised sentence.
      wordStart: span ? base + windowStart + span.start : null,
      wordEnd: span ? base + windowStart + span.end : null,
      windowStart: base + windowStart,
      windowEnd: base + figureStart,
      segmentStart: base,
      segmentEnd
    });
  }
  return claims;
}

const JOINER_GAP = /^[\s,;&]*(?:and\s+|&\s*)?(?:the\s+)?$/i;

// Returns an array of claims (empty when the sentence is skipped).
function findFigureClaims(sentence, lookup) {
  if (typeof sentence !== 'string' || !sentence || !lookup?.matchers?.length) return [];
  const text = sentence.normalize('NFKC');
  const mentions = findMentions(text, lookup);
  const claims = [];
  for (let i = 0; i < mentions.length; i += 1) {
    const mention = mentions[i];
    const segmentEnd = i + 1 < mentions.length ? mentions[i + 1].start : text.length;
    const previous = mentions[i - 1];
    // "The Nasdaq and the S&P 500 rose 0.5%": two names, one figure, no clear order.
    if (previous && previous.subject !== mention.subject
        && JOINER_GAP.test(text.slice(previous.end, mention.start))) continue;
    claims.push(...claimsInSegment(text, mention, segmentEnd));
  }
  return claims;
}

module.exports = {buildFactLookup, findFigureClaims};
