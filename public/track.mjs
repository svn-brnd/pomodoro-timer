/* AI: erstellt von GPT-6 Luna (bifrost/azure/gpt-6-luna) | 2026-11-05 */

const REFRESH_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8_000;
const STATION_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;

function readTrack(payload, stationId) {
	if (payload?.id !== stationId || !Array.isArray(payload.songs)) return null;
	const firstSong = payload.songs[0];
	if (typeof firstSong?.artist !== 'string' || typeof firstSong.title !== 'string') return null;
	const artist = firstSong.artist.trim();
	const title = firstSong.title.trim();
	return artist && title && artist.length <= 300 && title.length <= 300 ? { artist, title } : null;
}

export function createTrackMonitor({ fetchImpl = globalThis.fetch, onTrack, timers = globalThis } = {}) {
	let active = false;
	let generation = 0;
	let intervalId = null;
	let pendingRequest = null;
	let stationId = 'groovesalad';

	function notify(track) {
		if (typeof onTrack !== 'function') return;
		try {
			onTrack(track);
		} catch {
			// A presentation callback must not interrupt polling.
		}
	}

	function isCurrent(request) {
		return active && request.generation === generation && pendingRequest === request;
	}

	async function refresh(requestGeneration) {
		if (!active || requestGeneration !== generation || pendingRequest) return;

		const controller = new AbortController();
		const requestState = { controller, generation: requestGeneration, timeoutId: null };
		pendingRequest = requestState;
		requestState.timeoutId = timers.setTimeout(() => {
			if (!isCurrent(requestState)) return;
			pendingRequest = null;
			controller.abort();
			notify(null);
		}, REQUEST_TIMEOUT_MS);

		try {
			const response = await fetchImpl(`https://somafm.com/songs/${stationId}.json`, {
				signal: controller.signal,
				credentials: 'omit',
				cache: 'no-store',
			});
			const payload = response.ok ? await response.json() : null;
			if (isCurrent(requestState)) notify(payload === null ? null : readTrack(payload, stationId));
		} catch {
			if (isCurrent(requestState)) notify(null);
		} finally {
			timers.clearTimeout(requestState.timeoutId);
			if (pendingRequest === requestState) pendingRequest = null;
		}
	}

	function start(nextStationId = 'groovesalad') {
		if (typeof nextStationId !== 'string' || !STATION_ID_PATTERN.test(nextStationId)) {
			stop();
			return false;
		}
		if (active && stationId === nextStationId) return true;
		if (active) stop();
		stationId = nextStationId;
		active = true;
		generation += 1;
		const currentGeneration = generation;
		intervalId = timers.setInterval(() => void refresh(currentGeneration), REFRESH_INTERVAL_MS);
		void refresh(currentGeneration);
		return true;
	}

	function stop() {
		if (!active && intervalId === null && pendingRequest === null) return;
		active = false;
		stationId = 'groovesalad';
		generation += 1;
		if (intervalId !== null) {
			timers.clearInterval(intervalId);
			intervalId = null;
		}
		if (pendingRequest) {
			const requestState = pendingRequest;
			pendingRequest = null;
			timers.clearTimeout(requestState.timeoutId);
			requestState.controller.abort();
		}
	}

	return { start, stop };
}
