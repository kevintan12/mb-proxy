// Step 21D.2: the exact Section 4 text for an empty list, as the current switch gives it.
// On (default): both lists are covered, so the text names both. Off: the starting list's text.
const {EMPTY_INITIATING_LIST_CONTENT} = require('../../lib/claude-analysis-contract');
const {sectionFourBothListsOn, SECTION_FOUR_BOTH_LISTS_EMPTY_CONTENT} = require('../../lib/section-rules');

function emptySectionFour(initiatingList = 'myStocks') {
  return sectionFourBothListsOn() ? SECTION_FOUR_BOTH_LISTS_EMPTY_CONTENT
    : EMPTY_INITIATING_LIST_CONTENT[initiatingList];
}

module.exports = {emptySectionFour};
