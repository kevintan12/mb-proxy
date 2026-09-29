# MarketBrief backend decisions

One entry per decision. Newest last. Never delete or rewrite an entry; supersede it with a new one.

## Step 8F — Plain-English style is non-blocking

- **Date:** 2026-09-26 · **Branch:** step-8-runtime-cost · **Status:** COMMITTED (4127b19) on Preview; REGULAR live-validated; PRE and POST live runs pending
- **Context:** 6b40f2b made context-dependent analyst jargon section-fatal. Words such as "hawkish", "positioning", "risk exposure" or "repriced" in a section's content or uncertainties caused the whole section to be removed, even when it was fully grounded. The same words in evidence gaps, or in a completed-session report, failed the entire report. On the 25 Sep PRE run, a healthy package produced empty Sections 1, 2, 3, 5, 6 and 7 and no Further Readings, because Further Readings derive only from surviving cited sections. Section 4 still carried jargon that the list did not cover.
- **Intent:** a style issue must never delete otherwise grounded analysis. The plain-English goal is pursued through the prompt and meaning-preserving rewrites, not through deletion.
- **Decision:**
  - Only malformed prose may localize a section. Malformed means either the existing structural invalid-content checks (non-string, empty, untrimmed) or a closed list of deterministic splice signatures produced by the rewrite mechanism. Today that list is one signature: a replacement clause sitting in a noun/subject slot, e.g. "healthcare how investors are already invested".
  - Style-only jargon is still detected but never blocks. It is emitted as a non-deleting diagnostic that counts leftover jargon per section, with no prose.
- **Must not change:** the strengthened plain-English prompt; the safe deterministic rewrites; Section 3/4/6 grounding (including the literal UNGROUNDED_OPPORTUNITY_SUBJECT rule); the Section 7 empty-when-unsupported rule; Further Readings citation rules; the Yahoo 3-article active acquisition; completed-session protections (39da041, 14534fc, c96a132); one Anthropic request per generation with no retry.
- **Rejected options:**
  - Tuning individual jargon phrases: the list can never be complete.
  - Rewriting context-dependent terms: this risks changing the claim.
  - Deleting sections for style: this is the destructive regression itself.
  - Reverting 6b40f2b wholesale: that would lose the prompt and safe rewrites, and bring back the positioning splice.
- **Open questions:** Should style residue be logged without deleting anything? Resolved 2026-09-26: YES, a per-section count.
- **Implementation:**
  - `lib/claude-analysis-contract.js`: the style and malformed patterns are split into `PLAIN_ENGLISH_STYLE_PATTERNS` and `MALFORMED_PLAIN_ENGLISH_PATTERNS`. `hasMalformedPlainEnglishProse` is the only plain-language check in the validator, covering section content, uncertainties and evidence gaps. `hasAnalystDeskJargon` and `countAnalystDeskJargon` remain for detection only.
  - `lib/claude-analysis-invocation.js`: the `PLAIN_LANGUAGE_VALIDATION` category now means malformed prose only. A new `plainLanguageStyleResidue` diagnostic runs after final validation. It records per-section content and uncertainty match counts plus an evidence-gap count, contains no prose, and is emitted only when a count is above zero.
- **Evidence/tests:**
  - Baseline at 6b40f2b: 701/701 tests passing, 46/46 syntax checks, `git diff --check` clean.
  - After Step 8F: 707/707 tests passing (6 new tests, 2 updated), 46/46 syntax checks, `git diff --check` clean.
  - New tests:
    - `tests/claude-analysis-invocation.test.js`: T1–T3 with T8 and T9 (PRE, REGULAR and POST keep their content, references, uncertainties, gaps and Further Readings); T5 active (malformed content or uncertainty localizes only Section 6, tagged `PLAIN_LANGUAGE_VALIDATION`); T6 (UNGROUNDED_OPPORTUNITY_SUBJECT is unchanged); T7 (Section 4 follows the same policy).
    - `tests/us-market-brief-quality-fixtures.test.js`: T4 (CLOSED, WEEKEND and HOLIDAY); T5 completed (a malformed splice still causes CONTRACT_FAILURE).
  - T10 and T11: the existing Yahoo acquisition tests (three-article stop, sixth article, eight-attempt ceiling) and the completed-session tests (39da041 freshness, 14534fc CLOSED/WEEKEND/HOLIDAY, c96a132 recovery) pass unchanged.
  - Discrimination check: all 8 new or updated tests fail against the unmodified 6b40f2b code.
