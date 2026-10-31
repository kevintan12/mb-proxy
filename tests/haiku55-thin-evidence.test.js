// Step 9AF: the Haiku 5.5 thin-evidence fix. With haiku55WriterDepthEnabled on, a Haiku 5.5
// writer request says a thin package still supports Sections 5 and 6, keeps field names out of
// the notes, and carries the fuller Section 4 line; a Haiku 5.5 section retry for a section the
// writer left empty itself points to what the package supplies; and a Haiku 5.5 note line
// (evidence gap or section uncertainty) that names an internal field is replaced with a fixed
// plain sentence. Section text is never rewritten. Haiku 4.5, the switch off and every other
// call are unchanged (the d00c78e requests and retry text exactly).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {buildClaudeAnalysisRequest, invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {sectionRetryInstruction} = require('../lib/writer-section-retry');
const {REPORT_SECTION_NAMES} = require('../lib/claude-analysis-contract');
const {
  buildClaudeEvidenceRoleClassificationRequest,
  buildClaudeEvidenceSubjectRepairRequest
} = require('../lib/claude-evidence-role-classification');
const {buildClaudeBoundedNewsDiscoveryRequest} = require('../lib/claude-bounded-news-discovery');
const {
  buildClaudeBoundedCnbcMarketNewsDiscoveryRequests
} = require('../lib/claude-bounded-cnbc-market-news-discovery');
const {buildClaudeNewsMaterialityRequest} = require('../lib/claude-news-materiality-selection');
const {
  createNewsEvidenceCandidate,
  createNewsEvidenceCandidateCollection
} = require('../lib/news-evidence-candidates');
const {createEvidenceItem} = require('../lib/evidence-items');
const {createCompletedRegularSession, createFiveSessionSnapshot} = require('../lib/five-session-snapshot');
const {MARKET_STATE_CASES, marketStateCase, providerTransport} = require('./fixtures/market-state-cases');

const THIN_LINE = ' THIN EVIDENCE: a package with few articles and no principal catalyst';
const NOTE_EXAMPLES = 'for example "no article explains why the market moved"';
const NOT_EMPTY = 'which is a reason to write what the evidence does support, not a reason to leave a section empty';
const SECTION_FOUR_REPLACES = 'It also replaces, in Section 4 only, the earlier instructions to set Section 4 content to null';
const NAME_CLASH = 'a drug trial for wet AMD, an eye disease, is not about the chipmaker AMD';
const POINTER = 'you may add one short sentence in Section 4 that names the stock and points to Stocks & Sectors in Focus';
const BLOCK_PARTS = [THIN_LINE, NOTE_EXAMPLES, NOT_EMPTY];
const SECTION_FOUR_PARTS = [SECTION_FOUR_REPLACES, NAME_CLASH, POINTER];
const ALL_PARTS = BLOCK_PARTS.concat(SECTION_FOUR_PARTS);
const HINT = 'empty yourself; no check removed anything.';
const GAP_LINE = 'Part of the evidence this report needed was not available.';
const NOTE_LINE = 'Part of the evidence this section needed was not available.';
const FIELD_NAMES = ['evidenceContext', 'analysisRequest', 'portfolioContext', 'outputRequirements',
  'marketContext', 'telemetryContext', 'broadMarketFocus', 'materialEvents', 'principalCatalysts',
  'subsequentDevelopments', 'sessionAssociations', 'unresolvedGaps', 'evidenceRefs', 'telemetryRefs',
  'evidenceGaps', 'initiatingList', 'sectionFourReferenceAllowlist'];
const PLANTED = FIELD_NAMES.map(name => `The supplied ${name} list was empty.`).concat([
  'Nothing in evidenceContext.principalCatalysts explained the move.',
  'The marketBrief.sectionSlot value was missing.'
]);
const ENV_NAMES = ['MODEL_CHOICE_ENABLED', 'CLAUDE_MODEL', 'USER_MODEL_CHOICE_ENABLED',
  'HAIKU55_WRITER_DEPTH_ENABLED', 'SECTION_FOUR_TABLE_ENABLED'];

