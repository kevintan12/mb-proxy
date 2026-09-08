const {XMLParser, XMLValidator} = require('fast-xml-parser');
const {
  NEWS_EVIDENCE_HORIZONS,
  createNewsEvidenceCandidate,
  createNewsEvidenceCandidateCollection
} = require('./news-evidence-candidates');

const CNBC_US_MARKET_INSIDER_RSS_URL =
  'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20409666';
const DEFAULT_TIMEOUT_MS = 4000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_HEADERS = Object.freeze({
  Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
  'User-Agent': 'MarketBrief/1.0 evidence-acquisition'
});
const HORIZON_KEYS = Object.freeze(['classification', 'startsAtExclusive', 'endsAtInclusive']);
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

class CnbcUsMarketNewsCandidateAcquisitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CnbcUsMarketNewsCandidateAcquisitionError';
    this.code = code;
  }
}

function fail(code, message) {
  return new CnbcUsMarketNewsCandidateAcquisitionError(code, message);
}

function isAbort(error, signal) {
  return signal.aborted || (error && error.name === 'AbortError');
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  const calendarDate = new Date(0);
  calendarDate.setUTCHours(0, 0, 0, 0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  if (calendarDate.getUTCFullYear() !== year
      || calendarDate.getUTCMonth() !== month - 1
      || calendarDate.getUTCDate() !== day
      || hour > 23 || minute > 59 || second > 59
      || offsetHour > 14 || offsetMinute > 59
      || (offsetHour === 14 && offsetMinute !== 0)) return null;
  const epochMilliseconds = Date.parse(value);
  return Number.isFinite(epochMilliseconds) ? new Date(epochMilliseconds).toISOString() : null;
}

function canonicalHorizons(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw fail('INVALID_INPUT', 'At least one canonical evidence horizon is required');
  }
  const horizons = value.map(horizon => {
    if (!hasExactKeys(horizon, HORIZON_KEYS)
        || !NEWS_EVIDENCE_HORIZONS.includes(horizon.classification)) {
      throw fail('INVALID_INPUT', 'Invalid evidence horizon');
    }
    const startsAtExclusive = canonicalTimestamp(horizon.startsAtExclusive);
    const endsAtInclusive = canonicalTimestamp(horizon.endsAtInclusive);
    if (!startsAtExclusive || !endsAtInclusive
        || Date.parse(startsAtExclusive) >= Date.parse(endsAtInclusive)) {
      throw fail('INVALID_INPUT', 'Invalid evidence horizon');
    }
    return {
      classification: horizon.classification,
      startsAtExclusive,
      endsAtInclusive,
      start: Date.parse(startsAtExclusive),
      end: Date.parse(endsAtInclusive)
    };
  });
  for (let left = 0; left < horizons.length; left++) {
    for (let right = left + 1; right < horizons.length; right++) {
      if (horizons[left].start < horizons[right].end
          && horizons[right].start < horizons[left].end) {
        throw fail('INVALID_INPUT', 'Evidence horizons must not overlap');
      }
    }
  }
  return horizons;
}

async function readBoundedBody(response, signal) {
  const contentLengthValue = response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-length') : null;
  if (contentLengthValue !== null) {
    const contentLength = Number(contentLengthValue);
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw fail('RESPONSE_TOO_LARGE', 'CNBC RSS response exceeds the size limit');
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
      if (!(value instanceof Uint8Array)) throw fail('INVALID_FEED', 'CNBC RSS body is malformed');
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        if (typeof reader.cancel === 'function') await reader.cancel();
        throw fail('RESPONSE_TOO_LARGE', 'CNBC RSS response exceeds the size limit');
      }
      text += decoder.decode(value, {stream: true});
    }
    return text + decoder.decode();
  }

  if (typeof response.text !== 'function') throw fail('INVALID_FEED', 'CNBC RSS response body is unavailable');
  const text = await response.text();
  if (typeof text !== 'string') throw fail('INVALID_FEED', 'CNBC RSS response body is malformed');
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw fail('RESPONSE_TOO_LARGE', 'CNBC RSS response exceeds the size limit');
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

function canonicalCnbcUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    return url.protocol === 'https:'
      && (hostname === 'cnbc.com' || hostname.endsWith('.cnbc.com'))
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

function parseProviderItems(xml) {
  if (XMLValidator.validate(xml) !== true) throw fail('INVALID_FEED', 'CNBC RSS is invalid XML');
  let parsed;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
      processEntities: true,
      trimValues: false
    }).parse(xml);
  } catch (error) {
    throw fail('INVALID_FEED', 'CNBC RSS could not be parsed');
  }
  const channel = parsed && parsed.rss && parsed.rss.channel;
  if (!channel || typeof channel !== 'object' || Array.isArray(channel) || channel.item === undefined) {
    throw fail('INVALID_FEED', 'CNBC RSS feed structure is malformed');
  }
  return Array.isArray(channel.item) ? channel.item : [channel.item];
}

