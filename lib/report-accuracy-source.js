// 9AV Build 1: a news source named in the report must be one a cited article carries. Pure functions
// only; lib/claude-analysis-invocation.js runs them from the report cleanup behind three Admin switches.
//
// The faults it targets (18 Nov 2026 Pre-market report):
//   Section 4  "Reuters reported that Microsoft announced ..."; no cited article in Section 4 mentions
//              Reuters (the fact is from a Simply Wall St article).
//   Section 2  "At the close on Tuesday, Reuters reported that ..." for an article published after the
//              close (the facts are about Tuesday's close; the order implies the report time).
//   S1 vs S7   the same debut given two different days.
//
//   reorderCloseMarker(sentence)          C: "At the close on <day>, <Source> (also) reported that X" ->
//                                         "<Source> (also) reported that at the close on <day>, X". No word
//                                         is added or removed.
//   findSourceMentions(sentence)          every listed source named in the sentence.
//   sourceCarried(name, citedArticles)    A1: true when any cited article carries the source (publisher,
//                                         title or summary; lib/report-accuracy-time.js carriesSource).
//   sourcePhraseFor(sentence, mention)    the removable source phrase around a mention, or null.
//   dropSourcePhrase(sentence, phrase)    removes only that phrase; the rest of the sentence stays.
//   checkSourceCarrier(sentence, name, citedArticles)
//                                         A2 (log only): do the articles that hold this sentence's figures
//                                         and names carry the source, without crediting another one?
//   findEventDayClaims(sentence, options) B (log only): subject + event class + resolved ET date.
//   sameEventDayConflicts(claims)         B: same subject and class with two different dates.
'use strict';

const {TIME_CLAIM_SOURCES, carriesSource} = require('./report-accuracy-time');

// The 9AT list, unchanged (shared, not copied, so the two checks always name the same sources).
const SOURCES = TIME_CLAIM_SOURCES;
const FAMILY = Object.freeze({'Wall Street Journal': 'WSJ', 'Associated Press': 'AP'});

const ESC = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NAME_RE = name => `(?<![A-Za-z])${ESC(name)}(?![A-Za-z])`;
const ANY_SOURCE_RE = `(?:${[...SOURCES].sort((a, b) => b.length - a.length).map(NAME_RE).join('|')})`;

const WEEKDAYS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
const SHORT_TO_WEEKDAY = Object.freeze({
  sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', tues: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  thur: 'Thursday', thurs: 'Thursday', fri: 'Friday', sat: 'Saturday'
});
const MONTHS = Object.freeze({jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12});
const WEEKDAY_RE = '(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sun|Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat)\\.?';
const MONTH_RE = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?'
  + '|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const DATE_RE = `(?:\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_RE}|${MONTH_RE}\\s+\\d{1,2}(?:st|nd|rd|th)?)(?:,?\\s+(?:19|20)\\d{2})?`;
const DAY_RE = `(?:${WEEKDAY_RE}(?:,?\\s+${DATE_RE})?|${DATE_RE})`;

// ---------------------------------------------------------------------------------------------------
// C: close-marker word order.
// ---------------------------------------------------------------------------------------------------
const CLOSE_MARKER = new RegExp(
  `^(\\s*)At the close on (${DAY_RE}),\\s+((?:[Tt]he\\s+)?${ANY_SOURCE_RE}\\s+(?:also\\s+)?reported\\s+that)\\s+(?=\\S)`);

function reorderCloseMarker(sentence) {
  if (typeof sentence !== 'string') return {sentence, changed: false};
  const m = CLOSE_MARKER.exec(sentence);
  if (!m) return {sentence, changed: false};
  const [whole, lead, day, credit] = m;
  const head = credit.charAt(0).toUpperCase() + credit.slice(1);
  return {sentence: `${lead}${head} at the close on ${day}, ${sentence.slice(whole.length)}`, changed: true};
}

// ---------------------------------------------------------------------------------------------------
// A1: source named but carried by no cited article.
// ---------------------------------------------------------------------------------------------------
function findSourceMentions(sentence) {
  if (typeof sentence !== 'string') return [];
  const mentions = [];
  for (const name of SOURCES) {
    for (const m of sentence.matchAll(new RegExp(NAME_RE(name), 'g'))) {
      mentions.push({name, start: m.index, end: m.index + m[0].length});
    }
  }
  return mentions.sort((x, y) => x.start - y.start).map(mention => Object.freeze(mention));
}

function sourceCarried(name, citedArticles = []) {
  return (Array.isArray(citedArticles) ? citedArticles : []).some(article => carriesSource(article, name));
}

