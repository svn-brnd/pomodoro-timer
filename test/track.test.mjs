/* AI: erstellt von GPT-6 Luna (bifrost/azure/gpt-6-luna) | 2026-11-05 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrackMonitor } from '../public/track.mjs';

class FakeTimers {
	constructor() {
		this.nextId = 1;
		this.intervals = new Map();
		this.timeouts = new Map();
	}

	setInterval(callback, delay) {
		const id = this.nextId++;
		this.intervals.set(id, { callback, delay });
		return id;
	}

	clearInterval(id) {
		this.intervals.delete(id);
	}

	setTimeout(callback, delay) {
		const id = this.nextId++;
		this.timeouts.set(id, { callback, delay });
		return id;
	}

	clearTimeout(id) {
		this.timeouts.delete(id);
	}

	fireInterval() {
		this.intervals.values().next().value.callback();
	}
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((complete, fail) => {
		resolve = complete;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function trackResponse(title, artist = 'Interpret', id = 'groovesalad') {
	return { ok: true, json: async () => ({ id, songs: [{ artist, title }] }) };
}

test('fetches immediately, ignores repeated starts and refreshes on the interval', async () => {
	const timers = new FakeTimers();
	const firstResponse = deferred();
	const secondResponse = deferred();
	const firstNotification = deferred();
	const secondNotification = deferred();
	const tracks = [];
	let calls = 0;
	const monitor = createTrackMonitor({
		timers,
		fetchImpl: () => {
			calls += 1;
			return calls === 1 ? firstResponse.promise : secondResponse.promise;
		},
		onTrack: (track) => {
			tracks.push(track);
			if (tracks.length === 1) firstNotification.resolve();
			if (tracks.length === 2) secondNotification.resolve();
		},
	});

	monitor.start();
	monitor.start();
	assert.equal(calls, 1);
	assert.equal(timers.intervals.size, 1);
	timers.fireInterval();
	assert.equal(calls, 1);
	firstResponse.resolve(trackResponse('Titel 1'));
	await firstNotification.promise;
	timers.fireInterval();
	assert.equal(calls, 2);
	secondResponse.resolve(trackResponse('Titel 2'));
	await secondNotification.promise;

	assert.deepEqual(tracks, [
		{ artist: 'Interpret', title: 'Titel 1' },
		{ artist: 'Interpret', title: 'Titel 2' },
	]);
	monitor.stop();
});

test('fetches the fixed SomaFM URL without credentials and displays the first song', async () => {
	const timers = new FakeTimers();
	const notification = deferred();
	const tracks = [];
	let request;
	const monitor = createTrackMonitor({
		timers,
		fetchImpl: async (url, options) => {
			request = { url, options };
			return {
				ok: true,
				json: async () => ({
					id: 'groovesalad',
					songs: [
						{ artist: ' First Artist ', title: ' First Title ' },
						{ artist: 'History Artist', title: 'History Title' },
					],
				}),
			};
		},
		onTrack: (track) => {
			tracks.push(track);
			notification.resolve();
		},
	});

	monitor.start();
	await notification.promise;

	assert.equal(request.url, 'https://somafm.com/songs/groovesalad.json');
	assert.equal(request.options.credentials, 'omit');
	assert.deepEqual(tracks, [{ artist: 'First Artist', title: 'First Title' }]);
	monitor.stop();
});

test('stop clears timers, aborts the request and ignores its late response', async () => {
	const timers = new FakeTimers();
	const response = deferred();
	let signal;
	let callbacks = 0;
	const monitor = createTrackMonitor({
		timers,
		fetchImpl: (_url, options) => {
			signal = options.signal;
			return response.promise;
		},
		onTrack: () => { callbacks += 1; },
	});

	monitor.start();
	monitor.stop();
	monitor.stop();
	assert.equal(signal.aborted, true);
	assert.equal(timers.intervals.size, 0);
	assert.equal(timers.timeouts.size, 0);
	response.resolve(trackResponse('Veraltet'));
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(callbacks, 0);
});

test('does not let an earlier request overwrite metadata after restart', async () => {
	const timers = new FakeTimers();
	const earlierResponse = deferred();
	const currentResponse = deferred();
	const currentNotification = deferred();
	const tracks = [];
	let calls = 0;
	const monitor = createTrackMonitor({
		timers,
		fetchImpl: () => {
			calls += 1;
			return calls === 1 ? earlierResponse.promise : currentResponse.promise;
		},
		onTrack: (track) => {
			tracks.push(track);
			currentNotification.resolve();
		},
	});

	monitor.start();
	monitor.stop();
	monitor.start();
	currentResponse.resolve(trackResponse('Aktuell'));
	await currentNotification.promise;
	earlierResponse.resolve(trackResponse('Veraltet'));
	await Promise.resolve();
	await Promise.resolve();

	assert.deepEqual(tracks, [{ artist: 'Interpret', title: 'Aktuell' }]);
	monitor.stop();
});

test('reports request errors as null and recovers on the next interval', async () => {
	const timers = new FakeTimers();
	const unavailable = deferred();
	const recovered = deferred();
	const missingNotification = deferred();
	const recoveredNotification = deferred();
	const tracks = [];
	let calls = 0;
	const monitor = createTrackMonitor({
		timers,
		fetchImpl: () => {
			calls += 1;
			return calls === 1 ? unavailable.promise : recovered.promise;
		},
		onTrack: (track) => {
			tracks.push(track);
			if (tracks.length === 1) missingNotification.resolve();
			if (tracks.length === 2) recoveredNotification.resolve();
		},
	});

	monitor.start();
	unavailable.reject(new Error('upstream failure'));
	await missingNotification.promise;
	assert.doesNotThrow(() => timers.fireInterval());
	assert.equal(calls, 2);
	recovered.resolve(trackResponse('Wieder da'));
	await recoveredNotification.promise;

	assert.deepEqual(tracks, [null, { artist: 'Interpret', title: 'Wieder da' }]);
	monitor.stop();
});

test('reports unsuccessful or invalid responses as null', async () => {
	const timers = new FakeTimers();
	const notifications = [deferred(), deferred(), deferred(), deferred(), deferred()];
	const tracks = [];
	const invalidResponses = [
		{ ok: false, json: async () => ({}) },
		{ ok: true, json: async () => ({ id: 'wrong-station', songs: [{ artist: 'Interpret', title: 'Titel' }] }) },
		{ ok: true, json: async () => ({ id: 'groovesalad', songs: [] }) },
		trackResponse('Titel', '  '),
		trackResponse('  '),
	];
	let calls = 0;
	const monitor = createTrackMonitor({
		timers,
		fetchImpl: async () => invalidResponses[calls++],
		onTrack: (track) => {
			tracks.push(track);
			notifications[tracks.length - 1]?.resolve();
		},
	});

	monitor.start();
	for (const notification of notifications) {
		await notification.promise;
		if (notification !== notifications.at(-1)) timers.fireInterval();
	}

	assert.deepEqual(tracks, [null, null, null, null, null]);
	monitor.stop();
});

test('switches metadata URLs immediately, aborts the prior station, and ignores its late response', async () => {
	const timers = new FakeTimers();
	const oldResponse = deferred();
	const newResponse = deferred();
	const notification = deferred();
	const tracks = [];
	const requests = [];
	const monitor = createTrackMonitor({
		timers,
		fetchImpl: (url, options) => {
			requests.push({ url, signal: options.signal });
			return requests.length === 1 ? oldResponse.promise : newResponse.promise;
		},
		onTrack: (track) => {
			tracks.push(track);
			if (track?.title === 'Fluid Song' || track === null) notification.resolve();
		},
	});

	monitor.start();
	monitor.start('fluid');
	assert.equal(requests[0].url, 'https://somafm.com/songs/groovesalad.json');
	assert.equal(requests[1].url, 'https://somafm.com/songs/fluid.json');
	assert.equal(requests[0].signal.aborted, true);
	newResponse.resolve(trackResponse('Fluid Song', 'Fluid Artist', 'fluid'));
	await notification.promise;
	oldResponse.resolve(trackResponse('Stale Song'));
	await Promise.resolve();
	await Promise.resolve();

	assert.deepEqual(tracks, [{ artist: 'Fluid Artist', title: 'Fluid Song' }]);
	monitor.stop();
});

test('rejects mismatched response IDs and stops for an invalid station ID', async () => {
	const timers = new FakeTimers();
	const notification = deferred();
	const tracks = [];
	const monitor = createTrackMonitor({
		timers,
		fetchImpl: async () => trackResponse('Wrong station', 'Artist', 'groovesalad'),
		onTrack: (track) => {
			tracks.push(track);
			notification.resolve();
		},
	});

	monitor.start('fluid');
	await notification.promise;
	assert.deepEqual(tracks, [null]);
	assert.equal(monitor.start('../groovesalad'), false);
	assert.equal(timers.intervals.size, 0);
});
