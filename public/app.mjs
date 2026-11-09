/* AI: erstellt von GPT-6.1 Sol (bifrost/azure/gpt-6.1-sol) | 2026-11-05 */

import {
	advance,
	createInitialState,
	decodeSnapshot,
	encodeSnapshot,
	pause,
	reset,
	start,
	updateDurations,
} from './timer.mjs';
import { createAudioController } from './audio.mjs';
import { createTrackMonitor } from './track.mjs';
import { DEFAULT_STATION, isValidStationId, loadStationStreams, loadStations } from './stations.mjs';

const STORAGE_KEY = 'stillpoint-pomodoro-v1';
const DEFAULT_PREFERENCES = Object.freeze({ volume: 0.35, muted: false, stationId: DEFAULT_STATION.id });
const PHASE_NAMES = Object.freeze({ work: 'Fokuszeit', shortBreak: 'Kurze Pause', longBreak: 'Lange Pause' });
const PHASE_BADGES = Object.freeze({ work: 'ARBEIT', shortBreak: 'KURZE PAUSE', longBreak: 'LANGE PAUSE' });
const elements = {
	phaseLabel: document.querySelector('#phase-label'),
	phaseBadge: document.querySelector('#phase-badge'),
	timerRing: document.querySelector('#timer-ring'),
	timerDisplay: document.querySelector('#timer-display'),
	timerCaption: document.querySelector('#timer-caption'),
	cycleDots: [...document.querySelectorAll('#cycle-dots span')],
	completedCount: document.querySelector('#completed-count'),
	startButton: document.querySelector('#start-button'),
	pauseButton: document.querySelector('#pause-button'),
	resetButton: document.querySelector('#reset-button'),
	nextPhase: document.querySelector('#next-phase'),
	settingsForm: document.querySelector('#settings-form'),
	settingsMessage: document.querySelector('#settings-message'),
	workMinutes: document.querySelector('#work-minutes'),
	shortBreakMinutes: document.querySelector('#short-break-minutes'),
	longBreakMinutes: document.querySelector('#long-break-minutes'),
	volume: document.querySelector('#volume-control'),
	volumeValue: document.querySelector('#volume-value'),
	muteButton: document.querySelector('#mute-button'),
	retryButton: document.querySelector('#retry-button'),
	audioStatus: document.querySelector('#audio-status'),
	stationSelect: document.querySelector('#station-select'),
	stationDescription: document.querySelector('#station-description'),
	musicHeading: document.querySelector('#music-heading'),
	stationListStatus: document.querySelector('#station-list-status'),
	reloadStationsButton: document.querySelector('#reload-stations-button'),
	storageNote: document.querySelector('#storage-note'),
};

let storage = null;
let storageFailed = false;
let preferences = { ...DEFAULT_PREFERENCES };
let state = createInitialState();
let initialStationId = DEFAULT_STATION.id;

try {
	storage = window.localStorage;
	const restored = decodeSnapshot(storage.getItem(STORAGE_KEY), Date.now());
	if (restored) {
		state = restored.state;
		preferences = { ...DEFAULT_PREFERENCES, ...restored.preferences };
		initialStationId = isValidStationId(restored.preferences?.stationId) ?
			restored.preferences.stationId : DEFAULT_STATION.id;
		preferences.stationId = initialStationId;
	}
} catch {
	storageFailed = true;
}

let currentStation = DEFAULT_STATION;
let stationList = [DEFAULT_STATION];
let sourcesReady = initialStationId === DEFAULT_STATION.id;
let sourcesLoading = false;
let sourceGeneration = 0;
let sourceController = null;
let catalogueGeneration = 0;
let initialSelectionHandled = false;
let userSelectedStation = false;

const trackMonitor = createTrackMonitor({
	onTrack: (track) => {
		if (elements.audioStatus.dataset.state !== 'playing') return;
		elements.audioStatus.textContent = track ? `${track.artist} – ${track.title}` :
			`${currentStation.title} läuft – Titel derzeit nicht verfügbar.`;
	},
});

