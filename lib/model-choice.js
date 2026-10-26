// Step 9AC Stage 1: the one place that decides which Claude model every call uses.
//
// The allowed list lives here, in code, for good: no request, setting or table can
// name a model that is not on it. modelChoiceEnabled off gives the bd7ef08 request
// exactly (Haiku 4.5, today's reply limits, no extra field, no cost line).
'use strict';

const {AsyncLocalStorage} = require('node:async_hooks');
const {SETTINGS_REGISTRY, settingValue} = require('./settings-registry');

const CALL_KINDS = Object.freeze([
  'writer', 'classifier', 'subjectRepair', 'recapSearch', 'cnbcSearch', 'materiality'
]);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

// Reply limits and prices are the registry's Fixed entries (claudeModelReplyLimits,
// claudeModelPrices). Prices are US dollars per million tokens; longPromptTokens: a
// prompt above this many tokens (all input, cache reads and writes included) is
// billed on the `long` card; null means one card only.
const REPLY_LIMITS = settingValue('claudeModelReplyLimits');
const PRICES = settingValue('claudeModelPrices');

function allowedModel(id, apiModel, thinkingDisabled) {
  return deepFreeze({
    apiModel,
    status: 'active',
    thinkingDisabled,
    maxTokens: {...REPLY_LIMITS[id]},
    price: JSON.parse(JSON.stringify(PRICES[id]))
  });
}

const ALLOWED_MODELS = Object.freeze({
  'haiku-4.5': allowedModel('haiku-4.5', 'claude-haiku-4-5-20251001', false),
  'haiku-5.5': allowedModel('haiku-5.5', 'claude-haiku-5-5', true)
});

// The model every call used before this step; also the switch-off answer.
const SWITCH_OFF_MODEL_ID = 'haiku-4.5';
const WEB_SEARCH_USD_PER_SEARCH = settingValue('webSearchUsdPerSearch');
const ALLOWED_API_MODELS = Object.freeze(Object.values(ALLOWED_MODELS).map(entry => entry.apiModel));

// Per-request context (set by api/quote.js): the page's model query value, read
// only while userModelChoiceEnabled is on, and whether a fallback was already logged.
const requestContext = new AsyncLocalStorage();

function runWithModelChoiceContext(context, callback) {
  return requestContext.run({queryModel: context?.queryModel, fallbackLogged: false}, callback);
}

function choiceFor(id, models) {
  const entry = models[id];
  return Object.freeze({
    id,
    apiModel: entry.apiModel,
    maxTokens: entry.maxTokens,
    thinkingDisabled: entry.thinkingDisabled,
    price: entry.price
  });
}

function logFallback(reason, source, fallbackModel) {
  const store = requestContext.getStore();
  if (store) {
    if (store.fallbackLogged) return;
    store.fallbackLogged = true;
  }
  try {
    // Reason only: the raw value is never written to the log.
    console.info('[model-choice]', JSON.stringify({stage: 'modelChoiceFallback', reason, source, fallbackModel}));
  } catch (error) {
    // Observability must not affect model choice.
  }
}

// Whether `value` names a usable entry: UNKNOWN (not on the list, exact match
// only), RETIRED, or null when usable.
function unusableReason(value, models) {
  if (typeof value !== 'string' || !Object.hasOwn(models, value)) return 'UNKNOWN';
  return models[value].status === 'active' ? null : 'RETIRED';
}

function modelChoiceEnabled(env) {
  return settingValue('modelChoiceEnabled', {env}) === true;
}

// `models` is for tests only (a retired entry); production always uses ALLOWED_MODELS.
function resolveModelChoice({env = process.env, models = ALLOWED_MODELS} = {}) {
  if (!modelChoiceEnabled(env)) return choiceFor(SWITCH_OFF_MODEL_ID, ALLOWED_MODELS);
  const fallbackId = SETTINGS_REGISTRY.claudeModel.default;
  const store = requestContext.getStore();
  if (store && store.queryModel !== undefined && settingValue('userModelChoiceEnabled', {env}) === true) {
    const reason = unusableReason(store.queryModel, models);
    if (!reason) return choiceFor(store.queryModel, models);
    logFallback(reason, 'query', fallbackId);
  }
  const raw = env[SETTINGS_REGISTRY.claudeModel.envVar];
  if (raw === undefined) return choiceFor(fallbackId, models);
  const reason = unusableReason(raw, models);
  if (!reason) return choiceFor(raw, models);
  logFallback(reason, 'CLAUDE_MODEL', fallbackId);
  return choiceFor(fallbackId, models);
}

