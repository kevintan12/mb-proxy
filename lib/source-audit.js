// Step 9F.6a.2: the candidate-audit helpers every news source shares, moved
// unchanged out of lib/us-analysis-package-orchestration.js. The limits come
// from lib/settings-registry.js (auditMaxCandidatesPerEvent, auditMaxEventBytes,
// auditFieldLimits), at the values that were literals before.
'use strict';

const {settingValue} = require('./settings-registry');

const AUDIT_MAX_CANDIDATES_PER_EVENT = settingValue('auditMaxCandidatesPerEvent');
const AUDIT_MAX_EVENT_BYTES = settingValue('auditMaxEventBytes');
const AUDIT_FIELD_LIMITS = settingValue('auditFieldLimits');

// The log stage names each source writes. Yahoo keeps today's names in Step
// 9F.6a (even in completed states); neutral names arrive with CNBC in 9F.6b.
const SOURCE_STAGE_NAMES = Object.freeze({
  'us.yahoo-finance': Object.freeze({
    summary: 'activeYahooAcquisition',
    audit: 'activeYahooCandidateAudit',
    listingTiming: 'yahooLatestNewsDiscoveryMs',
    downloadTiming: 'yahooCurrentNewsArticleAcquisitionMs'
  })
});

function sourceStageNames(sourceId) {
  const names = SOURCE_STAGE_NAMES[sourceId];
  if (!names) throw new TypeError(`No stage names for source: ${sourceId}`);
  return names;
}

function truncatedText(value, maxCharacters, maxBytes) {
  let text = Array.from(typeof value === 'string' ? value : '').slice(0, maxCharacters).join('');
  while (text && Buffer.byteLength(text, 'utf8') > maxBytes) text = Array.from(text).slice(0, -1).join('');
  return text;
}

function auditSlug(url) {
  try {
    return truncatedText(new URL(url).pathname.split('/').filter(Boolean).at(-1) || '',
      AUDIT_FIELD_LIMITS.slugCharacters, AUDIT_FIELD_LIMITS.slugBytes);
  } catch (error) {
    return '';
  }
}

// Splits the audit entries into events that each stay under the byte budget
// (serialized with a generationId) and at most ten candidates per event.
// Step 9F.6a.5: each event names its source once (`sourceId`, right after the
// stage); it is part of the reserved bytes, so no event can exceed the limit.
function auditEvents(entries, window, readingWindow = null,
  {stage = SOURCE_STAGE_NAMES['us.yahoo-finance'].audit, sourceId = null} = {}) {
  const groups = [];
  let current = [];
  const base = {
    stage, ...(sourceId ? {sourceId} : {}), part: 99, parts: 99,
    windowStartsAtInclusive: window?.startsAtInclusive ?? null,
    windowEndsAtInclusive: window?.endsAtInclusive ?? null,
    readingWindowStartsAt: readingWindow?.startsAt ?? null
  };
  const reservedBytes = Buffer.byteLength(
    JSON.stringify({...base, candidates: [], generationId: '0'.repeat(36)}), 'utf8'
  );
  let bytes = reservedBytes;
  for (const entry of entries) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
    if (current.length > 0 && (current.length >= AUDIT_MAX_CANDIDATES_PER_EVENT
        || bytes + entryBytes > AUDIT_MAX_EVENT_BYTES)) {
      groups.push(current);
      current = [];
      bytes = reservedBytes;
    }
    current.push(entry);
    bytes += entryBytes;
  }
  groups.push(current);
  return groups.map((candidates, index) => ({
    ...base, part: index + 1, parts: groups.length, candidates
  }));
}

module.exports = {
  AUDIT_FIELD_LIMITS,
  AUDIT_MAX_CANDIDATES_PER_EVENT,
  AUDIT_MAX_EVENT_BYTES,
  sourceStageNames,
  truncatedText,
  auditSlug,
  auditEvents
};
