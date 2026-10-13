// Step 9F.2e.4a: Yahoo news listings for the score try-order tests
// (tests/article-selection.test.js, tests/source-reader.test.js).
//
// LISTING_2026_10_12: the first live Pre-market run of the Step 9 work
// (12 Oct 2026). Rows 1-37 are the logged audit rows in today's tier order
// ([logged score, age label, publisher, edition, headline]); the logged score is
// kept for the record only -- tests compute their own with scoreArticle. Then
// the three headlines the drop rule removed, then plain rows scoring 10 or
// less (two of them old-labelled) so the listing has 74 candidates. Most Active
// and the lists are set so rows 1, 3, 5 and 6 get most-active points and rows
// 1-6 get portfolio points, as in the run.
'use strict';

const TRIGGER_2026_10_12 = '2026-10-12T11:30:00.000Z';
// The reading window start for that run: 24 hours before Friday 9 Oct's
// 16:00 New York close.
const WINDOW_START_2026_10_12 = '2026-10-08T20:00:00.000Z';

const MOST_ACTIVE_2026_10_12 = Object.freeze([
  {symbol: 'NVDA', shortName: 'NVIDIA Corporation', longName: 'NVIDIA Corporation'},
  {symbol: 'INTC', shortName: 'Intel Corporation', longName: 'Intel Corporation'}
]);
const PORTFOLIO_2026_10_12 = Object.freeze([
  {symbol: 'NVDA', instrumentName: 'NVIDIA Corporation'},
  {symbol: 'AMD', instrumentName: 'Advanced Micro Devices, Inc.'}
]);

const LOGGED_ROWS_2026_10_12 = Object.freeze([
  [45, '2h ago', 'Stocktwits', 'US', 'INTC, AMD, NVDA, MU: Chip Stocks Open Mixed Premarket After Worst Week In A Month'],
  [30, '12h ago', 'Simply Wall St', 'US', 'Advanced Micro Devices (AMD) Stock Falls After AI Revenue Reset Shakes Demand Outlook'],
  [45, '1d ago', 'MarketWatch', 'US', "Why Nvidia's stock is dodging the AI credit scare that is crushing Broadcom and Oracle"],
  [32, '4h ago', 'Simply Wall St', 'US', 'AMD Stock And Two AI Infrastructure Names Facing A Big Margin Test'],
  [40, '1d ago', 'Motley Fool', 'US', "Meet the Only AI Stock I'd Buy Over Nvidia in October"],
  [40, '1d ago', 'Motley Fool', 'US', "TSMC Reports Oct. 15. It's the Best Early Read on Nvidia's Next Quarter."],
  [30, '2h ago', 'Bloomberg', 'US', 'Goldman Strategists Upgrade Global Stocks on Earnings Boost'],
  [29, '1h ago', 'Reuters', 'SG', 'European shares climb on bank gains, focus turns to earnings season'],
  [29, '2h ago', 'Reuters', 'SG', 'Dollar firm near 18-month highs, as Gulf unrest, US inflation keep investors on edge'],
  [20, '1d ago', 'Insider Monkey', 'US', "Broadcom's AI Revenue Is Tripling, but the Stock Has Lagged"],
  [23, '13h ago', 'Barchart', 'US', 'The S&P 500 Is Near Record Highs. So Why Does Your Portfolio Feel Like a Bear Market'],
  [20, '2d ago', 'Motley Fool', 'US', "This Forgotten AI Stock Is Up 689% and Nobody's Talking About It"],
  [24, '1h ago', 'Motley Fool', 'US', 'Mark My Words: ASML Stock Is the Most Overlooked Way to Play the AI Infrastructure'],
  [21, '2d ago', 'Stocktwits', 'US', "Tom Lee Says Stocks Are A 'Coiled Spring' As AI Skepticism Peaks"],
  [23, '8h ago', 'BeInCrypto', 'US', 'A Few Stocks Carry the S&P 500: 41% of Stocks Trade 30% Below Highs'],
  [23, '10h ago', 'TheStreet', 'US', 'Sector rotation reveals new buying opportunities (even with the S&P 500 near records)'],
  [21, '1d ago', 'Motley Fool', 'US', "The Stock Market's Biggest Winners Are Hiding a Problem"],
  [21, '2d ago', 'Motley Fool', 'US', "I've Owned the Vanguard S&P 500 ETF for 6 Years"],
  [20, '2d ago', 'Yahoo Finance', 'US', "Why AI bubble fears aren't keeping this Amazon boss up at night"],
  [20, '2d ago', 'Simply Wall St', 'US', 'ASML Holding (ENXTAM:ASML) Faces An AI Pullback'],
  [20, '2d ago', 'Zacks', 'US', "ASML's Q3 Earnings Coming Up"],
  [25, '53m ago', 'InvestorsHub', 'US', 'Oil Prices Decline as Investors Await US Inflation Data and Bank Earnings Amid Gulf tensions'],
  [22, '7h ago', 'TheStreet', 'US', 'Earnings season will fight the real world for attention'],
  [20, '2d ago', 'Zacks', 'US', 'Record Profits at Samsung and TSMC Say the AI Trade is Intact'],
  [25, '1h ago', 'Euronews', 'US', "Oil prices drop as stocks rise after Trump touts 'energy ceasefire'"],
  [25, '2h ago', 'Yahoo Finance', 'US', 'Strip out AI stocks, and the US market lags Europe'],
  [23, '16h ago', 'USA TODAY', 'US', "Is the stock market open on Columbus Day, Indigenous Peoples' Day?"],
  [22, '17h ago', 'Barchart', 'US', 'CoreWeave Just Landed a Massive New AI Opportunity'],
  [23, '21h ago', 'Barchart', 'US', "Domino's Pizza Releases Earnings Pre-Market on Tuesday, Oct. 13"],
  [23, '23h ago', 'Fortune', 'US', 'The hawk Fed Chair who broke the bond market?'],
  [20, '1d ago', 'Barchart', 'US', 'Cantor Fitzgerald Thinks This Little-Known AI Stock Is Set to Soar 300%'],
  [24, '53m ago', 'Investing.com', 'SG', 'Premarket movers: Iren jumps on Anthropic deal, CCC surges on buyout talks'],
  [25, '54m ago', 'Simply Wall St', 'SG', 'Asian Oil Storage Stocks In Focus As Japan Pushes Bigger Regional Reserves'],
  [24, '1h ago', 'MT Newswires', 'SG', "Singapore's STI Edges up on Lower Oil Prices"],
  [24, '1h ago', 'Investing.com', 'SG', 'Iren shares jump 5% in premarket trade on report of Anthropic AI cloud deal'],
  [25, '1h ago', 'Simply Wall St', 'SG', 'Elite AI Stocks To Own In October 2026'],
  [24, '1h ago', 'Investing.com', 'SG', 'Sterling today: Pound edges up, euro slips as Fed bets back dollar']
].map(row => Object.freeze(row)));

