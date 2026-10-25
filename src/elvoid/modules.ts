/**
 * The ELVOID module registry: the single source of truth for what each analytical
 * capability will take in, put out and refuse. `docs/ELVOID-MODULES.md` is generated from
 * this file (`npm run docs:gen`) and a test fails if the two drift apart.
 *
 * Status is deliberately strict:
 *  - `not-implemented`: nothing exists beyond this entry.
 *  - `contract-only`: a TypeScript contract exists in the repository (types and, where noted,
 *    validation), but no analytical logic does.
 *  - `implemented`: runs, has tests, and is covered by documented error states.
 * In Phase 1 only market data normalization is `implemented` (it is the data layer every other
 * module would read from, and it runs in production). No analytical module exists, and the UI
 * says how many of the thirteen are implemented.
 *
 * Adding a module means adding an entry here first. It must name its inputs, outputs and
 * error states before any code is written for it.
 */

export type ModuleStatus = 'not-implemented' | 'contract-only' | 'implemented';

export interface ElvoidModuleSpec {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly errorStates: readonly string[];
  readonly status: ModuleStatus;
  /** Repository paths of the contract that exists today, or null. */
  readonly contract: string | null;
}

export const MODULE_STATUS_LABEL: Readonly<Record<ModuleStatus, string>> = {
  'not-implemented': 'NOT IMPLEMENTED',
  'contract-only': 'CONTRACT ONLY',
  implemented: 'IMPLEMENTED',
};

/** What each status promises. Shown in the generated module documentation. */
export const MODULE_STATUS_MEANING: Readonly<Record<ModuleStatus, string>> = {
  'not-implemented': 'Nothing exists beyond the entry in this registry.',
  'contract-only':
    'A TypeScript contract exists in the repository (types and, where noted, validation), but no analytical logic does.',
  implemented: 'It runs, has tests, and is covered by documented error states.',
};