const audioController = createAudioController(new Audio(), ({ state: audioState, message }) => {
	const wasPlaying = elements.audioStatus.dataset.state === 'playing';
	elements.audioStatus.dataset.state = audioState;
	if (audioState === 'playing') {
		if (!wasPlaying) elements.audioStatus.textContent = `${currentStation.title}: Titel wird geladen …`;
		trackMonitor.start(currentStation.id);
		return;
	}
	elements.audioStatus.textContent = message;
	trackMonitor.stop();
});

function save() {
	if (!storage || storageFailed) return;
	const snapshot = encodeSnapshot(state, preferences);
	if (!snapshot) return;
	try {
		storage.setItem(STORAGE_KEY, snapshot);
	} catch {
		storageFailed = true;
		elements.storageNote.textContent = 'Speichern ist nicht verfügbar; der Timer läuft bis zum Schließen dieses Tabs.';
	}
}

function updateStationDetails() {
	elements.stationSelect.value = currentStation.id;
	elements.stationDescription.textContent = currentStation.description || 'Live-Musik von SomaFM.';
	elements.musicHeading.textContent = currentStation.title;
}

function updateStationOptions() {
	elements.stationSelect.replaceChildren(...stationList.map((station) => {
		const option = document.createElement('option');
		option.value = station.id;
		option.textContent = station.title;
		return option;
	}));
	updateStationDetails();
}

function useDefaultStationNotice(message) {
	sourceGeneration += 1;
	sourceController?.abort();
	sourceController = null;
	currentStation = DEFAULT_STATION;
	sourcesReady = true;
	sourcesLoading = false;
	preferences = { ...preferences, stationId: DEFAULT_STATION.id };
	updateStationDetails();
	audioController.reconcile(false, preferences.volume);
	audioController.setStation({ title: DEFAULT_STATION.title, streams: DEFAULT_STATION.streams });
	elements.audioStatus.dataset.state = 'idle';
	elements.audioStatus.textContent = message;
	save();
	render();
}

async function resolveStationStreams() {
	const generation = ++sourceGeneration;
	sourceController?.abort();
	const controller = new AbortController();
	sourceController = controller;
	sourcesReady = false;
	sourcesLoading = true;
	elements.retryButton.disabled = true;
	elements.audioStatus.dataset.state = 'connecting';
	elements.audioStatus.textContent = `${currentStation.title}: Lade Streamadressen …`;
	try {
		const streams = await loadStationStreams(currentStation, { signal: controller.signal });
		if (generation !== sourceGeneration) return;
		if (!audioController.setStation({ title: currentStation.title, streams })) {
			throw new Error('Ungültige Streamadressen.');
		}
		sourcesReady = true;
		sourcesLoading = false;
		sourceController = null;
		elements.audioStatus.dataset.state = 'idle';
		elements.audioStatus.textContent = `${currentStation.title} ist bereit.`;
		tick();
	} catch {
		if (generation !== sourceGeneration) return;
		sourcesReady = false;
		sourcesLoading = false;
		sourceController = null;
		elements.audioStatus.dataset.state = 'error';
		elements.audioStatus.textContent = `${currentStation.title}: Streamadressen nicht verfügbar. Erneut verbinden, wenn die Verbindung zurück ist.`;
		tick();
	}
}

function changeStation(station, { persist = true } = {}) {
	if (!station || station.id === currentStation.id) return;
	currentStation = station;
	preferences = { ...preferences, stationId: station.id };
	if (persist) save();
	updateStationDetails();
	trackMonitor.stop();
	audioController.reconcile(false, preferences.volume);
	elements.audioStatus.dataset.state = 'connecting';
	elements.audioStatus.textContent = `${station.title}: Lade Streamadressen …`;
	void resolveStationStreams();
	render();
}

