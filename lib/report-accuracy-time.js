// Step 9AT: a time next to a source name must belong to an article that source
// published. Pure functions only. Build 2 runs them from the report cleanup (lib/claude-analysis-invocation.js
// timeMatchesArticleCleanup) behind the Admin setting timeMatchesArticleEnabled.
//
// The fault it targets (13 Nov 2026 17:08 SGT Pre-market report, Section 2): "At 9:06 am ET on Thursday,
// Bloomberg reported that ..." took the 9:06 am ET publish time of one cited article (a Zacks piece) and
// put it on the facts of another (a Bloomberg story published Wed 11 Nov, 9:56 pm ET).
//
//   findTimeClaims(sentence)            every "<H:MM am/pm> ET" in the sentence, with the optional
//                                       weekday/date written with it, the listed source the sentence
//                                       names, and the exact text span of the time phrase when the
//                                       phrase is in a form dropTimePhrase can remove.
//   checkTimeClaim(claim, citedArticles) pass / fail / skipped / logOnly with a reason. Only 'fail'
//                                       (timeMismatch, sourceMismatch) is meant to drop the time phrase;
//                                       'logOnly' (sourceUnsupported) changes no text.
//   dropTimePhrase(sentence, claim)     removes only the time phrase and capitalises what follows;
//                                       anything not recognised is returned unchanged.
'use strict';

// The sources a time claim can be checked against. Aliases name the same source.
const TIME_CLAIM_SOURCES = Object.freeze([
  'Reuters', 'Bloomberg', 'CNBC', 'Barchart', 'Yahoo Finance', 'Financial Times', 'WSJ',
  'Wall Street Journal', 'Zacks', 'MarketWatch', 'Associated Press', 'AP'
]);
const SOURCE_FAMILIES = Object.freeze({
  WSJ: ['WSJ', 'Wall Street Journal'], 'Wall Street Journal': ['WSJ', 'Wall Street Journal'],
  AP: ['AP', 'Associated Press'], 'Associated Press': ['AP', 'Associated Press']
});
// The source name may sit anywhere in the summary (Kevin, 14 Nov 2026): Barchart articles name Barchart
// about 1,000 characters in, so a first-250-characters rule would drop correct Barchart times.

const WEEKDAYS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
const SHORT_TO_WEEKDAY = Object.freeze({
  sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', tues: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  thur: 'Thursday', thurs: 'Thursday', fri: 'Friday', sat: 'Saturday'
});
const MONTHS = Object.freeze({jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12});

const ESC = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WEEKDAY_RE = '(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sun|Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat)\\.?';
const MONTH_RE = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?'
  + '|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const DATE_RE = `(?:\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_RE}|${MONTH_RE}\\s+\\d{1,2}(?:st|nd|rd|th)?)(?:,?\\s+(?:19|20)\\d{2})?`;
// A day as written: a weekday, a date, or a weekday then a date.
const DAY_RE = `(?:${WEEKDAY_RE}(?:,?\\s+${DATE_RE})?|${DATE_RE})`;
// "9:06 am", "9:06 a.m.", "9:06 AM", "09:06am".
const TIME_RE = '(\\d{1,2}):([0-5]\\d)\\s*([AaPp])\\.?\\s?[Mm]\\.?';
// Step 9AT Build 3: a 24-hour time ("07:08", "14:07") counts only with a TWO-digit hour 00 to 23, never
// with seconds or more digits ("12:02:08"), and only with a label. The label is ET, EST or EDT (one
// label, no offset check). GMT/UTC/SGT/HKT or no label: never a claim.
const TIME24_RE = '(?<![\\d:])([01]\\d|2[0-3]):([0-5]\\d)(?![\\d:])';
const LABEL_RE = '(?:ET|EST|EDT)\\b';
const TIME_ET = new RegExp(`(?:\\b${TIME_RE}|${TIME24_RE})\\s+${LABEL_RE}`, 'g');

