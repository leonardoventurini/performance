const CASE_TRANSITION_ENTRIES = [
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

const RELEASE_TRANSITION_ENTRIES = [
  ['planned', ['identity_verified']],
  ['identity_verified', ['executing']],
  ['executing', ['aggregating']],
  ['aggregating', ['conformant', 'non_conformant', 'incomplete']],
  ['conformant', []],
  ['non_conformant', []],
  ['incomplete', []],
];

function createTransitionMap(entries) {
  return Object.freeze(Object.fromEntries(entries.map(([state, nextStates]) => [
    state,
    Object.freeze([...nextStates]),
  ])));
}

function assertKnownState(transitions, state, machineName) {
  if (!Object.hasOwn(transitions, state)) {
    throw new TypeError(`Unknown ${machineName} execution state: ${String(state)}`);
  }
}

function assertTransition(transitions, previousState, nextState, machineName) {
  assertKnownState(transitions, previousState, machineName);
  assertKnownState(transitions, nextState, machineName);
  if (!transitions[previousState].includes(nextState)) {
    throw new InvalidStateTransitionError(machineName, previousState, nextState);
  }
}

function createExecutionState(initialState) {
  return Object.freeze({
    state: initialState,
    history: Object.freeze([initialState]),
  });
}

function advanceExecutionState(
  execution,
  nextState,
  transitions,
  machineName,
  initialState,
) {
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
  /**
   * Creates a transition error with stable machine and state coordinates.
   */
  constructor(machine, previousState, nextState) {
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
export function createCaseExecution() {
  return createExecutionState('declared');
}

/**
 * Advances a case attempt through one valid edge and returns a new record.
 */
export function advanceCaseExecution(execution, nextState) {
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
export function assertCaseTransition(previousState, nextState) {
  assertTransition(CASE_EXECUTION_TRANSITIONS, previousState, nextState, 'case');
}

/**
 * Creates the execution record for a planned release audit.
 */
export function createReleaseExecution() {
  return createExecutionState('planned');
}

/**
 * Advances the release coordinator through one valid edge.
 */
export function advanceReleaseExecution(execution, nextState) {
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
export function assertReleaseTransition(previousState, nextState) {
  assertTransition(RELEASE_EXECUTION_TRANSITIONS, previousState, nextState, 'release');
}