- **Live validation:**
  - 2026-09-26, REGULAR on Preview (generation be9d8e9f): passed. There were no `PLAIN_LANGUAGE_VALIDATION` events. `plainLanguageStyleResidue` fired for Section 7 without deleting anything. 3 Yahoo articles were admitted.
  - The same run showed a separate, pre-existing Section 3 and number-accuracy issue, recorded as Step 8G. It is not a Step 8F regression.
- **Pending:** PRE and POST live runs on Preview, then Kevin's decision on promotion to `main`.
- **Supersedes:** none.

## Step 8G — Section 3 blanking and unchecked numbers (record only)

- **Date:** 2026-09-26 · **Branch:** step-8-runtime-cost · **Status:** RECORDED, not fixed. Deferred to the Market Brief pipeline redesign.
- **Context:**
  - **Section 3 blanked:** in the 26 Sep REGULAR Preview run (generation be9d8e9f), the older `NON_BENCHMARK_TELEMETRY` rule blanked Section 3 because it cited portfolio stock telemetry (6 of 10 refs offending).
  - **Further Readings lost:** blanking Section 3 also dropped 2 of 3 Further Readings links, because Further Readings derive only from surviving cited sections.
  - **Wrong number:** Section 5 stated an index move incorrectly (NASDAQ 0.45% vs actual 0.53%), and no check caught it.
  - **Not new:** both behaviors are pre-existing in Production and are not caused by Step 8F.
- **Intent:** whole-section blanking throws away good content and links, and wrong numbers reach the user unchecked. Both undermine report quality.
- **Decision:** record only; no code change now. Solve in the Market Brief pipeline redesign by fact-checking numbers against fetched data instead of blanking whole sections.
- **Must not change (until the redesign is approved):** the existing Section 3 scope rules (`NON_BENCHMARK_TELEMETRY`, broad-market focus grounding) and the Further Readings citation rules stay as they are. No ad-hoc loosening or patching in the meantime.
- **Rejected options (for now):**
  - Loosening or removing `NON_BENCHMARK_TELEMETRY`: that would weaken Section 3 grounding without a replacement check.
  - Patching the Section 5 wording or adding one-off number checks outside the redesign: that is piecemeal and inconsistent with a single fact-checking design.
- **Open questions (for the redesign):**
  - How should numbers be fact-checked against fetched telemetry, and with what tolerance?
  - What happens on a mismatch (correct, drop the sentence, or flag) instead of blanking the section?
  - How can Further Readings survive when only part of a section is rejected?
- **Supersedes:** none.

## Step 18 — Development process setup (repo: both)

- **Date:** 2026-09-26 · **Branch:** MarketBrief `step-8-runtime-cost` (610fa07) / mb-proxy `main` · **Status:** POLICY
- **Intent:** Establish a repeatable, auditable development workflow that keeps Kevin in control of every commit while documenting all decisions in one place. Protect both repos from accidental or surprise changes.
- **Decision:**
  - **Git commands:** Kevin runs every git command that changes either repo (commit, push, merge, rebase, reset, checkout, tag, stash, branch create/delete, etc.) himself in Git Bash. Claude Code provides exact copy-paste command blocks (starting with `cd` and `git branch --show-current`) with expected output, but never executes them. Read-only commands (status, log, diff, show, rev-parse, etc.) are allowed.
  - **Shared decision log:** the single authoritative decision log for both MarketBrief and mb-proxy is `mb-proxy/docs/DECISIONS.md`. Claude Code reads it at the start of each session and logs each request there, tagged `repo: MarketBrief` or `repo: mb-proxy` (or `repo: both`), with its intent, what must not change, and rejected options.
  - **Permission mode:** Claude Code runs in Manual mode by default (approvals required for all tool use). Accept edits only temporarily for approved work. Auto/Bypass modes are never used. Intent: nothing changes without Kevin's deliberate approval.
  - **Node modules:** `node_modules/` is excluded from Dropbox sync in both repos. Intent: Dropbox file locks prevent npm installs.
