// Step 9AH: Haiku 5.5-only wording for Sections 3 and 6 on thin days. The wording sits inside the
// existing 9AE/9AF writer-depth block (same switch, no new setting). Haiku 4.5, and Haiku 5.5 with
// the switch off, send the exact d00c78e (= 3d02d56) requests. Nothing cuts report text.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {buildClaudeAnalysisRequest} = require('../lib/claude-analysis-invocation');
const {MARKET_STATE_CASES, marketStateCase} = require('./fixtures/market-state-cases');

const ENV_NAMES = ['MODEL_CHOICE_ENABLED', 'CLAUDE_MODEL', 'USER_MODEL_CHOICE_ENABLED',
  'HAIKU55_WRITER_DEPTH_ENABLED', 'SECTION_FOUR_TABLE_ENABLED'];

// sha256 of JSON.stringify(writer request) at d00c78e, unchanged at 3d02d56: Haiku 5.5 with the
// switch off, and the default model (Haiku 4.5).
const BASELINE_3D02D56 = Object.freeze({
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

const SECTION_THREE_WORDING = 'Section 3 wording: write only about the companies and sectors';
const THIN_DAY_SIX_WORDING = 'THIN DAY, Section 6: each risk must come from a risk the cited article itself states';
const FINAL_SENTENCE = 'and each Section 6 opportunity still needs its own focus reference.';

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

const fingerprint = request => crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
const text = request => JSON.stringify(request);

for (const [marketState, generatedAt, overlayAsOf, currentPublishedAt] of MARKET_STATE_CASES) {
  test(`Step 9AH: ${marketState} -- Haiku 4.5 and Haiku 5.5 switch off are the 3d02d56 requests, with none of the new wording`, async () => {
    const {input} = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    const off = await withEnv({CLAUDE_MODEL: 'haiku-5.5', HAIKU55_WRITER_DEPTH_ENABLED: 'off'},
      () => buildClaudeAnalysisRequest(input));
    assert.equal(fingerprint(off), BASELINE_3D02D56[marketState].off55);
    for (const env of [{}, {CLAUDE_MODEL: 'haiku-4.5'}]) {
      const request = await withEnv(env, () => buildClaudeAnalysisRequest(input));
      assert.equal(fingerprint(request), BASELINE_3D02D56[marketState].default);
      assert.equal(text(request).includes(SECTION_THREE_WORDING), false);
      assert.equal(text(request).includes(THIN_DAY_SIX_WORDING), false);
    }
    assert.equal(text(off).includes(SECTION_THREE_WORDING), false);
    assert.equal(text(off).includes(THIN_DAY_SIX_WORDING), false);
  });

  test(`Step 9AH: ${marketState} -- Haiku 5.5 with the switch on carries the new wording, once, and the final sentence stays last`, async () => {
    const {input} = marketStateCase(marketState, generatedAt, overlayAsOf, currentPublishedAt);
    const on = await withEnv({CLAUDE_MODEL: 'haiku-5.5'}, () => buildClaudeAnalysisRequest(input));
    const body = text(on);
    for (const phrase of [SECTION_THREE_WORDING, THIN_DAY_SIX_WORDING]) {
      assert.equal(body.split(phrase).length - 1, 1, `${phrase} appears once`);
    }
    for (const phrase of ['never name a section by its number', 'never use the word \\"telemetry\\" in report text',
      'never state a count of companies', 'a fall in an index alone is not a risk to restate',
      'never use the same article fact twice', 'does not need 200 words on a thin day',
      'say once that they concern single companies']) {
      assert.ok(body.includes(phrase), `missing: ${phrase}`);
    }
    // The new lines sit inside the block, before its final sentence, which stays last in the block.
    const finalAt = body.indexOf(FINAL_SENTENCE);
    assert.ok(finalAt > body.indexOf(THIN_DAY_SIX_WORDING));
    assert.ok(body.indexOf(THIN_DAY_SIX_WORDING) > body.indexOf(SECTION_THREE_WORDING));
    // The new wording is the only difference from the switch-off request: removing it restores
    // nothing else, and the "telemetry" and "count" wording is in the Haiku 5.5 block only.
    const off = await withEnv({CLAUDE_MODEL: 'haiku-5.5', HAIKU55_WRITER_DEPTH_ENABLED: 'off'},
      () => buildClaudeAnalysisRequest(input));
    assert.equal(text(off).includes('never use the word \\"telemetry\\" in report text'), false);
    assert.equal(text(off).includes('never state a count of companies'), false);
    assert.equal(text(on).length > text(off).length, true);
  });
}
