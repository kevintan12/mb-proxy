'use strict';

// 9AU Build 3: the alert email for the holiday calendar refresh job. One plain-text email per run,
// sent through Resend with plain fetch (no package). Only fixed words, market names, years, dates,
// kinds and times go into the body: never a secret, a database address, page text or a raw fetched
// value. The To and From addresses and RESEND_API_KEY are never logged, returned or put in the body.

const {settingValue} = require('./settings-registry');

const RESEND_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 8000;
const BODY_LIMIT = 2000;
const SUBJECT_PREFIX = 'MarketBrief calendar:';

const ADVICE = Object.freeze({
  UNREADABLE: 'Not read from any source; nothing was written. Check the exchange page; the job tries again tomorrow.',
  HELD: 'Held and flagged, not applied (within 30 days or past). Check the exchange page and change the date by hand if it is right.',
  APPLIED: 'Applied (more than 30 days away). No action needed unless it looks wrong; details are in the market_calendar_changes table.',
  TOO_MANY: 'Too many stored dates would change, so nothing was written for this year. Check the exchange page and the page parser; the job tries again tomorrow.',
  MISSING_YEAR: 'Next year has no holiday calendar yet. Without it, every brief dated next year will fail. Check the exchange page and the refresh log, and add the year before it starts.',
  REJECTED: 'Failed the sanity check; nothing was written. The page layout may have changed; check the parser.'
});
const TITLES = Object.freeze({
  UNREADABLE: 'COULD NOT READ',
  HELD: 'CHANGE HELD',
  APPLIED: 'CHANGES APPLIED',
  REJECTED: 'YEAR REJECTED',
  TOO_MANY: 'TOO MANY CHANGES',
  MISSING_YEAR: 'NEXT YEAR MISSING'
});
const ORDER = Object.freeze(['UNREADABLE', 'REJECTED', 'TOO_MANY', 'HELD', 'APPLIED', 'MISSING_YEAR']);

// Only a known kind and a clock time are ever shown, so page text cannot reach the body.
function valueText(value) {
  if (value === null || value === undefined) return 'removed';
  const kind = value.kind === 'HOLIDAY' || value.kind === 'EARLY_CLOSE' ? value.kind : 'unknown';
  const time = typeof value.earlyCloseTime === 'string' && /^\d{2}:\d{2}/.test(value.earlyCloseTime)
    ? ` close ${value.earlyCloseTime.slice(0, 5)}` : '';
  return `${kind}${time}`;
}

function safeDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function eventLine(event) {
  const where = `${String(event.market).replace(/[^A-Z]/g, '')} ${Number(event.year)}`;
  if (event.category === 'TOO_MANY') {
    return `- ${where}: ${Number(event.count) || 0} changes, limit ${Number(event.limit) || 0}`;
  }
  if ((event.category === 'HELD' || event.category === 'APPLIED') && safeDate(event.date)) {
    return `- ${where} ${event.date}: ${valueText(event.from)} -> ${valueText(event.to)}`;
  }
  if (event.category === 'APPLIED') {
    return `- ${where}: ${Number(event.count) || 0} date(s) changed or removed`;
  }
  return `- ${where}`;
}

function buildAlert(events) {
  const list = Array.isArray(events) ? events.filter(event => event && TITLES[event.category]) : [];
  if (!list.length) return null;
  const present = ORDER.filter(category => list.some(event => event.category === category));
  const subject = `${SUBJECT_PREFIX} ${present.map(category => TITLES[category].toLowerCase()).join(', ')}`;
  const parts = ['The holiday calendar refresh needs your attention.', ''];
  for (const category of present) {
    parts.push(`${TITLES[category]}: ${ADVICE[category]}`);
    for (const event of list.filter(item => item.category === category)) parts.push(eventLine(event));
    parts.push('');
  }
  let text = parts.join('\n').trim();
  if (text.length > BODY_LIMIT) {
    const note = '\n... more events not shown; see the Vercel log and market_calendar_changes.';
    text = text.slice(0, BODY_LIMIT - note.length).replace(/\n[^\n]*$/, '') + note;
  }
  return {subject, text};
}

// The settings and key the email needs, or null when any is missing. Never logged.
function alertEmailConfig(env = process.env) {
  if (settingValue('calendarAlertEmailEnabled', {env}) !== true) return {enabled: false};
  const to = settingValue('calendarAlertEmailTo', {env});
  const from = settingValue('calendarAlertEmailFrom', {env});
  const key = env && typeof env.RESEND_API_KEY === 'string' ? env.RESEND_API_KEY.trim() : '';
  if (!to || !from || !key) return {enabled: true, configured: false};
  return {enabled: true, configured: true, to, from, key};
}

// Sends the one email. Never throws. Returns a plain outcome: {sent, reason?, code?}; the reason is
// one of: no_events, disabled, not_configured, send_failed. A failed send carries only a short code.
async function sendCalendarAlert({events, env = process.env, fetchImpl = global.fetch, timeoutMs = SEND_TIMEOUT_MS} = {}) {
  try {
    const alert = buildAlert(events);
    if (!alert) return {sent: false, reason: 'no_events'};
    const config = alertEmailConfig(env);
    if (!config.enabled) return {sent: false, reason: 'disabled'};
    if (!config.configured) return {sent: false, reason: 'not_configured'};
    if (typeof fetchImpl !== 'function') return {sent: false, reason: 'send_failed', code: 'NO_FETCH'};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    try {
      const response = await fetchImpl(RESEND_URL, {
        method: 'POST',
        headers: {Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({from: config.from, to: [config.to], subject: alert.subject, text: alert.text}),
        signal: controller.signal
      });
      if (!response || !response.ok) {
        return {sent: false, reason: 'send_failed', code: `HTTP_${Number(response && response.status) || 0}`};
      }
      return {sent: true};
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return {sent: false, reason: 'send_failed', code: 'SEND_ERROR'};
  }
}

module.exports = {
  RESEND_URL,
  SEND_TIMEOUT_MS,
  BODY_LIMIT,
  SUBJECT_PREFIX,
  buildAlert,
  alertEmailConfig,
  sendCalendarAlert
};