- **Baseline state (26 Sep 2026):**
  - MarketBrief `main` @ 610fa07: 130/130 tests passing, 14/14 syntax checks passing, `git diff --check` clean. Visible version `v2.20260921.25.F`, release commit `be5df88`.
  - mb-proxy `main` @ 4127b19: Step 8F committed on Preview; baseline pre-Step 8F was 701/701 tests passing, 46/46 syntax checks.
- **Must not change:** the rule that Kevin runs all repo-changing git commands himself. All other rules may be superseded if circumstances change.
- **Rejected options:** having Claude Code auto-commit or push; logging decisions in separate files per repo; allowing Auto/Bypass modes.
- **Supersedes:** none.

## Step 8I — CLOSED brief fails when Yahoo daily rows lag after the close (repo: mb-proxy)

- **Date:** 2026-09-26 · **Branch:** step-8-runtime-cost (05aed81) · **Status:** DIAGNOSING. No code change yet.
- **Context:**
  - A CLOSED-session Preview run failed (generation 51f0f1fc, 2026-09-26 01:29 UTC = Fri 25 Sep 21:29 ET). The failure was `sections[3]: factual content requires supplied evidence`.
  - For all 15 My Stocks/Watchlist symbols, Yahoo's 2026-09-25 daily row existed but had no valid close (`expectedDailyCloseValid=false`). The 4 indices had valid rows.
  - Intraday recovery (84f5ea4 / c96a132) then failed for every stock, with either `OUTSIDE_EXPECTED_SESSION` or `INVALID_INTRADAY_OHLC`. The freshness gate (39da041) therefore omitted every stock (`COMPLETED_SESSION_DATE_MISMATCH`).
  - Claude still wrote Section 4 prose, with 0 evidence refs and 0 telemetry refs. The strict completed-session contract (14534fc) rejected the whole report.
- **Findings (live Yahoo re-fetch, 26 Sep, same endpoints):**
  - **Daily rows are complete now.** MSFT, NVDA and the other listed symbols now have valid 25 Sep daily rows (e.g. MSFT O 499.04 H 519.40 L 497.25 C 516.17). The gap at 21:29 ET was real but temporary. The row values at run time were not logged, so the exact shape of the gap cannot be re-checked.
  - **Yahoo adds a closing bar that the check rejects.** The 1m request (`period1`=09:30 ET, `period2`=16:00 ET) returns 391 bars. Bar 391 is stamped exactly 16:00:00, with volume 0 and O=H=L=C equal to the official close. `normalizeIntradaySession` rejects any bar at or after `closeMs` (`OUTSIDE_EXPECTED_SESSION`), so recovery cannot succeed on real data for any symbol, indices included. The test fixtures model exactly 390 bars and no 16:00 bar, so the tests never caught this.
  - **Quiet minutes also fail the check.** Thinly traded names have minutes with no trades. Bad bars on 25 Sep: CPRI 4, CPRT 1, VEEV 21, VRSK 50, all before 16:00. Any invalid bar returns `INVALID_INTRADAY_OHLC` before the 16:00 check is reached. This explains the mix of the two rejection categories in the logs.
  - **The 15:59 close is not the official close.** Recovery uses the 15:59 bar's close, but the official close is on the 16:00 bar (e.g. VRSK 169.39 vs 169.21; MSFT 516.10 vs 516.17). Simply dropping the 16:00 bar would recover a wrong close. That wrong value could later conflict with Yahoo's corrected daily row (`CANONICAL_SESSION_VALUES_CONFLICT`).
  - **Why Section 4 failed the whole report:** `portfolioList` passes every configured security to the model, including omitted ones, each with empty ref arrays. The deterministic statement applies only to an empty list. The prompt has no instruction for a non-empty list with no data. Section-level localization (`normalizeUsIndependentSections`) runs only in active states. The completed-session Section 4 normalizer only handles wrong refs, not missing refs.
  - **Production (origin/main 430b0a6) is different.** It has neither the intraday recovery nor the 39da041 freshness gate. With the same Yahoo data, Production would most likely build stock snapshots ending 24 Sep and present them as the latest session: the stale-baseline problem 39da041 fixed, not this failure. This was not run live. The same contract rule (`factual content requires supplied evidence`) exists in Production.
