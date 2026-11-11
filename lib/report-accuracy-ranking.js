'use strict';

// Step 9AR Build 4 (Kevin, 9 Nov 2026): find a "weakest / strongest / worst day" ranking claim about
// the four main US indexes in one sentence and judge it against the package's own price data. Pure
// functions; they edit nothing. The cleanup (lib/claude-analysis-invocation.js rankingClaimCleanup)
// removes a sentence only when a claim in it is false on EVERY day and for EVERY index set it could
// mean. Ties, missing data, period claims ("this week"), other indexes ("Nasdaq 100") and unclear
// wording are never judged false. Comparisons ("fell more than the S&P 500") are only counted.
//
// Reads the same package fields as Build 1 (lib/report-accuracy-facts.js buildFactLookup), plus
// marketContext.primaryCompletedSessionDate / marketState and each benchmark's currentOverlay.

const {buildFactLookup} = require('./report-accuracy-facts');
const {weekdaysNamed, explicitDates} = require('./section-rules');
const {exchangeDateParts} = require('./us-active-session-evidence');
const {getSessionContext} = require('./market-session-calendar');

const FOUR = Object.freeze(['^GSPC', '^IXIC', '^DJI', '^RUT']);
const THREE = Object.freeze(['^GSPC', '^IXIC', '^DJI']);
const WEEKDAYS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);

const SKIP_REASONS = Object.freeze([
  'wouldEmptySection', 'wouldTripFinalCheck', 'missingData', 'unclearDay', 'unclearDirection',
  'unclearIndexSet', 'otherIndex', 'periodClaimNotChecked', 'liveDayUnknown'
]);

// --- word lists ------------------------------------------------------------------------------
const QUAL = String.raw`(?:major|main|big|key|benchmark|broad|broader|large|leading|headline|U\.S\.|US|American|Wall\s+Street|stock|equity|stock-market)`;
const RANK_CORE = String.raw`(best[- ]performing|top[- ]performing|worst[- ]performing|poorest[- ]performing|(?:biggest|largest|top)\s+gainer|top\s+performer|(?:biggest|largest)\s+(?:loser|decliner|laggard)|strongest|best|weakest|worst|poorest|laggard|leader)`;
const NOUN_OPT = String.raw`(?:\s+(?:performer|one))?`;
const GROUP_OF = String.raw`\s+(?:of|among)\s+(?:all\s+)?(?:the\s+)?(?:(three|four|3|4)\s+)?(?:${QUAL}\s+){0,3}(?:indexes|indices|averages|benchmarks)\b`;
const GROUP_DIRECT = String.raw`\s+(?:${QUAL}\s+){0,3}(?:index|average|benchmark)\b(?!\s+(?:fund|funds|etf|etfs|option|options|futures)\b)`;
const GROUP_NUMBER = String.raw`\s+of\s+the\s+(three|four)(?=\s*(?:[,.;:)]|$|\s+(?:on|for|in|during|with|after|as|while|and|but)\b))`;
const LEAD_IN = String.raw`(?:\s*,\s*(?:which\s+was\s+|being\s+)?|\s+(?:was|were|is|ended(?:\s+up)?|finished|closed|stood|proved|became|emerged)(?:\s+(?:again|also|once\s+again|clearly|easily|by\s+far))?(?:\s+as)?\s+)`;
// Step 9AR Build 4 fix: a short descriptive gap between the index name and the verb ("Russell 2000 small
// companies were the weakest...", "the Nasdaq, home to big tech, was the weakest..."). Verb form only; the
// gap is at most GAP_MAX_WORDS words, with no sentence break, no other index name and no word that starts
// a new clause or states a move.
const GAP_MAX_WORDS = 6;
const LEAD_VERB_ONLY = String.raw`(?:\s*,)?\s+(?:was|were|is|ended(?:\s+up)?|finished|closed|stood|proved|became|emerged)(?:\s+(?:again|also|once\s+again|clearly|easily|by\s+far))?(?:\s+as)?\s+`;
const GAP_BLOCKED = /^(?:and|but|or|while|as|after|before|with|without|whereas|although|though|because|since|when|that|which|who|if|than|then|so|yet|was|were|is|are|ended|finished|closed|rose|fell|gained|lost|dropped|slid|slipped|rallied|climbed|jumped|sank|added|shed|led|lagged)$/i;
const DAYS_THE =String.raw`(?:the\s+(?:day['’]s|session['’]s)\s+|the\s+)?`;

