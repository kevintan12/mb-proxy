'use strict';

// Step 9AR Build 1: made-up data only. Not connected to the pipeline.
const test = require('node:test');
const assert = require('node:assert/strict');
const {buildFactLookup, findFigureClaims} = require('../lib/report-accuracy-facts');

const DATES = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];

function snapshot(symbol, instrumentName, changes) {
  return {
    reference: `T:${symbol}`,
    snapshot: {
      symbol,
      instrumentName,
      completedSessions: changes.map(([absoluteChange, percentChange], i) => ({
        sessionDate: DATES[i], close: 1000 + i, absoluteChange, percentChange
      }))
    }
  };
}

function fixture() {
  return {
    marketPackages: [{
      telemetry: {
        benchmarkSnapshots: [
          snapshot('^GSPC', 'S&P 500', [[10.1, 0.11], [-5.2, -0.12], [14.4, 0.31], [-3.3, -0.07], [8.8, 0.18]]),
          snapshot('^IXIC', 'NASDAQ Composite', [[50.5, 0.21], [-60.6, -0.25], [30.3, 0.14], [-40.4, -0.52], [70.7, 0.33]]),
          snapshot('^DJI', 'Dow Jones Industrial Average', [[100.1, 0.22], [-90.9, -0.19], [237.33, 0.55], [-20.2, -0.04], [60.6, 0.13]]),
          snapshot('^RUT', 'Russell 2000', [[1.1, 0.06], [-2.2, -0.09], [3.3, 0.15], [-4.4, -0.21], [5.5, 0.27]])
        ],
        stockSnapshots: [
          snapshot('CPRT', 'Copart, Inc.', [[0.5, 1.1], [0.77, 1.4], [-0.09, -0.19], [0.2, 0.4], [-0.3, -0.6]]),
          snapshot('ACME', 'Acme Widgets Corporation', [[1.01, 2.1], [-1.02, -2.2], [0.88, 1.7], [-0.45, -0.9], [0.62, 1.3]]),
          // Same percent in both signs on different sessions
          snapshot('ZZZ', 'Zeta Zone Holdings', [[0.4, 0.45], [-0.4, -0.45], [0.1, 0.12], [0.2, 0.22], [0.3, 0.33]])
        ]
      }
    }]
  };
}

const lookup = buildFactLookup(fixture());

test('lookup lists five sessions per subject with date, close and both changes', () => {
  assert.equal(lookup.subjects.length, 7);
  const copart = lookup.subjects.find(s => s.symbol === 'CPRT');
  assert.equal(copart.sessions.length, 5);
  assert.deepEqual(Object.keys(copart.sessions[0]).sort(), ['absoluteChange', 'close', 'date', 'percentChange']);
  assert.equal(copart.sessions[4].date, '2026-10-30');
});

test('Copart "gained $0.09" when it fell is flagged as a disagreement', () => {
  const claims = findFigureClaims('Copart gained $0.09 on Wednesday.', lookup);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].symbol, 'CPRT');
  assert.equal(claims[0].sessionDate, '2026-10-28');
  assert.equal(claims[0].trueDirection, 'down');
  assert.equal(claims[0].sentenceDirection, 'up');
  assert.equal(claims[0].sentenceWord, 'gained');
  assert.equal(claims[0].disagrees, true);
});

test('name followed by ticker in brackets still resolves to the one stock', () => {
  const claims = findFigureClaims('Copart, Inc. (CPRT) gained $0.09.', lookup);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].disagrees, true);
});

test('three-index sentence with one wrong word returns three claims, one disagreeing', () => {
  const claims = findFigureClaims(
    'The S&P 500 rose 0.31%, the Nasdaq fell 0.14% and the Dow gained 237.33 points.', lookup);
  assert.equal(claims.length, 3);
  const bySymbol = Object.fromEntries(claims.map(c => [c.symbol, c]));
  assert.equal(bySymbol['^GSPC'].disagrees, false);
  assert.equal(bySymbol['^IXIC'].disagrees, true);
  assert.equal(bySymbol['^IXIC'].trueDirection, 'up');
  assert.equal(bySymbol['^IXIC'].sentenceWord, 'fell');
  assert.equal(bySymbol['^DJI'].disagrees, false);
  assert.equal(bySymbol['^DJI'].sessionDate, '2026-10-28');
});

test('a correct sentence returns agree', () => {
  const claims = findFigureClaims('The Russell 2000 slipped 0.21%.', lookup);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].trueDirection, 'down');
  assert.equal(claims[0].disagrees, false);
});

test('skip: whole-number figures', () => {
  assert.deepEqual(findFigureClaims('Acme added 11% over the week.', lookup), []);
  assert.deepEqual(findFigureClaims('Acme added 2% on Monday.', lookup), []);
});

test('skip: hedged figures', () => {
  for (const hedge of ['about', 'nearly', 'just over', 'more than', 'roughly', 'almost']) {
    assert.deepEqual(findFigureClaims(`Acme fell ${hedge} 2.2%.`, lookup), [], hedge);
  }
});

test('skip: levels after "to", "at" and "closed at"', () => {
  assert.deepEqual(findFigureClaims('The S&P 500 rose to 5,432.10.', lookup), []);
  assert.deepEqual(findFigureClaims('The Dow fell at 237.33 points.', lookup), []);
  assert.deepEqual(findFigureClaims('Copart closed at $0.09.', lookup), []);
  assert.deepEqual(findFigureClaims('Copart rose to $0.77.', lookup), []);
  assert.deepEqual(findFigureClaims('Acme closed at $1.01.', lookup), []);
});

test('skip: a figure that matches sessions with opposite signs', () => {
  assert.deepEqual(findFigureClaims('Zeta Zone Holdings rose 0.45%.', lookup), []);
});

test('skip: pre-market or foreign-listing figures that match no session', () => {
  assert.deepEqual(findFigureClaims('Acme rose 3.77% in pre-market trading.', lookup), []);
  assert.deepEqual(findFigureClaims('Acme fell $9.99 in Frankfurt.', lookup), []);
});

test('skip: two names with no clear order', () => {
  assert.deepEqual(findFigureClaims('The Nasdaq and the S&P 500 rose 0.31%.', lookup), []);
  assert.deepEqual(findFigureClaims('The Dow, Nasdaq and S&P 500 fell 0.14%.', lookup), []);
});

test('skip: no direction word, no known subject, empty input', () => {
  assert.deepEqual(findFigureClaims('The S&P 500 0.31% on the day.', lookup), []);
  assert.deepEqual(findFigureClaims('Gold rose 0.31%.', lookup), []);
  assert.deepEqual(findFigureClaims('', lookup), []);
  assert.deepEqual(findFigureClaims(null, lookup), []);
  assert.deepEqual(findFigureClaims('The S&P 500 rose 0.31%.', buildFactLookup({})), []);
});

test('the same decimal on two sessions with the same sign is not pinned to one date', () => {
  const twice = buildFactLookup({marketPackages: [{telemetry: {benchmarkSnapshots: [], stockSnapshots: [
    snapshot('TWIN', 'Twin Corp', [[0.1, 0.5], [0.2, 0.5], [0.3, 0.7], [0.4, 0.8], [0.5, 0.9]])
  ]}}]});
  assert.deepEqual(findFigureClaims('Twin rose 0.5%.', twice), []);
});

test('the function never changes its inputs', () => {
  const pkg = fixture();
  const before = JSON.stringify(pkg);
  const local = buildFactLookup(pkg);
  findFigureClaims('The S&P 500 rose 0.31%.', local);
  assert.equal(JSON.stringify(pkg), before);
});
