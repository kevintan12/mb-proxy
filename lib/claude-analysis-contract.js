const {MARKETS} = require('./evidence-sources');
const {validateEvidenceItem} = require('./evidence-items');
const {EVIDENCE_COLLECTION_KEYS, createEvidenceCollection} = require('./evidence-collections');
const {
  createCompletedSessionTelemetry,
  validateCompletedSessionTelemetry
} = require('./completed-session-telemetry');

const ANALYTICAL_STATUSES = Object.freeze(['NORMAL', 'DEGRADED', 'FAILED']);
const CLAUDE_ANALYSIS_INPUT_KEYS = Object.freeze(['market', 'evidence', 'completedSessions']);
const CLAUDE_EVIDENCE_REFERENCE_KEYS = Object.freeze(['reference', 'item']);
const CLAUDE_ANALYSIS_OUTPUT_KEYS = Object.freeze(['status', 'findings', 'gaps']);
const CLAUDE_FINDING_KEYS = Object.freeze(['text', 'evidenceRefs']);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}

const CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: ['status', 'findings', 'gaps'],
  properties: {
    status: {type: 'string', enum: ANALYTICAL_STATUSES.slice()},
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'evidenceRefs'],
        properties: {
          text: {type: 'string', minLength: 1, pattern: '^\\S(?:[\\s\\S]*\\S)?$'},
          evidenceRefs: {
            type: 'array',
            minItems: 1,
            items: {type: 'string', pattern: '^e[1-9][0-9]*$'}
          }
        }
      }
    },
    gaps: {
      type: 'array',
      items: {type: 'string', minLength: 1, pattern: '^\\S(?:[\\s\\S]*\\S)?$'}
    }
  },
  allOf: [
    {
      if: {properties: {status: {const: 'NORMAL'}}},
      then: {
        properties: {
          findings: {minItems: 1},
          gaps: {maxItems: 0}
        }
      }
    },
    {
      if: {properties: {status: {const: 'DEGRADED'}}},
      then: {
        properties: {
          findings: {minItems: 1},
          gaps: {minItems: 1}
        }
      }
    },
    {
      if: {properties: {status: {const: 'FAILED'}}},
      then: {
        properties: {
          findings: {maxItems: 0},
          gaps: {minItems: 1}
        }
      }
    }
  ]
});

function validateCompletedSessions(completedSessions, market) {
  if (!Array.isArray(completedSessions) || completedSessions.length > 3) return false;
  for (let index = 0; index < completedSessions.length; index++) {
    const record = completedSessions[index];
    if (!validateCompletedSessionTelemetry(record).valid || record.market !== market) return false;
    if (index > 0 && completedSessions[index - 1].sessionDate < record.sessionDate) return false;
  }
  return true;
}

function copyCompletedSessions(completedSessions) {
  return completedSessions.map(record => createCompletedSessionTelemetry({
    market: record.market,
    symbol: record.symbol,
    sessionDate: record.sessionDate,
    close: record.close,
    closeTime: record.closeTime,
    sourceId: record.sourceId
  }));
}

function createClaudeAnalysisInput({evidenceCollection, completedSessions = []} = {}) {
  if (!hasExactKeys(evidenceCollection, EVIDENCE_COLLECTION_KEYS)) {
    throw new TypeError('Invalid Claude analysis evidence collection: invalid canonical property shape or order');
  }

  const collection = createEvidenceCollection({
    market: evidenceCollection.market,
    items: evidenceCollection.items
  });
  if (collection.market !== evidenceCollection.market) {
    throw new TypeError('Invalid Claude analysis evidence collection: non-canonical market');
  }
  if (!validateCompletedSessions(completedSessions, collection.market)) {
    throw new TypeError('Invalid Claude analysis completed sessions');
  }

  return deepFreeze({
    market: collection.market,
    evidence: collection.items.map((item, index) => ({
      reference: `e${index + 1}`,
      item
    })),
    completedSessions: copyCompletedSessions(completedSessions)
  });
}

function validateAnalysisInput(input) {
  if (!hasExactKeys(input, CLAUDE_ANALYSIS_INPUT_KEYS)
      || !MARKETS.includes(input.market)
      || !Array.isArray(input.evidence)
      || !validateCompletedSessions(input.completedSessions, input.market)) return false;

  for (let index = 0; index < input.evidence.length; index++) {
    const entry = input.evidence[index];
    if (!hasExactKeys(entry, CLAUDE_EVIDENCE_REFERENCE_KEYS)
        || entry.reference !== `e${index + 1}`
        || !validateEvidenceItem(entry.item).valid
        || entry.item.market !== input.market) return false;
  }
  return true;
}

