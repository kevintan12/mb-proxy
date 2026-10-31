// Step 9AI: after a cleanup rule removes a sentence, a following sentence that points back (it,
// its, they, their, the stock, the company, the shares) and names no known subject is removed too,
// and so is the next one while the same holds. Haiku 5.5 with the writer-depth switch on only;
// removed, never rewritten; a follow-on cut that would leave no sentence is not made. One Haiku
// 5.5-only wording line asks the writer to name the subject in every sentence. Haiku 4.5, and Haiku
// 5.5 with the switch off, send the 3b3ece0 requests and get the 3b3ece0 cleanup. The Section 3
// "wet AMD" name check is unchanged.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {buildClaudeAnalysisRequest, invokeClaudeAnalysis} = require('../lib/claude-analysis-invocation');
const {
  splitReportSentences,
  sectionThreeScopeViolations,
  hasActiveDirectMarketCausalClaim
} = require('../lib/claude-analysis-contract');
const {dropOffendingSentences, causalClaimTrim, headlessFollowOnCheck} = require('../lib/section-rules');
const {MARKET_STATE_CASES, marketStateCase, providerTransport} = require('./fixtures/market-state-cases');

const ENV_NAMES = ['MODEL_CHOICE_ENABLED', 'CLAUDE_MODEL', 'USER_MODEL_CHOICE_ENABLED',
  'HAIKU55_WRITER_DEPTH_ENABLED', 'SECTION_FOUR_TABLE_ENABLED'];

