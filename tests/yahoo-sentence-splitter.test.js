// Step 9AG: the sentence splitter never ends a sentence at the "!" of "Yahoo!". The 9AF P1 run 1
// (POST, Haiku 5.5) Section 3 named "wet AMD" (an eye disease) in its Kodiak sentence; the
// Section 3 portfolio-name trim read it as the Watchlist stock AMD (that name check is unchanged
// here) and, because the splitter broke at "Yahoo!", removed only half of the sentence and left
// "...$89.92 after Yahoo!" joined to the Kratos sentence. Both models share the splitter. The
// writer requests (Haiku 4.5, and Haiku 5.5 with the switch off) are the d00c78e requests.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {buildClaudeAnalysisRequest} = require('../lib/claude-analysis-invocation');
const {splitReportSentences, sectionThreeScopeViolations} = require('../lib/claude-analysis-contract');
const {dropOffendingSentences} = require('../lib/section-rules');
const {MARKET_STATE_CASES, marketStateCase} = require('./fixtures/market-state-cases');

// The writer's Section 3 text in the 9AF P1 run 1 raw reply, exactly.
const RUN_ONE_SECTION_THREE = 'Three companies in the broad-market news since the close are worth noting. '
  + 'Kodiak Sciences rose about 178 percent to $89.92 after Yahoo! Finance reported that its wet AMD '
  + 'treatment candidate met its main trial goal, and Jefferies cut its price target to $112 from $156 '
  + 'while keeping a buy rating. Kratos Defense & Security and GE Aerospace reached a milestone on a '
  + 'small military jet engine, which Yahoo! Finance reported as a successful first ignition on Sept 21. '
  + 'SoFi Technologies and Mastercard began running SoFi\'s card settlement on a stablecoin system, which '
  + 'Yahoo! Finance described as a way to add fee income for both firms. These stories show company-level '
  + 'news only and do not show a sector trend. Section 3 uses no last-session telemetry beyond the index '
  + 'benchmarks, because the supplied telemetry does not show a broader leadership pattern.';
const KODIAK_SENTENCE = 'Kodiak Sciences rose about 178 percent to $89.92 after Yahoo! Finance reported that '
  + 'its wet AMD treatment candidate met its main trial goal, and Jefferies cut its price target to $112 '
  + 'from $156 while keeping a buy rating.';

const ENV_NAMES = ['MODEL_CHOICE_ENABLED', 'CLAUDE_MODEL', 'USER_MODEL_CHOICE_ENABLED',
  'HAIKU55_WRITER_DEPTH_ENABLED', 'SECTION_FOUR_TABLE_ENABLED'];

// sha256 of JSON.stringify(writer request) at d00c78e, as in tests/haiku55-thin-evidence.test.js:
// Haiku 5.5 with the switch off, and the default model (Haiku 4.5).
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

