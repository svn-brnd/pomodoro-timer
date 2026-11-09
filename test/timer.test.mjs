/* AI: erstellt von GPT-6 Luna (bifrost/azure/gpt-6-luna) | 2026-11-05 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
	DEFAULT_DURATIONS,
	advance,
	createInitialState,
	decodeSnapshot,
	encodeSnapshot,
	pause,
	reset,
	start,
	updateDurations,
} from '../public/timer.mjs';

const preferences = { volume: 0.4, muted: false };
const minute = 60_000;
const shortDurations = { work: 3 * minute, shortBreak: minute, longBreak: minute };

function createShortState(overrides = {}) {
	return updateDurations({ ...createInitialState(), ...overrides }, shortDurations);
}

test('advances at the exact work boundary into a short break', () => {
	const running = start(createInitialState(), 0);
	const next = advance(running, DEFAULT_DURATIONS.work);

	assert.equal(next.phase, 'shortBreak');
	assert.equal(next.completedWork, 1);
	assert.equal(next.endsAt, DEFAULT_DURATIONS.work + DEFAULT_DURATIONS.shortBreak);
});

test('uses a long break after every fourth completed work phase', () => {
	const state = {
		...createInitialState(),
		completedWork: 3,
		status: 'running',
		endsAt: 1_000,
	};
	const next = advance(state, 1_000);

	assert.equal(next.phase, 'longBreak');
	assert.equal(next.completedWork, 4);
});

test('catches up across multiple delayed phases and preserves the active phase remainder', () => {
	const running = start(createInitialState(), 0);
	const now = DEFAULT_DURATIONS.work + DEFAULT_DURATIONS.shortBreak + 2 * 60_000;
	const next = advance(running, now);

	assert.equal(next.phase, 'work');
	assert.equal(next.completedWork, 1);
	assert.equal(next.remainingMs, DEFAULT_DURATIONS.work - 2 * 60_000);
	assert.equal(next.endsAt, 2 * DEFAULT_DURATIONS.work + DEFAULT_DURATIONS.shortBreak);
});

test('catches up across three full cycles and preserves the active work remainder', () => {
	const running = start(createShortState(), 0);
	const cycleDuration = 4 * shortDurations.work + 3 * shortDurations.shortBreak + shortDurations.longBreak;
	const next = advance(running, 3 * cycleDuration + 2 * minute);

	assert.equal(next.phase, 'work');
	assert.equal(next.completedWork, 12);
	assert.equal(next.remainingMs, shortDurations.work - 2 * minute);
});

test('keeps the long-break rotation after whole-cycle catch-up from work count three', () => {
	const running = start(createShortState({ completedWork: 3 }), 0);
	const cycleDuration = 4 * shortDurations.work + 3 * shortDurations.shortBreak + shortDurations.longBreak;
	const next = advance(running, cycleDuration + shortDurations.work);

	assert.equal(next.phase, 'longBreak');
	assert.equal(next.completedWork, 8);
	assert.equal(next.remainingMs, shortDurations.longBreak);
});

test('pauses after reconciling elapsed time and resumes without background loss', () => {
	const running = start(createInitialState(), 0);
	const paused = pause(running, 2 * 60_000);
	const resumed = start(paused, 9 * 60 * 60_000);

	assert.equal(paused.status, 'paused');
	assert.equal(paused.remainingMs, DEFAULT_DURATIONS.work - 2 * 60_000);
	assert.equal(resumed.endsAt, 9 * 60 * 60_000 + paused.remainingMs);
});

test('reset stops the current phase using its configured duration and preserves work count', () => {
	const configured = updateDurations(createInitialState(), {
		work: 40 * 60_000,
		shortBreak: 7 * 60_000,
		longBreak: 20 * 60_000,
	});
	const running = start(configured, 0);
	const afterWork = advance(running, configured.durations.work);
	const resetState = reset(afterWork, configured.durations.work + 1_000);

	assert.equal(resetState.status, 'idle');
	assert.equal(resetState.phase, 'shortBreak');
	assert.equal(resetState.completedWork, 1);
	assert.equal(resetState.remainingMs, configured.durations.shortBreak);
});

test('duration changes do not alter an active phase but apply to the next phase', () => {
	const running = start(createInitialState(), 0);
	const changed = updateDurations(running, {
		work: 30 * 60_000,
		shortBreak: 8 * 60_000,
		longBreak: 18 * 60_000,
	});
	const next = advance(changed, DEFAULT_DURATIONS.work);

	assert.equal(changed.endsAt, running.endsAt);
	assert.equal(changed.remainingMs, running.remainingMs);
	assert.equal(next.phase, 'shortBreak');
	assert.equal(next.remainingMs, 8 * 60_000);
});

test('restores valid stored state and rejects corrupted snapshots', () => {
	const state = start(createInitialState(), 1_000);
	const encoded = encodeSnapshot(state, preferences);
	const restored = decodeSnapshot(encoded, 2_000);

	assert.equal(restored.state.remainingMs, state.endsAt - 2_000);
	assert.deepEqual(restored.preferences, preferences);
	assert.equal(decodeSnapshot('{broken', 2_000), null);
	assert.equal(decodeSnapshot(JSON.stringify({ version: 9, state, preferences }), 2_000), null);
	assert.equal(decodeSnapshot({
		version: 1,
		state: { ...state, completedWork: -1 },
		preferences,
	}, 2_000), null);
});

test('restores a running snapshot after multiple phases have elapsed', () => {
	const state = start(createShortState(), 0);
	const restored = decodeSnapshot(encodeSnapshot(state, preferences), 7 * minute + minute / 2);

	assert.equal(restored.state.phase, 'shortBreak');
	assert.equal(restored.state.completedWork, 2);
	assert.equal(restored.state.remainingMs, minute / 2);
});

test('does not advance a paused snapshot while it is stored', () => {
	const paused = pause(start(createShortState(), 0), minute);
	const restored = decodeSnapshot(encodeSnapshot(paused, preferences), 24 * 60 * minute);

	assert.equal(restored.state.status, 'paused');
	assert.equal(restored.state.remainingMs, 2 * minute);
});

test('rejects snapshots with invalid durations, end times, or preferences', () => {
	const state = start(createShortState(), 0);
	const snapshot = { version: 1, state, preferences };

	assert.equal(decodeSnapshot({
		...snapshot,
		state: { ...state, durations: { ...shortDurations, work: minute - 1 } },
	}, 0), null);
	assert.equal(decodeSnapshot({ ...snapshot, state: { ...state, endsAt: Infinity } }, 0), null);
	assert.equal(decodeSnapshot({ ...snapshot, preferences: { ...preferences, volume: 1.1 } }, 0), null);
});
