// Step 9D.5a: completeness guards for the shared section-rule registry
// (lib/section-rules.js, bound in lib/claude-analysis-contract.js as SECTION_RULES).
//
// These read the two matrix files as text -- the Step 9D.1 matrix
// (tests/section-rules-matrix.test.js, which must not be edited and exports
// nothing) and the Step 9D.5a extra rows (tests/section-rules-matrix-extra.test.js)
// -- and fail when:
//   1. a registry rule has no matrix row,
//   2. a rule's rows do not, between them, cover every state in the settings table,
//   3. a settings-table state has no matrix column (or the matrix has a column
//      the settings table does not know),
//   4. a matrix file uses a rule label the table below does not map.
// So a rule or a state added without test coverage fails here.
//
// How a "row" is found: each test() call is one row. Its labels are the
// R-labels in its body (up to the next "// ----" banner or test()), plus, for
// a test that loops over RULE_CASES, the labels in that table's `id`s. Its
// states are all of MARKET_STATE_CASES when it loops `of MARKET_STATE_CASES`,
// plus any state named as a string literal in its body.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  SECTION_RULES,
  validateClaudeAnalysisOutput,
  createClaudeAnalysisInput,
  REPORT_HEADER,
  REPORT_SECTION_NAMES
} = require('../lib/claude-analysis-contract');
const {
  US_SECTION_RULE_STATES,
  reportSettings,
  failedRescueScope,
  sectionOneRequired,
  nothingSurvivedFallbackEnabled
} = require('../lib/section-rules');
const {createEvidenceItem} = require('../lib/evidence-items');
const {createEvidenceCollection} = require('../lib/evidence-collections');
const {createCompletedRegularSession, createFiveSessionSnapshot} = require('../lib/five-session-snapshot');
const {MARKET_STATE_CASES} = require('./fixtures/market-state-cases');

// ---------------------------------------------------------------------------
// The one visible label table: each matrix file's own labels -> the Step 9D
// inventory's rule numbers. The 9D.1 matrix uses some older labels.
// ---------------------------------------------------------------------------
const MATRIX_LABELS = {
  'section-rules-matrix.test.js': {
    R4: [4], // unknown references
    R5: [5], // duplicate telemetry / uncertainties
    R6: [6], // malformed plain-language prose
    R7: [7], // internal identifier leak
    R7b: [13], // Section 2: causal claim, no principal catalyst
    R7c: [14], // Section 2: prior-session claim, no completed-session catalyst
    R7d: [15], // Section 2: current-session claim, no current-session catalyst
    R7e: [13], // Section 2 family's clean case (a cited catalyst; no rule fires)
    R8: [26], // the 2,500-word cap (rule 26 in the inventory)
    R9: [9], R10: [10], R13: [13], R16: [16],
    R18: [18], R19: [19], R20: [20], R21: [21], R22: [22], R23: [23], R24: [24],
    R25: [25], R27: [27], R28: [28], R29: [29]
  },
  'section-rules-matrix-extra.test.js': {
    R1: [1], R2: [2], R3: [3], R8: [8], R11: [11], R12: [12], R17: [17],
    R27: [27], R28: [28], R30: [30]
  }
};

const LABEL_PATTERN = /\bR\d+[a-z]?\b/g;

function parseMatrixFile(fileName, stateNames) {
  const lines = fs.readFileSync(path.join(__dirname, fileName), 'utf8').split(/\r?\n/);
  const stateLiteral = new RegExp(`'(${stateNames.join('|')})'`, 'g');
  const tableLabels = [...lines.join('\n').matchAll(/\bid: '([^']+)'/g)]
    .flatMap(match => match[1].split('-').filter(token => /^R\d+[a-z]?$/.test(token)));
  const rows = [];
  for (let start = 0; start < lines.length; start++) {
    if (!lines[start].startsWith('test(')) continue;
    let end = start + 1;
    while (end < lines.length && !lines[end].startsWith('test(') && !lines[end].startsWith('// ----')) end++;
    const body = lines.slice(start, end).join('\n');
    const labels = new Set(body.match(LABEL_PATTERN) || []);
    if (/of\s+RULE_CASES\b/.test(body)) for (const label of tableLabels) labels.add(label);
    const states = new Set([...body.matchAll(stateLiteral)].map(match => match[1]));
    if (/of\s+MARKET_STATE_CASES\b/.test(body)) {
      for (const [marketState] of MARKET_STATE_CASES) states.add(marketState);
    }
    rows.push({title: lines[start], labels: [...labels], states: [...states]});
  }
  return rows;
}

