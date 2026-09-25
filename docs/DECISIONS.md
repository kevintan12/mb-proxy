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