// The removable forms. Group "kept" stays, group "phrase" is removed and `replacement` put in its place.
//   START      "Reuters (also) reported that X" / "The Financial Times said that X"  -> "X"
//   ACCORDING  "According to Reuters, X"                                             -> "X"
//   TRAILING   "X, according to CNBC." / "X, as reported by CNBC."                    -> "X."
//   INLINE     "That reading, from CNBC's market recap, did not ..."                 -> "That reading did not ..."
function phraseForms(name) {
  const S = `(?:[Tt]he\\s+)?${NAME_RE(name)}`;
  return [
    {form: 'START', re: new RegExp(`^(\\s*)(${S}\\s+(?:also\\s+)?(?:reported|said)\\s+that\\s+)(?=\\S)`), replacement: '', leading: true},
    {form: 'ACCORDING', re: new RegExp(`^(\\s*)(According\\s+to\\s+${S},\\s+)(?=\\S)`), replacement: '', leading: true},
    {form: 'TRAILING', re: new RegExp(`()(,\\s+(?:according\\s+to|as\\s+reported\\s+by)\\s+${S})(?=[.!?]["'’”)\\]]*\\s*$)`), replacement: ''},
    {form: 'INLINE', re: new RegExp(`()(,\\s+from\\s+${S}(?:['’]s?)?(?:\\s+[a-z][a-z-]*){0,4},\\s+)`), replacement: ' '}
  ];
}

function sourcePhraseFor(sentence, mention) {
  if (typeof sentence !== 'string' || !mention) return null;
  for (const {form, re, replacement, leading} of phraseForms(mention.name)) {
    for (const m of sentence.matchAll(new RegExp(re.source, 'g'))) {
      const start = m.index + m[1].length;
      const end = start + m[2].length;
      if (mention.start < start || mention.end > end) continue;
      // A phrase that names a second listed source ("Reuters and Bloomberg") is never one of these forms,
      // but check anyway: only a phrase naming exactly this source is removed.
      if (findSourceMentions(m[2]).length !== 1) continue;
      return Object.freeze({form, text: m[2], start, end, replacement, leading: Boolean(leading)});
    }
  }
  return null;
}

function dropSourcePhrase(sentence, phrase) {
  if (typeof sentence !== 'string' || !phrase || sentence.slice(phrase.start, phrase.end) !== phrase.text) {
    return {sentence, changed: false};
  }
  let rest = sentence.slice(phrase.end);
  if (phrase.leading) rest = rest.charAt(0).toUpperCase() + rest.slice(1);
  return {sentence: `${sentence.slice(0, phrase.start)}${phrase.replacement}${rest}`, changed: true};
}

// ---------------------------------------------------------------------------------------------------
// A2 (log only): the articles that hold the sentence's own figures and names.
// ---------------------------------------------------------------------------------------------------
const NON_NAME_WORDS = new Set(['The', 'A', 'An', 'At', 'On', 'In', 'As', 'By', 'For', 'From', 'Its', 'That',
  'This', 'According', 'Separately', 'Meanwhile', 'Also', 'And', 'But', 'After', 'Before', 'While',
  ...WEEKDAYS, 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December']);

function sentenceAnchors(sentence) {
  const anchors = [];
  for (const m of sentence.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s?(?:%|percent\b)/g)) {
    anchors.push(new RegExp(`(?<![\\d.])${ESC(m[1])}\\s?(?:%|percent\\b)`));
  }
  for (const m of sentence.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)(?![\d])/g)) {
    anchors.push(new RegExp(`\\$\\s?${ESC(m[1])}(?![\\d])`));
  }
  const sourceWords = new Set(SOURCES.flatMap(name => name.split(' ')));
  for (const m of sentence.matchAll(/[A-Z][A-Za-z&-]+(?:\s+[A-Z][A-Za-z&-]+)+/g)) {
    const words = m[0].split(/\s+/).filter(word => !NON_NAME_WORDS.has(word) && !sourceWords.has(word));
    if (words.length >= 2) anchors.push(new RegExp(NAME_RE(words.join(' '))));
  }
  return anchors;
}

function articleText(article) {
  return `${article?.title || ''} ${String(article?.summary || '')}`;
}

