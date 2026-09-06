const {XMLParser, XMLValidator} = require('fast-xml-parser');
const {createEvidenceItem} = require('./evidence-items');
const {createEvidenceCollection} = require('./evidence-collections');

const FEDERAL_RESERVE_MONETARY_POLICY_RSS_URL = 'https://www.federalreserve.gov/feeds/press_monetary.xml';
const DEFAULT_TIMEOUT_MS = 4000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_EVIDENCE_ITEMS = 10;
const REQUEST_HEADERS = Object.freeze({
  Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
  'User-Agent': 'MarketBrief/1.0 evidence-acquisition'
});

class FederalReserveEvidenceAcquisitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FederalReserveEvidenceAcquisitionError';
    this.code = code;
  }
}

function fail(code, message) {
  return new FederalReserveEvidenceAcquisitionError(code, message);
}

function isAbort(error, signal) {
  return signal.aborted || (error && error.name === 'AbortError');
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

async function readBoundedBody(response, signal) {
  const contentLengthValue = response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-length') : null;
  if (contentLengthValue !== null) {
    const contentLength = Number(contentLengthValue);
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw fail('RESPONSE_TOO_LARGE', 'Federal Reserve RSS response exceeds the size limit');
    }
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw fail('INVALID_FEED', 'Federal Reserve RSS body is malformed');
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        if (typeof reader.cancel === 'function') await reader.cancel();
        throw fail('RESPONSE_TOO_LARGE', 'Federal Reserve RSS response exceeds the size limit');
      }
      text += decoder.decode(value, {stream: true});
    }
    return text + decoder.decode();
  }

  if (typeof response.text !== 'function') throw fail('INVALID_FEED', 'Federal Reserve RSS response body is unavailable');
  const text = await response.text();
  if (typeof text !== 'string') throw fail('INVALID_FEED', 'Federal Reserve RSS response body is malformed');
  if (byteLength(text) > MAX_RESPONSE_BYTES) {
    throw fail('RESPONSE_TOO_LARGE', 'Federal Reserve RSS response exceeds the size limit');
  }
  return text;
}

function decodeHtmlEntities(value) {
  const named = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] || match;
    const hexadecimal = entity[1].toLowerCase() === 'x';
    const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    try {
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF
        ? String.fromCodePoint(codePoint) : match;
    } catch (error) {
      return match;
    }
  });
}

function normalizePlainText(value) {
  if (typeof value !== 'string') return null;
  let text = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  text = decodeHtmlEntities(text)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
  return text || null;
}

function canonicalFederalReserveUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    return url.protocol === 'https:'
      && (hostname === 'federalreserve.gov' || hostname.endsWith('.federalreserve.gov'))
      ? url.href : null;
  } catch (error) {
    return null;
  }
}

function canonicalPubDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+(GMT|UTC|([+-])(\d{2})(\d{2}))$/i.exec(value.trim());
  if (!match) return null;
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const day = Number(match[2]);
  const month = months.indexOf(match[3].toLowerCase());
  const year = Number(match[4]);
  const hour = Number(match[5]);
  const minute = Number(match[6]);
  const second = Number(match[7]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  const calendar = new Date(0);
  calendar.setUTCHours(hour, minute, second, 0);
  calendar.setUTCFullYear(year, month, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month || calendar.getUTCDate() !== day
      || hour > 23 || minute > 59 || second > 59 || offsetHour > 14 || offsetMinute > 59
      || (offsetHour === 14 && offsetMinute !== 0)
      || (match[1] && weekdays[calendar.getUTCDay()].toLowerCase() !== match[1].toLowerCase())) return null;
  const offsetMilliseconds = (offsetHour * 60 + offsetMinute) * 60 * 1000;
  const milliseconds = calendar.getTime() + (match[9] === '+' ? -offsetMilliseconds : offsetMilliseconds);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function canonicalItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const title = normalizePlainText(item.title);
  const summary = normalizePlainText(item.description);
  const canonicalUrl = canonicalFederalReserveUrl(item.link);
  const publishedAt = canonicalPubDate(item.pubDate);
  if (!title || !canonicalUrl || !publishedAt) return null;
  try {
    return createEvidenceItem({
      sourceId: 'us.federal-reserve',
      market: 'US',
      evidenceCategory: 'monetary-policy',
      title,
      summary,
      canonicalUrl,
      publishedAt,
      symbols: []
    });
  } catch (error) {
    return null;
  }
}

function parseFeed(xml) {
  if (XMLValidator.validate(xml) !== true) {
    throw fail('INVALID_FEED', 'Federal Reserve RSS is invalid XML');
  }
  let parsed;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
      processEntities: true,
      trimValues: false
    }).parse(xml);
  } catch (error) {
    throw fail('INVALID_FEED', 'Federal Reserve RSS could not be parsed');
  }
  const channel = parsed && parsed.rss && parsed.rss.channel;
  if (!channel || typeof channel !== 'object' || Array.isArray(channel) || channel.item === undefined) {
    throw fail('INVALID_FEED', 'Federal Reserve RSS feed structure is malformed');
  }
  const providerItems = Array.isArray(channel.item) ? channel.item : [channel.item];
  const items = [];
  for (const providerItem of providerItems) {
    const item = canonicalItem(providerItem);
    if (item) items.push(item);
    if (items.length === MAX_EVIDENCE_ITEMS) break;
  }
  if (items.length === 0) throw fail('NO_VALID_EVIDENCE', 'Federal Reserve RSS contains no valid evidence');
  return createEvidenceCollection({market: 'US', items});
}

function createFederalReserveMonetaryPolicyEvidenceAcquisitionService({
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive finite number');

  return Object.freeze({
    async acquireEvidence() {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let xml;
      try {
        let response;
        try {
          response = await fetchImpl(FEDERAL_RESERVE_MONETARY_POLICY_RSS_URL, {
            method: 'GET',
            headers: REQUEST_HEADERS,
            signal: controller.signal
          });
        } catch (error) {
          if (isAbort(error, controller.signal)) throw fail('TIMEOUT', 'Federal Reserve RSS request timed out');
          throw fail('NETWORK_FAILURE', 'Federal Reserve RSS request failed');
        }
        if (!response || !response.ok) {
          const status = response && Number.isInteger(response.status) ? response.status : 'unknown';
          throw fail('HTTP_FAILURE', `Federal Reserve RSS request returned HTTP ${status}`);
        }
        try {
          xml = await readBoundedBody(response, controller.signal);
        } catch (error) {
          if (isAbort(error, controller.signal)) throw fail('TIMEOUT', 'Federal Reserve RSS request timed out');
          if (error instanceof FederalReserveEvidenceAcquisitionError) throw error;
          throw fail('INVALID_FEED', 'Federal Reserve RSS body could not be read');
        }
      } finally {
        clearTimeout(timeout);
      }
      return parseFeed(xml);
    }
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  FEDERAL_RESERVE_MONETARY_POLICY_RSS_URL,
  MAX_EVIDENCE_ITEMS,
  MAX_RESPONSE_BYTES,
  FederalReserveEvidenceAcquisitionError,
  createFederalReserveMonetaryPolicyEvidenceAcquisitionService
};
