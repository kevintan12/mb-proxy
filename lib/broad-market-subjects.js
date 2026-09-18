const GENERIC_BROAD_MARKET_SUBJECT = /^(?:the )?(?:(?:u s|us|united states|global) )?(?:stocks?|equities|stock market|equity market|markets?|broad market|broader market|major averages|indexes|indices|market update|market news|market commentary|market leadership|market leaders?|market laggards?|market movers?|notable movers?|stock stories|wall street)$/;
const BROAD_INDEX_SUBJECT = /^(?:the )?(?:s and p(?: 500)?|s p(?: 500)?|standard and poor s 500|nasdaq(?: composite| 100)?|dow(?: jones(?: industrial average)?)?|djia|russell(?: 1000| 2000| 3000)?)(?: index)?$/;

function isSpecificBroadMarketSubject(subject) {
  if (!subject || typeof subject.name !== 'string') return false;
  const normalized = subject.name.normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized !== ''
    && !GENERIC_BROAD_MARKET_SUBJECT.test(normalized)
    && !BROAD_INDEX_SUBJECT.test(normalized);
}

module.exports = {isSpecificBroadMarketSubject};