// The removable forms. Each is tried at the claim's position; group "phrase" is what is removed and
// `replacement` what replaces it.
//   A  sentence start: "At 9:06 am ET on Thursday, " / "At 6:17 am ET Saturday Oct 24, " / "At 12:18 pm ET the same day, "
//   B  sentence start: "On Friday Oct 23 at 5:39 pm ET, "
//   C  inline, before "that": "Reuters reported at 6:49 am ET that" / "reported, at about 4:51 am ET, that"
//   D  inline between commas: "Since the close, at 11:36 pm ET on Friday, Bloom Energy ..."
const T = `(?:about\\s+|around\\s+)?(?:\\d{1,2}:[0-5]\\d\\s*[AaPp]\\.?\\s?[Mm]\\.?|(?<![\\d:])(?:[01]\\d|2[0-3]):[0-5]\\d(?![\\d:]))\\s+${LABEL_RE}`;
const DAY_AFTER = `(?:\\s+on\\s+${DAY_RE}|\\s+${DAY_RE}|\\s+the\\s+same\\s+day)?`;
// Build 3: forms A and B also accept no comma, but only when whitespace and a word character follow.
// C and D keep their commas.
const COMMA_OR_SPACE = ',\\s+|\\s+(?=\\w)';
const PHRASE_FORMS = Object.freeze([
  {form: 'A', re: new RegExp(`^(\\s*)(At\\s+${T}${DAY_AFTER}(?:${COMMA_OR_SPACE}))`), replacement: '', leading: true},
  {form: 'B', re: new RegExp(`^(\\s*)(On\\s+${DAY_RE}\\s+at\\s+${T}(?:${COMMA_OR_SPACE}))`), replacement: '', leading: true},
  {form: 'C', re: new RegExp(`(,\\s+at\\s+${T}${DAY_AFTER},\\s+|\\s+at\\s+${T}${DAY_AFTER}\\s+)(?=that\\b)`), replacement: ' '},
  {form: 'D', re: new RegExp(`(,\\s+)(at\\s+${T}${DAY_AFTER},\\s+)`), replacement: ''}
]);

function sourcePattern(name) {
  // "AP" only as an upper-case word; the others as words, case as listed.
  return new RegExp(`(?<![A-Za-z])${ESC(name)}(?![A-Za-z])`);
}

// The listed source the sentence names: the nearest mention after the time, else the nearest before.
function sourceForTime(sentence, timeIndex) {
  let best = null;
  for (const name of TIME_CLAIM_SOURCES) {
    const re = new RegExp(sourcePattern(name).source, 'g');
    for (const m of sentence.matchAll(re)) {
      // "Yahoo Finance" counts only as the full name; a bare "Yahoo" is not listed.
      const after = m.index >= timeIndex;
      const distance = Math.abs(m.index - timeIndex);
      const better = !best || (after && !best.after) || (after === best.after && distance < best.distance);
      if (better) best = {name, after, distance};
    }
  }
  return best ? best.name : null;
}

