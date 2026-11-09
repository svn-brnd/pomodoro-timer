/* AI: erstellt von GPT-6 Luna (bifrost/azure/gpt-6-luna) | 2026-11-05 */

export const MIN_DURATION_MS = 60_000;
export const MAX_DURATION_MS = 180 * 60_000;
export const STORAGE_VERSION = 1;

export const DEFAULT_DURATIONS = Object.freeze({
	work: 25 * 60_000,
	shortBreak: 5 * 60_000,
	longBreak: 15 * 60_000,
});

const PHASES = new Set(['work', 'shortBreak', 'longBreak']);
const STATUSES = new Set(['idle', 'running', 'paused']);

export function createInitialState() {
	return {
		status: 'idle',
		phase: 'work',
		completedWork: 0,
		durations: { ...DEFAULT_DURATIONS },
		phaseDurationMs: DEFAULT_DURATIONS.work,
		remainingMs: DEFAULT_DURATIONS.work,
		endsAt: null,
	};
}

export function validateDurations(durations) {
	return Boolean(durations && ['work', 'shortBreak', 'longBreak'].every((phase) =>
		Number.isFinite(durations[phase]) &&
		durations[phase] >= MIN_DURATION_MS &&
		durations[phase] <= MAX_DURATION_MS));
}

export function validateState(state) {
	if (!state || !STATUSES.has(state.status) || !PHASES.has(state.phase)) return false;
	if (!Number.isInteger(state.completedWork) || state.completedWork < 0) return false;
	if (!validateDurations(state.durations)) return false;
	if (!Number.isFinite(state.phaseDurationMs) ||
		state.phaseDurationMs < MIN_DURATION_MS || state.phaseDurationMs > MAX_DURATION_MS) return false;
	if (!Number.isFinite(state.remainingMs) || state.remainingMs <= 0 ||
		state.remainingMs > state.phaseDurationMs) return false;
	if (state.status === 'running') return Number.isFinite(state.endsAt);
	if (state.endsAt !== null) return false;
	return state.status !== 'idle' ||
		(state.phaseDurationMs === state.durations[state.phase] && state.remainingMs === state.phaseDurationMs);
}

function currentDuration(state) {
	return state.durations[state.phase];
}

function enterPhase(state, phase, completedWork, startsAt) {
	const duration = state.durations[phase];
	return {
		...state,
		phase,
		completedWork,
		phaseDurationMs: duration,
		remainingMs: duration,
		endsAt: startsAt + duration,
	};
}

export function advance(state, now = Date.now()) {
	if (!validateState(state) || !Number.isFinite(now) || state.status !== 'running') return state;
	if (now < state.endsAt) {
		const remainingMs = state.endsAt - now;
		return remainingMs === state.remainingMs ? state : { ...state, remainingMs };
	}

	let next = { ...state };
	let boundary = state.endsAt;

	if (next.phase === 'work' && next.phaseDurationMs === next.durations.work) {
		const cycleDuration = 4 * next.durations.work +
			3 * next.durations.shortBreak + next.durations.longBreak;
		const cycleStartedAt = next.endsAt - next.durations.work;
		const completeCycles = Math.floor((now - cycleStartedAt) / cycleDuration);
		if (completeCycles > 0) {
			const elapsedCycles = completeCycles * cycleDuration;
			next = {
				...next,
				completedWork: next.completedWork + 4 * completeCycles,
				phase: 'work',
				phaseDurationMs: next.durations.work,
				remainingMs: next.durations.work,
				endsAt: cycleStartedAt + elapsedCycles + next.durations.work,
			};
			boundary = next.endsAt - next.durations.work;
		}
	}

	while (now >= next.endsAt) {
		boundary = next.endsAt;
		if (next.phase === 'work') {
			const completedWork = next.completedWork + 1;
			const phase = completedWork % 4 === 0 ? 'longBreak' : 'shortBreak';
			next = enterPhase(next, phase, completedWork, boundary);
		} else {
			next = enterPhase(next, 'work', next.completedWork, boundary);
		}
	}

	return { ...next, remainingMs: next.endsAt - now };
}

export function start(state, now = Date.now()) {
	if (!validateState(state) || !Number.isFinite(now)) return state;
	const current = advance(state, now);
	if (current.status === 'running') return current;
	return { ...current, status: 'running', endsAt: now + current.remainingMs };
}

export function pause(state, now = Date.now()) {
	if (!validateState(state) || !Number.isFinite(now)) return state;
	const current = advance(state, now);
	if (current.status !== 'running') return current;
	return { ...current, status: 'paused', endsAt: null };
}

export function reset(state, now = Date.now()) {
	if (!validateState(state) || !Number.isFinite(now)) return state;
	const current = advance(state, now);
	const duration = currentDuration(current);
	return {
		...current,
		status: 'idle',
		phaseDurationMs: duration,
		remainingMs: duration,
		endsAt: null,
	};
}

export function updateDurations(state, durations) {
	if (!validateState(state) || !validateDurations(durations)) return state;
	const nextDurations = { ...durations };
	if (state.status === 'idle') {
		const duration = nextDurations[state.phase];
		return {
			...state,
			durations: nextDurations,
			phaseDurationMs: duration,
			remainingMs: duration,
		};
	}
	return { ...state, durations: nextDurations };
}

export function validatePreferences(preferences) {
	return Boolean(preferences && Number.isFinite(preferences.volume) &&
		preferences.volume >= 0 && preferences.volume <= 1 && typeof preferences.muted === 'boolean');
}

export function encodeSnapshot(state, preferences) {
	if (!validateState(state) || !validatePreferences(preferences)) return null;
	return JSON.stringify({ version: STORAGE_VERSION, state, preferences });
}

export function decodeSnapshot(serialized, now = Date.now()) {
	try {
		const snapshot = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
		if (snapshot?.version !== STORAGE_VERSION || !validateState(snapshot.state) ||
			!validatePreferences(snapshot.preferences)) return null;
		return {
			state: advance(snapshot.state, now),
			preferences: { ...snapshot.preferences },
		};
	} catch {
		return null;
	}
}