function coverageByRule() {
  const coverage = new Map();
  const unmapped = [];
  for (const [fileName, labelTable] of Object.entries(MATRIX_LABELS)) {
    for (const row of parseMatrixFile(fileName, US_SECTION_RULE_STATES)) {
      for (const label of row.labels) {
        if (!Object.hasOwn(labelTable, label)) {
          unmapped.push(`${fileName}: ${label}`);
          continue;
        }
        for (const ruleNumber of labelTable[label]) {
          const states = coverage.get(ruleNumber) || new Set();
          for (const state of row.states) states.add(state);
          coverage.set(ruleNumber, states);
        }
      }
    }
  }
  return {coverage, unmapped};
}

test('Step 9D.5a: the matrix parser finds the rows it should (guards against a vacuous pass)', () => {
  const original = parseMatrixFile('section-rules-matrix.test.js', US_SECTION_RULE_STATES);
  const extra = parseMatrixFile('section-rules-matrix-extra.test.js', US_SECTION_RULE_STATES);
  assert.equal(original.length >= 13, true);
  assert.equal(extra.length >= 9, true);
  const tableRow = original.find(row => row.labels.includes('R24'));
  assert.deepEqual(tableRow.states.slice().sort(), US_SECTION_RULE_STATES.slice().sort());
  const regularOnly = original.find(row => row.title.includes('R28'));
  assert.deepEqual(regularOnly.states, ['REGULAR']);
});

test('Step 9D.5a: every registry rule has at least one matrix row', () => {
  const {coverage} = coverageByRule();
  const missing = Object.values(SECTION_RULES)
    .filter(rule => !coverage.has(rule.number)).map(rule => `rule ${rule.number} (${rule.id})`);
  assert.deepEqual(missing, []);
});

test('Step 9D.5a: every registry rule is covered in every state of the settings table', () => {
  const {coverage} = coverageByRule();
  const gaps = Object.values(SECTION_RULES).flatMap(rule => {
    const states = coverage.get(rule.number) || new Set();
    const missingStates = US_SECTION_RULE_STATES.filter(state => !states.has(state));
    return missingStates.length ? [`rule ${rule.number} (${rule.id}): ${missingStates.join(', ')}`] : [];
  });
  assert.deepEqual(gaps, []);
});

test('Step 9D.5a: every settings-table state has a matrix column, and nothing else does', () => {
  const columns = MARKET_STATE_CASES.map(([marketState]) => marketState);
  assert.deepEqual(columns.slice().sort(), US_SECTION_RULE_STATES.slice().sort());
  for (const state of US_SECTION_RULE_STATES) {
    assert.equal(reportSettings('US', state).sectionRulesEnabled, true, state);
  }
});

test('Step 9D.5a: every label used in a matrix file is in the label table', () => {
  const {unmapped} = coverageByRule();
  assert.deepEqual(unmapped, []);
});

test('Step 9D.5a: the registry has one entry per inventory rule, 1 to 30', () => {
  const rules = Object.values(SECTION_RULES);
  assert.deepEqual(rules.map(rule => rule.number).sort((a, b) => a - b),
    Array.from({length: 30}, (_, index) => index + 1));
  for (const rule of rules) {
    assert.equal(Object.isFrozen(rule), true, rule.id);
    assert.equal(SECTION_RULES[rule.id], rule, rule.id);
    assert.equal(rule.detect === null || typeof rule.detect === 'function', true, rule.id);
    // A rule with no shared detector, or only one side using it, says why.
    if (rule.detect === null || rule.usedBy.length < 2) {
      assert.equal(typeof rule.notShared, 'string', rule.id);
    }
  }
});