function parseDay(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const day = {text: text.trim(), weekday: null, date: null};
  const wd = new RegExp(`^${WEEKDAY_RE}`).exec(day.text);
  if (wd) {
    const bare = wd[0].replace(/\.$/, '');
    day.weekday = WEEKDAYS.find(name => name === bare) || SHORT_TO_WEEKDAY[bare.toLowerCase()] || null;
  }
  const dayFirst = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})`).exec(day.text);
  const monthFirst = new RegExp(`(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?`).exec(day.text);
  if (dayFirst) day.date = {day: Number(dayFirst[1]), month: MONTHS[dayFirst[2].toLowerCase().slice(0, 3)]};
  else if (monthFirst) day.date = {day: Number(monthFirst[2]), month: MONTHS[monthFirst[1].toLowerCase().slice(0, 3)]};
  return day.weekday || day.date ? day : null;
}

// The day written with a time: "on Thursday" / "Thursday 12 Nov" straight after it, or "On Friday Oct 23 at"
// straight before it.
function dayNearTime(sentence, start, end) {
  const after = new RegExp(`^(?:\\s+on)?\\s+(${DAY_RE})(?![A-Za-z])`).exec(sentence.slice(end));
  if (after) return parseDay(after[1]);
  const before = new RegExp(`(?:^|\\b)On\\s+(${DAY_RE})\\s+at\\s+(?:about\\s+|around\\s+)?$`).exec(sentence.slice(0, start));
  if (before) return parseDay(before[1]);
  return null;
}

// The time phrase around the claim, if it is in a removable form.
function phraseFor(sentence, start, end) {
  for (const {form, re, replacement, leading} of PHRASE_FORMS) {
    for (const m of sentence.matchAll(new RegExp(re.source, 'g'))) {
      // A, B and D: group 1 is kept (leading space / the comma), group 2 is removed. C: group 1 is removed.
      const kept = form === 'C' ? '' : m[1];
      const phrase = form === 'C' ? m[1] : m[2];
      const phraseStart = m.index + kept.length;
      if (start < phraseStart || end > phraseStart + phrase.length) continue;
      return {form, text: phrase, start: phraseStart, end: phraseStart + phrase.length, replacement, leading: Boolean(leading)};
    }
  }
  return null;
}

function findTimeClaims(sentence) {
  if (typeof sentence !== 'string') return [];
  const claims = [];
  for (const m of sentence.matchAll(TIME_ET)) {
    let time;
    if (m[4] !== undefined) {
      // 24-hour: 00 = 12 am, 01-11 am, 12 = 12 pm, 13-23 = 1-11 pm.
      const h24 = Number(m[4]);
      time = {hour: h24 % 12 || 12, minute: Number(m[5]), period: h24 < 12 ? 'am' : 'pm', text: m[0]};
    } else {
      const hour = Number(m[1]);
      if (hour < 1 || hour > 12) continue;
      time = {hour, minute: Number(m[2]), period: m[3].toLowerCase() === 'a' ? 'am' : 'pm', text: m[0]};
    }
    const start = m.index;
    const end = m.index + m[0].length;
    claims.push({
      time,
      day: dayNearTime(sentence, start, end),
      source: sourceForTime(sentence, start),
      phrase: phraseFor(sentence, start, end)
    });
  }
  // Build 3: two removable phrases that touch or overlap are dropped by neither (no ", ," and no lost
  // word); they are left as written and counted as unrecognised, like any phrase in an unknown form.
  // The test uses the original phrases, so the conflicting claims are found first and changed after.
  const touching = claims.filter(a => a.phrase && claims.some(b => b !== a && b.phrase
    && a.phrase.start <= b.phrase.end && b.phrase.start <= a.phrase.end));
  for (const claim of touching) claim.phrase = null;
  return claims.map(claim => Object.freeze(claim));
}

// "Thu 12 Nov, 9:06 am ET" (lib/us-active-session-evidence.js exchangeTimeLabel) as parts.
function parsePublishedEt(label) {
  if (typeof label !== 'string') return null;
  const m = /^([A-Za-z]{3})\s+(\d{1,2})\s+([A-Za-z]{3}),\s+(\d{1,2}):(\d{2})\s+(am|pm)\s+ET$/.exec(label.trim());
  if (!m) return null;
  return {
    weekday: SHORT_TO_WEEKDAY[m[1].toLowerCase()] || null, day: Number(m[2]),
    month: MONTHS[m[3].toLowerCase()] || null, hour: Number(m[4]), minute: Number(m[5]), period: m[6]
  };
}

function sameTime(time, parts) {
  return parts && parts.hour === time.hour && parts.minute === time.minute && parts.period === time.period;
}

function sameDay(day, parts) {
  if (!day) return true;
  if (day.weekday && day.weekday !== parts.weekday) return false;
  if (day.date && (day.date.day !== parts.day || day.date.month !== parts.month)) return false;
  return true;
}

function articleText(article) {
  return `${article.title || ''} ${String(article.summary || '')}`;
}

function carriesSource(article, source) {
  const names = SOURCE_FAMILIES[source] || [source];
  const publisher = String(article.publisher || '').replace(/Yahoo!/g, 'Yahoo');
  const text = `${publisher} ${articleText(article)}`;
  return names.some(name => sourcePattern(name).test(text));
}

function timeInText(article, time) {
  const re = new RegExp(`(?<!\\d)0?${time.hour}:${String(time.minute).padStart(2, '0')}\\s*${time.period[0]}\\.?\\s?m\\b`, 'i');
  if (re.test(articleText(article))) return true;
  // Build 3: the same time written as a labelled 24-hour time ("14:07 ET", "07:08 EST"). The label is
  // required here so "12:08 GMT" or a ratio is never read as an ET time.
  const h24 = String(time.period === 'am' ? time.hour % 12 : (time.hour % 12) + 12).padStart(2, '0');
  const re24 = new RegExp(`(?<![\\d:])${h24}:${String(time.minute).padStart(2, '0')}(?![\\d:])\\s*${LABEL_RE}`);
  return re24.test(articleText(article));
}

// The market open and close (9:30 am and 4:00 pm ET, also written 09:30 and 16:00) are scheduled times, not
// article publish times; a sentence naming one is left as written.
function isBellTime(time) {
  return time.minute === 0 ? time.hour === 4 && time.period === 'pm' : time.minute === 30 && time.hour === 9 && time.period === 'am';
}

// citedArticles: [{reference, publishedEt, publisher, title, summary}] for the section's cited articles.
function checkTimeClaim(claim, citedArticles = []) {
  if (!claim || !claim.source) return {verdict: 'skipped', reason: 'noSource'};
  if (isBellTime(claim.time)) return {verdict: 'skipped', reason: 'bellTime'};
  const articles = Array.isArray(citedArticles) ? citedArticles : [];
  const published = articles.filter(article => {
    const parts = parsePublishedEt(article.publishedEt);
    return sameTime(claim.time, parts) && sameDay(claim.day, parts);
  });
  const publishedCarrier = published.find(article => carriesSource(article, claim.source));
  if (publishedCarrier) return {verdict: 'pass', reason: 'publishedTime', reference: publishedCarrier.reference ?? null};
  const inText = articles.filter(article => timeInText(article, claim.time));
  const textCarrier = inText.find(article => carriesSource(article, claim.source));
  if (textCarrier) return {verdict: 'pass', reason: 'eventTime', reference: textCarrier.reference ?? null};
  if (published.length || inText.length) {
    const references = [...published, ...inText].map(article => article.reference ?? null);
    // Kevin, 14 Nov 2026: the time belongs to a cited article but no cited article names the source at
    // all (24 Oct 01:01, "the Financial Times reported"): the time is right and the source is what is
    // unsupported, so dropping the time would make the sentence worse. Log only, no text change.
    if (!articles.some(article => carriesSource(article, claim.source))) {
      return {verdict: 'logOnly', reason: 'sourceUnsupported', references};
    }
    return {verdict: 'fail', reason: 'sourceMismatch', references};
  }
  return {verdict: 'fail', reason: 'timeMismatch'};
}

// Removes only the claim's time phrase. Returns {sentence, changed, reason}.
function dropTimePhrase(sentence, claim) {
  if (typeof sentence !== 'string' || !claim || !claim.phrase) {
    return {sentence, changed: false, reason: 'unrecognisedForm'};
  }
  const {start, end, text, replacement, leading} = claim.phrase;
  if (sentence.slice(start, end) !== text) return {sentence, changed: false, reason: 'unrecognisedForm'};
  let rest = sentence.slice(end);
  if (leading) rest = rest.charAt(0).toUpperCase() + rest.slice(1);
  return {sentence: `${sentence.slice(0, start)}${replacement}${rest}`, changed: true, reason: 'dropped'};
}

module.exports = {
  TIME_CLAIM_SOURCES,
  findTimeClaims, checkTimeClaim, dropTimePhrase, parsePublishedEt
};