function fingerprint(request) {
  return crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

// The run 1 shape that matters to the Section 3 portfolio-name check: three cited focus entries
// (none names AMD) and AMD on the Watchlist.
const RUN_ONE_INPUT = Object.freeze({
  marketPackages: [{
    evidenceContext: {broadMarketFocus: [
      {evidenceRef: 'e31', subjects: [{kind: 'COMPANY', name: 'SoFi Technologies'},
        {kind: 'COMPANY', name: 'Mastercard'}]},
      {evidenceRef: 'e32', subjects: [{kind: 'COMPANY', name: 'Kratos Defense & Security'},
        {kind: 'COMPANY', name: 'GE Aerospace'}]},
      {evidenceRef: 'e33', subjects: [{kind: 'COMPANY', name: 'Kodiak Sciences'}]}
    ]},
    telemetry: {
      benchmarkSnapshots: [{reference: 't1'}],
      stockSnapshots: [{reference: 't10',
        snapshot: {market: 'US', symbol: 'AMD', instrumentName: 'Advanced Micro Devices'}}]
    }
  }],
  portfolioContext: {myStocks: [], watchlist: [{market: 'US', symbol: 'AMD', telemetryRefs: ['t10']}]}
});

// The Section 3 portfolio-name trim's sentence step, as lib/claude-analysis-invocation.js runs it.
function portfolioNameTrim(section) {
  return dropOffendingSentences(section, sentence => sectionThreeScopeViolations(
    {...section, content: sentence}, RUN_ONE_INPUT).unfocusedPortfolioMentionCount > 0, splitReportSentences);
}

test('Step 9AG: "Yahoo!" is never a sentence end; other exclamation marks still are', () => {
  assert.deepEqual(splitReportSentences(
    'Yahoo! Finance reported a deal. Did yields fall? Yes! The Nasdaq ended at 18,950.25'
  ), ['Yahoo! Finance reported a deal.', 'Did yields fall?', 'Yes!', 'The Nasdaq ended at 18,950.25']);
  assert.deepEqual(splitReportSentences('Shares rose, said YAHOO! Finance. Then they eased.'),
    ['Shares rose, said YAHOO! Finance.', 'Then they eased.']);
  // Only the whole word Yahoo: a longer word ending in "yahoo" is an ordinary sentence end.
  assert.deepEqual(splitReportSentences('It was a Myyahoo! The end.'), ['It was a Myyahoo!', 'The end.']);
});

test('Step 9AG: run 1 Section 3 -- the Kodiak sentence is one sentence and is removed whole', () => {
  const sentences = splitReportSentences(RUN_ONE_SECTION_THREE);
  assert.equal(sentences.length, 6);
  assert.equal(sentences[1], KODIAK_SENTENCE);
  assert.equal(sentences.some(sentence => /Yahoo!$/.test(sentence)), false, 'no sentence ends at Yahoo!');

  const section = {content: RUN_ONE_SECTION_THREE, evidenceRefs: ['e33', 'e32', 'e31'], telemetryRefs: []};
  assert.equal(sectionThreeScopeViolations(section, RUN_ONE_INPUT).unfocusedPortfolioMentionCount, 1);
  const {section: trimmed, removedSentenceCount, sentenceCount, keptSentenceCount} = portfolioNameTrim(section);
  assert.deepEqual({removedSentenceCount, sentenceCount, keptSentenceCount},
    {removedSentenceCount: 1, sentenceCount: 6, keptSentenceCount: 5});
  assert.equal(trimmed.content, RUN_ONE_SECTION_THREE.replace(`${KODIAK_SENTENCE} `, ''));
  assert.equal(trimmed.content.includes('after Yahoo!'), false, 'no "after Yahoo!" fragment is left');
  assert.equal(trimmed.content.includes('Kodiak'), false, 'the Kodiak sentence is gone whole');
  assert.equal(trimmed.content.includes('Finance reported that its wet AMD'), false);
  assert.ok(trimmed.content.includes('Kratos Defense & Security and GE Aerospace reached a milestone'));
  assert.equal(sectionThreeScopeViolations(trimmed, RUN_ONE_INPUT).unfocusedPortfolioMentionCount, 0);
});

for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
  test(`Step 9AG: ${marketState} -- Haiku 4.5 and Haiku 5.5 switch off are still the d00c78e requests`, async () => {
    const {input} = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    const off = await withEnv({CLAUDE_MODEL: 'haiku-5.5', HAIKU55_WRITER_DEPTH_ENABLED: 'off'},
      () => buildClaudeAnalysisRequest(input));
    assert.equal(fingerprint(off), BASELINE_D00C78E[marketState].off55, 'switch off = d00c78e Haiku 5.5');
    for (const env of [{}, {CLAUDE_MODEL: 'haiku-4.5'}]) {
      const request = await withEnv(env, () => buildClaudeAnalysisRequest(input));
      assert.equal(fingerprint(request), BASELINE_D00C78E[marketState].default, 'Haiku 4.5 = d00c78e');
    }
  });
}