const DROPPED_HEADLINES_2026_10_12 = Object.freeze([
  'How to Play Rivian Stock as RIVN Keeps Falling Despite Record Deliveries',
  '3 Australian Stocks Trading Up To 43% Below Fair Value',
  'Australia, NZ telecom shares tumble as SpaceX spectrum deal stokes fears'
]);

const FILLER_AGES = ['3h ago', '9h ago', '1d ago', '2d ago', null, '40m ago', '5d ago'];

const slugOf = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function listingCandidate(headline, publisher, ageLabel, edition = 'US') {
  return {
    headline, url: `https://finance.yahoo.com/news/${slugOf(headline)}.html`, uuid: null, publisher, edition,
    ...(ageLabel ? {ageLabel} : {})
  };
}

// A fresh array of fresh candidate objects (the reader needs one object per row).
function listing2026_10_12() {
  const rows = LOGGED_ROWS_2026_10_12.map(([, ageLabel, publisher, edition, headline]) =>
    listingCandidate(headline, publisher, ageLabel, edition));
  const dropped = DROPPED_HEADLINES_2026_10_12.map(headline => listingCandidate(headline, 'Simply Wall St', '3h ago'));
  const fillers = Array.from({length: 34}, (_, index) => listingCandidate(
    `Filler Holdings ${index + 1} names a new chief operating officer`, 'Zacks', FILLER_AGES[index % FILLER_AGES.length]));
  return rows.concat(dropped, fillers);
}

