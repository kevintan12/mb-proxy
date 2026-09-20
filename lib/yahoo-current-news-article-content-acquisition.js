const DEFAULT_TIMEOUT_MS = 4000;
const MAX_RESPONSE_BYTES = 1572864;
const MAX_ARTICLE_TEXT_BYTES = 8192;
const MAX_HEADLINE_BYTES = 512;
const MAX_PUBLISHER_BYTES = 256;
const MAX_RESULT_BYTES = 12288;
const ARTICLE_TYPES = new Set(['Article', 'NewsArticle', 'ReportageNewsArticle']);
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function failure(type, message) {
  return deepFreeze({ok: false, type, message, articleContent: null});
}

function decode(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16)));
}

function plainText(value) {
  return decode(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function timestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value.trim())) return null;
  const milliseconds = Date.parse(value.trim());
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function canonicalUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(decode(value).trim());
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
        || !['finance.yahoo.com', 'sg.finance.yahoo.com'].includes(hostname)
        || !/^\/(?:news\/[^/]+|[a-z0-9-]+\/articles\/[^/]+)\.html\/?$/i.test(url.pathname)) return null;
    url.hostname = 'finance.yahoo.com';
    url.port = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch (error) {
    return null;
  }
}

function identity(url) {
  try { return new URL(url).pathname.split('/').filter(Boolean).at(-1).toLowerCase(); } catch (error) { return null; }
}

function jsonLdNodes(value, output) {
  if (Array.isArray(value)) return value.forEach(item => jsonLdNodes(item, output));
  if (!value || typeof value !== 'object') return;
  output.push(value);
  if (value['@graph']) jsonLdNodes(value['@graph'], output);
}

function isArticle(value) {
  return [].concat(value?.['@type'] || []).some(type => ARTICLE_TYPES.has(type));
}

function metadataUrl(article) {
  const value = typeof article?.url === 'string' ? article.url
    : typeof article?.mainEntityOfPage === 'string' ? article.mainEntityOfPage
      : article?.mainEntityOfPage?.['@id'];
  return canonicalUrl(value);
}

function canonicalLink(html) {
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] || '';
    if (!rel.split(/\s+/).some(value => value.toLowerCase() === 'canonical')) continue;
    return canonicalUrl(/\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]);
  }
  return null;
}

function elementByTestId(html, testId) {
  const startPattern = new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*\\bdata-testid\\s*=\\s*["']${testId}["'][^>]*>`, 'i');
  const start = startPattern.exec(html);
  if (!start) return null;
  const tag = start[1].toLowerCase();
  const tokens = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
  tokens.lastIndex = start.index;
  let depth = 0;
  let token;
  while ((token = tokens.exec(html)) !== null) {
    if (/^<\//.test(token[0])) depth--;
    else if (!/\/>$/.test(token[0])) depth++;
    if (depth === 0) return html.slice(start.index, tokens.lastIndex);
  }
  return null;
}

function removeTestIdElements(html, testIds) {
  let output = html;
  for (const testId of testIds) {
    while (true) {
      const element = elementByTestId(output, testId);
      if (!element) break;
      output = output.replace(element, ' ');
    }
  }
  return output;
}

function renderedArticleBody(html) {
  const wrapper = elementByTestId(html, 'article-content-wrapper');
  if (!wrapper) return null;
  let body = elementByTestId(wrapper, 'article-body');
  if (!body) return null;
  body = removeTestIdElements(body, ['inarticle-ad', 'ad-container', 'read-more']);
  body = body.replace(/<(?:script|style|nav|aside|button|figure)\b[\s\S]*?<\/(?:script|style|nav|aside|button|figure)\s*>/gi, ' ');
  const paragraphs = (body.match(/<p\b[^>]*>[\s\S]*?<\/p\s*>/gi) || []).map(plainText).filter(Boolean);
  return paragraphs.length ? paragraphs.join(' ') : null;
}

function publisherName(value) {
  const raw = typeof value === 'string' ? value : value?.name;
  const result = plainText(raw);
  return result && Buffer.byteLength(result, 'utf8') <= MAX_PUBLISHER_BYTES ? result : null;
}

function extract(html, requestedUrl, requestedHeadline) {
  const scripts = [];
  const pattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) scripts.push(match[1]);
  const nodes = [];
  for (const script of scripts) {
    try { jsonLdNodes(JSON.parse(script.trim()), nodes); } catch (error) {}
  }
  const requestedIdentity = identity(requestedUrl);
  const pageCanonical = canonicalLink(html);
  const articles = nodes.filter(isArticle).filter(article => {
    const url = metadataUrl(article);
    return url && identity(url) === requestedIdentity
      && (!pageCanonical || identity(pageCanonical) === requestedIdentity);
  });
  for (const article of articles) {
    const url = metadataUrl(article) || pageCanonical;
    const headline = plainText(article.headline);
    if (!url || !headline || Buffer.byteLength(headline, 'utf8') > MAX_HEADLINE_BYTES
        || (requestedHeadline && headline !== requestedHeadline)) continue;
    const articleText = plainText(article.articleBody) || renderedArticleBody(html);
    if (!articleText) continue;
    return {
      canonicalUrl: pageCanonical || url,
      headline,
      publisher: publisherName(article.publisher),
      publishedAt: timestamp(article.datePublished),
      updatedAt: timestamp(article.dateModified),
      articleText
    };
  }
  return null;
}

async function boundedHtml(response, maximum) {
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maximum) return {tooLarge: true, html: ''};
  const html = await response.text();
  return Buffer.byteLength(html, 'utf8') > maximum ? {tooLarge: true, html: ''} : {tooLarge: false, html};
}

