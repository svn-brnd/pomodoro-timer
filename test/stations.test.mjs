/* AI: erstellt von GPT-6 Luna (bifrost/azure/gpt-6-luna) | 2026-11-05 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
	DEFAULT_STATION,
	isValidStationId,
	loadStationStreams,
	loadStations,
	normalizeChannels,
	parsePlaylist,
} from '../public/stations.mjs';

function channel(id, title = id, overrides = {}) {
	return {
		id,
		title,
		description: `${title} description`,
		playlists: [{ url: `https://api.somafm.com/${id}.pls`, format: 'mp3', quality: 'highest' }],
		...overrides,
	};
}

test('normalizes every MP3 channel, keeps numeric IDs, removes aliases, and sorts by title', () => {
	const stations = normalizeChannels({ channels: [
		channel('zeta', 'Zulu'),
		channel('7soul', '7 Soul'),
		channel('gsclassic', 'Groove Salad Classic'),
		channel('7soul', '7soul'),
		channel('bad', 'Foreign', { playlists: [{ url: 'https://example.com/bad.pls', format: 'mp3' }] }),
		channel('no-mp3', 'No MP3', { playlists: [{ url: 'https://api.somafm.com/no-mp3.pls', format: 'aac' }] }),
	] });

	assert.deepEqual(stations.map(({ id }) => id), ['7soul', 'gsclassic', 'zeta']);
	assert.equal(stations[0].title, '7 Soul');
	assert.equal(stations[0].playlistUrl, 'https://api.somafm.com/7soul.pls');
	assert.equal(isValidStationId('7soul'), true);
	assert.equal(isValidStationId('../songs/groovesalad'), false);
	assert.throws(() => normalizeChannels({ channels: null }), /Senderverzeichnis/);
});

test('parses ordered published hosts, upgrades HTTP, deduplicates, and rejects unsafe addresses', () => {
	const streams = parsePlaylist([
		'[playlist]',
		'File2=https://ice2.somafm.com/fluid-128-mp3',
		'File1=http://ice6.somafm.com/fluid-128-mp3',
		'File3=https://ice6.somafm.com/fluid-128-mp3',
		'File4=javascript:alert(1)',
		'File5=https://example.com/audio.mp3',
		'File6=https://ice7.somafm.com.evil.test/audio.mp3',
		'File7=https://user@ice8.somafm.com/audio.mp3',
	].join('\n'));

	assert.deepEqual(streams, [
		'https://ice6.somafm.com/fluid-128-mp3',
		'https://ice2.somafm.com/fluid-128-mp3',
	]);
	assert.throws(() => parsePlaylist('[playlist]\nFile1=https://example.com/audio.mp3'), /keine gültigen Streams/);
});

test('loads the official catalogue without credentials and rejects HTTP failures', async () => {
	let request;
	const stations = await loadStations({
		fetchImpl: async (url, options) => {
			request = { url, options };
			return { ok: true, text: async () => JSON.stringify({ channels: [channel('fluid', 'Fluid')] }) };
		},
	});

	assert.equal(request.url, 'https://somafm.com/channels.json');
	assert.equal(request.options.credentials, 'omit');
	assert.equal(stations[0].id, 'fluid');
	await assert.rejects(loadStations({ fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
});

test('loads the selected PLS text, rejects a foreign playlist URL, and preserves the offline default', async () => {
	let requestUrl;
	const streams = await loadStationStreams({ id: 'fluid', playlistUrl: 'https://api.somafm.com/fluid.pls' }, {
		fetchImpl: async (url) => {
			requestUrl = url;
			return { ok: true, text: async () => '[playlist]\nFile1=https://ice6.somafm.com/fluid-128-mp3' };
		},
	});

	assert.equal(requestUrl, 'https://api.somafm.com/fluid.pls');
	assert.deepEqual(streams, ['https://ice6.somafm.com/fluid-128-mp3']);
	await assert.rejects(loadStationStreams({ playlistUrl: 'https://example.com/fluid.pls' }), /ungültige SomaFM-Playlistadresse/i);
	assert.deepEqual(DEFAULT_STATION.streams, [
		'https://ice5.somafm.com/groovesalad-128-mp3',
		'https://ice2.somafm.com/groovesalad-128-mp3',
	]);
});

test('aborts an in-flight catalogue request when its caller signal is cancelled', async () => {
	const controller = new AbortController();
	let requestSignal;
	const pending = loadStations({
		fetchImpl: (_url, options) => {
			requestSignal = options.signal;
			return new Promise((resolve, reject) => {
				options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
			});
		},
		signal: controller.signal,
	});
	controller.abort();

	await assert.rejects(pending, { name: 'AbortError' });
	assert.equal(requestSignal.aborted, true);
});