export const ELVOID_MODULES: readonly ElvoidModuleSpec[] = [
  {
    id: 'market-data-normalization',
    name: 'Market data normalization',
    purpose:
      'Turn vendor payloads into validated quotes, candles and depth, each with an honest data state.',
    inputs: [
      'Provider quote, candle and depth payloads',
      'Source mode declaration (live or delayed)',
    ],
    outputs: [
      'Quote, CandleSeries and DepthResult',
      'Data state per datum: LIVE, DELAYED, STALE or UNAVAILABLE',
    ],
    errorStates: [
      'Invalid, crossed or unsorted data is rejected, never repaired',
      'A series for the wrong instrument or timeframe is rejected',
      'Provider unreachable or timed out',
    ],
    status: 'implemented',
    contract: 'src/data/provider.ts, src/data/validate.ts, src/data/service.ts',
  },
  {
    id: 'technical-analysis',
    name: 'Technical analysis',
    purpose: 'Describe price structure and indicator readings with stated parameters.',
    inputs: ['Validated CandleSeries (live or delayed only)'],
    outputs: ['Evidence of kind technical, with indicator definitions and parameters'],
    errorStates: ['Too few bars for the stated method', 'Data state not eligible for analysis'],
    status: 'not-implemented',
    contract: null,
  },
  {
    id: 'macro-analysis',
    name: 'Macro analysis',
    purpose: "Relate scheduled releases and policy settings to a currency's outlook.",
    inputs: [
      'CalendarEvent list with source attribution and classified impact',
      'Policy-rate and inflation series (provider required)',
    ],
    outputs: ['Evidence of kind macro', 'Macro context section with evidence references'],
    errorStates: [
      'Event without source attribution is rejected',
      'Impact claimed without a classification is rejected',
      'Series older than its stated freshness limit',
    ],
    status: 'not-implemented',
    contract: null,
  },
  {
    id: 'news-interpretation',
    name: 'News interpretation',
    purpose: 'Read attributed news items and state their relevance to the selected instrument.',
    inputs: ['NewsItem list with source attribution'],
    outputs: ['Evidence of kind news', 'Interpretation text attributed to the item it came from'],
    errorStates: [
      'Unattributed item is rejected',
      'Syndicated copies of one story are not counted as independent evidence',
    ],
    status: 'not-implemented',
    contract: null,
  },
  {
    id: 'cross-asset-relationships',
    name: 'Cross-asset relationships',
    purpose: 'Measure how the selected instrument relates to other instruments, rates and indices.',
    inputs: [
      'Time-aligned series for several instruments',
      'Rates and index series (provider required)',
    ],
    outputs: ['Evidence of kind cross-asset, with window length and method stated'],
    errorStates: ['Series not time-aligned', 'Window too short for the stated method'],
    status: 'not-implemented',
    contract: null,
  },
  {
    id: 'volatility-liquidity',
    name: 'Volatility and liquidity analysis',
    purpose: 'Interpret implied volatility and venue-level depth without generalizing either.',
    inputs: ['VolSurface with a stated strike axis', 'DepthSnapshot naming its venue'],
    outputs: ['Evidence of kind volatility or liquidity, scoped to the named source or venue'],
    errorStates: [
      'Surface fails validation',
      'Book is crossed or one-sided',
      'Venue depth presented as market-wide is rejected',
    ],
    status: 'contract-only',
    contract: 'src/data/options.ts, src/data/depth.ts',
  },
  {
    id: 'hypothesis-generation',
    name: 'Hypothesis generation',
    purpose:
      'Propose explanations for observed price behavior that can be tested against evidence.',
    inputs: ['Evidence set'],
    outputs: ['Candidate hypotheses, each naming the evidence that would confirm or refute it'],
    errorStates: ['A hypothesis with no refutation condition is rejected'],
    status: 'not-implemented',
    contract: null,
  },
  {
    id: 'scenario-comparison',
    name: 'Scenario comparison',
    purpose: 'Set bullish and bearish scenarios side by side with what would invalidate each.',
    inputs: ['Hypotheses', 'Evidence set'],
    outputs: [
      'Bullish and bearish Scenario, each with evidence references',
      'Invalidation conditions and risk factors',
    ],
    errorStates: [
      'A scenario references unknown evidence',
      'A conclusion without invalidation conditions',
    ],
    status: 'contract-only',
    contract: 'src/elvoid/contracts.ts, src/elvoid/validate-result.ts',
  },
  {
    id: 'backtesting',
    name: 'Backtesting',
    purpose: 'Test a versioned strategy definition against historical data.',
    inputs: ['Versioned strategy definition', 'Historical data with stated source and period'],
    outputs: [
      'A report stating data range, cost assumptions and parameters, produced only by a real run',
    ],
    errorStates: ['Look-ahead detected', 'Insufficient history', 'Cost assumptions not stated'],
    status: 'not-implemented',
    contract: null,
  },
  {
    id: 'performance-evaluation',
    name: 'Performance evaluation',
    purpose: 'Compare past analyses with what subsequently happened.',
    inputs: ['Decision log', 'Realized outcomes'],
    outputs: ['An evaluation report that states its sample size'],
    errorStates: ['Sample too small to report', 'Outcomes missing for logged decisions'],
    status: 'not-implemented',
    contract: null,
  },
  {
    id: 'controlled-improvement',
    name: 'Controlled improvement',
    purpose:
      'Move a proposed change through testing, evaluation and human approval. ELVOID never changes itself.',
    inputs: ['Evaluation reports', 'A proposed change with from and to versions'],
    outputs: [
      'A ChangeProposal moving proposed, testing, evaluated, approved, released, with full history',
    ],
    errorStates: [
      'A stage is skipped',
      'Approval or release by anything other than a person',
      'Release without a recorded human approval',
      'Any change to a rejected or released proposal',
    ],
    status: 'contract-only',
    contract: 'src/elvoid/improvement.ts',
  },
  {
    id: 'decision-logging',
    name: 'Decision logging',
    purpose:
      'Keep an append-only record of what ELVOID concluded, from what, and under which version.',
    inputs: ['AnalysisResult', 'Operator action'],
    outputs: ['Append-only decision record with engine version and evidence references'],
    errorStates: [
      'A failed write is surfaced, never dropped',
      'Editing a record after the fact is rejected',
    ],
    status: 'not-implemented',
    contract: null,
  },
  {
    id: 'notification-events',
    name: 'Notification events',
    purpose:
      'Emit events for decisions and data conditions; delivery channels come in a later phase.',
    inputs: ['Decision records', 'User notification rules'],
    outputs: ['Notification event payloads'],
    errorStates: ['A failed delivery is surfaced', 'Duplicate events are suppressed'],
    status: 'not-implemented',
    contract: null,
  },
];

export function countImplemented(modules: readonly ElvoidModuleSpec[] = ELVOID_MODULES): number {
  return modules.filter((module) => module.status === 'implemented').length;
}