// sha256 of JSON.stringify(writer request) at d00c78e, unchanged at 3b3ece0 (as in
// tests/haiku55-thin-day-wording.test.js): Haiku 5.5 with the switch off, and Haiku 4.5.
const BASELINE_3B3ECE0 = Object.freeze({
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

const NAME_LINE = 'NAME THE SUBJECT: name the company or index in every sentence that states a fact about it';
const FINAL_SENTENCE = 'and each Section 6 opportunity still needs its own focus reference.';

// The 9AH P1 package shape that matters here: the three cited focus entries and AMD on the
// Watchlist (whose ticker the "wet AMD" wording matches).
const NINE_AHP_INPUT = Object.freeze({
  marketPackages: [{
    evidenceContext: {broadMarketFocus: [
      {evidenceRef: 'e31', subjects: [{kind: 'COMPANY', name: 'SoFi Technologies'},
        {kind: 'COMPANY', name: 'Mastercard'}]},
      {evidenceRef: 'e32', subjects: [{kind: 'COMPANY', name: 'Kratos Defense & Security'},
        {kind: 'COMPANY', name: 'GE Aerospace'}]},
      {evidenceRef: 'e33', subjects: [{kind: 'COMPANY', name: 'Kodiak Sciences'}]}
    ]},
    telemetry: {
      benchmarkSnapshots: [{reference: 't1', snapshot: {symbol: '^GSPC', instrumentName: 'S&P 500'}}],
      stockSnapshots: [{reference: 't10',
        snapshot: {market: 'US', symbol: 'AMD', instrumentName: 'Advanced Micro Devices'}}]
    }
  }],
  portfolioContext: {myStocks: [], watchlist: [{market: 'US', symbol: 'AMD', telemetryRefs: ['t10']}]}
});

// The writer's Section 3 text in the 9AH P1 run 2 raw reply, exactly.
const RUN_TWO_SECTION_THREE = 'Kodiak Sciences, the wet AMD drug developer, is the largest mover in the news. '
  + 'Its shares nearly tripled, closing up 177.96% at $89.92, after its treatment Zenkuda met the main goal '
  + 'of its phase 3 trial. Yahoo! Finance reported that Jefferies cut its price target from $156 to $112 '
  + 'while keeping a buy rating. SoFi Technologies and Mastercard are also in focus after SoFi began '
  + 'running its card program on blockchain-based settlement, which Yahoo! Finance said could add payment '
  + 'volume for Mastercard. Kratos Defense and GE Aerospace drew attention after their GEK800 engine first '
  + 'ignited successfully, which Yahoo! Finance said keeps development on schedule. These stories are '
  + 'single-company news and do not show a broad sector trend.';
const RUN_TWO_KEPT = 'SoFi Technologies and Mastercard are also in focus after SoFi began running its card '
  + 'program on blockchain-based settlement, which Yahoo! Finance said could add payment volume for '
  + 'Mastercard. Kratos Defense and GE Aerospace drew attention after their GEK800 engine first ignited '
  + 'successfully, which Yahoo! Finance said keeps development on schedule. These stories are '
  + 'single-company news and do not show a broad sector trend.';

// The writer's Section 2 text in the 9AH P1 run 1 raw reply, exactly.
const RUN_ONE_SECTION_TWO = 'At 7:00 pm ET on Mon 28 Sep, Yahoo! Finance reported that SoFi Technologies '
  + 'and Mastercard began settling card payments on a blockchain, using a stablecoin issued by a nationally '
  + 'chartered bank. The article says this could help Mastercard add transaction volume and fees without '
  + 'taking on balance-sheet risk, while SoFi\'s rapid lending growth may need more capital. At 7:14 pm ET '
  + 'on Mon 28 Sep, Yahoo! Finance reported that Kodiak Sciences\' wet AMD candidate met its main trial '
  + 'goal, sending the shares up about 178% to $89.92. Jefferies cut its price target for the stock to $112 '
  + 'from $156 while keeping its buy rating. At 7:17 pm ET on Mon 28 Sep, Yahoo! Finance reported that '
  + 'Kratos and GE Aerospace ignited their GEK800 engine for the first time, a milestone the article says '
  + 'keeps the programme on schedule. At the close on Mon 28 Sep, the three main indexes fell as a group, '
  + 'with the Dow down 0.67%, the NASDAQ down 0.92% and the S&P 500 down 0.77%. The supplied articles do '
  + 'not link these company events to that broad decline.';
const RUN_ONE_CATALYST_SENTENCE = 'At 7:14 pm ET on Mon 28 Sep, Yahoo! Finance reported that Kodiak Sciences\' '
  + 'wet AMD candidate met its main trial goal, sending the shares up about 178% to $89.92.';
const RUN_ONE_JEFFERIES = 'Jefferies cut its price target for the stock to $112 from $156 while keeping its '
  + 'buy rating.';

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

function fingerprint(request) {
  return crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

function count(text, part) {
  return text.split(part).length - 1;
}

const splitOnPeriods = content => content.split(/(?<=\.)\s+/).filter(Boolean);

function section(content) {
  return {name: 'Test', content, evidenceRefs: ['e1'], telemetryRefs: [], uncertainties: []};
}

// The Section 3 portfolio-name trim's sentence step, as lib/claude-analysis-invocation.js runs it.
function portfolioNameTrim(content, followOn) {
  const value = {content, evidenceRefs: ['e33', 'e31', 'e32'], telemetryRefs: []};
  return dropOffendingSentences(value, sentence => sectionThreeScopeViolations(
    {...value, content: sentence}, NINE_AHP_INPUT).unfocusedPortfolioMentionCount > 0, splitReportSentences,
  followOn);
}

// The Section 2 catalyst trim, as trimOrLocalizeDriverCausality runs it.
function catalystTrim(content, followOn) {
  return causalClaimTrim(section(content), {
    offendingSentence: sentence => hasActiveDirectMarketCausalClaim(sentence),
    splitSentences: splitReportSentences, keepIf: () => true,
    caveat: 'The news does not show for certain what moved the market.', followOn
  });
}

// ---------------------------------------------------------------- the two 9AH P1 runs

test('Step 9AI: 9AH P1 run 2 Section 3 -- both headless follow-ons go, the rest is kept', () => {
  const result = portfolioNameTrim(RUN_TWO_SECTION_THREE, headlessFollowOnCheck(NINE_AHP_INPUT));
  assert.equal(result.section.content, RUN_TWO_KEPT);
  assert.equal(result.removedSentenceCount, 1, 'the rule itself still removes one sentence');
  assert.equal(result.followOnRemovedCount, 2, 'a chain of two follow-ons');
  assert.equal(result.sentenceCount, 6);
  assert.equal(result.keptSentenceCount, 3);
  assert.equal(result.section.content.includes('Its shares'), false);
  assert.equal(result.section.content.includes('Jefferies'), false);
  // The portfolio-name check is unchanged: "wet AMD" still reads as the Watchlist stock AMD.
  assert.equal(sectionThreeScopeViolations({content: 'Kodiak Sciences, the wet AMD drug developer.',
    evidenceRefs: ['e33'], telemetryRefs: []}, NINE_AHP_INPUT).unfocusedPortfolioMentionCount, 1);
});

test('Step 9AI: 9AH P1 run 2 Section 3 without the check is the saved 9AH P1 text', () => {
  const result = portfolioNameTrim(RUN_TWO_SECTION_THREE, null);
  assert.equal(result.section.content, RUN_TWO_SECTION_THREE.slice(
    RUN_TWO_SECTION_THREE.indexOf('Its shares nearly tripled')));
  assert.equal(result.removedSentenceCount, 1);
  assert.equal('followOnRemovedCount' in result, false);
});

test('Step 9AI: 9AH P1 run 1 Section 2 -- the headless Jefferies line goes, the Kratos line stays', () => {
  const on = catalystTrim(RUN_ONE_SECTION_TWO, headlessFollowOnCheck(NINE_AHP_INPUT));
  assert.equal(on.trimmed, true);
  assert.equal(on.section.content, RUN_ONE_SECTION_TWO
    .replace(`${RUN_ONE_CATALYST_SENTENCE} `, '').replace(`${RUN_ONE_JEFFERIES} `, ''));
  assert.equal(on.removedSentenceCount, 1);
  assert.equal(on.followOnRemovedCount, 1);
  assert.ok(on.section.content.includes('Kratos and GE Aerospace ignited their GEK800 engine'),
    'a follow-on that points back but names a subject stops the chain');

  const off = catalystTrim(RUN_ONE_SECTION_TWO, null);
  assert.equal(off.section.content, RUN_ONE_SECTION_TWO.replace(`${RUN_ONE_CATALYST_SENTENCE} `, ''),
    'without the check: the saved 9AH P1 text, Jefferies line included');
  assert.equal('followOnRemovedCount' in off, false);
});

// ---------------------------------------------------------------- the rule itself

test('Step 9AI: a follow-on that names a subject is kept', () => {
  const check = headlessFollowOnCheck(NINE_AHP_INPUT);
  for (const kept of ['Kodiak Sciences said its trial worked.', 'Kodiak said its trial worked.',
    'Mastercard said its fees could rise.', 'The S&P 500 fell, and it closed lower.',
    'AMD said its chips sold well.']) {
    const result = dropOffendingSentences(section(`Bad one. ${kept} Good two.`),
      sentence => sentence.startsWith('Bad'), splitOnPeriods, check);
    assert.equal(result.section.content, `${kept} Good two.`, kept);
    assert.equal('followOnRemovedCount' in result, false, kept);
  }
});

test('Step 9AI: each pointing-back form is headless when no subject is named', () => {
  const check = headlessFollowOnCheck(NINE_AHP_INPUT);
  for (const sentence of ['It rose 5%.', 'Its shares rose.', 'They gained.', 'Their sales rose.',
    'Analysts like the stock.', 'Analysts said the company grew.', 'Buyers lifted the shares.']) {
    assert.equal(check(sentence), true, sentence);
  }
  for (const sentence of ['These stories are single-company news.', 'Stocks fell broadly.',
    'Bond yields rose.', 'The supplied articles do not link these events.']) {
    assert.equal(check(sentence), false, sentence);
  }
});

test('Step 9AI: a chain of two follow-ons goes; the chain stops at the first sentence that is not headless', () => {
  const result = dropOffendingSentences(section('Good one. Bad one. It rose. Its shares rose. Bond yields rose. '
    + 'It fell.'), sentence => sentence.startsWith('Bad'), splitOnPeriods, headlessFollowOnCheck(NINE_AHP_INPUT));
  assert.equal(result.section.content, 'Good one. Bond yields rose. It fell.',
    'a pointing-back sentence not straight after a removed one is kept');
  assert.equal(result.removedSentenceCount, 1);
  assert.equal(result.followOnRemovedCount, 2);
  assert.equal(result.keptSentenceCount, 3);
});

test('Step 9AI: a follow-on is kept when removing it would leave the section with no sentence', () => {
  const result = dropOffendingSentences(section('Bad one. It rose. Its shares rose.'),
    sentence => sentence.startsWith('Bad'), splitOnPeriods, headlessFollowOnCheck(NINE_AHP_INPUT));
  assert.equal(result.section.content, 'It rose. Its shares rose.');
  assert.equal(result.keptSentenceCount, 2);
  assert.equal('followOnRemovedCount' in result, false);
  // When the rule itself removes everything, the check changes nothing either.
  const all = dropOffendingSentences(section('Bad one. Bad two.'), () => true, splitOnPeriods,
    headlessFollowOnCheck(NINE_AHP_INPUT));
  assert.equal(all.section.content, '');
  assert.equal(all.keptSentenceCount, 0);
});

test('Step 9AI: with nothing removed the section is returned unchanged, check or not', () => {
  const original = section('Good one.  It rose.');
  const result = dropOffendingSentences(original, () => false, splitOnPeriods, headlessFollowOnCheck(NINE_AHP_INPUT));
  assert.equal(result.section, original);
  assert.equal('followOnRemovedCount' in result, false);
});

// ---------------------------------------------------------------- the whole cleanup

function reply(output) {
  return {
    ok: true, status: 200, headers: {get: () => null},
    async json() { return {content: [{type: 'text', text: JSON.stringify(providerTransport(output))}]}; }
  };
}

async function invoke(env, input, output) {
  const diagnostics = [];
  const result = await withEnv(env, () => invokeClaudeAnalysis({
    input, apiKey: 'test-key', fetchImpl: async () => reply(output),
    onDiagnostics: value => diagnostics.push(value)
  }));
  return {result, diagnostics};
}

// An active-day fixture with Apple on the Watchlist (not in focus) and a Section 3 whose Apple
// sentence the portfolio-name trim removes, followed by two headless sentences.
function headlessCase(marketState, ...times) {
  const fixture = marketStateCase(marketState, ...times);
  fixture.input = structuredClone(fixture.input);
  fixture.input.portfolioContext.watchlist = [{
    market: 'US', symbol: 'AAPL', telemetryRefs: [], evidenceRefs: [], upcomingEvents: []
  }];
  const original = fixture.output.sections[2].content;
  fixture.output.sections[2].content = `${original} Apple (AAPL) jumped 5 percent. Its shares hit a record `
    + 'high. Analysts said the stock could keep rising. Microsoft also gained.';
  return {...fixture, original};
}

const ACTIVE_CASES = MARKET_STATE_CASES.filter(([, , overlayAsOf]) => overlayAsOf);

for (const [marketState, ...times] of ACTIVE_CASES) {
  test(`Step 9AI: ${marketState} -- Haiku 5.5 removes the headless follow-ons; Haiku 4.5 and switch off keep the 3b3ece0 cleanup`, async () => {
    const fixture = headlessCase(marketState, ...times);
    const trimEvent = extra => ({
      stage: 'claudeAnalysisSectionNormalization', sectionIndex: 2,
      violationCategory: 'UNFOCUSED_PORTFOLIO_MENTION', action: 'TRIMMED',
      suppliedReferenceCount: 0, allowedReferenceCount: 0, offendingReferenceCount: 0,
      removedSentenceCount: 1, ...extra
    });
    const portfolioEvents = diagnostics => diagnostics.filter(value =>
      value.violationCategory === 'UNFOCUSED_PORTFOLIO_MENTION');

    const on = await invoke({CLAUDE_MODEL: 'haiku-5.5'}, fixture.input, fixture.output);
    assert.equal(on.result.type, 'SUCCESS', `${marketState}: ${on.result.message}`);
    assert.equal(on.result.output.sections[2].content, `${fixture.original} Microsoft also gained.`);
    assert.deepEqual(portfolioEvents(on.diagnostics), [trimEvent({followOnRemovedCount: 2})]);

    const older = [];
    for (const env of [{}, {CLAUDE_MODEL: 'haiku-4.5'}, {CLAUDE_MODEL: 'haiku-4.5', HAIKU55_WRITER_DEPTH_ENABLED: 'on'},
      {CLAUDE_MODEL: 'haiku-5.5', HAIKU55_WRITER_DEPTH_ENABLED: 'off'}]) {
      older.push(await invoke(env, fixture.input, fixture.output));
    }
    for (const run of older) {
      assert.equal(run.result.type, 'SUCCESS', `${marketState}: ${run.result.message}`);
      assert.equal(run.result.output.sections[2].content, `${fixture.original} Its shares hit a record high. `
        + 'Analysts said the stock could keep rising. Microsoft also gained.');
      assert.deepEqual(portfolioEvents(run.diagnostics), [trimEvent({})]);
    }
    // Haiku 4.5 and Haiku 5.5 switch off: the same output and the same diagnostics as each other.
    const strip = run => JSON.stringify(run.result.output);
    assert.equal(strip(older[0]), strip(older[1]));
    assert.equal(strip(older[0]), strip(older[2]));
  });
}

// ---------------------------------------------------------------- the wording line

for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
  test(`Step 9AI: ${marketState} -- the name-the-subject line is on Haiku 5.5 (switch on) once, before the final sentence; never on Haiku 4.5 or switch off`, async () => {
    const {input} = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    const on = await withEnv({CLAUDE_MODEL: 'haiku-5.5'}, () => buildClaudeAnalysisRequest(input));
    assert.equal(count(on.system, NAME_LINE), 1);
    const blockStart = on.system.indexOf(' HAIKU 5.5 WRITING DEPTH (every section).');
    const lineAt = on.system.indexOf(NAME_LINE);
    const finalAt = on.system.indexOf(FINAL_SENTENCE);
    assert.ok(blockStart >= 0 && lineAt > blockStart && finalAt > lineAt,
      'inside the block, before its final sentence');
    assert.equal(on.system.indexOf('All other rules still apply:') > lineAt, true,
      'the final "All other rules still apply" line stays last');

    const off = await withEnv({CLAUDE_MODEL: 'haiku-5.5', HAIKU55_WRITER_DEPTH_ENABLED: 'off'},
      () => buildClaudeAnalysisRequest(input));
    assert.equal(count(JSON.stringify(off), NAME_LINE), 0);
    assert.equal(fingerprint(off), BASELINE_3B3ECE0[marketState].off55, 'switch off = 3b3ece0');
    for (const env of [{}, {CLAUDE_MODEL: 'haiku-4.5'}, {CLAUDE_MODEL: 'haiku-4.5', HAIKU55_WRITER_DEPTH_ENABLED: 'on'}]) {
      const request = await withEnv(env, () => buildClaudeAnalysisRequest(input));
      assert.equal(count(JSON.stringify(request), NAME_LINE), 0);
      assert.equal(fingerprint(request), BASELINE_3B3ECE0[marketState].default, 'Haiku 4.5 = 3b3ece0');
    }
  });
}
