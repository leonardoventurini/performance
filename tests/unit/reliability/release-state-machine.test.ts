import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  InvalidStateTransitionError,
  advanceCaseExecution,
  advanceReleaseExecution,
  createCaseExecution,
  createReleaseExecution,
} from '../../../reliability/release-audit/state-machine.js';
import type { CaseExecutionState, ReleaseExecutionState } from '../../../reliability/release-audit/state-machine.js';

function advanceCaseThrough(states: readonly CaseExecutionState[]) {
  return states.reduce(
    (execution, state) => advanceCaseExecution(execution, state),
    createCaseExecution(),
  );
}

describe('release audit case execution state', () => {
  test('permits the fault-free path only in declared order', () => {
    const execution = advanceCaseThrough([
      'preflighted',
      'environment_ready',
      'clients_ready',
      'workload_running',
      'converging',
      'evidence_sealed',
      'cleanup_verified',
      'passed',
    ]);

    assert.equal(execution.state, 'passed');
    assert.deepEqual(execution.history, [
      'declared',
      'preflighted',
      'environment_ready',
      'clients_ready',
      'workload_running',
      'converging',
      'evidence_sealed',
      'cleanup_verified',
      'passed',
    ]);
  });

  test('permits the optional witnessed fault edge', () => {
    const execution = advanceCaseThrough([
      'preflighted',
      'environment_ready',
      'clients_ready',
      'workload_running',
      'fault_activated',
      'converging',
      'evidence_sealed',
      'cleanup_verified',
      'failed',
    ]);

    assert.equal(execution.state, 'failed');
  });

  test('rejects passing before evidence sealing and cleanup verification', () => {
    const execution = advanceCaseThrough([
      'preflighted',
      'environment_ready',
      'clients_ready',
      'workload_running',
      'converging',
    ]);

    assert.throws(
      () => advanceCaseExecution(execution, 'passed'),
      (error) => (
        error instanceof InvalidStateTransitionError
        && error.previousState === 'converging'
        && error.nextState === 'passed'
      ),
    );
  });

  test('rejects invalid transitions without mutating the execution record', () => {
    const execution = createCaseExecution();

    assert.throws(
      () => advanceCaseExecution(execution, 'clients_ready'),
      /declared -> clients_ready/,
    );
    assert.deepEqual(execution, {
      state: 'declared',
      history: ['declared'],
    });
  });

  test('prevents terminal attempts from being overwritten by a later pass', () => {
    const execution = advanceCaseThrough([
      'preflighted',
      'environment_ready',
      'clients_ready',
      'workload_running',
      'converging',
      'evidence_sealed',
      'cleanup_verified',
      'incomplete',
    ]);

    assert.throws(() => advanceCaseExecution(execution, 'passed'), /incomplete -> passed/);
  });

  test('rejects forged history that bypasses evidence and cleanup states', () => {
    assert.throws(
      () => advanceCaseExecution({
        state: 'cleanup_verified',
        history: ['cleanup_verified'],
      }, 'passed'),
      /must begin at declared/,
    );
    assert.throws(
      () => advanceCaseExecution({
        state: 'cleanup_verified',
        history: ['declared', 'cleanup_verified'],
      }, 'passed'),
      /declared -> cleanup_verified/,
    );
  });
});

describe('release coordinator execution state', () => {
  test('permits a complete conformance decision path', () => {
    const execution = ([
      'identity_verified',
      'executing',
      'aggregating',
      'conformant',
    ] satisfies readonly ReleaseExecutionState[]).reduce(
      (current, state) => advanceReleaseExecution(current, state),
      createReleaseExecution(),
    );

    assert.equal(execution.state, 'conformant');
  });

  test('rejects a decision before aggregation', () => {
    const execution = advanceReleaseExecution(
      advanceReleaseExecution(createReleaseExecution(), 'identity_verified'),
      'executing',
    );

    assert.throws(
      () => advanceReleaseExecution(execution, 'non_conformant'),
      /executing -> non_conformant/,
    );
  });
});
