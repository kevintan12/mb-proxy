# MarketBrief backend decisions

One entry per decision. Newest last. Never delete or rewrite an entry; supersede it with a new one.

## D-001 — Plain-English style is non-blocking (step 8)

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
  - After D-001: 707/707 tests passing (6 new tests, 2 updated), 46/46 syntax checks, `git diff --check` clean.
  - New tests:
    - `tests/claude-analysis-invocation.test.js`: T1–T3 with T8 and T9 (PRE, REGULAR and POST keep their content, references, uncertainties, gaps and Further Readings); T5 active (malformed content or uncertainty localizes only Section 6, tagged `PLAIN_LANGUAGE_VALIDATION`); T6 (UNGROUNDED_OPPORTUNITY_SUBJECT is unchanged); T7 (Section 4 follows the same policy).
    - `tests/us-market-brief-quality-fixtures.test.js`: T4 (CLOSED, WEEKEND and HOLIDAY); T5 completed (a malformed splice still causes CONTRACT_FAILURE).
  - T10 and T11: the existing Yahoo acquisition tests (three-article stop, sixth article, eight-attempt ceiling) and the completed-session tests (39da041 freshness, 14534fc CLOSED/WEEKEND/HOLIDAY, c96a132 recovery) pass unchanged.
  - Discrimination check: all 8 new or updated tests fail against the unmodified 6b40f2b code.
- **Live validation:**
  - 2026-09-26, REGULAR on Preview (generation be9d8e9f): passed. There were no `PLAIN_LANGUAGE_VALIDATION` events. `plainLanguageStyleResidue` fired for Section 7 without deleting anything. 3 Yahoo articles were admitted.
  - The same run showed a separate, pre-existing Section 3 and number-accuracy issue, recorded as D-002. It is not a D-001 regression.
- **Pending:** PRE and POST live runs on Preview, then Kevin's decision on promotion to `main`.
- **Supersedes:** none.

## D-002 — Section 3 blanking and unchecked numbers (record only)

- **Date:** 2026-09-26 · **Branch:** step-8-runtime-cost · **Status:** RECORDED, not fixed. Deferred to the Market Brief pipeline redesign.
- **Context:**
  - **Section 3 blanked:** in the 26 Sep REGULAR Preview run (generation be9d8e9f), the older `NON_BENCHMARK_TELEMETRY` rule blanked Section 3 because it cited portfolio stock telemetry (6 of 10 refs offending).
  - **Further Readings lost:** blanking Section 3 also dropped 2 of 3 Further Readings links, because Further Readings derive only from surviving cited sections.
  - **Wrong number:** Section 5 stated an index move incorrectly (NASDAQ 0.45% vs actual 0.53%), and no check caught it.
  - **Not new:** both behaviors are pre-existing in Production and are not caused by D-001.
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

## D-003 — Development process setup (repo: both)

- **Date:** 2026-09-26 · **Branch:** MarketBrief `step-8-runtime-cost` (610fa07) / mb-proxy `main` · **Status:** POLICY
- **Intent:** Establish a repeatable, auditable development workflow that keeps Kevin in control of every commit while documenting all decisions in one place. Protect both repos from accidental or surprise changes.
- **Decision:**
  - **Git commands:** Kevin runs every git command that changes either repo (commit, push, merge, rebase, reset, checkout, tag, stash, branch create/delete, etc.) himself in Git Bash. Claude Code provides exact copy-paste command blocks (starting with `cd` and `git branch --show-current`) with expected output, but never executes them. Read-only commands (status, log, diff, show, rev-parse, etc.) are allowed.
  - **Shared decision log:** the single authoritative decision log for both MarketBrief and mb-proxy is `mb-proxy/docs/DECISIONS.md`. Claude Code reads it at the start of each session and logs each request there, tagged `repo: MarketBrief` or `repo: mb-proxy` (or `repo: both`), with its intent, what must not change, and rejected options.
  - **Permission mode:** Claude Code runs in Manual mode by default (approvals required for all tool use). Accept edits only temporarily for approved work. Auto/Bypass modes are never used. Intent: nothing changes without Kevin's deliberate approval.
  - **Node modules:** `node_modules/` is excluded from Dropbox sync in both repos. Intent: Dropbox file locks prevent npm installs.