// True when a sentence of the article that holds an anchor credits a listed source other than `name`.
function creditsOtherSource(article, name, anchors) {
  const own = new Set([name, FAMILY[name], ...Object.keys(FAMILY).filter(key => FAMILY[key] === name)].filter(Boolean));
  const other = SOURCES.filter(source => !own.has(source));
  const credit = new RegExp(`(?:(?:${other.map(NAME_RE).join('|')})\\s+(?:also\\s+)?(?:reported|said|says|reports)\\b`
    + `|[Aa]ccording\\s+to\\s+(?:[Tt]he\\s+)?(?:${other.map(NAME_RE).join('|')}))`);
  const named = new RegExp([...own].map(NAME_RE).join('|'));
  // A wire dateline ("(Reuters) - ") names the wire, not who the sentence credits.
  return articleText(article).split(/(?<=[.!?])\s+/).map(part => part.replace(/\([^)]{1,40}\)\s*[-–—]\s*/g, ''))
    .some(part => anchors.some(anchor => anchor.test(part)) && credit.test(part) && !named.test(part));
}

function checkSourceCarrier(sentence, name, citedArticles = []) {
  const articles = Array.isArray(citedArticles) ? citedArticles : [];
  const anchors = typeof sentence === 'string' ? sentenceAnchors(sentence) : [];
  if (anchors.length === 0) return {verdict: 'skipped', reason: 'noAnchor'};
  const carriers = articles.filter(article => anchors.every(anchor => anchor.test(articleText(article))));
  if (carriers.length === 0) return {verdict: 'skipped', reason: 'noCarrier'};
  const good = carriers.some(article => carriesSource(article, name) && !creditsOtherSource(article, name, anchors));
  if (good) return {verdict: 'pass', reason: 'carried'};
  return {verdict: 'mismatch',
    reason: carriers.some(article => carriesSource(article, name)) ? 'creditsOtherSource' : 'carrierLacksSource'};
}

// ---------------------------------------------------------------------------------------------------
// B (log only): the same event given two different days.
// ---------------------------------------------------------------------------------------------------
const EVENT_CLASSES = Object.freeze([
  ['debut', /\b(?:debut(?:s|ed)?|listing|starts? trading|begins? trading|first day of trading)\b/i],
  ['pricing', /\b(?:pricing|prices? (?:its|the) shares|priced)\b/i],
  ['ipo', /\bIPO\b/],
  ['results', /\b(?:results|earnings)\b/i],
  ['minutes', /\bminutes\b/i],
  ['decision', /\b(?:decision|meeting)\b/i]
]);
// Fixed macro events. FOMC/Fed only with a class word; the data releases count as their own event.
const MACRO_SUBJECTS = Object.freeze([
  {key: 'FOMC', re: /\b(?:FOMC|Fed|Federal Reserve)\b/, classWordRequired: true},
  {key: 'CPI', re: /\b(?:CPI|consumer price index)\b/i},
  {key: 'PPI', re: /\b(?:PPI|producer price index)\b/i},
  {key: 'JOBS', re: /\b(?:jobs report|nonfarm payrolls|payrolls report)\b/i},
  {key: 'GDP', re: /\bGDP\b/},
  {key: 'RETAIL_SALES', re: /\bretail sales\b/i}
]);
const DAY_WORD = new RegExp(`(?<![A-Za-z])(?:${DAY_RE}|today|tonight|tomorrow|yesterday)(?![A-Za-z])`, 'gi');

function isoDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10);
}

function shiftDate(reportDate, days) {
  const [y, m, d] = reportDate.split('-').map(Number);
  return isoDate(y, m, d + days);
}

