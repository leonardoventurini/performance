const CASE_STATES = ['declared', 'preflighted', 'environment_ready', 'clients_ready', 'workload_running', 'fault_activated', 'converging', 'evidence_sealed', 'cleanup_verified', 'passed', 'failed', 'incomplete'] as const;
const RELEASE_STATES = ['planned', 'identity_verified', 'executing', 'aggregating', 'conformant', 'non_conformant', 'incomplete'] as const;
export type CaseExecutionState = typeof CASE_STATES[number];
export type ReleaseExecutionState = typeof RELEASE_STATES[number];
type ExecutionState<State extends string> = Readonly<{ state: State; history: readonly State[] }>;
type TransitionMap<State extends string> = Readonly<Record<string, readonly State[]>>;

const CASE_TRANSITION_ENTRIES: readonly (readonly [CaseExecutionState, readonly CaseExecutionState[]])[] = [
  ['declared', ['preflighted']],
  ['preflighted', ['environment_ready']],
  ['environment_ready', ['clients_ready']],
  ['clients_ready', ['workload_running']],
  ['workload_running', ['fault_activated', 'converging']],
  ['fault_activated', ['converging']],
  ['converging', ['evidence_sealed']],
  ['evidence_sealed', ['cleanup_verified']],
  ['cleanup_verified', ['passed', 'failed', 'incomplete']],
  ['passed', []],
  ['failed', []],
  ['incomplete', []],
];

const RELEASE_TRANSITION_ENTRIES: readonly (readonly [ReleaseExecutionState, readonly ReleaseExecutionState[]])[] = [
  ['planned', ['identity_verified']],
  ['identity_verified', ['executing']],
  ['executing', ['aggregating']],
  ['aggregating', ['conformant', 'non_conformant', 'incomplete']],
  ['conformant', []],
  ['non_conformant', []],
  ['incomplete', []],
];

function createTransitionMap<State extends string>(entries: readonly (readonly [State, readonly State[]])[]): TransitionMap<State> {
  return Object.freeze(Object.fromEntries(entries.map(([state, nextStates]) => [
    state,
    Object.freeze([...nextStates]),
  ])));
}

function assertKnownState<State extends string>(transitions: TransitionMap<State>, state: string, machineName: string): asserts state is State {
  if (!Object.hasOwn(transitions, state)) {
    throw new TypeError(`Unknown ${machineName} execution state: ${String(state)}`);
  }
}

function assertTransition<State extends string>(transitions: TransitionMap<State>, previousState: string, nextState: string, machineName: string): void {
  assertKnownState(transitions, previousState, machineName);
  assertKnownState(transitions, nextState, machineName);
  const allowedNextStates = transitions[previousState];
  if (allowedNextStates === undefined || !allowedNextStates.includes(nextState)) {
    throw new InvalidStateTransitionError(machineName, previousState, nextState);
  }
}

function createExecutionState<State extends string>(initialState: State): ExecutionState<State> {
  return Object.freeze({
    state: initialState,
    history: Object.freeze([initialState]),
  });
}

function advanceExecutionState<State extends string>(
  execution: ExecutionState<State>,
  nextState: State,
  transitions: TransitionMap<State>,
  machineName: string,
  initialState: State,
): ExecutionState<State> {
  if (
    !execution
    || typeof execution !== 'object'
    || !Array.isArray(execution.history)
    || execution.history.length === 0
    || execution.history[0] !== initialState
    || execution.history.at(-1) !== execution.state
  ) {
    throw new TypeError(
      `${machineName} execution history must begin at ${initialState} and end at its current state`,
    );
  }
  for (let index = 1; index < execution.history.length; index += 1) {
    assertTransition(
      transitions,
      execution.history[index - 1],
      execution.history[index],
      machineName,
    );
  }
  assertTransition(transitions, execution.state, nextState, machineName);
  return Object.freeze({
    state: nextState,
    history: Object.freeze([...execution.history, nextState]),
  });
}

/**
 * Error raised when an execution attempts an edge outside its frozen graph.
 */
export class InvalidStateTransitionError extends Error {
  readonly machine: string;
  readonly previousState: string;
  readonly nextState: string;
  /**
   * Creates a transition error with stable machine and state coordinates.
   */
  constructor(machine: string, previousState: string, nextState: string) {
    super(`Invalid ${machine} execution transition: ${previousState} -> ${nextState}`);
    this.name = 'InvalidStateTransitionError';
    this.machine = machine;
    this.previousState = previousState;
    this.nextState = nextState;
  }
}

/** Frozen allowed transitions for one immutable case attempt. */
export const CASE_EXECUTION_TRANSITIONS = createTransitionMap(CASE_TRANSITION_ENTRIES);

/** Frozen allowed transitions for the release-level coordinator. */
export const RELEASE_EXECUTION_TRANSITIONS = createTransitionMap(RELEASE_TRANSITION_ENTRIES);

/** Case states whose evidence cannot be replaced or advanced. */
export const CASE_TERMINAL_STATES = Object.freeze(['passed', 'failed', 'incomplete']);

/** Release states whose aggregate decision cannot be advanced. */
export const RELEASE_TERMINAL_STATES = Object.freeze([
  'conformant',
  'non_conformant',
  'incomplete',
]);

/**
 * Creates the execution record for a newly declared case attempt.
 */
export function createCaseExecution(): ExecutionState<CaseExecutionState> {
  return createExecutionState('declared');
}

/**
 * Advances a case attempt through one valid edge and returns a new record.
 */
export function advanceCaseExecution(execution: ExecutionState<CaseExecutionState>, nextState: CaseExecutionState): ExecutionState<CaseExecutionState> {
  return advanceExecutionState(
    execution,
    nextState,
    CASE_EXECUTION_TRANSITIONS,
    'case',
    'declared',
  );
}

/**
 * Asserts that a proposed case transition belongs to the frozen graph.
 */
export function assertCaseTransition(previousState: string, nextState: string): void {
  assertTransition(CASE_EXECUTION_TRANSITIONS, previousState, nextState, 'case');
}

/**
 * Creates the execution record for a planned release audit.
 */
export function createReleaseExecution(): ExecutionState<ReleaseExecutionState> {
  return createExecutionState('planned');
}

/**
 * Advances the release coordinator through one valid edge.
 */
export function advanceReleaseExecution(execution: ExecutionState<ReleaseExecutionState>, nextState: ReleaseExecutionState): ExecutionState<ReleaseExecutionState> {
  return advanceExecutionState(
    execution,
    nextState,
    RELEASE_EXECUTION_TRANSITIONS,
    'release',
    'planned',
  );
}

/**
 * Asserts that a proposed release transition belongs to the frozen graph.
 */
export function assertReleaseTransition(previousState: string, nextState: string): void {
  assertTransition(RELEASE_EXECUTION_TRANSITIONS, previousState, nextState, 'release');
}