// The harness's REAL HEADLINES scenario (Replay Packages/harness), with its
// Most Active list; the publish times there are not part of the listing.
const REAL_HEADLINES = Object.freeze([
  ['Stock market today: Dow, S&P 500, Nasdaq fall as Treasury yields continue to climb', 'Yahoo Finance', '2h ago'],
  ['Dollar steadies near two-month high as US-Iran stalemate lifts oil, Fed rate hike bets', 'Reuters', '3h ago'],
  ['Stocks fall as Middle East stalemate boosts oil', 'Reuters', null],
  ['Morning Bid: Inflation relief gives bonds little reprieve', 'Reuters', '5h ago'],
  ['Dow futures hit three-month low as yields surge, Micron earnings offer support', 'Yahoo Finance', '30m ago'],
  ['Microsoft’s Trillion-Dollar Quarter Shows AI Trade Won’t Quit', 'Motley Fool', '2h ago'],
  ['Elizabeth Warren demands answers on $96B in lost federal revenue as Amazon, Google, Meta and Microsoft shift', 'Yahoo Finance', null],
  ['Nvidia, Broadcom, and AMD Investors Need to Have Oct. 15 Circled on Their Calendars', 'Motley Fool', '8h ago'],
  ['UNH stock slides after Medicare rate update', 'Barchart', '4h ago'],
  ['Veeva Systems (VEEV) beats on subscription revenue', 'Zacks', '6h ago'],
  ['Apple supplier warns on iPhone demand', 'Insider Monkey', '10h ago'],
  ['Could Blockchain Create Another Growth Lever for SoFi Technologies (SOFI) and Mastercard (MA)?', 'Zacks', '3h ago'],
  ['Kodiak Sciences (KOD) Climbs Nearly 3x on Promising Wet AMD Trial', 'Yahoo Finance', '2h ago'],
  ['China factory data lifts sentiment', 'AFP', '7h ago'],
  ['Nikkei slips as yen strengthens', 'Bloomberg', '9h ago'],
  ['Verbund shares rise 3% after Deutsche Bank upgrade to Hold', 'Yahoo Finance', '4h ago'],
  ['Singapore Stocks Rally to Three-Week High; Oiltek International Zooms 13%', 'Yahoo Finance', '2h ago'],
  ['What’s a ‘normal’ age to retire? Americans can’t decide between 4 milestones', 'Yahoo Finance', '3h ago'],
  ['Australian developer axes Sydney suburban data centre plan after local opposition', 'Reuters', '1h ago'],
  ['How to trade volatile markets', 'Yahoo Finance', '1h ago'],
  ['How to open a savings account', 'Yahoo Finance', '2h ago'],
  ['Investors weigh how to respond to the rate path', 'Yahoo Finance', '2h ago'],
  ['Singapore markets react as Fed raises rates', 'Reuters', '4h ago'],
  ['Thai baht weakens as China exports slow', 'Reuters', '5h ago'],
  ['Better Collective shares plunge 24% to early 2020 lows after Brazil ban', 'Yahoo Finance', '6h ago'],
  ['GE Aerospace (GE) and Kratos Defense & Security (KTOS) are Expanding Their Defense Footprint', 'Zacks', '1h ago'],
  ['Retailer names a new chief executive', 'Reuters', '12h ago'],
  ['Russell rebounds after a volatile trading day', 'Yahoo Finance', '2d ago']
].map(row => Object.freeze(row)));

const REAL_HEADLINES_MOST_ACTIVE = Object.freeze([
  {symbol: 'NVDA', shortName: 'NVIDIA Corporation', longName: 'NVIDIA Corporation'},
  {symbol: 'SOFI', shortName: 'SoFi Technologies, Inc.', longName: 'SoFi Technologies, Inc.'},
  {symbol: 'INTC', shortName: 'Intel Corporation', longName: 'Intel Corporation'}
]);

function realHeadlinesListing() {
  return REAL_HEADLINES.map(([headline, publisher, ageLabel]) => listingCandidate(headline, publisher, ageLabel));
}

// The Pre-market "no material news" package of 28 Sep 2026: its three Yahoo
// headlines and both of its lists (12 companies).
const NO_MATERIAL_HEADLINES = Object.freeze([
  'Australian developer axes Sydney suburban data centre plan after local opposition',
  'Singapore Stocks Rally to Three-Week High; Oiltek International Zooms 13%',
  'What’s a ‘normal’ age to retire? Americans can’t decide between 4 milestones — the wrong call could cost you thousands'
]);

const NO_MATERIAL_PORTFOLIO = Object.freeze([
  ['CPRI', 'Capri Holdings Limited'], ['UNH', 'UnitedHealth Group Incorporated'], ['NVO', 'Novo Nordisk A/S'],
  ['CPRT', 'Copart, Inc.'], ['NVDA', 'NVIDIA Corporation'], ['MSFT', 'Microsoft Corporation'],
  ['VEEV', 'Veeva Systems Inc.'], ['SPYM', 'State Street SPDR Portfolio S&P 500 ETF'],
  ['VOO', 'Vanguard S&P 500 ETF'], ['AAPL', 'Apple Inc.'], ['CRM', 'Salesforce, Inc.'],
  ['VRSK', 'Verisk Analytics, Inc.']
].map(([symbol, instrumentName]) => Object.freeze({symbol, instrumentName})));

function noMaterialListing() {
  return NO_MATERIAL_HEADLINES.map(headline => listingCandidate(headline, 'Yahoo Finance', null));
}

module.exports = {
  TRIGGER_2026_10_12,
  WINDOW_START_2026_10_12,
  MOST_ACTIVE_2026_10_12,
  PORTFOLIO_2026_10_12,
  LOGGED_ROWS_2026_10_12,
  DROPPED_HEADLINES_2026_10_12,
  listing2026_10_12,
  REAL_HEADLINES,
  REAL_HEADLINES_MOST_ACTIVE,
  realHeadlinesListing,
  NO_MATERIAL_HEADLINES,
  NO_MATERIAL_PORTFOLIO,
  noMaterialListing
};
