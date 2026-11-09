/* AI: erstellt von GPT-6 Luna (bifrost/azure/gpt-6-luna) | 2026-11-05 */

import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { createServer } from '../server.mjs';

async function withServer(t, options) {
	const server = createServer(options);
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	t.after(() => new Promise((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	}));
	return server.address().port;
}

function upstreamResponse(payload, ok = true, status = ok ? 200 : 503) {
	return { ok, status, json: async () => payload };
}

function songPayload(song) {
	return { id: 'groovesalad', songs: [song] };
}

async function requestCurrentTrack(t, fetchImpl) {
	const port = await withServer(t, { fetchImpl });
	return request(port, '/api/current-track');
}

function deferred() {
	let resolve;
	const promise = new Promise((complete) => { resolve = complete; });
	return { promise, resolve };
}

function request(port, path, method = 'GET') {
	return new Promise((resolve, reject) => {
		const outgoing = httpRequest({ hostname: '127.0.0.1', port, path, method }, (response) => {
			const chunks = [];
			response.on('data', (chunk) => chunks.push(chunk));
			response.on('end', () => resolve({
				status: response.statusCode,
				headers: response.headers,
				body: Buffer.concat(chunks).toString('utf8'),
			}));
		});
		outgoing.on('error', reject);
		outgoing.end();
	});
}

test('serves the app and supported MIME types with an optional query string', async (t) => {
	const port = await withServer(t);
	const page = await request(port, '/?source=test');
	const css = await request(port, '/styles.css?v=1');
	const module = await request(port, '/timer.mjs?v=1');

	assert.equal(page.status, 200);
	assert.match(page.headers['content-type'], /^text\/html;/);
	assert.equal(css.status, 200);
	assert.match(css.headers['content-type'], /^text\/css;/);
	assert.equal(module.status, 200);
	assert.match(module.headers['content-type'], /^text\/javascript;/);
});

test('supports HEAD without returning the static file body', async (t) => {
	const port = await withServer(t);
	const response = await request(port, '/', 'HEAD');

	assert.equal(response.status, 200);
	assert.equal(response.body, '');
	assert.ok(Number(response.headers['content-length']) > 0);
});

test('rejects malformed and decoded traversal paths and unsupported methods', async (t) => {
	const port = await withServer(t);
	const malformed = await request(port, '/bad%ZZ');
	const traversal = await request(port, '/%2e%2e/server.mjs');
	const unsupported = await request(port, '/', 'POST');

	assert.equal(malformed.status, 400);
	assert.equal(traversal.status, 403);
	assert.equal(unsupported.status, 405);
	assert.equal(unsupported.headers.allow, 'GET, HEAD');
});

test('returns normalized current-track metadata and caches successful results', async (t) => {
	let calls = 0;
	let requestSignal;
	const port = await withServer(t, {
		fetchImpl: async (url, options) => {
			calls += 1;
			assert.equal(url, 'https://somafm.com/songs/groovesalad.json');
			requestSignal = options.signal;
			return upstreamResponse({
				id: 'groovesalad',
				songs: [{ artist: '  Interpret  ', title: ' Titel  ', ignored: 'value' }],
			});
		},
	});
	const first = await request(port, '/api/current-track');
	const second = await request(port, '/api/current-track');

	assert.equal(first.status, 200);
	assert.deepEqual(JSON.parse(first.body), { artist: 'Interpret', title: 'Titel' });
	assert.equal(second.body, first.body);
	assert.equal(calls, 1);
	assert.ok(requestSignal instanceof AbortSignal);
	assert.match(first.headers['content-type'], /^application\/json;/);
	assert.equal(first.headers['cache-control'], 'no-store');
});

test('fetches fresh current-track metadata after the 30-second cache expires', async (t) => {
	let currentTime = 1_000;
	let calls = 0;
	const port = await withServer(t, {
		now: () => currentTime,
		fetchImpl: async () => {
			calls += 1;
			return upstreamResponse({
				id: 'groovesalad',
				songs: [{ artist: 'Interpret', title: `Titel ${calls}` }],
			});
		},
	});
	const first = await request(port, '/api/current-track');
	currentTime += 30_001;
	const second = await request(port, '/api/current-track');

	assert.equal(JSON.parse(first.body).title, 'Titel 1');
	assert.equal(JSON.parse(second.body).title, 'Titel 2');
	assert.equal(calls, 2);
});