- **Baseline state (26 Sep 2026):**
  - MarketBrief `main` @ 610fa07: 130/130 tests passing, 14/14 syntax checks passing, `git diff --check` clean. Visible version `v2.20260921.25.F`, release commit `be5df88`.
  - mb-proxy `main` @ 4127b19: D-001 committed on Preview; baseline pre-D-001 was 701/701 tests passing, 46/46 syntax checks.
- **Must not change:** the rule that Kevin runs all repo-changing git commands himself. All other rules may be superseded if circumstances change.
- **Rejected options:** having Claude Code auto-commit or push; logging decisions in separate files per repo; allowing Auto/Bypass modes.
- **Supersedes:** none.

## D-005 — CLOSED brief fails when Yahoo daily rows lag after the close (repo: mb-proxy)

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

## D-006 — Implement D-005 Fix A: make Yahoo completed-session recovery work on real data (repo: mb-proxy)

- **Date:** 2026-09-26 · **Branch:** step-8-runtime-cost · **Status:** IMPLEMENTED, tests and read-only live replay passing; not yet committed.
- **Context:** D-005 diagnosed three mismatches between `normalizeIntradaySession`'s assumptions and Yahoo's real 1-minute data: (1) Yahoo sends a 391st bar stamped exactly at the close, with O=H=L=C equal to the official close, which the old code rejected outright (`OUTSIDE_EXPECTED_SESSION`); (2) thinly traded symbols have no-trade minutes where every field is null, which the old code rejected (`INVALID_INTRADAY_OHLC`); (3) daily-row open/high/low differ from the intraday bar by a small amount (opening auction vs. first trade), which the old exact-match reconciliation rejected (`DAILY_INTRADAY_OHLC_CONFLICT`) even for indices' near-identical values.
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
  - Exact-match reconciliation (status quo): rejects real Yahoo data for both stocks and indices, per D-005's live findings.