- **Intent:**
  - Recovery must work on Yahoo's real 1m shape and must return the official close.
  - A brief whose initiating list has no usable data must degrade to a clear deterministic Section 4 statement, not fail the whole report.
- **Candidate fixes (not approved):**
  - **A (root cause, `lib/yahoo-telemetry-acquisition.js`):**
    - Accept exactly one terminal bar stamped at `closeMs` and use its close as the recovered close. Require that bar; if it is absent, fail closed.
    - Treat all-null minutes as no-trade minutes. Still require valid 09:30 and 16:00 bars, and still reject partially null or inconsistent bars.
    - Replace the fixtures with a real-shape fixture: 391 bars plus null minutes.
  - **B (graceful Section 4, contract + invocation + prompt):** when the initiating list is non-empty but no initiating security has any telemetry or evidence ref, Section 4 becomes a fixed server-owned statement with no refs. The report is DEGRADED with an evidence gap. This applies in both active and completed modes. Partial-data lists are unchanged.
- **Must not change:**
  - 39da041 freshness: a stale snapshot must never define the baseline.
  - The 14534fc strict completed-session contract for all other sections.
  - c96a132 exact-date recovery semantics: intraday data must never promote a row it cannot reconcile.
  - Section 4 initiating-list-only scope.
  - One Anthropic request per generation, with no retry.
  - A failed regeneration preserves the previous valid report.
- **Rejected options:**
  - Just dropping the 16:00 bar: it recovers the 15:59 price, not the official close.
  - Loosening freshness to accept 24 Sep snapshots: that brings back the 39da041 stale-baseline bug.
  - Removing omitted securities from `portfolioContext`: Section 4 would then falsely say no securities are configured.
  - Enabling active-style section localization for all completed-session sections: that weakens 14534fc.
- **Open questions:**
  - How long after the close do Yahoo equity daily rows stay incomplete? The answer sets the failure window and whether recovery is needed routinely.
  - What is the exact wording of the Fix B statement?
  - Should Fix B also apply when data is present but stale?
- **Note:** a CLOSED re-run now would probably pass, because Yahoo has since filled the daily rows. That would hide this bug, not validate a fix.
- **Supersedes:** none.

## Step 8I (continued) — Implement Fix A: make Yahoo completed-session recovery work on real data (repo: mb-proxy)

- **Date:** 2026-09-26 · **Branch:** step-8-runtime-cost · **Status:** IMPLEMENTED, tests and read-only live replay passing; not yet committed.
- **Context:** the Step 8I diagnosis identified three mismatches between `normalizeIntradaySession`'s assumptions and Yahoo's real 1-minute data: (1) Yahoo sends a 391st bar stamped exactly at the close, with O=H=L=C equal to the official close, which the old code rejected outright (`OUTSIDE_EXPECTED_SESSION`); (2) thinly traded symbols have no-trade minutes where every field is null, which the old code rejected (`INVALID_INTRADAY_OHLC`); (3) daily-row open/high/low differ from the intraday bar by a small amount (opening auction vs. first trade), which the old exact-match reconciliation rejected (`DAILY_INTRADAY_OHLC_CONFLICT`) even for indices' near-identical values.
- **Intent:** recovery must succeed on Yahoo's real data for both stocks and indices and must return the official close, while staying fail-closed on data it genuinely cannot reconcile.
- **Decision (Kevin approved Fix A with a 0.1% reconciliation tolerance):**
  - `normalizeIntradaySession` now accepts exactly one "closing print" bar at `regularCloseTime` (any bar timestamped later still returns `OUTSIDE_EXPECTED_SESSION`, since timestamps are strictly increasing so a bar after the closing print necessarily exceeds `closeMs`). Its close becomes the session close; a missing closing print returns `MISSING_FINAL_REGULAR_OBSERVATION`.
  - A bar where open/high/low/close are all null is treated as a no-trade minute: skipped for open/high/low, but its timestamp still counts toward the 390-minute grid coverage check. The 09:30 opening bar must not be a no-trade bar (`INVALID_INTRADAY_OHLC` if it is, since it supplies the session open). Any other bar with only some fields null is still rejected as malformed (`INVALID_INTRADAY_OHLC`).
  - Session values: open = 09:30 bar's open; high/low = max/min over traded bars plus the closing print; close = closing print's close.
  - The two near-identical reconciliation blocks (expected-date and preceding-date paths) are merged into one `reconcileDailyWithIntraday` helper. A present daily open/high/low is kept only if positive and within `DAILY_INTRADAY_TOLERANCE = 0.001` (0.1%) of the reconciled intraday value (open: relative distance; high: daily must be ≥ intraday × 0.999; low: daily must be ≤ intraday × 1.001); a missing one is filled from intraday. Close always comes from the closing print. Out-of-tolerance or non-positive daily values still give `DAILY_INTRADAY_OHLC_CONFLICT`; a result that still fails `validOhlcBar` gives `INVALID_RECONSTRUCTED_OHLC`, exactly as before.