function horizonFor(publishedAt, horizons) {
  const publishedTime = Date.parse(publishedAt);
  return horizons.find(horizon => publishedTime > horizon.start && publishedTime <= horizon.end) || null;
}

function candidateInput(providerItem, horizon, reference) {
  if (!providerItem || typeof providerItem !== 'object' || Array.isArray(providerItem)) return null;
  const title = normalizePlainText(providerItem.title);
  const summary = normalizePlainText(providerItem.description);
  const canonicalUrl = canonicalCnbcUrl(providerItem.link);
  const publishedAt = canonicalPubDate(providerItem.pubDate);
  if (!title || !canonicalUrl || !publishedAt || !horizon) return null;
  return {
    reference,
    horizon: {
      classification: horizon.classification,
      startsAtExclusive: horizon.startsAtExclusive,
      endsAtInclusive: horizon.endsAtInclusive
    },
    sourceId: 'us.cnbc',
    market: 'US',
    evidenceCategory: 'news',
    title,
    summary,
    extract: null,
    canonicalUrl,
    publishedAt,
    symbols: []
  };
}

function createCnbcUsMarketNewsCandidateAcquisitionService({
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive finite number');

  return Object.freeze({
    async acquireCandidates({horizons, bounds} = {}) {
      const canonicalWindows = canonicalHorizons(horizons);
      let candidateBounds;
      try {
        candidateBounds = Object.freeze({
          maxCandidates: bounds.maxCandidates,
          maxTitleBytes: bounds.maxTitleBytes,
          maxSummaryBytes: bounds.maxSummaryBytes,
          maxExtractBytes: bounds.maxExtractBytes,
          maxCollectionBytes: bounds.maxCollectionBytes
        });
        createNewsEvidenceCandidateCollection({market: 'US', candidates: []}, {bounds: candidateBounds});
      } catch (error) {
        throw fail('INVALID_INPUT', 'Invalid news evidence candidate bounds');
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let xml;
      try {
        let response;
        try {
          response = await fetchImpl(CNBC_US_MARKET_INSIDER_RSS_URL, {
            method: 'GET',
            headers: REQUEST_HEADERS,
            signal: controller.signal
          });
        } catch (error) {
          if (isAbort(error, controller.signal)) throw fail('TIMEOUT', 'CNBC RSS request timed out');
          throw fail('NETWORK_FAILURE', 'CNBC RSS request failed');
        }
        if (!response || !response.ok) {
          const status = response && Number.isInteger(response.status) ? response.status : 'unknown';
          throw fail('HTTP_FAILURE', `CNBC RSS request returned HTTP ${status}`);
        }
        try {
          xml = await readBoundedBody(response, controller.signal);
        } catch (error) {
          if (isAbort(error, controller.signal)) throw fail('TIMEOUT', 'CNBC RSS request timed out');
          if (error instanceof CnbcUsMarketNewsCandidateAcquisitionError) throw error;
          throw fail('INVALID_FEED', 'CNBC RSS body could not be read');
        }
      } finally {
        clearTimeout(timeout);
      }

      const providerItems = parseProviderItems(xml);
      const seenUrls = new Set();
      const candidates = [];
      for (const providerItem of providerItems) {
        const publishedAt = canonicalPubDate(providerItem && providerItem.pubDate);
        const horizon = publishedAt ? horizonFor(publishedAt, canonicalWindows) : null;
        const input = candidateInput(providerItem, horizon, `c${candidates.length + 1}`);
        if (!input || seenUrls.has(input.canonicalUrl)) continue;
        let candidate;
        try {
          candidate = createNewsEvidenceCandidate(input, {bounds: candidateBounds});
        } catch (error) {
          continue;
        }
        seenUrls.add(candidate.canonicalUrl);
        candidates.push(candidate);
        if (candidates.length === candidateBounds.maxCandidates) break;
      }
      if (candidates.length === 0) {
        throw fail('NO_VALID_CANDIDATES', 'CNBC RSS contains no valid in-horizon candidates');
      }
      try {
        return createNewsEvidenceCandidateCollection({market: 'US', candidates}, {bounds: candidateBounds});
      } catch (error) {
        throw fail('INVALID_CANDIDATE_COLLECTION', 'CNBC candidate collection is invalid');
      }
    }
  });
}

module.exports = {
  CNBC_US_MARKET_INSIDER_RSS_URL,
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  CnbcUsMarketNewsCandidateAcquisitionError,
  createCnbcUsMarketNewsCandidateAcquisitionService
};