const FORWARD_RANK = new RegExp(`^${LEAD_IN}${DAYS_THE}${RANK_CORE}${NOUN_OPT}(?:${GROUP_OF}|${GROUP_DIRECT}|${GROUP_NUMBER})`, 'i');
const FORWARD_RANK_GAP = new RegExp(`^${LEAD_VERB_ONLY}${DAYS_THE}${RANK_CORE}${NOUN_OPT}(?:${GROUP_OF}|${GROUP_DIRECT}|${GROUP_NUMBER})`, 'i');
const REVERSED_RANK =new RegExp(String.raw`(?:^|[\s,(;:])the\s+(?:day['’]s\s+|session['’]s\s+)?${RANK_CORE}${NOUN_OPT}(?:${GROUP_OF}|${GROUP_DIRECT})(?:\s+(?:on|for)\s+[A-Za-z0-9.' ]{1,25}?)?\s*,?\s*(?:was|were|is|:)\s+(?:the\s+)?$`, 'i');
// Later in the same clause: "The Nasdaq fell 3.50% on Friday, the weakest of the major indexes." /
// ", making it the weakest ..." / "... and was the weakest ...".
const TRAILING_RANK = new RegExp(String.raw`(?:,\s*(?:making\s+it\s+|leaving\s+it\s+(?:as\s+)?|as\s+)?|\s+and\s+(?:was|were|is|ended|finished|closed)(?:\s+as)?\s+)the\s+${RANK_CORE}${NOUN_OPT}(?:${GROUP_OF}|${GROUP_DIRECT}|${GROUP_NUMBER})`, 'i');
const AMONG_BEFORE = new RegExp(String.raw`\bamong\s+(?:all\s+)?(?:the\s+)?(?:(three|four|3|4)\s+)?(?:${QUAL}\s+){0,3}(?:indexes|indices|averages|benchmarks)\s*,\s*(?:the\s+)?$`, 'i');
const AMONG_AFTER = new RegExp(String.raw`^\s+(?:was|were|is|ended|finished|closed)(?:\s+as)?\s+the\s+${RANK_CORE}${NOUN_OPT}\b(?!\s+(?:of|among)\b)`, 'i');

const LEAD_VERB = /^\s+(?:(?:also|again|clearly|once\s+again)\s+)?(led|lagged|trailed|underperformed|outperformed)\b/i;
const MOVE_PREFIX = String.raw`\s+(?:the\s+)?(?:(?:market|broad|broader|day['’]s|session['’]s|market['’]s)\s+)?`;
const LED_TOP = new RegExp(`^${MOVE_PREFIX}(?:way\\s+(?:higher|up)|gains|gainers|advance|advances|rally|rebound|recovery|charge\\s+higher|upswing|climb)\\b`, 'i');
const LED_BOTTOM = new RegExp(`^${MOVE_PREFIX}(?:way\\s+(?:lower|down)|losses|losers|decline|declines|drop|selloff|sell-off|slide|retreat|rout|downturn|slump)\\b`, 'i');
const GROUP_OBJECT = new RegExp(String.raw`^\s+(?:the\s+|its\s+)?(?:other\s+|fellow\s+|rest\s+of\s+the\s+)?(?:(three|four|3|4)\s+)?(?:(?:other|fellow)\s+)?(?:${QUAL}\s+){0,3}(?:indexes|indices|averages|benchmarks|peers|pack)\b`, 'i');