async function loadStationCatalogue() {
	const generation = ++catalogueGeneration;
	elements.reloadStationsButton.disabled = true;
	elements.stationListStatus.textContent = 'Senderliste wird geladen …';
	try {
		const remoteStations = await loadStations();
		if (generation !== catalogueGeneration) return;
		const uniqueStations = new Map(remoteStations.map((station) => [station.id, station]));
		uniqueStations.set(DEFAULT_STATION.id, DEFAULT_STATION);
		stationList = [...uniqueStations.values()].sort((left, right) =>
			left.title.localeCompare(right.title, 'en', { sensitivity: 'base' }) || left.id.localeCompare(right.id));
		updateStationOptions();
		elements.stationListStatus.textContent = `${stationList.length} Sender verfügbar`;
		if (!initialSelectionHandled && !userSelectedStation) {
			initialSelectionHandled = true;
			if (initialStationId !== DEFAULT_STATION.id) {
				const restoredStation = stationList.find((station) => station.id === initialStationId);
				if (restoredStation) {
					changeStation(restoredStation, { persist: false });
				} else {
					elements.stationListStatus.textContent = `${stationList.length} Sender verfügbar · gespeicherter Sender nicht verfügbar; Groove Salad ausgewählt.`;
					useDefaultStationNotice('Groove Salad ausgewählt; der gespeicherte Sender ist nicht verfügbar.');
				}
			}
		}
	} catch {
		if (generation !== catalogueGeneration) return;
		elements.stationListStatus.textContent = 'Senderliste nicht verfügbar; Groove Salad bleibt verfügbar.';
		if (!initialSelectionHandled && !userSelectedStation && initialStationId !== DEFAULT_STATION.id) {
			initialSelectionHandled = true;
			useDefaultStationNotice('Groove Salad ausgewählt; die gespeicherte Senderliste konnte nicht geladen werden.');
		}
	} finally {
		if (generation === catalogueGeneration) elements.reloadStationsButton.disabled = false;
	}
}

function formatTime(milliseconds) {
	const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
	const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
	const seconds = (totalSeconds % 60).toString().padStart(2, '0');
	return `${minutes}:${seconds}`;
}

function phaseAfterCurrentWork() {
	return (state.completedWork + 1) % 4 === 0 ? 'longBreak' : 'shortBreak';
}

function updateNextPhase() {
	const next = state.phase === 'work' ? phaseAfterCurrentWork() : 'work';
	const minutes = Math.round(state.durations[next] / 60_000);
	elements.nextPhase.textContent = `Danach: ${next === 'work' ? 'Fokuszeit' : PHASE_NAMES[next].toLowerCase()} · ${minutes} Minuten`;
}

function render(now = Date.now()) {
	const remainingMs = state.status === 'running' ? Math.max(0, state.endsAt - now) : state.remainingMs;
	const phaseName = PHASE_NAMES[state.phase];
	const musicExpected = state.status === 'running' && state.phase === 'work' && !preferences.muted;
	const progress = Math.min(1, Math.max(0, 1 - remainingMs / state.phaseDurationMs));

	elements.phaseLabel.textContent = phaseName;
	elements.phaseBadge.textContent = PHASE_BADGES[state.phase];
	elements.timerDisplay.textContent = formatTime(remainingMs);
	elements.timerCaption.textContent = state.status === 'running' ?
		(state.phase === 'work' ? 'Zeit für deinen Fokus' : 'Zeit zum Auftanken') :
		(state.status === 'paused' ? 'Pausiert — du kannst jederzeit fortsetzen' : 'Bereit zum Start');
	elements.timerRing.style.setProperty('--progress', `${progress * 100}%`);
	elements.completedCount.textContent = String(state.completedWork);
	elements.startButton.textContent = state.status === 'paused' ? 'Fortsetzen' : 'Starten';
	elements.pauseButton.disabled = state.status !== 'running';
	elements.startButton.disabled = state.status === 'running';
	elements.retryButton.disabled = !musicExpected || sourcesLoading;
	elements.muteButton.setAttribute('aria-pressed', String(preferences.muted));
	elements.muteButton.textContent = preferences.muted ? 'Musik einschalten' : 'Musik stummschalten';
	elements.volume.value = String(preferences.volume);
	elements.volumeValue.value = `${Math.round(preferences.volume * 100)}%`;
	const completedInCycle = state.phase === 'longBreak' ? 4 : state.completedWork % 4;
	elements.cycleDots.forEach((dot, index) => {
		dot.classList.toggle('is-complete', index < completedInCycle);
		dot.classList.toggle('is-current', state.phase === 'work' && index === completedInCycle);
	});
	updateNextPhase();
	document.title = `${formatTime(remainingMs)} · ${phaseName} — stillpoint`;
	audioController.reconcile(musicExpected && sourcesReady, preferences.volume);
}