test('coalesces simultaneous current-track requests', async (t) => {
	const response = deferred();
	const fetchStarted = deferred();
	let calls = 0;
	const port = await withServer(t, {
		fetchImpl: () => {
			calls += 1;
			fetchStarted.resolve();
			return response.promise;
		},
	});
	const firstRequest = request(port, '/api/current-track');
	const secondRequest = request(port, '/api/current-track');
	await fetchStarted.promise;
	response.resolve(upstreamResponse({ id: 'groovesalad', songs: [{ artist: 'Interpret', title: 'Titel' }] }));
	const responses = await Promise.all([firstRequest, secondRequest]);

	assert.equal(calls, 1);
	assert.deepEqual(responses.map((result) => result.status), [200, 200]);
	assert.deepEqual(JSON.parse(responses[0].body), { artist: 'Interpret', title: 'Titel' });
	assert.equal(responses[1].body, responses[0].body);
});

test('returns a safe 502 instead of expired metadata and recovers on the next request', async (t) => {
	let currentTime = 1_000;
	let calls = 0;
	const port = await withServer(t, {
		now: () => currentTime,
		fetchImpl: async () => {
			calls += 1;
			if (calls === 1 || calls === 3) {
				return upstreamResponse({ id: 'groovesalad', songs: [{ artist: 'Interpret', title: `Titel ${calls}` }] });
			}
			return upstreamResponse({ secret: 'must not leak' }, false, 503);
		},
	});
	const first = await request(port, '/api/current-track');
	currentTime += 30_001;
	const failed = await request(port, '/api/current-track');
	const recovered = await request(port, '/api/current-track');

	assert.equal(JSON.parse(first.body).title, 'Titel 1');
	assert.equal(failed.status, 502);
	assert.deepEqual(JSON.parse(failed.body), {
		error: 'Current track unavailable',
		code: 'UPSTREAM_HTTP',
		message: 'SomaFM meldet HTTP 503.',
		upstreamStatus: 503,
	});
	assert.equal(failed.body.includes('must not leak'), false);
	assert.equal(recovered.status, 200);
	assert.equal(JSON.parse(recovered.body).title, 'Titel 3');
	assert.equal(calls, 3);
});

test('rejects malformed current-track payloads without returning a stale title', async (t) => {
	let calls = 0;
	const port = await withServer(t, {
		fetchImpl: async () => {
			calls += 1;
			return upstreamResponse(calls === 1 ?
				{ id: 'groovesalad', songs: [{ title: 'Titel' }] } :
				{ id: 'other-station', songs: [{ artist: 'Interpret', title: 'Titel' }] });
		},
	});
	const missingArtist = await request(port, '/api/current-track');
	const wrongStation = await request(port, '/api/current-track');

	assert.equal(missingArtist.status, 502);
	assert.equal(wrongStation.status, 502);
	assert.deepEqual(JSON.parse(missingArtist.body), {
		error: 'Current track unavailable',
		code: 'MISSING_TRACK',
		message: 'SomaFM hat derzeit keine vollständigen Songdaten bereitgestellt.',
	});
	assert.deepEqual(JSON.parse(wrongStation.body), {
		error: 'Current track unavailable',
		code: 'INVALID_RESPONSE',
		message: 'SomaFM hat eine unlesbare oder ungültige Antwort geliefert.',
	});
	assert.equal(calls, 2);
});

test('classifies an upstream request timeout without exposing its message or stack', async (t) => {
	const timeout = Object.assign(new Error('sensitive proxy password'), { name: 'TimeoutError' });
	const response = await requestCurrentTrack(t, async () => { throw timeout; });
	const body = JSON.parse(response.body);

	assert.equal(response.status, 502);
	assert.equal(body.code, 'TIMEOUT');
	assert.equal(body.message, 'Zeitüberschreitung beim Abruf der SomaFM-Titeldaten.');
	assert.equal(response.body.includes('sensitive proxy password'), false);
	assert.equal(response.body.includes(timeout.stack), false);
});

