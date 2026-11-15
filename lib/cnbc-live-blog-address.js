// Step 9V.3: CNBC renamed its daily live blog from ".../stock-market-today-live-updates.html"
// to ".../stock-market-today-live-update.html" (seen 24 Oct 2026). With sinceCloseFixesEnabled
// on, both names are the live blog; off, only the old name, exactly as before. One rule for every
// CNBC site. It loads only the settings table, so the CNBC news list (lib/sources/cnbc-rss.js)
// can use it without loading any CNBC acquisition module.
'use strict';

const {settingValue} = require('./settings-registry');

const OLD_LIVE_BLOG_NAME = 'stock-market-today-live-updates.html';
const NEW_LIVE_BLOG_NAME = 'stock-market-today-live-update.html';
const LIVE_BLOG_PATHS = Object.freeze({
  old: /^\/\d{4}\/\d{2}\/\d{2}\/stock-market-today-live-updates\.html$/,
  oldIgnoreCase: /^\/\d{4}\/\d{2}\/\d{2}\/stock-market-today-live-updates\.html$/i,
  either: /^\/\d{4}\/\d{2}\/\d{2}\/stock-market-today-live-updates?\.html$/,
  eitherIgnoreCase: /^\/\d{4}\/\d{2}\/\d{2}\/stock-market-today-live-updates?\.html$/i
});
// A dated .html path that looks like a live blog, for the unrecognised-address log only.
const LOOSE_LIVE_BLOG_PATH = /^\/\d{4}\/\d{2}\/\d{2}\/[^/]*(?:stock-market-today|live-update)[^/]*\.html$/i;

function sinceCloseFixesOn(env) {
  return settingValue('sinceCloseFixesEnabled', env ? {env} : undefined) === true;
}

// The live-blog path test every CNBC site shares. `trailingSlash` and `ignoreCase` keep each
// site's own rule; only the name part changes with the switch.
function isCnbcLiveBlogPath(pathname, {trailingSlash = false, ignoreCase = false, env} = {}) {
  if (typeof pathname !== 'string') return false;
  const path = trailingSlash && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const name = (sinceCloseFixesOn(env) ? 'either' : 'old') + (ignoreCase ? 'IgnoreCase' : '');
  return LIVE_BLOG_PATHS[name].test(path);
}

// True when a CNBC path looks like a live blog but the rule above does not recognise it.
function isUnrecognisedCnbcLiveBlogPath(pathname, {env} = {}) {
  return typeof pathname === 'string' && LOOSE_LIVE_BLOG_PATH.test(pathname)
    && !isCnbcLiveBlogPath(pathname, {ignoreCase: true, env});
}

// The same address under the other live-blog name, or null.
function otherCnbcLiveBlogUrl(url) {
  if (typeof url !== 'string') return null;
  if (url.endsWith(`/${OLD_LIVE_BLOG_NAME}`)) return url.slice(0, -OLD_LIVE_BLOG_NAME.length) + NEW_LIVE_BLOG_NAME;
  if (url.endsWith(`/${NEW_LIVE_BLOG_NAME}`)) return url.slice(0, -NEW_LIVE_BLOG_NAME.length) + OLD_LIVE_BLOG_NAME;
  return null;
}

module.exports = {
  sinceCloseFixesOn,
  isCnbcLiveBlogPath,
  isUnrecognisedCnbcLiveBlogPath,
  otherCnbcLiveBlogUrl
};