function hasTransitioned(previous, next) {
	return previous.status !== next.status || previous.phase !== next.phase ||
		previous.completedWork !== next.completedWork || previous.endsAt !== next.endsAt;
}

function tick(now = Date.now()) {
	const previous = state;
	state = advance(state, now);
	if (hasTransitioned(previous, state)) save();
	render(now);
}

function advanceForInteraction(now) {
	const previous = state;
	state = advance(state, now);
	if (hasTransitioned(previous, state)) save();
	return now;
}

elements.startButton.addEventListener('click', () => {
	const now = advanceForInteraction(Date.now());
	state = start(state, now);
	save();
	render(now);
});

elements.pauseButton.addEventListener('click', () => {
	const now = advanceForInteraction(Date.now());
	state = pause(state, now);
	save();
	render(now);
});

elements.resetButton.addEventListener('click', () => {
	const now = advanceForInteraction(Date.now());
	state = reset(state, now);
	save();
	render(now);
});

elements.settingsForm.addEventListener('submit', (event) => {
	event.preventDefault();
	const now = advanceForInteraction(Date.now());
	const values = [elements.workMinutes, elements.shortBreakMinutes, elements.longBreakMinutes].map((input) => Number(input.value));
	if (values.some((value) => !Number.isInteger(value) || value < 1 || value > 180)) {
		elements.settingsMessage.textContent = 'Gib für jede Phase eine ganze Zahl zwischen 1 und 180 ein.';
		render(now);
		return;
	}
	state = updateDurations(state, {
		work: values[0] * 60_000,
		shortBreak: values[1] * 60_000,
		longBreak: values[2] * 60_000,
	});
	elements.settingsMessage.textContent = 'Dein neuer Rhythmus ist gespeichert.';
	save();
	render(now);
});

elements.muteButton.addEventListener('click', () => {
	const now = advanceForInteraction(Date.now());
	preferences = { ...preferences, muted: !preferences.muted };
	save();
	render(now);
});

elements.stationSelect.addEventListener('change', () => {
	const now = advanceForInteraction(Date.now());
	const station = stationList.find((entry) => entry.id === elements.stationSelect.value);
	if (!station) {
		updateStationDetails();
		return;
	}
	userSelectedStation = true;
	initialSelectionHandled = true;
	changeStation(station);
	render(now);
});

elements.reloadStationsButton.addEventListener('click', () => void loadStationCatalogue());

elements.volume.addEventListener('input', () => {
	const now = advanceForInteraction(Date.now());
	preferences = { ...preferences, volume: Number(elements.volume.value) };
	save();
	render(now);
});

elements.retryButton.addEventListener('click', () => {
	const now = advanceForInteraction(Date.now());
	const musicExpected = state.status === 'running' && state.phase === 'work' && !preferences.muted;
	render(now);
	if (!musicExpected) {
		elements.audioStatus.textContent = 'Musik ist während einer laufenden, nicht stummgeschalteten Fokusphase verfügbar.';
	} else if (!sourcesReady) {
		if (!sourcesLoading) void resolveStationStreams();
	} else if (!audioController.retry()) {
		elements.audioStatus.textContent = 'Musik konnte nicht erneut gestartet werden.';
	}
});

document.addEventListener('visibilitychange', () => {
	if (!document.hidden) tick();
});
window.addEventListener('pageshow', () => tick());
window.addEventListener('focus', () => tick());

for (const [input, phase] of [
	[elements.workMinutes, 'work'],
	[elements.shortBreakMinutes, 'shortBreak'],
	[elements.longBreakMinutes, 'longBreak'],
]) {
	input.value = String(Math.round(state.durations[phase] / 60_000));
}

if (storageFailed) {
	elements.storageNote.textContent = 'Lokaler Speicher ist nicht verfügbar; der Timer läuft bis zum Schließen dieses Tabs.';
}
if (state.status === 'running') save();
render();
void loadStationCatalogue();
window.setInterval(() => tick(), 250);