- **Implementation:** `lib/yahoo-telemetry-acquisition.js` only — `normalizeIntradaySession` rewritten (closing print, no-trade minutes); new `reconcileDailyWithIntraday` helper and `DAILY_INTRADAY_TOLERANCE` constant, called from both `applyLatestCompletedCloseFallback` branches (expected-date row and preceding-date row).
- **Evidence/tests:**
  - `tests/yahoo-telemetry-acquisition.test.js`: `intradayResponseFor` now defaults to the real 391-bar shape (390 regular minutes + one closing print, defaulting to the same close as the regular bars so all pre-existing assertions hold unchanged); new options `closingPrint`, `closingClose`, `noTradeMinutes`, `extraBarAfterClose`, `sessionContext`. All 23 pre-existing tests in this file pass unmodified against the real shape.
  - 11 new tests: real-shape recovery uses the closing print's close, not the 15:59 bar (and cross-checked its high/low from it); missing closing print → `MISSING_FINAL_REGULAR_OBSERVATION`; a bar after the closing print → `OUTSIDE_EXPECTED_SESSION`; no-trade minutes accepted and excluded from high/low while still counted for coverage; a partially-null bar and a no-trade opening bar → `INVALID_INTRADAY_OHLC`; a partial daily row (O/H/L present, close null) recovers for a US equity (AAPL); tolerance boundary tests (±0.05% recovers and keeps the daily value, ±0.2% conflicts) for open/high/low on both the expected-date and preceding-date paths; an early-close scenario (session close time-driven, not hardcoded 16:00, tested via `getSessionContext` dependency injection since the exchange calendar deliberately has no supported real early-close date — see Note); the three pre-existing exact-magnitude conflict cases (open 100 vs 101, low 0, close 0) still conflict unchanged.
  - Discrimination check: all 14 tests that exercise the new/changed behavior fail against the unmodified 970521a code (verified in a scratch copy).
  - Full suite: 718/718 passing (707 baseline + 11 new). Syntax: 46/46. `git diff --check`: clean.
  - **Read-only live replay** (no code/env changes, no paid calls): real Yahoo daily data for 16 symbols (MSFT, NVDA, VOO, CPRI, CPRT, VEEV, VRSK, AAPL, UNH, NVO, SPYM, CRM, ^GSPC, ^DJI, ^IXIC, ^RUT) fetched live, with the 2026-09-25 row artificially degraded two ways (close-only null; all of open/high/low/close/volume null) before being handed to the service; the 1-minute intraday requests were real, live Yahoo calls. All 32 runs (16 symbols × 2 variants) recovered `SUCCESS` with `primaryCompletedSessionDate = 2026-09-25` and a close matching Yahoo's real (undegraded) daily close exactly, cross-verified directly against the live API for MSFT (516.1699829101562) and VRSK (169.2100067138672).
  - **Round 2 (UNH, NVO, SPYM, CRM), including the daily-vs-intraday gap:** all 8 runs (4 symbols × 2 variants) `SUCCESS`, `recoveredClose` equal to the real undegraded daily close in every case (UNH 376.5899963378906; NVO 38.79999923706055; SPYM 90.80000305175781; CRM 234.02000427246094). Largest daily-vs-intraday open/high/low gap per symbol: UNH 0.0000%, NVO 0.0000%, SPYM 0.0048% (high), CRM 0.0000% — all far inside the 0.1% tolerance (nearest case at ~5% of the tolerance's width, not 80%). No symbol failed and none came within 0.08% of the tolerance boundary, so `DAILY_INTRADAY_TOLERANCE` was left unchanged.
- **Note:** the full 15-symbol My Stocks/Watchlist list from the 25 Sep failure was not available to this session; the replay used the 7 stocks and index named in D-005's findings, plus AAPL, UNH, NVO, SPYM and CRM (12 stocks, 4 indices = 16 of the 15+4 likely list). Kevin may want any still-missing symbols re-run before promotion.
- **Open questions (unresolved from D-005, still open):** how long Yahoo equity daily rows stay incomplete after the close; the exact wording of a Fix B statement (not implemented — Fix A alone resolved the 25 Sep failure without needing Fix B, since recovery now succeeds); whether Fix B should also apply when data is present but stale.
- **Pending:** Kevin's commit decision; a live CLOSED Preview run soon after 20:00 ET (08:00 SGT on a weekday) to confirm in production-shaped conditions.
- **Supersedes:** none (extends D-005's diagnosis with the approved fix; D-005 is left unedited).

## Step 8K.1 — Drop clearly unrelated active Yahoo candidates before fetching (repo: mb-proxy)

- **Request:** add a relevance floor to the active-session (PRE/REGULAR/POST) Yahoo candidate selection built in Step 8K (dd57d1b).
- **Kevin's reason:** the quality of Pre-Market and After-Hours analysis is the key of the project. On 28 Sep 2026 three PRE runs admitted clearly unrelated articles (a Sydney data centre, Singapore stocks, retirement age), which blocked good sections.
- **Previous decision:** Step 8K ranked candidates by US-market relevance and chose that **no candidate is dropped**. This reverses that choice **only for tier 4a**.
- **Decision:**
  - Tier 4 is split. **4a (dropped before fetching):** headlines with no tier 1 or tier 2 signal that match Singapore, STI, ASX, Australia, Australian, Hong Kong, Hang Seng, Nikkei, FTSE, Malaysia, Indonesia, retire, retirement, mortgage, credit card, savings account, how to. **4b (kept, ranked last):** China and India headlines, since items such as "China May Reopen Nvidia's AI Market" are US-relevant. Tier 3 (neutral) is not dropped. A headline matching both a 4a and a 4b term is dropped.
  - Dropped candidates are never fetched and use no fetch attempts. The 8-attempt and 3-admitted caps are unchanged.
  - They stay in `activeYahooCandidateAudit` (listed after all fetchable candidates, tier 4) with decision `SKIPPED_BELOW_RELEVANCE_FLOOR`. The log line and fields are unchanged.
  - If nothing fetchable remains, behaviour is unchanged: classification skipped, `ACTIVE_YAHOO_NEWS_UNAVAILABLE_GAP` added, one Claude call with the limited-evidence instruction, report DEGRADED. `noCurrentSessionEvidenceOutput` is untouched.
- **Must not change:** the CNBC completed-session path (138af60); the 8-attempt and 3-admitted caps; prompts.
- **Deferred:** rejecting an article after fetch on a non-US exchange tag is not added.
- **Implementation:** `lib/us-analysis-package-orchestration.js` (`activeYahooCandidateTier`, `selectedActiveYahooCandidates`, the fetch loop skips dropped entries).
- **Evidence/tests:** `tests/us-analysis-package-orchestration.test.js`: the Step 8K "never dropped" test is inverted; the real-headlines test now expects the non-US and lifestyle items skipped; new tests cover 4a dropped and not fetched, 4b kept and ranked last, tier 3 kept, all-dropped takes the limited path, and the attempt cap unchanged.
- **Amendment (Step 8K.1 correction, 28 Sep 2026):**
  - **Kevin's reason:** China and other Asian or European market headlines can affect US markets, and the Pre-Market focus (Step 21G) includes what happened in Asia and Europe overnight. The first Step 8K.1 build dropped a headline on any 4a match, even one that also named China or India, and dropped Hong Kong, Hang Seng, Nikkei and FTSE headlines.
  - **4b (kept, ranked last) is now:** China, India, Hong Kong, Hang Seng, Nikkei, FTSE. A 4b match wins over a 4a match in the same headline.
  - **4a (dropped before fetching) is now only:** Singapore, STI, ASX, Australia, Australian, Malaysia, Indonesia, retire, retirement, mortgage, credit card, savings account, and "how to" at the start of the headline.
  - **Matching:** whole words only, case-insensitive, so "stimulus" and "investing" never match STI. "how to" counts only at the start, so "Investors weigh how to respond" is kept.
  - Tier 1 and tier 2 signals still win first. Caps, audit fields, the log line and the empty-result path are unchanged. This replaces the term lists above; the rest of the Step 8K.1 decision stands.
- **Amendment (Step 8K.1 correction #2, 29 Sep 2026):**
  - **Kevin's reason:** a live POST run fetched 3 articles (of 24 candidates) that were all irrelevant to his portfolio and to the indices (SoFi/Mastercard, GE/Kratos, a biotech trial), because tier 3 (neutral, no red-flag match) had no positive relevance test and was ordered by page position only, blanking 5 sections.
  - **Decision:** tier 3 is split. **3a (kept, ranked above 4b):** a headline with no tier 1, tier 2, 4a or 4b signal that names a benchmark index not already in the tier 2 macro list, or a broad market/macro term — S&P, Russell, "stocks", "shares fall", "shares rise", "trading day", "market". **3b (kept, ranked last, below 4b):** no such signal — today's tier 3 catch-all becomes 3b. Matching uses headline text only, same as the existing tiers.
  - **Final order:** tier 1, tier 2, tier 3a, tier 4b, tier 3b. Tier 4a stays dropped, unfetched. A 4a or 4b match still wins over a 3a signal in the same headline (checked first, unchanged from the correction above), so a headline like "Singapore stocks rally" is still dropped.
  - `ACTIVE_YAHOO_MAX_ADMITTED_ARTICLES` raised from 3 to 6. `ACTIVE_YAHOO_MAX_ARTICLE_ATTEMPTS` stays 8.
  - The candidate audit now records a `subTier` ('3a'/'3b'/'4a'/'4b'/null) alongside the existing `tier` field for every candidate.
  - **Implementation:** `lib/us-analysis-package-orchestration.js` (`ACTIVE_YAHOO_TIER_3A_PATTERNS`, `activeYahooCandidateTier`, `selectedActiveYahooCandidates`, `ACTIVE_YAHOO_MAX_ADMITTED_ARTICLES`).
  - **Evidence/tests:** `tests/us-analysis-package-orchestration.test.js`: existing tier assertions updated for the new tier 3b number (5) and the 4b-before-3b order; new tests cover 3a ranked above 4b, 3b ranked last below 4b, a drop term still winning over a bare 3a word, the six-admission cap, and the audit's `subTier` field.

## Step 8K.2 — Close-anchored active-session window plus item-age field (repo: mb-proxy)

- **Request:** the active-session (PRE/REGULAR/POST) evidence window started at a fixed 04:00 ET same-day boundary. An early-PRE run (16:16 SGT = 04:16 ET) had only 16 minutes of admissible news, and weekend/holiday news was rejected as before-window even though nothing happened between the prior close and 04:00.
- **Kevin's reason:** the quality of Pre-Market and After-Hours analysis is the key of the project. His Pre-Market focus (Step 21G) is: where we left off, what changed since the close, and what is happening now — which needs the window to start at the previous close, not an arbitrary clock time.
- **Decision:**
  - `createUsActiveSessionAnchor` (`lib/us-active-session-evidence.js`) now anchors the window start to a regular close instead of the 04:00 ET PRE-session start: **PRE and REGULAR** start at the **previous trading day's** regular close (so a REGULAR run at 10:00 ET does not lose the weekend/overnight news that a PRE run at 09:00 already had); **POST** starts at **today's own** regular close. Weekend/holiday (CLOSED/WEEKEND/HOLIDAY) generation is unaffected — it never reaches this path, since `marketState` must already be PRE/REGULAR/POST and match the canonical current session.
  - The previous trading day's close is found by a new `findPreviousTradingDayClose` helper that walks the calendar backward one date at a time via `getSessionContext({market, exchangeDate})` (no `instant` needed, since that already yields `regularCloseTime`/`tradingDay`/`calendarSupported` for a bare date), skipping any day that is not `calendarSupported && tradingDay`. This uniformly skips weekends, full holidays, **and** `UNSUPPORTED_SPECIAL_SESSION_DATES` early-close days (e.g. Black Friday) whose exact close time this checkpoint deliberately does not model — it widens the window further back rather than fabricating a close time, and gives up (anchor unavailable) only after a bounded 10-day lookback.
  - The anchor prefix is bumped from `US_ACTIVE_SESSION_V1:` to `US_ACTIVE_SESSION_V2:`. `serializeUsActiveSessionAnchor` always emits V2. `parseUsActiveSessionAnchor` still accepts a `US_ACTIVE_SESSION_V1:` anchor and replays it with the OLD (04:00 ET session-start) window math, via an internal, unexported `legacyCreateUsActiveSessionAnchorV1`/`legacySerializeUsActiveSessionAnchorV1` pair kept only for that purpose. A V1 anchor is never reinterpreted under the new close-anchored rule.
  - `lib/claude-model-input-projection.js` adds `ageHoursAtGeneration` (hours between `publishedAt` and package generation time, rounded to one decimal) to each current-session evidence item's projection only; no other projected field changed.
  - `lib/claude-analysis-invocation.js` adds one prompt sentence: "Items with ageHoursAtGeneration above 12 are overnight background from before the session, not fresh news; do not present them as new."
  - The classifier's own limits (50 items, 64 KB) and the fetch budget (`ACTIVE_YAHOO_MAX_ARTICLE_ATTEMPTS = 8`, `ACTIVE_YAHOO_MAX_ADMITTED_ARTICLES = 6`) are unchanged.
- **What was rejected:**
  - Reinterpreting old `US_ACTIVE_SESSION_V1` anchors under the new close-anchored window: rejected so a previously saved Replay Package still replays to the exact same evidence set it originally produced.
  - Failing closed outright when the previous calendar day is an early-close/unsupported-special-session date: rejected as needlessly fragile — the walk-back instead treats it like a holiday and widens the window to the last fully-modeled close, which only ever makes the window larger, never fabricates a close time.
- **V1 compatibility:** every anchor-string validator in the repo (`lib/claude-analysis-contract.js` build-time creation check and validation check; `lib/us-analysis-package-orchestration.js` new-anchor creation) goes through `parseUsActiveSessionAnchor`/`createUsActiveSessionAnchor`/`serializeUsActiveSessionAnchor`, so all of them are version-agnostic automatically — no changes were needed outside `lib/us-active-session-evidence.js`. Both V1 and V2 anchors parse to the same shape (`marketState`, `sessionDate`, `startsAtInclusive`, `endsAtInclusive`), so downstream code never needs to know which version it received.
- **Frontend finding:** `MarketBrief/claude-analysis.js` (`isCanonicalMarketBriefEnvelope`/`isCanonicalMarketPackage`) checks only that `calendarContext` is present via an exact-keys check; it never inspects the anchor string's prefix or contents. **No frontend change is needed for this step.** (Read-only check; the frontend repo was not edited.)
- **Must not change:** the CNBC completed-session path (138af60), unaffected — this step touches only the US active-session (PRE/REGULAR/POST) Yahoo evidence path; the classifier's 50-item/64 KB limits and the 8-attempt/6-admitted fetch budget; Section 6/7 grounding rules; one Anthropic request per generation with no retry.
- **Implementation:** `lib/us-active-session-evidence.js` (window/anchor rewrite, V1/V2 versioning), `lib/claude-model-input-projection.js` (`ageHoursAtGeneration`), `lib/claude-analysis-invocation.js` (prompt sentence).
- **Evidence/tests:** `tests/us-active-session-evidence.test.js` — existing window-derivation, DST-boundary and REGULAR-boundary tests updated for close-anchored start values; new tests cover PRE on an ordinary Monday, PRE after a Monday holiday, POST anchored to today's close, REGULAR anchored to the previous close, an early-close day widening the window past Black Friday and Thanksgiving to the last modeled close, V2 always produced for new anchors, a saved V1 anchor replaying its original narrower window unchanged, and a tampered V1 anchor failing closed. `tests/us-analysis-package-orchestration.test.js` — the Step 8K candidate-audit window-boundary assertions and the before/after-window rejection fixture updated for the wider window; the bounded-active-Yahoo-acquisition test's fixed publication time is now per-market-state so POST's narrower (today-only) window still admits its candidates; the stale/future Yahoo news test's "stale" fixture moved earlier so it stays genuinely before the new (wider) window. `tests/claude-analysis-invocation.test.js` — new tests assert `ageHoursAtGeneration` is present (and rounded correctly) only on current-session evidence, and that the new prompt sentence appears in the built request exactly once. `tests/claude-evidence-role-classification.test.js` — new test builds a synthetic worst-case package of six max-size (512-byte headline, 8192-byte article-text) admitted current-session articles and asserts the classifier request stays under the 64 KB limit (measured ~55 KB, ~10 KB of headroom). Full suite: 743 baseline, report the new total after this entry is committed.

## Step 8K.3 — Add the US edition of Yahoo Finance as a second candidate source (repo: mb-proxy)

- **Request:** active-session (PRE/REGULAR/POST) candidate discovery read only the Singapore edition page, a global wire stream. A live PRE run admitted 3 of 25 candidates, none about US stocks (Senegal debt, a French inspection company broker note, Canada GDP), so most sections came back empty.
- **Kevin's reason:** the quality of Pre-Market and After-Hours analysis is the key of the project. The US edition surfaces US market drivers (yields, Nvidia, IPOs, earnings) that the Singapore stream mostly does not.
- **Decision:**
  - Discovery now also reads `https://finance.yahoo.com/topic/stock-market-news/` (the US `/topic/latestnews/` page returns 404). Both pages are fetched in parallel. The Singapore page and its parser are unchanged.
  - **US parser:** any `story-item` section with `yContentType=story` whose link is on `finance.yahoo.com` and matches the path shapes the article fetcher already accepts (`/news/<slug>.html` or `/<1-3 segments>/articles/<slug>.html`). It does not depend on module names, sub-module ids or section paths. Ads and sponsored items are dropped as before. Read live on 29 Sep 2026: 48 sections in two modules (`topic-content-module`, `ai-topic-stream`), none of which the Singapore `topic-stream` filter matched.
  - **Bounds for the US page only:** response cap 2 MiB (the page is about 1.3 MB, over the 1 MiB Singapore cap) and a 6 s timeout. **US extraction cap is 60** (raised from 30 in the same step, see the amendment below); the Singapore cap stays 30.
  - **Merge:** US first, then Singapore. A Singapore entry is dropped when it matches a US entry by canonical URL, then UUID, then trailing numeric id (6+ digits), then normalized headline (lower-case letters and digits, 12+ characters). The US entry is kept. The merged list is capped at **90** after de-duplication (60 US + 30 Singapore), so the merge can never cut a US item; if a smaller cap were ever configured, Singapore entries are cut first.
  - **Fallback:** if the US page fails, times out, is oversized, is not HTML, or yields zero usable items, the result is the Singapore-only list (same candidates as before, plus an `edition` tag). If Singapore fails and US works, US alone is used. If both fail, the list is empty and the existing limited-evidence path runs. A 200 page that has sections but no accepted story is reported as `SHAPE_CHANGED`.
  - **Diagnostics and audit:** every candidate audit entry carries `edition` (`US`, `SG`, or null). The `activeYahooAcquisition` diagnostic adds `usNewsOutcome`, `usNewsSectionCount`, `usNewsCandidateCount`, `singaporeNewsCandidateCount` and `crossEditionDuplicateCount`. The audit event splitter (10 candidates and 3400 bytes per event) is unchanged and a test covers 90 worst-case entries (about 9 events).
- **Must not change:** the 8-attempt and 6-admitted caps; one Anthropic request per generation; tiers 1, 2, 3a, 4b, 3b and the 4a drop list; the CNBC completed-session path (138af60); V1 and V2 active-session anchors and V1 replay; Neon storage; `sg.news.yahoo.com` links stay dropped, as before.
- **Known limits:**
  - No known cap limit for US items: the caps are sized with headroom over the live page (see the amendment).
  - Singular `/article/` and `/live/` URLs (mostly Yahoo Finance originals, about 8 of 48 items on 29 Sep) are not accepted by the article fetcher, so they are dropped at discovery and never fetched.
- **Step 8K.5 (follow-up, not built):** (1) widen the article fetcher to the singular `/article/` and `/live/` page styles, after checking those pages carry the same article metadata; (2) use the relative-time labels on the page ("58m ago", "1d ago") for ranking. Both were explicitly left out of Step 8K.3.
- **Implementation:** `lib/yahoo-latest-news-discovery.js` (`createYahooUsMarketNewsDiscoveryService`, `createYahooMultiEditionNewsDiscoveryService`, shared page fetch), `lib/analysis-package-runtime.js` (uses the merged service), `lib/us-analysis-package-orchestration.js` (audit `edition`, diagnostic counts).
- **Evidence/tests:** `tests/yahoo-latest-news-discovery.test.js` (11 new tests: US parser accepts any module and only fetcher path shapes, `SHAPE_CHANGED`, US size bound, parallel fetch, US-first merge, de-duplication by URL/UUID/numeric id/headline, short-headline guard, cap behaviour (see the amendment), six fallback cases matching the Singapore-only result, throwing US service, one-edition-down cases); `tests/us-analysis-package-orchestration.test.js` (3 new tests: audit `edition` and diagnostic counts, missing metadata, 90 worst-case audit entries within the byte budget); `tests/analysis-package-runtime.test.js` (composition name updated). Read-only replay of the saved live pages through the new parser: 48 US sections, 30 accepted, 22 Singapore, 1 cross-edition duplicate, 40 merged (before the amendment). No paid calls.
- **Amendment (Step 8K.3 caps, 29 Sep 2026):**
  - **Kevin's reason:** the US cap of 30 kept the first 30 items in page order. The live page lists its curated storyline items first and its fresher `ai-topic-stream` items last, so the freshest items could be cut before tiering. Every usable US item must reach tiering.
  - **Decision:** US extraction cap 30 -> **60**, merged post-dedupe cap 40 -> **90** (60 US + 30 Singapore, so the merge never cuts a US item; the merge still puts US first and would cut Singapore first). The Singapore cap stays 30. The 48-section live page has headroom of 12 sections.
  - **Unchanged:** 8 fetch attempts, 6 admitted articles, one Anthropic request per generation. More candidates only means more headlines for tiering; only up to 8 articles are fetched, so cost and article-fetch time do not change.
  - **Audit budget:** up to 90 entries need about 9 audit events (10 candidates and 3400 bytes per event), up from 3 today. Those events are extra log lines within the 1-hour log retention; the audit must still be read within the hour. A test checks 90 worst-case entries stay inside the per-event byte budget with every rank present.
  - **Measured on the saved 29 Sep pages (read-only replay):** 48 US sections, 40 accepted (the other 8 are singular `/article/` or `/live/` links, Step 8K.5), 22 Singapore, 1 cross-edition duplicate, 61 merged, with the last US items present.
  - **Tests:** `tests/yahoo-latest-news-discovery.test.js` replaces the 40-cap test with a 48-section page reaching the list in full, the 60/30/90 caps, and Singapore-cut-first under a smaller merged cap; `tests/us-analysis-package-orchestration.test.js` audit-budget test now uses 90 entries.