test('classifies a nested DNS resolution error and returns its safe node code', async (t) => {
	const cause = Object.assign(new Error('private resolver details'), { code: 'ENOTFOUND' });
	const failure = Object.assign(new Error('request failed'), { cause });
	const response = await requestCurrentTrack(t, async () => { throw failure; });
	const body = JSON.parse(response.body);

	assert.equal(response.status, 502);
	assert.equal(body.code, 'DNS_ERROR');
	assert.equal(body.nodeCode, 'ENOTFOUND');
	assert.equal(response.body.includes('private resolver details'), false);
});

test('classifies a certificate verification error as TLS_ERROR', async (t) => {
	const failure = Object.assign(new Error('certificate path details'), {
		cause: Object.assign(new Error('certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
	});
	const response = await requestCurrentTrack(t, async () => { throw failure; });
	const body = JSON.parse(response.body);

	assert.equal(body.code, 'TLS_ERROR');
	assert.equal(body.nodeCode, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE');
	assert.equal(response.body.includes('certificate path details'), false);
});

test('classifies other fetch failures as NETWORK_ERROR', async (t) => {
	const failure = Object.assign(new Error('private proxy URL'), { code: 'ECONNREFUSED' });
	const response = await requestCurrentTrack(t, async () => { throw failure; });
	const body = JSON.parse(response.body);

	assert.equal(body.code, 'NETWORK_ERROR');
	assert.equal(body.nodeCode, 'ECONNREFUSED');
	assert.equal(response.body.includes('private proxy URL'), false);
});

test('classifies invalid JSON as INVALID_RESPONSE', async (t) => {
	const response = await requestCurrentTrack(t, async () => ({
		...upstreamResponse(null),
		json: async () => { throw new SyntaxError('private parse details'); },
	}));
	const body = JSON.parse(response.body);

	assert.equal(body.code, 'INVALID_RESPONSE');
	assert.equal(response.body.includes('private parse details'), false);
});

test('classifies an empty valid song list as MISSING_TRACK', async (t) => {
	const response = await requestCurrentTrack(t, async () => upstreamResponse({ id: 'groovesalad', songs: [] }));

	assert.equal(JSON.parse(response.body).code, 'MISSING_TRACK');
});

test('classifies a missing artist in a song as MISSING_TRACK', async (t) => {
	const response = await requestCurrentTrack(t, async () => upstreamResponse(songPayload({ title: 'Titel' })));

	assert.equal(JSON.parse(response.body).code, 'MISSING_TRACK');
});

test('classifies blank song metadata as MISSING_TRACK', async (t) => {
	const response = await requestCurrentTrack(t, async () =>
		upstreamResponse(songPayload({ artist: '  ', title: 'Titel' })));

	assert.equal(JSON.parse(response.body).code, 'MISSING_TRACK');
});

test('does not invent an upstream status when the response has none', async (t) => {
	const response = await requestCurrentTrack(t, async () => ({
		ok: false,
		json: async () => ({}),
	}));
	const body = JSON.parse(response.body);

	assert.equal(body.code, 'UPSTREAM_HTTP');
	assert.equal(body.message, 'SomaFM meldet einen HTTP-Fehler.');
	assert.equal(Object.hasOwn(body, 'upstreamStatus'), false);
});

test('supports HEAD without fetching metadata and rejects POST on the metadata route', async (t) => {
	let calls = 0;
	const port = await withServer(t, { fetchImpl: async () => { calls += 1; } });
	const head = await request(port, '/api/current-track', 'HEAD');
	const post = await request(port, '/api/current-track', 'POST');

	assert.equal(head.status, 200);
	assert.equal(head.body, '');
	assert.match(head.headers['content-type'], /^application\/json;/);
	assert.equal(head.headers['cache-control'], 'no-store');
	assert.equal(post.status, 405);
	assert.equal(post.headers.allow, 'GET, HEAD');
	assert.equal(calls, 0);
});