test('Step 9D.5a: the settings readers give today\'s answers, including the non-US fallback', () => {
  const disabled = reportSettings('SG', 'CLOSED');
  assert.equal(disabled.sectionRulesEnabled, false);
  assert.equal(failedRescueScope(disabled), 'SECTION_ONE');
  assert.equal(sectionOneRequired(disabled), true);
  assert.equal(nothingSurvivedFallbackEnabled(disabled), false);
  for (const state of ['PRE', 'REGULAR', 'POST']) {
    const settings = reportSettings('US', state);
    assert.equal(failedRescueScope(settings), 'ANY_SECTION', state);
    assert.equal(sectionOneRequired(settings), false, state);
    assert.equal(nothingSurvivedFallbackEnabled(settings), true, state);
  }
  for (const state of ['CLOSED', 'WEEKEND', 'HOLIDAY']) {
    const settings = reportSettings('US', state);
    assert.equal(failedRescueScope(settings), 'SECTION_ONE', state);
    assert.equal(sectionOneRequired(settings), true, state);
    assert.equal(nothingSurvivedFallbackEnabled(settings), false, state);
  }
});

test('Step 9D.5a: rule 25 still requires Section 1 for a Singapore report', () => {
  const session = createCompletedRegularSession({
    market: 'SG', sessionDate: '2026-09-04', open: 5700, high: 5800, low: 5650,
    close: 5747, previousClose: 5710, volume: null, asOf: '2026-09-04T17:00:00+08:00',
    sourceId: 'sg.yahoo-finance', validationState: 'VALIDATED'
  });
  const snapshot = createFiveSessionSnapshot({
    market: 'SG', symbol: '^STI', instrumentName: 'Straits Times Index', instrumentType: 'INDEX',
    currency: 'SGD', marketState: 'CLOSED', completedSessions: [session], currentOverlay: null
  });
  const item = createEvidenceItem({
    sourceId: 'sg.reuters', market: 'SG', evidenceCategory: 'news', title: 'Technology sector update',
    canonicalUrl: 'https://www.reuters.com/markets/example', publishedAt: '2026-09-06T08:00:00Z'
  });
  const input = createClaudeAnalysisInput({
    analysisRequest: {
      selectedScope: 'SG', initiatingList: 'myStocks', generatedAt: '2026-09-06T18:00:00+08:00',
      userTimezone: 'Asia/Singapore', reportType: 'MARKET_BRIEF'
    },
    marketPackages: [{
      market: 'SG',
      marketContext: {
        exchangeTimezone: 'Asia/Singapore', marketState: 'CLOSED',
        primaryCompletedSessionDate: '2026-09-04', includesCurrentOverlay: false,
        calendarContext: 'Weekend; latest completed session remains applicable.'
      },
      telemetry: {benchmarkSnapshots: [snapshot], stockSnapshots: []},
      evidenceCollection: createEvidenceCollection({market: 'SG', items: [item]}),
      evidenceContext: {
        materialEvents: ['e1'], authoritativeFacts: [], principalCatalysts: ['e1'],
        supportingEvidence: ['e1'], conflictingEvidence: [], subsequentDevelopments: [],
        sessionAssociations: [],
        broadMarketFocus: [{evidenceRef: 'e1', subjects: [{kind: 'SECTOR', name: 'Technology'}]}],
        unresolvedGaps: [], furtherReadings: []
      }
    }],
    portfolioContext: {myStocks: [], watchlist: []}
  });
  const output = {
    status: 'DEGRADED',
    reportContext: {
      header: REPORT_HEADER, selectedScope: 'SG', generatedAt: input.analysisRequest.generatedAt,
      userTimezone: 'Asia/Singapore', reportType: 'MARKET_BRIEF', markets: ['SG']
    },
    sections: REPORT_SECTION_NAMES.map((name, index) => ({
      name, content: null, evidenceRefs: [], telemetryRefs: [],
      uncertainties: index === 7 ? [] : ['Not enough data.']
    })),
    evidenceReferences: [], furtherReadings: [], evidenceGaps: ['Not enough data.']
  };
  const {errors} = validateClaudeAnalysisOutput(output, input);
  assert.equal(errors.includes('sections[0]: executive market summary requires supported content'), true);
});