// A written day as an ET date, read against the report's ET date: a bare weekday is the nearest one
// (three days either way), a date without a year takes the report's year.
function resolveDay(text, reportDate) {
  const word = text.trim().toLowerCase();
  if (word === 'today' || word === 'tonight') return reportDate;
  if (word === 'tomorrow') return shiftDate(reportDate, 1);
  if (word === 'yesterday') return shiftDate(reportDate, -1);
  const [y] = reportDate.split('-').map(Number);
  const dayFirst = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})`, 'i').exec(text);
  const monthFirst = new RegExp(`(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?`, 'i').exec(text);
  if (dayFirst) return isoDate(y, MONTHS[dayFirst[2].toLowerCase().slice(0, 3)], Number(dayFirst[1]));
  if (monthFirst) return isoDate(y, MONTHS[monthFirst[1].toLowerCase().slice(0, 3)], Number(monthFirst[2]));
  const bare = text.trim().replace(/\.$/, '');
  const weekday = WEEKDAYS.find(name => name.toLowerCase() === bare.toLowerCase())
    || SHORT_TO_WEEKDAY[bare.toLowerCase()];
  if (!weekday) return null;
  const reportWeekday = new Date(`${reportDate}T12:00:00Z`).getUTCDay();
  let diff = WEEKDAYS.indexOf(weekday) - reportWeekday;
  if (diff > 3) diff -= 7;
  if (diff < -3) diff += 7;
  return shiftDate(reportDate, diff);
}

// options: {subjects: [company names], reportDate: 'YYYY-MM-DD'}. Returns [{subject, eventClass, date}].
// Each event word is paired with the nearest written day after it in the same clause (clauses split
// at ";" and at " and " / " but " / " while "), and with the nearest subject before it in the sentence
// (else the nearest after it).
function findEventDayClaims(sentence, {subjects = [], reportDate} = {}) {
  if (typeof sentence !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate || '')) return [];
  const subjectHits = [];
  for (const name of subjects) {
    if (typeof name !== 'string' || name.trim().length < 2) continue;
    for (const m of sentence.matchAll(new RegExp(NAME_RE(name.trim()), 'g'))) {
      subjectHits.push({key: `COMPANY:${name.trim().toLowerCase()}`, index: m.index, macro: null});
    }
  }
  for (const macro of MACRO_SUBJECTS) {
    for (const m of sentence.matchAll(new RegExp(macro.re.source, `${macro.re.flags}g`))) {
      subjectHits.push({key: `MACRO:${macro.key}`, index: m.index, macro});
    }
  }
  if (subjectHits.length === 0) return [];
  const claims = [];
  let offset = 0;
  for (const clause of sentence.split(/(;|\s+(?:and|but|while)\s+)/)) {
    const clauseStart = offset;
    offset += clause.length;
    if (/^(?:;|\s+(?:and|but|while)\s+)$/.test(clause)) continue;
    const days = [...clause.matchAll(DAY_WORD)].map(m => ({index: clauseStart + m.index, text: m[0]}));
    if (days.length === 0) continue;
    const events = [];
    for (const [eventClass, re] of EVENT_CLASSES) {
      for (const m of clause.matchAll(new RegExp(re.source, `${re.flags}g`))) {
        events.push({eventClass, index: clauseStart + m.index});
      }
    }
    // A data release with no class word is its own event, at the subject's place.
    for (const hit of subjectHits) {
      if (hit.macro && !hit.macro.classWordRequired && hit.index >= clauseStart && hit.index < offset
          && events.length === 0) {
        events.push({eventClass: 'release', index: hit.index, subjectKey: hit.key});
      }
    }
    for (const event of events) {
      const day = days.find(entry => entry.index > event.index);
      if (!day) continue;
      const date = resolveDay(day.text, reportDate);
      if (!date) continue;
      let subject = event.subjectKey ? subjectHits.find(hit => hit.key === event.subjectKey) : null;
      if (!subject) {
        const eligible = subjectHits.filter(hit => !hit.macro || event.eventClass !== 'release');
        const before = eligible.filter(hit => hit.index <= event.index).sort((x, y) => y.index - x.index)[0];
        const after = eligible.filter(hit => hit.index > event.index).sort((x, y) => x.index - y.index)[0];
        subject = before || after;
      }
      if (!subject) continue;
      // Company subjects pair with company events; macro subjects with minutes/decision/release.
      const companyClass = ['debut', 'pricing', 'ipo', 'results'].includes(event.eventClass);
      if (subject.macro ? companyClass : !companyClass) continue;
      claims.push(Object.freeze({subject: subject.key, eventClass: event.eventClass, date}));
    }
  }
  return claims;
}

// claims: [{sectionIndex, subject, eventClass, date}]. Returns [{eventClass, sectionIndexes}], one per
// subject and class with more than one date (no subject text, so the log carries no report text).
function sameEventDayConflicts(claims = []) {
  const groups = new Map();
  for (const claim of Array.isArray(claims) ? claims : []) {
    const key = `${claim.subject}|${claim.eventClass}`;
    if (!groups.has(key)) groups.set(key, {eventClass: claim.eventClass, dates: new Set(), sections: new Set()});
    const group = groups.get(key);
    group.dates.add(claim.date);
    group.sections.add(claim.sectionIndex);
  }
  return [...groups.values()].filter(group => group.dates.size > 1).map(group => Object.freeze({
    eventClass: group.eventClass, sectionIndexes: [...group.sections].sort((x, y) => x - y)
  }));
}

module.exports = {
  reorderCloseMarker,
  findSourceMentions, sourceCarried, sourcePhraseFor, dropSourcePhrase,
  checkSourceCarrier,
  findEventDayClaims, sameEventDayConflicts, resolveDay
};