// The request fields a builder puts where it had `model` and `max_tokens`, in that
// order. Haiku 5.5 adds thinking switched off directly after `max_tokens`; Haiku 4.5
// adds nothing (and never `effort`).
function modelRequestFields(callKind, {env, choice} = {}) {
  if (!CALL_KINDS.includes(callKind)) throw new TypeError(`Unknown call kind: ${callKind}`);
  const resolved = choice || resolveModelChoice(env ? {env} : {});
  const fields = {model: resolved.apiModel, max_tokens: resolved.maxTokens[callKind]};
  if (resolved.thinkingDisabled) fields.thinking = {type: 'disabled'};
  return fields;
}

// Step 9AE: whether the writer request gets the Haiku 5.5 writing-depth block. Only the
// resolved choice and the switch are read; nothing is logged. Haiku 4.5: always false.
function writerDepthGuideApplies(choice, {env} = {}) {
  return choice?.id === 'haiku-5.5'
    && settingValue('haiku55WriterDepthEnabled', {env: env || process.env}) === true;
}

function finiteCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

// Money is worked in whole nano-dollars (a price per million tokens x 1000 is a whole
// number of nano-dollars per token), so rounding to micro-dollars is exact.
function nanoPerToken(pricePerMTok) {
  return Math.round(pricePerMTok * 1000);
}

function microUsd(nano) {
  return Math.round(nano / 1000) / 1e6;
}

// Cost of one call from its `usage`, for the read-only modelCost log line.
function modelCallCost(usage, choice) {
  const source = usage && typeof usage === 'object' ? usage : {};
  const input = finiteCount(source.input_tokens);
  const cacheWrite = finiteCount(source.cache_creation_input_tokens);
  const cacheRead = finiteCount(source.cache_read_input_tokens);
  const output = finiteCount(source.output_tokens);
  const searches = finiteCount(source.server_tool_use?.web_search_requests);
  const promptTokens = input + cacheWrite + cacheRead;
  const long = choice.price.longPromptTokens !== null && promptTokens > choice.price.longPromptTokens;
  const card = long ? choice.price.long : choice.price.standard;
  const inputNano = input * nanoPerToken(card.input) + cacheWrite * nanoPerToken(card.cacheWrite)
    + cacheRead * nanoPerToken(card.cacheRead);
  const outputNano = output * nanoPerToken(card.output);
  const searchNano = searches * Math.round(WEB_SEARCH_USD_PER_SEARCH * 1e9);
  return Object.freeze({
    promptTokens,
    priceCard: long ? 'long' : 'standard',
    inputUsd: microUsd(inputNano),
    outputUsd: microUsd(outputNano),
    searchUsd: microUsd(searchNano),
    totalUsd: microUsd(inputNano + outputNano + searchNano)
  });
}

// One read-only modelCost log line per Anthropic call, only while the switch is on
// and the reply carried usage. It has its own prefix (not the calls' diagnostics),
// so every existing diagnostic line is unchanged; requestId matches it to the
// call's own usage line. The model is the one the request actually named.
function emitModelCost({call, model, requestId = null, usage, env} = {}) {
  if (!usage || typeof usage !== 'object') return;
  if (!modelChoiceEnabled(env || process.env)) return;
  const id = Object.keys(ALLOWED_MODELS).find(key => ALLOWED_MODELS[key].apiModel === model);
  if (!id) return;
  try {
    console.info('[model-cost]', JSON.stringify({
      stage: 'modelCost', call, model, requestId, ...modelCallCost(usage, choiceFor(id, ALLOWED_MODELS))
    }));
  } catch (error) {
    // Observability must not affect analysis behavior.
  }
}

// Step 9AC decision 3: the older ?claude=1 route forwards only allowed model names.
function guardLegacyModel(body, {env = process.env} = {}) {
  if (settingValue('legacyModelGuardEnabled', {env}) !== true) return {body, replaced: false};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {body, replaced: false};
  if (ALLOWED_API_MODELS.includes(body.model)) return {body, replaced: false};
  return {body: {...body, model: ALLOWED_MODELS[SWITCH_OFF_MODEL_ID].apiModel}, replaced: true};
}

module.exports = {
  ALLOWED_MODELS,
  ALLOWED_API_MODELS,
  CALL_KINDS,
  SWITCH_OFF_MODEL_ID,
  WEB_SEARCH_USD_PER_SEARCH,
  emitModelCost,
  guardLegacyModel,
  modelCallCost,
  modelChoiceEnabled,
  modelRequestFields,
  resolveModelChoice,
  runWithModelChoiceContext,
  writerDepthGuideApplies
};