function createYahooCurrentNewsArticleContentAcquisitionService({
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  maxArticleTextBytes = MAX_ARTICLE_TEXT_BYTES,
  maxResultBytes = MAX_RESULT_BYTES
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  for (const value of [timeoutMs, maxResponseBytes, maxArticleTextBytes, maxResultBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Invalid Yahoo current-news acquisition bounds');
  }
  return deepFreeze({
    async acquireArticleContent({url, headline = null} = {}) {
      const requestedUrl = canonicalUrl(url);
      const requestedHeadline = headline === null ? null : plainText(headline);
      if (!requestedUrl || (headline !== null && (!requestedHeadline
          || Buffer.byteLength(requestedHeadline, 'utf8') > MAX_HEADLINE_BYTES))) {
        return failure('INVALID_INPUT', 'Invalid Yahoo current-news article request');
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      let body;
      try {
        try {
          response = await fetchImpl(requestedUrl, {
            redirect: 'follow',
            headers: {'User-Agent': 'MarketBrief/1.0 active-session-acquisition', Accept: 'text/html'},
            signal: controller.signal
          });
        } catch (error) {
          return failure(controller.signal.aborted || error?.name === 'AbortError' ? 'TIMEOUT' : 'RETRIEVAL_FAILURE', 'Yahoo current-news article could not be retrieved');
        }
        if (!response?.ok) return failure('HTTP_FAILURE', 'Yahoo current-news article request was unsuccessful');
        const responseUrl = response.url ? canonicalUrl(response.url) : requestedUrl;
        if (!responseUrl || identity(responseUrl) !== identity(requestedUrl)) {
          return failure('IDENTITY_MISMATCH', 'Yahoo current-news article identity does not match');
        }
        const contentType = response.headers?.get?.('content-type');
        if (typeof contentType === 'string' && !/^text\/html(?:\s*;|$)/i.test(contentType.trim())) {
          return failure('INVALID_CONTENT_TYPE', 'Yahoo current-news article response is not HTML');
        }
        try { body = await boundedHtml(response, maxResponseBytes); } catch (error) {
          return failure(controller.signal.aborted || error?.name === 'AbortError' ? 'TIMEOUT' : 'RESPONSE_READ_FAILURE', 'Yahoo current-news article response could not be read');
        }
      } finally {
        clearTimeout(timeout);
      }
      if (body.tooLarge) return failure('RESPONSE_TOO_LARGE', 'Yahoo current-news article response exceeds configured bounds');
      const extracted = extract(body.html, requestedUrl, requestedHeadline);
      if (!extracted) return failure('NO_USABLE_ARTICLE', 'Yahoo current-news article has no usable provider-owned content');
      if (Buffer.byteLength(extracted.articleText, 'utf8') > maxArticleTextBytes) {
        return failure('ARTICLE_TEXT_TOO_LARGE', 'Yahoo current-news article text exceeds configured bounds');
      }
      const articleContent = deepFreeze({sourceId: 'us.yahoo-finance', ...extracted});
      if (Buffer.byteLength(JSON.stringify(articleContent), 'utf8') > maxResultBytes) {
        return failure('RESULT_TOO_LARGE', 'Yahoo current-news article result exceeds configured bounds');
      }
      return deepFreeze({ok: true, type: 'SUCCESS', articleContent});
    }
  });
}

module.exports = {
  YAHOO_CURRENT_NEWS_DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
  YAHOO_CURRENT_NEWS_MAX_RESPONSE_BYTES: MAX_RESPONSE_BYTES,
  YAHOO_CURRENT_NEWS_MAX_ARTICLE_TEXT_BYTES: MAX_ARTICLE_TEXT_BYTES,
  YAHOO_CURRENT_NEWS_MAX_HEADLINE_BYTES: MAX_HEADLINE_BYTES,
  YAHOO_CURRENT_NEWS_MAX_PUBLISHER_BYTES: MAX_PUBLISHER_BYTES,
  YAHOO_CURRENT_NEWS_MAX_RESULT_BYTES: MAX_RESULT_BYTES,
  canonicalYahooCurrentNewsArticleUrl: canonicalUrl,
  createYahooCurrentNewsArticleContentAcquisitionService
};
