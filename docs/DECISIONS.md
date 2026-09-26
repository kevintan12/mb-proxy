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
