// Step 9F.2d.2: the portfolio-slot picker. Pure and NOT wired into the
// pipeline -- nothing calls it yet (Step 9F.2d.3 switches the slots on).
//
// Portfolio slots sit on top of the general article slots. Only articles that
// name a company in `portfolioSlotList` are eligible: the caller passes the
// identities of the list that started the run (My Stocks or Watchlist); Step
// 21D can pass both lists by changing that one input. Recaps are never
// eligible and are never dropped by the slots.
//
// First pass: in score order, each company not yet covered gets its best
// article (up to `firstPassPerCompany` per company). Second pass: only if a
// slot is still empty, the next best article, even for a company already
// covered. An article naming two companies covers both.
'use strict';

const {settingValue} = require('./settings-registry');
const {headlineMatchesIdentity} = require('./headline-matching');
const {compareScoredArticles} = require('./article-score');

// `articles`: [{key, headline, score, ageHours, isRecap?}] in listing order
// (the order supplies the final tie-break). `portfolioSlotList`: [{symbol,
// shortName, longName}]. `alreadyChosen`: keys already holding a general slot.
// Returns {picks: [{key, symbols, pass}], passedOver: [{key, reason}]} with
// picks in the order they were taken.
function pickPortfolioArticles({
  articles,
  portfolioSlotList,
  slots = settingValue('portfolioSlots'),
  firstPassPerCompany = settingValue('portfolioFirstPassPerCompany'),
  alreadyChosen = new Set()
}) {
  if (!Array.isArray(articles)) throw new TypeError('articles must be an array');
  if (!Array.isArray(portfolioSlotList)) throw new TypeError('portfolioSlotList must be an array');
  if (!Number.isInteger(slots) || slots < 0) throw new TypeError('slots must be a whole number >= 0');
  if (!Number.isInteger(firstPassPerCompany) || firstPassPerCompany < 1) {
    throw new TypeError('firstPassPerCompany must be a whole number >= 1');
  }
  const chosen = alreadyChosen instanceof Set ? alreadyChosen : new Set(alreadyChosen);

  const passedOver = [];
  const eligible = [];
  articles.forEach((article, listIndex) => {
    if (article?.isRecap === true) {
      passedOver.push({key: article.key, reason: 'RECAP'});
      return;
    }
    if (chosen.has(article.key)) {
      passedOver.push({key: article.key, reason: 'ALREADY_CHOSEN'});
      return;
    }
    const symbols = [];
    for (const item of portfolioSlotList) {
      if (!symbols.includes(item.symbol) && headlineMatchesIdentity(article.headline, item)) {
        symbols.push(item.symbol);
      }
    }
    if (symbols.length === 0) {
      passedOver.push({key: article.key, reason: 'NO_PORTFOLIO_COMPANY'});
      return;
    }
    eligible.push({
      key: article.key,
      symbols,
      score: article.score,
      ageHours: Number.isFinite(article.ageHours) ? article.ageHours : null,
      listIndex
    });
  });
  eligible.sort(compareScoredArticles);

  const picks = [];
  const taken = new Set();
  const perCompany = new Map();
  for (const entry of eligible) {
    if (picks.length >= slots) break;
    if (!entry.symbols.some(symbol => (perCompany.get(symbol) || 0) < firstPassPerCompany)) continue;
    picks.push({key: entry.key, symbols: entry.symbols, pass: 'FIRST_PASS'});
    taken.add(entry.key);
    for (const symbol of entry.symbols) perCompany.set(symbol, (perCompany.get(symbol) || 0) + 1);
  }
  for (const entry of eligible) {
    if (picks.length >= slots) break;
    if (taken.has(entry.key)) continue;
    picks.push({key: entry.key, symbols: entry.symbols, pass: 'SECOND_PASS'});
    taken.add(entry.key);
  }
  for (const entry of eligible) {
    if (!taken.has(entry.key)) passedOver.push({key: entry.key, reason: 'SLOTS_FULL'});
  }
  return Object.freeze({
    picks: Object.freeze(picks.map(pick => Object.freeze({...pick, symbols: Object.freeze(pick.symbols)}))),
    passedOver: Object.freeze(passedOver.map(entry => Object.freeze(entry)))
  });
}

module.exports = {
  pickPortfolioArticles
};