function validateClaudeAnalysisOutput(output, input) {
  const errors = [];
  if (!validateAnalysisInput(input)) {
    return deepFreeze({valid: false, errors: ['invalid canonical Claude analysis input']});
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return deepFreeze({valid: false, errors: ['Claude analysis output must be an object']});
  }
  if (!hasExactKeys(output, CLAUDE_ANALYSIS_OUTPUT_KEYS)) {
    errors.push('invalid canonical output property shape or order');
  }

  const status = output.status;
  if (!ANALYTICAL_STATUSES.includes(status)) errors.push('invalid analytical status');

  const validReferences = new Set(input.evidence.map(entry => entry.reference));
  if (!Array.isArray(output.findings)) {
    errors.push('findings must be an array');
  } else {
    for (let index = 0; index < output.findings.length; index++) {
      const finding = output.findings[index];
      if (!hasExactKeys(finding, CLAUDE_FINDING_KEYS)) {
        errors.push(`findings[${index}]: invalid property shape or order`);
        continue;
      }
      if (typeof finding.text !== 'string' || !finding.text.trim() || finding.text !== finding.text.trim()) {
        errors.push(`findings[${index}]: text must be a canonical non-empty string`);
      }
      if (!Array.isArray(finding.evidenceRefs) || finding.evidenceRefs.length === 0) {
        errors.push(`findings[${index}]: at least one evidence reference is required`);
      } else {
        for (let referenceIndex = 0; referenceIndex < finding.evidenceRefs.length; referenceIndex++) {
          const reference = finding.evidenceRefs[referenceIndex];
          if (typeof reference !== 'string' || !validReferences.has(reference)) {
            errors.push(`findings[${index}]: unknown evidence reference`);
          }
        }
      }
    }
  }

  if (!Array.isArray(output.gaps)) {
    errors.push('gaps must be an array');
  } else {
    for (let index = 0; index < output.gaps.length; index++) {
      const gap = output.gaps[index];
      if (typeof gap !== 'string' || !gap.trim() || gap !== gap.trim()) {
        errors.push(`gaps[${index}]: gap must be a canonical non-empty string`);
      }
    }
  }

  if (status === 'NORMAL') {
    if (!Array.isArray(output.findings) || output.findings.length === 0) {
      errors.push('NORMAL requires at least one supported finding');
    }
    if (!Array.isArray(output.gaps) || output.gaps.length !== 0) {
      errors.push('NORMAL must not contain unresolved gaps');
    }
  } else if (status === 'DEGRADED') {
    if (!Array.isArray(output.findings) || output.findings.length === 0) {
      errors.push('DEGRADED requires at least one supported finding');
    }
    if (!Array.isArray(output.gaps) || output.gaps.length === 0) {
      errors.push('DEGRADED requires at least one unresolved gap');
    }
  } else if (status === 'FAILED') {
    if (!Array.isArray(output.findings) || output.findings.length !== 0) {
      errors.push('FAILED must not contain analysis findings');
    }
    if (!Array.isArray(output.gaps) || output.gaps.length === 0) {
      errors.push('FAILED requires at least one failure gap');
    }
  }

  return deepFreeze({valid: errors.length === 0, errors});
}

function createClaudeAnalysisOutput(output, input) {
  const validation = validateClaudeAnalysisOutput(output, input);
  if (!validation.valid) {
    throw new TypeError(`Invalid Claude analysis output: ${validation.errors.join('; ')}`);
  }

  return deepFreeze({
    status: output.status,
    findings: output.findings.map(finding => ({
      text: finding.text,
      evidenceRefs: finding.evidenceRefs.slice()
    })),
    gaps: output.gaps.slice()
  });
}

module.exports = {
  ANALYTICAL_STATUSES,
  CLAUDE_ANALYSIS_INPUT_KEYS,
  CLAUDE_EVIDENCE_REFERENCE_KEYS,
  CLAUDE_ANALYSIS_OUTPUT_KEYS,
  CLAUDE_FINDING_KEYS,
  CLAUDE_ANALYSIS_OUTPUT_JSON_SCHEMA,
  createClaudeAnalysisInput,
  validateClaudeAnalysisOutput,
  createClaudeAnalysisOutput
};