// sha256 of JSON.stringify(writer request) at d00c78e (the same as 5e83159 for these): Haiku 5.5
// with the switch off, and the default model (Haiku 4.5).
const BASELINE_D00C78E = Object.freeze({
  PRE: {off55: '3328e0c44f82a9ea182c751421643a07ae1abd8dbf54e242f4c2864310a124b5',
    default: '48bc9ebfd14006bf5e59fecfbd08d18936a64e6f266bca4a1e76332df04e9adc'},
  REGULAR: {off55: '3ac2b4c8736ab8a0ee79f057912b2993fc03e86a1e67f928eacb6fa7d929235a',
    default: 'b6d7cd2a8bcaf9ac5a8932bb411621fb84cbd0ee3cc573718a91b7ad36f8037d'},
  POST: {off55: 'bb15bbf8cdd1e47fd6dc4be66f051bcc665b939d7eb78b2fed0cf04674ead7f6',
    default: 'd364ae424643462c683d7488f4251ce9dfea9672f19f5e330832c991fb175957'},
  CLOSED: {off55: 'b6d4bb91118d8591f9eb8fa292d69bfdde69df343f501d506b81ff1d94965e14',
    default: '6703e94fb6ac42b4321a9701918e69ce6d6f1b19db9049bd529211d5e8e2a9c9'},
  WEEKEND: {off55: '629607e7bd111c669de7bb487ab9af73bdcbe257d8e7db288814375da0b85eeb',
    default: '95bb910a0a9c4ccef0aa600bd30851b2db717339590e8824b5e7cba041a51558'},
  HOLIDAY: {off55: '13df00fc7f48df4145a035550c3a10a8f718c62929d4b0adcc19a524b24d9de0',
    default: '7552a06d9c68874a2b896c9fb93fe2eb21886f7fe405a3e78b14ff18a9e7d5a4'}
});

