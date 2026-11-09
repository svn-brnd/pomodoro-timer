/* AI: erstellt von GPT-6 Luna (bifrost/azure/gpt-6-luna) | 2026-11-05 */

const CATALOGUE_URL = 'https://somafm.com/channels.json';
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_STREAMS = 16;
const SOMAFM_PLAYLIST_HOSTS = new Set(['api.somafm.com', 'somafm.com']);

export const DEFAULT_STATION = Object.freeze({
	id: 'groovesalad',
	title: 'Groove Salad',
	description: 'Sanfte elektronische Klänge für deine Fokuszeit.',
	playlistUrl: 'https://api.somafm.com/groovesalad.pls',
	streams: Object.freeze([
		'https://ice5.somafm.com/groovesalad-128-mp3',
		'https://ice2.somafm.com/groovesalad-128-mp3',
	]),
});

export function isValidStationId(id) {
	return typeof id === 'string' && /^[a-z0-9_-]{1,64}$/.test(id);
}

function approvedPlaylistUrl(value) {
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && SOMAFM_PLAYLIST_HOSTS.has(url.hostname) &&
			url.pathname.toLowerCase().endsWith('.pls') && !url.username && !url.password && !url.port ? url.href : null;
	} catch {
		return null;
	}
}

function text(value, limit) {
	return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

export function normalizeChannels(payload) {
	if (!Array.isArray(payload?.channels)) throw new Error('Ungültiges SomaFM-Senderverzeichnis.');
	const stations = new Map();
	for (const channel of payload.channels) {
		if (!isValidStationId(channel?.id) || !Array.isArray(channel.playlists)) continue;
		const playlist = channel.playlists.find((entry) =>
			typeof entry?.format === 'string' && entry.format.toLowerCase() === 'mp3' &&
			approvedPlaylistUrl(entry.url));
		if (!playlist) continue;
		const id = channel.id;
		const title = text(channel.title, 200) || id;
		const station = {
			id,
			title,
			description: text(channel.description, 1_000),
			playlistUrl: approvedPlaylistUrl(playlist.url),
		};
		const previous = stations.get(id);
		if (!previous || (previous.title === id && title !== id)) stations.set(id, station);
	}
	return [...stations.values()].sort((left, right) =>
		left.title.localeCompare(right.title, 'en', { sensitivity: 'base' }) || left.id.localeCompare(right.id));
}

export function parsePlaylist(content) {
	if (typeof content !== 'string') throw new Error('Ungültige SomaFM-Playlist.');
	const entries = [];
	for (const line of content.split(/\r?\n/)) {
		const match = /^File(\d+)\s*=\s*(\S+)\s*$/i.exec(line.trim());
		if (!match) continue;
		const order = Number(match[1]);
		try {
			const url = new URL(match[2]);
			if (!/^ice\d+\.somafm\.com$/i.test(url.hostname) || !['https:', 'http:'].includes(url.protocol) ||
				url.username || url.password || url.port) continue;
			url.protocol = 'https:';
			entries.push({ order, url: url.href });
		} catch {
			// Ignore malformed or untrusted playlist entries.
		}
	}
	const streams = [...new Set(entries.sort((left, right) => left.order - right.order).map((entry) => entry.url))]
		.slice(0, MAX_STREAMS);
	if (!streams.length) throw new Error('Die SomaFM-Playlist enthält keine gültigen Streams.');
	return streams;
}

async function fetchText(url, { fetchImpl, signal }) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const abort = () => controller.abort();
	signal?.addEventListener('abort', abort, { once: true });
	if (signal?.aborted) controller.abort();
	try {
		const response = await fetchImpl(url, { signal: controller.signal, credentials: 'omit' });
		if (!response.ok) throw new Error(`SomaFM antwortete mit HTTP ${response.status}.`);
		return await response.text();
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener('abort', abort);
	}
}

export async function loadStations({ fetchImpl = globalThis.fetch, signal } = {}) {
	const body = await fetchText(CATALOGUE_URL, { fetchImpl, signal });
	return normalizeChannels(JSON.parse(body));
}

export async function loadStationStreams(station, { fetchImpl = globalThis.fetch, signal } = {}) {
	const playlistUrl = approvedPlaylistUrl(station?.playlistUrl);
	if (!playlistUrl) throw new Error('Ungültige SomaFM-Playlistadresse.');
	return parsePlaylist(await fetchText(playlistUrl, { fetchImpl, signal }));
}