- **Must not change (all confirmed unaffected — see Evidence/tests):**
  - 39da041 freshness, the 14534fc strict completed-session contract, c96a132 exact-date recovery semantics, Section 4 initiating-list-only scope, one Anthropic request per generation with no retry, a failed regeneration preserves the previous valid report.
  - Diagnostics shape and rejection-category names: no new category names were introduced.
  - SG/HK: recovery remains US-only (`applyLatestCompletedCloseFallback` still gates on `market !== 'US'`).
- **Rejected options:**
  - Dropping the 16:00 bar and keeping the 15:59 close: recovers a materially wrong close (e.g. VRSK 169.39 vs the official 169.21).
  - Trusting daily open/high/low unchecked when present: would let a genuinely corrupt daily row silently override real intraday values.
  - Exact-match reconciliation (status quo): rejects real Yahoo data for both stocks and indices, per the Step 8I diagnosis findings.
- **Implementation:** `lib/yahoo-telemetry-acquisition.js` only — `normalizeIntradaySession` rewritten (closing print, no-trade minutes); new `reconcileDailyWithIntraday` helper and `DAILY_INTRADAY_TOLERANCE` constant, called from both `applyLatestCompletedCloseFallback` branches (expected-date row and preceding-date row).
- **Evidence/tests:**
  - `tests/yahoo-telemetry-acquisition.test.js`: `intradayResponseFor` now defaults to the real 391-bar shape (390 regular minutes + one closing print, defaulting to the same close as the regular bars so all pre-existing assertions hold unchanged); new options `closingPrint`, `closingClose`, `noTradeMinutes`, `extraBarAfterClose`, `sessionContext`. All 23 pre-existing tests in this file pass unmodified against the real shape.
  - 11 new tests: real-shape recovery uses the closing print's close, not the 15:59 bar (and cross-checked its high/low from it); missing closing print → `MISSING_FINAL_REGULAR_OBSERVATION`; a bar after the closing print → `OUTSIDE_EXPECTED_SESSION`; no-trade minutes accepted and excluded from high/low while still counted for coverage; a partially-null bar and a no-trade opening bar → `INVALID_INTRADAY_OHLC`; a partial daily row (O/H/L present, close null) recovers for a US equity (AAPL); tolerance boundary tests (±0.05% recovers and keeps the daily value, ±0.2% conflicts) for open/high/low on both the expected-date and preceding-date paths; an early-close scenario (session close time-driven, not hardcoded 16:00, tested via `getSessionContext` dependency injection since the exchange calendar deliberately has no supported real early-close date — see Note); the three pre-existing exact-magnitude conflict cases (open 100 vs 101, low 0, close 0) still conflict unchanged.
  - Discrimination check: all 14 tests that exercise the new/changed behavior fail against the unmodified 970521a code (verified in a scratch copy).
  - Full suite: 718/718 passing (707 baseline + 11 new). Syntax: 46/46. `git diff --check`: clean.
  - **Read-only live replay** (no code/env changes, no paid calls): real Yahoo daily data for 16 symbols (MSFT, NVDA, VOO, CPRI, CPRT, VEEV, VRSK, AAPL, UNH, NVO, SPYM, CRM, ^GSPC, ^DJI, ^IXIC, ^RUT) fetched live, with the 2026-09-25 row artificially degraded two ways (close-only null; all of open/high/low/close/volume null) before being handed to the service; the 1-minute intraday requests were real, live Yahoo calls. All 32 runs (16 symbols × 2 variants) recovered `SUCCESS` with `primaryCompletedSessionDate = 2026-09-25` and a close matching Yahoo's real (undegraded) daily close exactly, cross-verified directly against the live API for MSFT (516.1699829101562) and VRSK (169.2100067138672).
  - **Round 2 (UNH, NVO, SPYM, CRM), including the daily-vs-intraday gap:** all 8 runs (4 symbols × 2 variants) `SUCCESS`, `recoveredClose` equal to the real undegraded daily close in every case (UNH 376.5899963378906; NVO 38.79999923706055; SPYM 90.80000305175781; CRM 234.02000427246094). Largest daily-vs-intraday open/high/low gap per symbol: UNH 0.0000%, NVO 0.0000%, SPYM 0.0048% (high), CRM 0.0000% — all far inside the 0.1% tolerance (nearest case at ~5% of the tolerance's width, not 80%). No symbol failed and none came within 0.08% of the tolerance boundary, so `DAILY_INTRADAY_TOLERANCE` was left unchanged.
- **Note:** the full 15-symbol My Stocks/Watchlist list from the 25 Sep failure was not available to this session; the replay used the 7 stocks and index named in the Step 8I diagnosis findings, plus AAPL, UNH, NVO, SPYM and CRM (12 stocks, 4 indices = 16 of the 15+4 likely list). Kevin may want any still-missing symbols re-run before promotion.
- **Open questions (unresolved from Step 8I, still open):** how long Yahoo equity daily rows stay incomplete after the close; the exact wording of a Fix B statement (not implemented — Fix A alone resolved the 25 Sep failure without needing Fix B, since recovery now succeeds); whether Fix B should also apply when data is present but stale.
- **Pending:** Kevin's commit decision; a live CLOSED Preview run soon after 20:00 ET (08:00 SGT on a weekday) to confirm in production-shaped conditions.
- **Supersedes:** none (extends the Step 8I diagnosis with the approved fix; Step 8I (diagnosis) is left unedited).

## Step 8J — Plain-language rewrite of the Market Brief writing instructions (repo: mb-proxy)

- **Date:** 2026-09-26 · **Branch:** step-8-runtime-cost · **Status:** AGREED, not started.
- **Context:** Kevin reviewed the 26 Sep CLOSED live run on Preview (generation be9d8e9f, following the Step 8F fix). All 8 sections were present and the content was substantively good, but the language remained analyst-style. Examples from the live brief: "measured reassessment of risk and opportunity rather than broad-based capitulation"; "positioning shifts"; "repricing dynamics". A reader without investment experience would not connect to these terms.
- **Intent:** the brief must read in plain English that a non-analyst retail investor understands, without making confident claims that lack cited evidence. A non-expert should be able to follow the reasoning and assess whether the analysis fits their own situation.
- **Decision (prompt only, no logic changes):**
  - **Target language level:** "Level 2 plain English". Short sentences, everyday words, keep the numbers and detail. Example to target: "Stocks rose on Friday even though US government bond rates hit their highest level since 2008. Investors weren't panicking, but they weren't getting carried away either. Most of the buying went into technology and AI companies." Example to avoid (analyst-style): "Friday's market action reflects a measured reassessment of risk and opportunity rather than broad-based capitulation or euphoria."
  - **Rewrite the writing instructions** in `lib/claude-analysis-invocation.js` (the main prompt, approximately line 73 and the section-specific prompts thereafter). Use short sentences, plain transitions ("because", "so"), concrete facts, and move away from abstract financial concepts. Keep the evidence grounding rules (Sections 3, 4, 6, 7 citations) and the Section 6 literal rule (`UNGROUNDED_OPPORTUNITY_SUBJECT`) intact.
  - **Section 6 (Key Risks & Opportunities) must not make unsupported forward claims:** strike language like "years of runway ahead", "durable margin expansion", or "tailwinds ahead" unless they are grounded in a cited source or a logical consequence of cited facts. Risks and opportunities tied to cited evidence only.
  - Carry the rewritten instructions into the Market Brief pipeline redesign (per Step 8G analysis).
- **Must not change:** validation logic (malformed-prose checks remain), grounding rules (Sections 3/4/6 literal evidence, Section 7 empty-when-unsupported), Step 8F behaviour (style residue never blocks).
- **Rejected options:**
  - Simpler language levels ("explaining to a friend", "assuming no finance knowledge"): these lose the precision needed for an investing decision.
  - Automated jargon replacement beyond the existing `PLAIN_ENGLISH_REPLACEMENTS`: context-dependent rewrites risk changing claims.
  - Removing Section 6 or weakening the `UNGROUNDED_OPPORTUNITY_SUBJECT` rule: that would invite unsupported claims.
- **Implementation plan (when approved):**
  - Rewrite the main generation prompt in `lib/claude-analysis-invocation.js` (lines ~73 onwards, and section-specific prompts).
  - Add or strengthen the `PLAIN_ENGLISH_REPLACEMENTS` list with additional common analyst phrases → plain equivalents.
  - Test with the existing 26 Sep fixture (live replay or regenerate from the same input).
  - Once Step 8F and Step 8I Fix A are in Production, stage Step 8J and run a new PRE/REGULAR/POST/CLOSED set on Preview before promotion.
- **Timing:** after Step 8F and Step 8I Fix A are promoted to Production. Can be staged and reviewed independently, but carries forward only when both prior fixes are live.
- **Open questions:** should the prompt also discourage hedging language ("may", "could", "possible") when alternatives are clearer, or is that over-specification?
- **Supersedes:** none (complements Step 8F on style and adds Section 6 unsupported-claim guidance; independent of Step 8I Fix A telemetry logic).

## Step 8J — update: plain-language rewrite implemented (repo: mb-proxy)

- **Date:** 2026-09-26 · **Branch:** step-8-runtime-cost · **Status:** IMPLEMENTED (prompt only), not committed; live validation pending. Refers back to the decision entry "Step 8J" above. From 26 Sep 2026 the Master's Step Table is the single tracker and new entries are keyed by Step number.
- **Amendments agreed 26 Sep 2026 and how they were applied:**
  1. **Hedging is not banned.** The prompt now says: state uncertainty once, where it matters, as a concrete "if [cited fact], then [consequence]"; never stack hedges ("could potentially"); never hedge a cited fact. This answers the Step 8J open question.
  2. **`PLAIN_ENGLISH_REPLACEMENTS` was not extended.** It rewrites Claude's output automatically (`normalizePlainEnglishOutput`), so new analyst phrases (repricing, positioning shifts, capitulation, etc.) went into the prompt guidance only. No new automatic rewriting. `PLAIN_ENGLISH_STYLE_PATTERNS`, malformed-prose checks and the style-residue diagnostic are unchanged.
  3. **No leakable example facts.** The single tone example is marked "Style example only, do not reuse its facts or wording as content" and uses placeholders. The movement-format examples (previously real-looking Apple / S&P 500 values) are now placeholders: `[Company] fell $[amount] ([percent]%) to $[price].` A test asserts the old example values are absent from the prompt.
  4. **Section 4 wording untouched.** No list-specific text was added, so Step 21D (Section 4 covering both lists) is not made harder.
  5. **Section 6 forward claims.** Added: no "years of runway", "tailwinds ahead" or "durable margin expansion" unless a cited source says so or it follows directly from cited facts; otherwise omit or use "if [cited fact] continues, [consequence]". All Section 6 grounding sentences are unchanged.
- **What changed:** `CLAUDE_ANALYSIS_SYSTEM_PROMPT` in `lib/claude-analysis-invocation.js`: main writing instruction, movement-format and uncertainty instructions, plus light plain-sentence wording in Sections 1, 5 and 6. The system prompt is about 2.4 KB (roughly 600 tokens) longer per request.
- **Tests (wording pins updated, rules untouched):** `tests/claude-analysis-invocation.test.js` "gives Claude plain-language and locked movement presentation instructions" and `tests/us-market-brief-quality-fixtures.test.js` "plain-English style is deterministic..." pinned the old sentences and old example values, so they now pin the new wording; added "Step 8J: Section 6 forbids unsupported forward claims". No rule test was changed or weakened. Full suite 719/719.
- **Must not change (kept):** validation logic, Sections 3/4/6 grounding, `UNGROUNDED_OPPORTUNITY_SUBJECT`, Section 7 empty when unsupported, Step 8F behaviour (style residue never blocks), one request with no retry, the 8-section structure, protected checkpoints. (Step 8F is the prior decision that made style-only jargon non-blocking.)
- **Step 8J — citation fix:** A replay of one saved WEEKEND package gave NORMAL on 2 of 2 replays with the old prompt and DEGRADED on 2 of 2 with Step 8J. One replay lost Section 2 to `MISSING_PRINCIPAL_CATALYST`; the other lost Section 3 to `NON_FOCUS_EVIDENCE` (a recap/session reference was cited). Likely causes: the style example "Stocks rose on [day]…" and the "because / so" nudge match `hasDirectMarketCausalClaim`, which then demands a principal catalyst, and "keep every number" pulled index/recap references into Section 3. Prompt-only fix: Section 2 must cite a principal catalyst whenever it says what moved the market and whenever principal catalysts exist; Section 3 must not cite recap, session, index or weekly-summary references; the causal-pattern style example was removed; "so" is tied to a cited principal catalyst; added a 25-word sentence limit, one idea per sentence, and a banned-word list. No validator changed. The validator false positive (plain "rose on" counted as a causal claim) is unchanged and logged for Step 21B.
- **Step 8J — readability round:** Replay on the citation-fixed prompt was NORMAL 3 of 3 but readability did not improve (22–27 words per sentence, banned words still present), so the plain-English, hedging, sentence-length and banned-word rules now form a "FINAL STYLE CHECK" block at the end of `CLAUDE_ANALYSIS_SYSTEM_PROMPT` (before the request-specific allowlists), with one placeholder-only worked example and a closing reread instruction. Prompt text and position only; no validator, grounding rule or assembly order changed.
- **Step 8J — blank-section wording:** (request 28 Sep 2026) Step 8J made populated sections plain, but the text shown when a section has no content was still old analyst wording (a live replay showed "Supported market causality could not be established from the generated citation set."). Kevin asked for plain wording such as "Not enough data to produce an analysis." Text-only change to the message constants in `lib/claude-analysis-invocation.js`; no evidence, classification or validation logic changed. Wording is short, plain, and says there is too little evidence without implying a technical failure. Before → after:
  - Section 1 controlled gap: "The supplied evidence did not establish a material market driver." → "Not enough data to point to a main market driver."
  - Section 2 controlled gap: "Validated broad-market company or sector evidence was unavailable." → "Not enough data to point out specific stocks or sectors."
  - Incomplete report gap: "The generated report did not establish complete analytical coverage." → "Not enough data to cover every part of this report."
  - Active session, nothing survived: "No grounded analytical section survived validation for the active session." → "Not enough data to produce an analysis for the current session."
  - Per-section fallback (two places): "The supplied evidence did not support a reliable [SECTION] section." → "Not enough data to write the [SECTION] section."
  - causality: "Supported market causality could not be established from the generated citation set." → "Not enough data to say what moved the market."
  - referenceIntegrity: "Supported analysis could not be validated from the generated reference set." → "Not enough data to produce an analysis."
  - initiatingList: "Initiating-list support could not be validated from the generated citation set." → "Not enough data to comment on the stocks in this list."
  - sectionThreeScope: "Broad-market company and sector support could not be validated from the generated Section 3 scope." → "Not enough data to point out specific stocks or sectors."
  - opportunity: "Constructive opportunity support could not be validated from the generated citation set." → "Not enough data to point out a clear opportunity."
  - Tests: pinned strings updated in `tests/claude-analysis-invocation.test.js`, `tests/us-market-brief-quality-fixtures.test.js` and `tests/fixtures/us-market-brief-quality.js`. Suite 722/722 before and after.
  - Not changed: the package-side gap in `lib/us-analysis-package-orchestration.js` (same old Section 3 sentence, an evidence gap rather than a section message) and other package-assembly gaps (CNBC, Yahoo, Federal Reserve, telemetry). Those are outside the requested file.
- **Pending:** Preview PRE/REGULAR/POST/CLOSED live set to check readability, no new `PLAIN_LANGUAGE_VALIDATION`, and no Section 6 forward claims. Kevin's commit decision.
- **Supersedes:** none.