async function withEnv(values, callback) {
  const saved = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return await callback();
  } finally {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

function count(text, part) {
  return text.split(part).length - 1;
}

function fingerprint(request) {
  return crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

function reply(output) {
  return {
    ok: true, status: 200, headers: {get: () => null},
    async json() { return {content: [{type: 'text', text: JSON.stringify(providerTransport(output))}]}; }
  };
}

// One invocation with every writer reply the same; returns the result, each call's system text
// and the diagnostics.
async function invokeSame(env, input, output) {
  const systems = [];
  const diagnostics = [];
  const result = await withEnv(env, () => invokeClaudeAnalysis({
    input, apiKey: 'test-key',
    fetchImpl: async (url, options) => { systems.push(JSON.parse(options.body).system); return reply(output); },
    onDiagnostics: value => diagnostics.push(value)
  }));
  return {result, systems, diagnostics};
}

function regularCase() {
  return marketStateCase(...MARKET_STATE_CASES[1]);
}

function classifierInput() {
  const session = createCompletedRegularSession({
    market: 'US', sessionDate: '2026-09-11', open: 100, high: 105, low: 98,
    close: 104, previousClose: 100, volume: 1000000,
    asOf: '2026-09-11T16:00:00-04:00', sourceId: 'us.yahoo-finance', validationState: 'VALIDATED'
  });
  const snapshot = createFiveSessionSnapshot({
    market: 'US', symbol: '^GSPC', instrumentName: '^GSPC benchmark', instrumentType: 'INDEX',
    currency: 'USD', marketState: 'CLOSED', completedSessions: [session], currentOverlay: null
  });
  return {
    marketContext: {
      market: 'US', exchangeTimezone: 'America/New_York', marketState: 'CLOSED',
      primaryCompletedSessionDate: '2026-09-11'
    },
    benchmarkTelemetry: [{reference: 't1', snapshot}],
    evidence: [1, 2].map(index => ({
      reference: `e${index}`, horizon: 'COMPLETED_SESSION', requiresBroadMarketSubjects: false,
      item: createEvidenceItem({
        sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news',
        title: `Canonical evidence ${index}`, summary: `Bounded evidence summary ${index}.`,
        canonicalUrl: `https://www.cnbc.com/2026/09/11/evidence-${index}.html`,
        publishedAt: '2026-09-11T19:30:00Z', symbols: []
      })
    }))
  };
}

const MATERIALITY_BOUNDS = Object.freeze({
  maxCandidates: 30, maxTitleBytes: 200, maxSummaryBytes: 1000, maxExtractBytes: 1000,
  maxCollectionBytes: 50000
});

function materialityCollection() {
  const candidates = ['c1', 'c2'].map(reference => createNewsEvidenceCandidate({
    reference,
    horizon: {
      classification: 'SUBSEQUENT_DEVELOPMENT',
      startsAtExclusive: '2026-09-07T20:00:00Z',
      endsAtInclusive: '2026-09-08T20:00:00Z'
    },
    sourceId: 'us.cnbc', market: 'US', evidenceCategory: 'news',
    title: `Candidate ${reference}`, summary: 'Bounded factual candidate summary.', extract: null,
    canonicalUrl: `https://www.cnbc.com/${reference}.html`, publishedAt: '2026-09-08T13:00:00Z',
    symbols: []
  }, {bounds: MATERIALITY_BOUNDS}));
  return createNewsEvidenceCandidateCollection({market: 'US', candidates}, {bounds: MATERIALITY_BOUNDS});
}

// ---------------------------------------------------------------- wording

for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
  test(`Step 9AF: ${marketState} -- Haiku 5.5 carries the new wording once, inside the block; Haiku 4.5 and switch off are the d00c78e requests`, async () => {
    const {input} = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    const on = await withEnv({CLAUDE_MODEL: 'haiku-5.5'}, () => buildClaudeAnalysisRequest(input));
    const off = await withEnv({CLAUDE_MODEL: 'haiku-5.5', HAIKU55_WRITER_DEPTH_ENABLED: 'off'},
      () => buildClaudeAnalysisRequest(input));
    const others = [];
    for (const env of [{}, {CLAUDE_MODEL: 'haiku-4.5'},
      {CLAUDE_MODEL: 'haiku-4.5', HAIKU55_WRITER_DEPTH_ENABLED: 'on'},
      {CLAUDE_MODEL: 'haiku-4.5', HAIKU55_WRITER_DEPTH_ENABLED: 'off'},
      {MODEL_CHOICE_ENABLED: 'off', CLAUDE_MODEL: 'haiku-5.5'}]) {
      others.push(await withEnv(env, () => buildClaudeAnalysisRequest(input)));
    }

    for (const part of ALL_PARTS) assert.equal(count(on.system, part), 1, part);
    const blockStart = on.system.indexOf(' HAIKU 5.5 WRITING DEPTH (every section).');
    const next = on.system.indexOf(' Request-specific Section 3 telemetry allowlist:');
    for (const part of ALL_PARTS) {
      const at = on.system.indexOf(part);
      assert.ok(at > blockStart && at < next, `${part} is inside the block`);
    }
    for (const request of [off, ...others]) {
      for (const part of ALL_PARTS) assert.equal(count(request.system, part), 0, part);
    }
    assert.equal(fingerprint(off), BASELINE_D00C78E[marketState].off55, 'switch off = d00c78e Haiku 5.5');
    for (const request of others) {
      assert.equal(fingerprint(request), BASELINE_D00C78E[marketState].default, 'Haiku 4.5 = d00c78e');
    }
  });
}

test('Step 9AF: without the table prompt the thin-evidence wording stays and the Section 4 override is not added', async () => {
  const {input} = regularCase();
  const request = await withEnv({CLAUDE_MODEL: 'haiku-5.5', SECTION_FOUR_TABLE_ENABLED: 'off'},
    () => buildClaudeAnalysisRequest(input));
  for (const part of BLOCK_PARTS) assert.equal(count(request.system, part), 1, part);
  for (const part of SECTION_FOUR_PARTS) assert.equal(count(request.system, part), 0, part);
});

test('Step 9AF: no other call carries the new wording on Haiku 5.5', async () => {
  const requests = await withEnv({CLAUDE_MODEL: 'haiku-5.5'}, () => ({
    classifier: buildClaudeEvidenceRoleClassificationRequest(classifierInput()),
    materiality: buildClaudeNewsMaterialityRequest(materialityCollection(), MATERIALITY_BOUNDS),
    subjectRepair: buildClaudeEvidenceSubjectRepairRequest({evidence: [{
      reference: 'e28', title: 'Friday stock stories',
      summary: 'Microsoft and Apple advanced while Financials led.'
    }]}),
    recapSearch: buildClaudeBoundedNewsDiscoveryRequest({targetSessionDate: '2026-09-09'}),
    cnbcSearch: buildClaudeBoundedCnbcMarketNewsDiscoveryRequests({targetSessionDate: '2026-09-09'})
  }));
  for (const [name, value] of Object.entries(requests)) {
    const text = JSON.stringify(value);
    for (const part of ALL_PARTS.concat([HINT])) assert.equal(text.includes(part.trim()), false, `${name}: ${part}`);
  }
});

// ---------------------------------------------------------------- retry hint

function leftEmptyOutput(output, indexes) {
  const empty = structuredClone(output);
  empty.status = 'DEGRADED';
  for (const index of indexes) {
    empty.sections[index] = {...empty.sections[index], content: null, evidenceRefs: [], telemetryRefs: [],
      uncertainties: ['The supplied news does not support this section.']};
  }
  empty.evidenceGaps = ['Some sections had no supporting news.'];
  return empty;
}

test('Step 9AF: a Haiku 5.5 retry of a section the writer left empty carries the pointer once; Haiku 4.5 never does', async () => {
  const {input, output} = regularCase();
  const empty = leftEmptyOutput(output, [4, 5, 6]);
  const newer = await invokeSame({CLAUDE_MODEL: 'haiku-5.5'}, input, empty);
  const older = await invokeSame({}, input, empty);
  const offSwitch = await invokeSame({CLAUDE_MODEL: 'haiku-5.5', HAIKU55_WRITER_DEPTH_ENABLED: 'off'}, input, empty);
  assert.ok(newer.systems.length >= 2, 'a section-retry round ran');
  assert.equal(count(newer.systems[0], HINT), 0, 'the first call has no pointer');
  for (const system of newer.systems.slice(1)) {
    assert.equal(count(system, HINT), 1);
    assert.ok(system.includes(`You left ${REPORT_SECTION_NAMES[4]}, ${REPORT_SECTION_NAMES[5]}, ${REPORT_SECTION_NAMES[6]} empty yourself`));
    assert.ok(system.includes('cite these index references (t1)'), 'Section 5 is pointed to the index refs');
    assert.ok(system.includes('cited articles themselves state (e1)'), 'Section 6 is pointed to the focus articles');
    assert.ok(system.includes(`leave ${REPORT_SECTION_NAMES[6]} empty when nothing forward-looking is supported.`));
  }
  assert.equal(older.systems.length, newer.systems.length);
  for (const system of older.systems.concat(offSwitch.systems)) assert.equal(count(system, HINT), 0);
  // A thin package with nothing forward-looking keeps Section 7 empty.
  assert.equal(newer.result.ok, true);
  assert.equal(newer.result.output.sections[6].content, null);
});

test('Step 9AF: the retry text without the pointer is exactly the d00c78e text', () => {
  const {input} = regularCase();
  const targets = [{index: 4, reasons: ['WRITER_LEFT_EMPTY']}, {index: 2, reasons: ['INTERNAL_IDENTIFIER_LEAK']}];
  for (const round of [1, 2]) {
    const base = sectionRetryInstruction({round, rounds: 2, targets, input, maxSentences: 4});
    assert.equal(sectionRetryInstruction({round, rounds: 2, targets, input, maxSentences: 4, leftEmptyHint: false}), base);
    assert.equal(count(base, HINT), 0);
    const hinted = sectionRetryInstruction({round, rounds: 2, targets, input, maxSentences: 4, leftEmptyHint: true});
    assert.ok(hinted.startsWith(`${base} `), 'the pointer is only added at the end');
    assert.equal(count(hinted, HINT), 1);
  }
  // A section emptied by a check (not by the writer) gets no pointer.
  const checked = [{index: 2, reasons: ['INTERNAL_IDENTIFIER_LEAK']}];
  assert.equal(sectionRetryInstruction({round: 1, rounds: 2, targets: checked, input, maxSentences: 4, leftEmptyHint: true}),
    sectionRetryInstruction({round: 1, rounds: 2, targets: checked, input, maxSentences: 4}));
});

// ---------------------------------------------------------------- note rewrite

function withGap(output, gap) {
  const copy = structuredClone(output);
  copy.status = 'DEGRADED';
  copy.evidenceGaps = [gap];
  return copy;
}

function withNotes(output, index, notes) {
  const copy = structuredClone(output);
  copy.sections[index] = {...copy.sections[index], uncertainties: notes};
  return copy;
}

test('Step 9AF: every planted field name in an evidence-gap line is rewritten on Haiku 5.5, and only that line changes', async () => {
  const {input, output} = regularCase();
  const clean = await invokeSame({CLAUDE_MODEL: 'haiku-5.5'}, input, withGap(output, GAP_LINE));
  assert.equal(clean.result.ok, true);
  for (const planted of PLANTED) {
    const run = await invokeSame({CLAUDE_MODEL: 'haiku-5.5'}, input, withGap(output, planted));
    assert.equal(run.result.ok, true, planted);
    assert.equal(run.systems.length, 1, 'no retry was needed');
    assert.deepEqual(run.result.output.evidenceGaps, [GAP_LINE]);
    assert.equal(JSON.stringify(run.result.output), JSON.stringify(clean.result.output),
      'nothing but the note line changed; no section text is shortened');
    const event = run.diagnostics.find(value => value.stage === 'writerNoteLeakRewrite');
    assert.deepEqual(event, {stage: 'writerNoteLeakRewrite', evidenceGapLines: 1, sectionNoteLines: 0,
      duplicateLinesRemoved: 0});
  }
});

test('Step 9AF: every planted field name in a section note is rewritten on Haiku 5.5, duplicates folded', async () => {
  const {input, output} = regularCase();
  const clean = await invokeSame({CLAUDE_MODEL: 'haiku-5.5'}, input, withNotes(output, 4, [NOTE_LINE]));
  for (const planted of PLANTED) {
    const run = await invokeSame({CLAUDE_MODEL: 'haiku-5.5'}, input, withNotes(output, 4, [planted]));
    assert.equal(run.result.ok, true, planted);
    assert.deepEqual(run.result.output.sections[4].uncertainties, [NOTE_LINE]);
    assert.equal(JSON.stringify(run.result.output), JSON.stringify(clean.result.output), planted);
  }
  const two = await invokeSame({CLAUDE_MODEL: 'haiku-5.5'}, input,
    withNotes(output, 4, [PLANTED[6], 'A plain note that stays.', PLANTED[8]]));
  assert.deepEqual(two.result.output.sections[4].uncertainties, [NOTE_LINE, 'A plain note that stays.']);
  const event = two.diagnostics.find(value => value.stage === 'writerNoteLeakRewrite');
  assert.deepEqual(event, {stage: 'writerNoteLeakRewrite', evidenceGapLines: 0, sectionNoteLines: 2,
    duplicateLinesRemoved: 1});
});

test('Step 9AF: Haiku 4.5 and the switch off never rewrite a note line', async () => {
  const {input, output} = regularCase();
  for (const env of [{}, {CLAUDE_MODEL: 'haiku-4.5', HAIKU55_WRITER_DEPTH_ENABLED: 'on'},
    {CLAUDE_MODEL: 'haiku-5.5', HAIKU55_WRITER_DEPTH_ENABLED: 'off'}]) {
    const gap = await invokeSame(env, input, withGap(output, PLANTED[8]));
    assert.equal(gap.result.ok, false, 'the leaking gap still fails the checks');
    assert.equal(gap.diagnostics.some(value => value.stage === 'writerNoteLeakRewrite'), false);
    const note = await invokeSame(env, input, withNotes(output, 4, [PLANTED[6]]));
    assert.equal(note.result.ok === true ? note.result.output.sections[4].content : null, null,
      'the section with the leaking note is still emptied');
    assert.equal(JSON.stringify(note).includes(NOTE_LINE), false);
  }
});

test('Step 9AF: a field name in section text is never rewritten on Haiku 5.5', async () => {
  const {input, output} = regularCase();
  for (const planted of [PLANTED[6], PLANTED[17]]) {
    const leaking = structuredClone(output);
    leaking.sections[4] = {...leaking.sections[4], content: `Supported analysis. ${planted}`};
    const run = await invokeSame({CLAUDE_MODEL: 'haiku-5.5'}, input, leaking);
    const text = JSON.stringify(run.result);
    assert.equal(text.includes(planted), false, 'the leaking sentence never reaches the report');
    assert.equal(text.includes(NOTE_LINE) || text.includes(GAP_LINE), false, 'no fixed note line was written');
    assert.equal(run.diagnostics.some(value => value.stage === 'writerNoteLeakRewrite'), false);
    if (run.result.ok) assert.equal(run.result.output.sections[4].content, null, 'the section is emptied as before');
  }
});

// ---------------------------------------------------------------- logs

test('Step 9AF: no raw switch or model value reaches any log line', async () => {
  const {input, output} = regularCase();
  const junk = {CLAUDE_MODEL: 'zz-raw-model-9af', HAIKU55_WRITER_DEPTH_ENABLED: 'zz-raw-switch-9af'};
  const lines = [];
  const originals = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[level] = console[level];
    console[level] = (...args) => lines.push(args.map(value =>
      typeof value === 'string' ? value : JSON.stringify(value)).join(' '));
  }
  const diagnostics = [];
  try {
    for (const env of [junk, {CLAUDE_MODEL: 'haiku-5.5', HAIKU55_WRITER_DEPTH_ENABLED: 'zz-raw-switch-9af'},
      {CLAUDE_MODEL: 'haiku-5.5'}]) {
      for (const raw of [withGap(output, PLANTED[8]), leftEmptyOutput(output, [4])]) {
        diagnostics.push(...(await invokeSame(env, input, raw)).diagnostics);
      }
    }
  } finally {
    for (const level of Object.keys(originals)) console[level] = originals[level];
  }
  const all = lines.concat(diagnostics.map(value => JSON.stringify(value))).join('\n');
  for (const value of Object.values(junk)) assert.equal(all.includes(value), false, value);
  assert.ok(diagnostics.some(value => value.stage === 'writerNoteLeakRewrite'), 'the rewrite ran');
  for (const event of diagnostics.filter(value => value.stage === 'writerNoteLeakRewrite')) {
    assert.deepEqual(Object.keys(event), ['stage', 'evidenceGapLines', 'sectionNoteLines', 'duplicateLinesRemoved']);
  }
});