const PERIOD_WORDS = /\b(?:this\s+week|last\s+week|for\s+the\s+week|on\s+the\s+week|over\s+the\s+week|the\s+week['’]s|weekly|this\s+month|for\s+the\s+month|monthly|year[- ]to[- ]date|this\s+year|so\s+far\s+this|since|over\s+the\s+past|in\s+recent\s+(?:days|weeks|sessions))\b/i;
const UNCLEAR_DAY_WORDS = /\b(?:yesterday|earlier|previous\s+session|prior\s+session|last\s+session|recently)\b/i;
const TODAY_WORDS = /\b(?:today|so\s+far)\b/i;
const OTHER_INDEX_AFTER = /^(?:[\s-]*(?:100|400|600|1000|3000|midcap|mid-cap|smallcap|small-cap|microcap|transportation|transports|utilities|utility|equal[- ]weight(?:ed)?|futures|e-mini)\b|\s+(?:[A-Za-z&-]+\s+){1,2}(?:sector|sectors|index|industry|group|subindex)\b)/i;
const OTHER_INDEX_BEFORE = /\b(?:e-mini|mini)\s+$/i;
// The suffix that makes a name another index ("Nasdaq 100"): skipped over before the claim is read.
const OTHER_INDEX_SUFFIX = /^[\s-]*(?:100|400|600|1000|3000|midcap|mid-cap|smallcap|small-cap|microcap|transportation|transports|utilities|utility|equal[- ]weight(?:ed)?|futures|e-mini)\b/i;
// Step 9AR Build 4 fix after the re-proof: words that describe one of the four indexes itself, so the
// name is still that index ("the Russell 2000 small-company index", "the S&P 500 benchmark index").
// A size word straight after "Russell 2000" describes it; after the S&P 500, Nasdaq or Dow it stays
// another index. One or two words before "index" describe it only when every word is on the list;
// any other word ("energy", "technology", "biotech", "Value") or noun ("sector") stays another index.
const RUSSELL_SIZE_WORD = /^[\s-]*(?:small-cap|smallcap|small-company|smaller-company|mid-cap|midcap|microcap)\b/i;
const DESCRIBED_INDEX = /^\s+((?:[A-Za-z.&-]+\s+){1,2})index\b/i;
const DESCRIBING_WORDS = Object.freeze({
  common: new Set(['benchmark', 'broad', 'broad-market', 'main', 'headline', 'flagship', 'large-cap', 'us', 'u.s.', 'stock']),
  '^IXIC': new Set(['tech-heavy']),
  '^DJI': new Set(['blue-chip']),
  '^RUT': new Set(['small-cap', 'smallcap', 'small-company', 'smaller-company', 'mid-cap', 'midcap', 'microcap'])
});

// The length of a describing phrase straight after the name (0 when there is none).
function describingPhraseLength(after, symbol) {
  let length = 0;
  if (symbol === '^RUT') {
    const size = RUSSELL_SIZE_WORD.exec(after);
    if (size) length = size[0].length;
  }
  const described = DESCRIBED_INDEX.exec(after.slice(length));
  const fits = word => DESCRIBING_WORDS.common.has(word) || Boolean(DESCRIBING_WORDS[symbol]?.has(word));
  if (described && described[1].trim().toLowerCase().split(/\s+/).every(fits)) length += described[0].length;
  else if (length && /^\s+index\b/i.test(after.slice(length))) length += /^\s+index\b/i.exec(after.slice(length))[0].length;
  return length;
}

// Day-of-the-week claim, with the day and the polarity word captured.
const DAY_WORD = String.raw`((?:Monday|Tuesday|Wednesday|Thursday|Friday)|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2})`;
const WEEK_POLARITY = '(worst|best|weakest|strongest)';
const WEEK_DAY_NOUN = String.raw`(?:day|session|trading\s+day)`;
const DAY_OF_WEEK_FORMS = Object.freeze([
  // "Thursday was the worst day of the week", "Thursday's session marked the best session for the week"
  {regex: new RegExp(String.raw`\b${DAY_WORD}(?:['’]s)?(?:\s+session)?\s+(?:was|marked|proved|became|turned\s+out\s+to\s+be)\s+(?:the\s+)?(?:[A-Za-z&0-9 ]{1,30}?['’]s?\s+)?${WEEK_POLARITY}\s+${WEEK_DAY_NOUN}\s+(?:of|for|in)\s+the\s+week\b`, 'gi'), day: 1, polarity: 2},
  // "Thursday was the week's worst day"
  {regex: new RegExp(String.raw`\b${DAY_WORD}(?:['’]s)?(?:\s+session)?\s+was\s+the\s+week['’]s\s+${WEEK_POLARITY}(?:\s+${WEEK_DAY_NOUN})?\b`, 'gi'), day: 1, polarity: 2},
  // "the worst day of the week came on Thursday", "the week's best session was Friday"
  {regex: new RegExp(String.raw`\bthe\s+(?:week['’]s\s+${WEEK_POLARITY}\s+${WEEK_DAY_NOUN}|${WEEK_POLARITY}\s+${WEEK_DAY_NOUN}\s+of\s+the\s+week)\s+(?:came|was|fell)\s+(?:on\s+)?${DAY_WORD}\b`, 'gi'), day: 3, polarity: [1, 2]}
]);

// Comparisons: counted, never cut.
const COMPARISON_PATTERNS = Object.freeze([
  /\b(?:more|less|further|faster)\b(?:\s+\w+){0,3}?\s+than\b/gi,
  /\b(?:bigger|smaller|steeper|sharper|larger|deeper|milder)\s+(?:gain|drop|loss|decline|rise|fall|advance|slide|move)s?\s+than\b/gi
]);
const GROUP_AFTER_THAN = /^\s+(?:all\s+)?(?:the\s+)?(?:other\s+|rest\s+of\s+the\s+)?(?:[A-Za-z0-9-]+\s+){0,3}?(?:indexes|indices|averages|benchmarks)\b/i;
const COMPARISON_VERB =/\b(?:outperformed|underperformed|outpaced|trailed|lagged|beat|lagging|trailing|outpacing)\s+(?:the\s+)?$/i;

// --- facts -------------------------------------------------------------------------------------
function round2(value) {
  return Math.round((value + (value >= 0 ? 1e-9 : -1e-9)) * 100) / 100;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function buildRankingFacts(input) {
  const lookup = buildFactLookup(input);
  const marketPackage = input?.marketPackages?.[0] || {};
  const context = marketPackage.marketContext || {};
  const values = new Map(); // date -> Map(symbol -> rounded percent)
  const indexes = new Map();
  for (const subject of lookup.subjects) {
    if (subject.kind !== 'index' || !FOUR.includes(subject.symbol)) continue;
    indexes.set(subject.symbol, subject);
    for (const session of subject.sessions) {
      if (!finite(session.percentChange)) continue;
      if (!values.has(session.date)) values.set(session.date, new Map());
      values.get(session.date).set(subject.symbol, round2(session.percentChange));
    }
  }
  const marketState = typeof context.marketState === 'string' ? context.marketState : null;
  const report = exchangeDateParts(input?.analysisRequest?.generatedAt);
  const reportDate = report?.date ?? null;
  // The live day counts only in Trading (REGULAR) and only from validated overlays.
  let live = null;
  if (marketState === 'REGULAR') {
    live = new Map();
    for (const entry of marketPackage.telemetry?.benchmarkSnapshots || []) {
      const snapshot = entry?.snapshot;
      const overlay = snapshot?.currentOverlay;
      if (!snapshot || !FOUR.includes(snapshot.symbol) || !overlay || overlay.validationState !== 'VALIDATED'
          || !finite(overlay.percentChange)) continue;
      live.set(snapshot.symbol, round2(overlay.percentChange));
    }
  }
  const principal = /^\d{4}-\d{2}-\d{2}$/.test(context.primaryCompletedSessionDate || '')
    ? context.primaryCompletedSessionDate : null;
  const matchers = lookup.matchers.filter(matcher => matcher.subject.kind === 'index'
    && FOUR.includes(matcher.subject.symbol));
  return {
    indexes, values, live, liveDate: marketState === 'REGULAR' ? reportDate : null,
    principal, reportDate, marketState,
    dates: [...values.keys()].sort(),
    matchers
  };
}

// --- mentions ----------------------------------------------------------------------------------
function findIndexMentions(text, facts) {
  const found = [];
  for (const {subject, regex} of facts.matchers) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const start = match.index + match[0].length - match[1].length;
      found.push({symbol: subject.symbol, start, end: start + match[1].length});
      if (match[0].length === 0) regex.lastIndex += 1;
    }
  }
  found.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const kept = [];
  for (const mention of found) {
    if (!kept.some(other => mention.start < other.end && other.start < mention.end)) kept.push(mention);
  }
  kept.sort((a, b) => a.start - b.start);
  kept.forEach((mention, index) => {
    mention.segmentEnd = index + 1 < kept.length ? kept[index + 1].start : text.length;
  });
  for (const mention of kept) {
    const after = text.slice(mention.end);
    const described = describingPhraseLength(after, mention.symbol);
    mention.other = (described ? OTHER_INDEX_AFTER.test(after.slice(described)) : OTHER_INDEX_AFTER.test(after))
      || OTHER_INDEX_BEFORE.test(text.slice(0, mention.start));
    const suffix = mention.other ? OTHER_INDEX_SUFFIX.exec(after.slice(described)) : null;
    mention.claimEnd = Math.min(mention.end + described + (suffix ? suffix[0].length : 0), mention.segmentEnd);
  }
  return kept;
}

// --- days --------------------------------------------------------------------------------------
const LIVE = 'LIVE';

function weekdayOf(dateKey) {
  return WEEKDAYS[new Date(`${dateKey}T12:00:00.000Z`).getUTCDay()];
}

// The stored session (or the live day) a weekday name points to, or null when there is none.
function resolveWeekday(name, facts) {
  if (facts.liveDate && weekdayOf(facts.liveDate) === name
      && (!facts.principal || facts.liveDate > facts.principal)) return LIVE;
  const limit = facts.principal || facts.reportDate;
  const candidates = facts.dates.filter(date => (!limit || date <= limit) && weekdayOf(date) === name);
  return candidates.length ? candidates[candidates.length - 1] : null;
}

// {dates: [...], unknown: bool} for the days named in a piece of text.
function namedDays(text, facts) {
  const dates = new Set();
  let unknown = false;
  for (const name of weekdaysNamed(text)) {
    if (name === 'Saturday' || name === 'Sunday') { unknown = true; continue; }
    const date = resolveWeekday(name, facts);
    if (date) dates.add(date); else unknown = true;
  }
  if (facts.reportDate) {
    for (const key of explicitDates(text, facts.reportDate)) {
      if (facts.liveDate === key && (!facts.principal || key > facts.principal)) dates.add(LIVE);
      else dates.add(key);
    }
  }
  return {dates: [...dates], unknown};
}

// The days an index-rank or lead/lag claim could mean, or a skip reason.
function candidateDays(sentence, facts, previousSentence) {
  if (PERIOD_WORDS.test(sentence)) return {reason: 'periodClaimNotChecked'};
  const own = namedDays(sentence, facts);
  if (TODAY_WORDS.test(sentence)) {
    if (facts.liveDate) own.dates.push(LIVE);
    else if (facts.principal) own.dates.push(facts.principal);
  }
  if (own.dates.length || own.unknown) return own.dates.length ? own : {reason: 'missingData'};
  if (UNCLEAR_DAY_WORDS.test(sentence)) return {reason: 'unclearDay'};
  const dates = new Set();
  if (facts.principal) dates.add(facts.principal);
  if (typeof previousSentence === 'string' && previousSentence) {
    const previous = namedDays(previousSentence, facts);
    for (const date of previous.dates) dates.add(date);
  }
  if (facts.liveDate) dates.add(LIVE);
  return dates.size ? {dates: [...dates]} : {reason: 'unclearDay'};
}

function valuesOn(date, facts) {
  return date === LIVE ? facts.live : facts.values.get(date);
}

// 'true' | 'tie' | 'false' | 'unknown' for one set on one day.
function rankOn(symbol, polarity, set, day) {
  if (!day || !set.every(member => day.has(member))) return 'unknown';
  const own = day.get(symbol);
  const others = set.filter(member => member !== symbol).map(member => day.get(member));
  if (!others.length) return 'true';
  const target = polarity === 'TOP' ? Math.max(...others) : Math.min(...others);
  if (own === target) return 'tie';
  return (polarity === 'TOP' ? own > target : own < target) ? 'true' : 'false';
}

function setsFor(groupNumber, symbol) {
  const sets = groupNumber === 'three' || groupNumber === '3' ? [THREE]
    : groupNumber === 'four' || groupNumber === '4' ? [FOUR] : [FOUR, THREE];
  return sets.filter(set => set.includes(symbol));
}

// Combines per-day, per-set outcomes: false only when every one is false.
function combine(outcomes, unknownReason) {
  if (!outcomes.length) return {verdict: 'skip', reason: unknownReason};
  if (outcomes.includes('true')) return {verdict: 'true'};
  if (outcomes.includes('tie')) return {verdict: 'tie'};
  if (outcomes.includes('unknown')) return {verdict: 'skip', reason: unknownReason};
  return {verdict: 'false'};
}

function judgeIndexClaim(claim, sentence, facts, previousSentence) {
  if (claim.other) return {verdict: 'skip', reason: 'otherIndex'};
  if (!claim.polarity) return {verdict: 'skip', reason: 'unclearDirection'};
  const sets = setsFor(claim.groupNumber, claim.symbol);
  if (!sets.length) return {verdict: 'skip', reason: 'unclearIndexSet'};
  const days = candidateDays(sentence, facts, previousSentence);
  if (days.reason) return {verdict: 'skip', reason: days.reason};
  const outcomes = [];
  let liveUnknown = false;
  for (const date of days.dates) {
    for (const set of sets) {
      const outcome = rankOn(claim.symbol, claim.polarity, set, valuesOn(date, facts));
      if (outcome === 'unknown' && date === LIVE) liveUnknown = true;
      outcomes.push(outcome);
    }
  }
  return combine(outcomes, liveUnknown ? 'liveDayUnknown' : 'missingData');
}

// --- the week check ----------------------------------------------------------------------------
function addDays(dateKey, count) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function tradingDay(dateKey) {
  try {
    const context = getSessionContext({market: 'US', exchangeDate: dateKey});
    if (!context.calendarSupported && context.dayType !== 'WEEKEND') return null;
    return context.tradingDay === true;
  } catch (error) {
    return null;
  }
}

function judgeWeekClaim(date, polarity, symbols, facts) {
  if (!date) return {verdict: 'skip', reason: 'missingData'};
  const anchor = date === LIVE ? facts.liveDate : date;
  const monday = addDays(anchor, -((new Date(`${anchor}T12:00:00.000Z`).getUTCDay() + 6) % 7));
  const last = facts.liveDate && facts.liveDate >= monday && facts.liveDate <= addDays(monday, 4)
    && (!facts.principal || facts.liveDate > facts.principal) ? facts.liveDate : facts.principal;
  if (!last) return {verdict: 'skip', reason: 'missingData'};
  const week = [];
  for (let offset = 0; offset < 5; offset++) {
    const key = addDays(monday, offset);
    if (key > last) break;
    const open = tradingDay(key);
    if (open === null) return {verdict: 'skip', reason: 'missingData'};
    if (open) week.push(key === facts.liveDate && key === last && last !== facts.principal ? LIVE : key);
  }
  if (!week.includes(date)) return {verdict: 'skip', reason: 'missingData'};
  const outcomes = [];
  let liveUnknown = false;
  for (const symbol of symbols) {
    const series = week.map(key => valuesOn(key, facts)?.get(symbol));
    if (series.some(value => !finite(value))) {
      if (week.includes(LIVE) && !finite(valuesOn(LIVE, facts)?.get(symbol))) liveUnknown = true;
      outcomes.push('unknown');
      continue;
    }
    const own = series[week.indexOf(date)];
    const others = series.filter((value, index) => index !== week.indexOf(date));
    if (!others.length) { outcomes.push('true'); continue; }
    const target = polarity === 'TOP' ? Math.max(...others) : Math.min(...others);
    outcomes.push(own === target ? 'tie' : (polarity === 'TOP' ? own > target : own < target) ? 'true' : 'false');
  }
  return combine(outcomes, liveUnknown ? 'liveDayUnknown' : 'missingData');
}

function resolveDayWord(word, facts) {
  const weekday = WEEKDAYS.find(name => name.toLowerCase() === word.toLowerCase());
  if (weekday) return resolveWeekday(weekday, facts);
  if (!facts.reportDate) return null;
  const [key] = explicitDates(word, facts.reportDate);
  if (!key) return null;
  if (key === facts.liveDate && (!facts.principal || key > facts.principal)) return LIVE;
  return facts.values.has(key) ? key : null;
}

// --- the sentence check ------------------------------------------------------------------------
function polarityOf(word) {
  const lower = String(word).toLowerCase();
  if (/strongest|best|top|gainer|leader/.test(lower)) return 'TOP';
  if (/weakest|worst|poorest|loser|decliner|laggard/.test(lower)) return 'BOTTOM';
  return null;
}

function leadLagClaim(after) {
  const verb = LEAD_VERB.exec(after);
  if (!verb) return null;
  const word = verb[1].toLowerCase();
  const rest = after.slice(verb[0].length);
  const clause = rest.split(/[,;.:]|\s(?:while|as|but|after|and|with)\s/i)[0];
  const group = GROUP_OBJECT.exec(clause);
  if (word === 'led') {
    if (LED_TOP.test(clause)) return {form: 'leadLag', polarity: 'TOP', groupNumber: null};
    if (LED_BOTTOM.test(clause)) return {form: 'leadLag', polarity: 'BOTTOM', groupNumber: null};
    if (group) {
      const tail = clause.slice(group[0].length);
      const polarity = /^\s+(?:higher|up|upward)\b/i.test(tail) ? 'TOP'
        : /^\s+(?:lower|down|downward)\b/i.test(tail) ? 'BOTTOM' : null;
      return {form: 'leadLag', polarity, groupNumber: group[1] ? group[1].toLowerCase() : null};
    }
    if (!clause.trim()) return {form: 'leadLag', polarity: null, groupNumber: null};
    return null;
  }
  if (!group) return null;
  return {form: 'leadLag', polarity: word === 'outperformed' ? 'TOP' : 'BOTTOM',
    groupNumber: group[1] ? group[1].toLowerCase() : null};
}

// "<name> <1 to 6 plain words> was the weakest of the major indexes": the gap holds no sentence break,
// ends before the next index name, and contains no clause-starting or move word.
function gapForwardRank(text, mention) {
  const after = text.slice(mention.claimEnd);
  for (let words = 1; words <= GAP_MAX_WORDS; words++) {
    const gap = new RegExp(String.raw`^(?:[\s,]*[^\s,.;:!?()]+){${words}}`).exec(after);
    if (!gap) return null;
    if (mention.claimEnd + gap[0].length > mention.segmentEnd) return null;
    const tokens = gap[0].split(/[\s,]+/).filter(Boolean);
    if (tokens.some(token => GAP_BLOCKED.test(token))) return null;
    const rank = FORWARD_RANK_GAP.exec(after.slice(gap[0].length));
    if (rank) return rank;
  }
  return null;
}

function rankClaimAt(text, mention) {
  const after = text.slice(mention.claimEnd);
  const before = text.slice(0, mention.start);
  const forward = FORWARD_RANK.exec(after) || gapForwardRank(text, mention);
  if (forward) {
    return {form: 'indexRank', polarity: polarityOf(forward[1]),
      groupNumber: (forward[2] || forward[3] || '').toLowerCase() || null};
  }
  const reversed = REVERSED_RANK.exec(before);
  if (reversed) {
    return {form: 'indexRank', polarity: polarityOf(reversed[1]),
      groupNumber: (reversed[2] || '').toLowerCase() || null};
  }
  const among = AMONG_BEFORE.exec(before);
  if (among) {
    const rank = AMONG_AFTER.exec(after);
    if (rank) return {form: 'indexRank', polarity: polarityOf(rank[1]), groupNumber: (among[1] || '').toLowerCase() || null};
  }
  const lead = leadLagClaim(after);
  if (lead) return lead;
  // Only within the name's own part of the sentence (up to the next index name or a semicolon).
  const segment = text.slice(mention.claimEnd, mention.segmentEnd).split(';')[0];
  const trailing = TRAILING_RANK.exec(segment);
  if (trailing) {
    return {form: 'indexRank', polarity: polarityOf(trailing[1]),
      groupNumber: (trailing[2] || trailing[3] || '').toLowerCase() || null};
  }
  return null;
}

function countComparisons(text, mentions) {
  let count = 0;
  const named = mentions.filter(mention => !mention.other);
  if (named.length >= 2) {
    for (const pattern of COMPARISON_PATTERNS) {
      pattern.lastIndex = 0;
      count += (text.match(pattern) || []).length;
    }
  }
  // A comparison against a group of indexes ("more sharply than the large-company indexes"): one named
  // index is enough. Counted only. (With two names the loop above already counted it.)
  if (named.length < 2 && mentions.length >= 1) {
    for (const pattern of COMPARISON_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        if (GROUP_AFTER_THAN.test(text.slice(match.index + match[0].length))) count += 1;
      }
    }
  }
  for (let i = 1; i < mentions.length; i++) {
    if (COMPARISON_VERB.test(text.slice(mentions[i - 1].end, mentions[i].start))) count += 1;
  }
  return count;
}

