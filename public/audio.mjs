/* AI: erstellt von GPT-6 Luna (bifrost/azure/gpt-6-luna) | 2026-11-05 */

export const GROOVE_SALAD_PRIMARY = 'https://ice5.somafm.com/groovesalad-128-mp3';
export const GROOVE_SALAD_FALLBACK = 'https://ice2.somafm.com/groovesalad-128-mp3';

export function createAudioController(audio, onStatus = () => {}) {
	let desiredPlaying = false;
	let generation = 0;
	let station = { title: 'Groove Salad', streams: [GROOVE_SALAD_PRIMARY, GROOVE_SALAD_FALLBACK] };
	let streamIndex = 0;
	let lastVolume = null;

	const report = (state, message) => onStatus({ state, message });

	function setVolume(volume) {
		if (!Number.isFinite(volume) || volume < 0 || volume > 1 || volume === lastVolume) return;
		lastVolume = volume;
		audio.volume = volume;
	}

	function playCurrentSource(token) {
		let result;
		try {
			result = audio.play();
		} catch (error) {
			handlePlayFailure(error, token);
			return;
		}
		Promise.resolve(result).then(() => {
			if (token === generation && desiredPlaying) {
				report('playing', `${station.title} läuft.`);
			} else if (!desiredPlaying) {
				audio.pause();
			}
		}).catch((error) => handlePlayFailure(error, token));
	}

	function handlePlayFailure(error, token) {
		if (token !== generation || !desiredPlaying) return;
		if (error?.name === 'NotAllowedError') {
			report('blocked', 'Automatische Wiedergabe blockiert. Musik manuell erneut starten.');
			return;
		}
		if (!tryFallback()) reportTerminalError();
	}

	function loadAndPlay(source, token) {
		report('connecting', `Verbinde mit ${station.title} …`);
		audio.src = source;
		audio.load();
		playCurrentSource(token);
	}

	function tryFallback() {
		if (desiredPlaying && streamIndex + 1 < station.streams.length) {
			streamIndex += 1;
			generation += 1;
			loadAndPlay(station.streams[streamIndex], generation);
			return true;
		}
		return false;
	}

	function reportTerminalError() {
		generation += 1;
		report('error', `${station.title}: Kein Stream erreichbar. Erneut versuchen, wenn die Verbindung zurück ist.`);
	}

	function handleMediaError() {
		if (!desiredPlaying || tryFallback()) return;
		reportTerminalError();
	}

	audio.addEventListener('error', handleMediaError);

	function reconcile(shouldPlay, volume) {
		setVolume(volume);
		if (Boolean(shouldPlay) === desiredPlaying) return;
		desiredPlaying = Boolean(shouldPlay);
		generation += 1;
		if (!desiredPlaying) {
			audio.pause();
			if (audio.src) {
				audio.removeAttribute('src');
				audio.load();
			}
			report('idle', 'Musik pausiert.');
			return;
		}
		streamIndex = 0;
		loadAndPlay(station.streams[streamIndex], generation);
	}

	function setStation(nextStation) {
		if (typeof nextStation?.title !== 'string' || !nextStation.title.trim() ||
			!Array.isArray(nextStation.streams) || !nextStation.streams.length ||
			nextStation.streams.some((source) => typeof source !== 'string' || !source.trim())) return false;
		const streams = [...nextStation.streams];
		if (station.title === nextStation.title && station.streams.length === streams.length &&
			station.streams.every((source, index) => source === streams[index])) return true;
		const resume = desiredPlaying;
		desiredPlaying = false;
		generation += 1;
		audio.pause();
		if (audio.src) {
			audio.removeAttribute('src');
			audio.load();
		}
		station = { title: nextStation.title.trim(), streams };
		streamIndex = 0;
		desiredPlaying = resume;
		if (resume) {
			generation += 1;
			loadAndPlay(station.streams[0], generation);
		} else {
			report('idle', 'Musik pausiert.');
		}
		return true;
	}

	function retry() {
		if (!desiredPlaying) return false;
		generation += 1;
		streamIndex = 0;
		loadAndPlay(station.streams[streamIndex], generation);
		return true;
	}

	function destroy() {
		reconcile(false, lastVolume ?? 1);
		audio.removeEventListener('error', handleMediaError);
	}

	return { reconcile, retry, setStation, destroy };
}
