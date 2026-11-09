/* AI: erstellt von GPT-6 Luna (bifrost/azure/gpt-6-luna) | 2026-11-05 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createAudioController,
	GROOVE_SALAD_FALLBACK,
	GROOVE_SALAD_PRIMARY,
} from '../public/audio.mjs';

class FakeAudio {
	constructor() {
		this.listeners = new Map();
		this.playCalls = 0;
		this.pauseCalls = 0;
		this.loadCalls = 0;
		this.removedAttributes = [];
		this.volume = 1;
		this.playImplementation = () => Promise.resolve();
	}

	addEventListener(type, listener) {
		this.listeners.set(type, listener);
	}

	removeEventListener(type, listener) {
		if (this.listeners.get(type) === listener) this.listeners.delete(type);
	}

	load() {
		this.loadCalls += 1;
	}

	removeAttribute(name) {
		this.removedAttributes.push(name);
		if (name === 'src') this.src = '';
	}

	play() {
		this.playCalls += 1;
		return this.playImplementation();
	}

	pause() {
		this.pauseCalls += 1;
	}

	dispatch(type) {
		this.listeners.get(type)?.();
	}
}

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

test('starts, stops, and does not issue another play call for repeated ticks', async () => {
	const audio = new FakeAudio();
	const statuses = [];
	const controller = createAudioController(audio, (status) => statuses.push(status));

	controller.reconcile(true, 0.35);
	controller.reconcile(true, 0.35);
	await flushPromises();
	controller.reconcile(false, 0.35);
	controller.reconcile(false, 0);

	assert.equal(audio.playCalls, 1);
	assert.equal(audio.pauseCalls, 1);
	assert.equal(audio.volume, 0);
	assert.equal(statuses.at(-1).state, 'idle');
});

test('unloads the live stream on stop and reconnects to the primary stream on restart', async () => {
	const audio = new FakeAudio();
	const controller = createAudioController(audio);

	controller.reconcile(true, 0.35);
	controller.reconcile(false, 0.35);

	assert.deepEqual(audio.removedAttributes, ['src']);
	assert.equal(audio.src, '');
	assert.equal(audio.loadCalls, 2);

	controller.reconcile(true, 0.35);

	assert.equal(audio.src, GROOVE_SALAD_PRIMARY);
	assert.equal(audio.playCalls, 2);
	await flushPromises();
});

test('reports autoplay rejection and permits a deliberate manual retry', async () => {
	const audio = new FakeAudio();
	const statuses = [];
	const controller = createAudioController(audio, (status) => statuses.push(status));
	audio.playImplementation = () => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));

	controller.reconcile(true, 0.5);
	await flushPromises();
	assert.equal(statuses.at(-1).state, 'blocked');

	audio.playImplementation = () => Promise.resolve();
	assert.equal(controller.retry(), true);
	await flushPromises();
	assert.equal(audio.playCalls, 2);
	assert.equal(audio.src, GROOVE_SALAD_PRIMARY);
	assert.equal(statuses.at(-1).state, 'playing');
});

test('tries the fallback stream once and reports exhaustion without looping', async () => {
	const audio = new FakeAudio();
	const statuses = [];
	const pendingResolvers = [];
	audio.playImplementation = () => new Promise((resolve) => pendingResolvers.push(resolve));
	const controller = createAudioController(audio, (status) => statuses.push(status));

	controller.reconcile(true, 0.5);
	audio.dispatch('error');
	assert.equal(audio.src, GROOVE_SALAD_FALLBACK);
	assert.equal(audio.playCalls, 2);
	audio.dispatch('error');
	assert.equal(statuses.at(-1).state, 'error');
	assert.equal(audio.playCalls, 2);
	pendingResolvers.forEach((resolve) => resolve());
	await flushPromises();
	assert.equal(statuses.at(-1).state, 'error');
});

test('falls back after a generic primary play rejection and reports fallback rejection after two attempts', async () => {
	const audio = new FakeAudio();
	const statuses = [];
	const controller = createAudioController(audio, (status) => statuses.push(status));
	let rejectPrimary;
	let rejectFallback;
	audio.playImplementation = () => new Promise((resolve, reject) => {
		if (audio.playCalls === 1) rejectPrimary = reject;
		else rejectFallback = reject;
	});

	controller.reconcile(true, 0.5);
	rejectPrimary(new Error('primary stream failed'));
	await flushPromises();
	assert.equal(audio.src, GROOVE_SALAD_FALLBACK);
	assert.equal(audio.playCalls, 2);

	rejectFallback(new Error('fallback stream failed'));
	await flushPromises();
	assert.equal(statuses.at(-1).state, 'error');
	assert.equal(audio.playCalls, 2);
});

test('does not report stale playback after stop resolves a pending play request', async () => {
	const audio = new FakeAudio();
	const statuses = [];
	let resolvePlay;
	audio.playImplementation = () => new Promise((resolve) => { resolvePlay = resolve; });
	const controller = createAudioController(audio, (status) => statuses.push(status));

	controller.reconcile(true, 1);
	controller.reconcile(false, 1);
	resolvePlay();
	await flushPromises();

	assert.equal(statuses.at(-1).state, 'idle');
	assert.equal(audio.pauseCalls, 2);
});

test('switches a playing station and falls back only through that station’s streams', async () => {
	const audio = new FakeAudio();
	const statuses = [];
	const controller = createAudioController(audio, (status) => statuses.push(status));
	controller.reconcile(true, 0.5);
	await flushPromises();
	controller.setStation({ title: 'Fluid', streams: ['https://ice6.somafm.com/fluid-128-mp3', 'https://ice2.somafm.com/fluid-128-mp3'] });

	assert.equal(audio.src, 'https://ice6.somafm.com/fluid-128-mp3');
	assert.equal(statuses.at(-1).state, 'connecting');
	audio.dispatch('error');
	assert.equal(audio.src, 'https://ice2.somafm.com/fluid-128-mp3');
	assert.equal(audio.playCalls, 3);
	await flushPromises();
	assert.equal(statuses.at(-1).message, 'Fluid läuft.');
});

test('configures a changed station while paused without starting playback', () => {
	const audio = new FakeAudio();
	const controller = createAudioController(audio);
	controller.setStation({ title: 'Drone Zone', streams: ['https://ice6.somafm.com/dronezone-128-mp3'] });

	assert.equal(audio.src, undefined);
	assert.equal(audio.playCalls, 0);
	controller.reconcile(true, 0.35);
	assert.equal(audio.src, 'https://ice6.somafm.com/dronezone-128-mp3');
	assert.equal(audio.playCalls, 1);
});

test('ignores an earlier station play promise after a switch', async () => {
	const audio = new FakeAudio();
	const statuses = [];
	let resolveOldPlay;
	audio.playImplementation = () => audio.playCalls === 1 ?
		new Promise((resolve) => { resolveOldPlay = resolve; }) : Promise.resolve();
	const controller = createAudioController(audio, (status) => statuses.push(status));
	controller.reconcile(true, 0.5);
	controller.setStation({ title: 'Sonic Universe', streams: ['https://ice6.somafm.com/sonicuniverse-128-mp3'] });
	await flushPromises();
	const currentStatus = statuses.at(-1);
	resolveOldPlay();
	await flushPromises();

	assert.equal(statuses.at(-1), currentStatus);
	assert.equal(statuses.at(-1).message, 'Sonic Universe läuft.');
});