// Returns {claims: [{form, symbol, polarity, verdict, reason?}], comparisonCount}. verdict is 'false'
// (remove), 'true', 'tie' or 'skip' (with a reason from SKIP_REASONS).
function checkRankingSentence(sentence, facts, {previousSentence = null} = {}) {
  const result = {claims: [], comparisonCount: 0};
  if (typeof sentence !== 'string' || !sentence || !facts) return result;
  const text = sentence.normalize('NFKC');
  const previous = typeof previousSentence === 'string' ? previousSentence.normalize('NFKC') : null;
  const mentions = findIndexMentions(text, facts);
  for (const mention of mentions) {
    const claim = rankClaimAt(text, mention);
    if (!claim) continue;
    const full = {...claim, symbol: mention.symbol, other: mention.other};
    const verdict = judgeIndexClaim(full, text, facts, previous);
    result.claims.push({form: claim.form, symbol: mention.symbol, polarity: claim.polarity, ...verdict});
  }
  for (const form of DAY_OF_WEEK_FORMS) {
    form.regex.lastIndex = 0;
    let match;
    while ((match = form.regex.exec(text)) !== null) {
      const polarityWord = Array.isArray(form.polarity)
        ? form.polarity.map(index => match[index]).find(Boolean) : match[form.polarity];
      const polarity = polarityOf(polarityWord);
      const named = mentions.filter(mention => !mention.other).map(mention => mention.symbol);
      const symbols = named.length ? [...new Set(named)] : FOUR.slice();
      const missingIndex = !named.length && !FOUR.every(symbol => facts.indexes.has(symbol));
      const date = resolveDayWord(match[form.day], facts);
      const verdict = missingIndex ? {verdict: 'skip', reason: 'missingData'}
        : !named.length && mentions.length ? {verdict: 'skip', reason: 'otherIndex'}
          : judgeWeekClaim(date, polarity, symbols, facts);
      result.claims.push({form: 'dayOfWeek', symbol: named.length === 1 ? named[0] : null, polarity, ...verdict});
    }
  }
  result.comparisonCount = countComparisons(text, mentions);
  return result;
}

module.exports = {
  FOUR_INDEXES: FOUR,
  THREE_INDEXES: THREE,
  SKIP_REASONS,
  buildRankingFacts,
  checkRankingSentence
};
