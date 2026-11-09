/* AI: erstellt von GPT-6.1 Sol (bifrost/azure/gpt-6.1-sol) | 2026-11-05 */

import { createReadStream, promises as fs } from 'node:fs';
import { createServer as createHttpServer, setGlobalProxyFromEnv } from 'node:http';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_ROOT = resolve(ROOT, 'public');
const MIME_TYPES = new Map([
	['.html', 'text/html; charset=utf-8'],
	['.css', 'text/css; charset=utf-8'],
	['.mjs', 'text/javascript; charset=utf-8'],
]);
const CURRENT_TRACK_URL = 'https://somafm.com/songs/groovesalad.json';
const CURRENT_TRACK_CACHE_MS = 30_000;
const TRACK_ERROR_MESSAGES = {
	UPSTREAM_HTTP: 'SomaFM meldet einen HTTP-Fehler.',
	INVALID_RESPONSE: 'SomaFM hat eine unlesbare oder ungültige Antwort geliefert.',
	MISSING_TRACK: 'SomaFM hat derzeit keine vollständigen Songdaten bereitgestellt.',
	TIMEOUT: 'Zeitüberschreitung beim Abruf der SomaFM-Titeldaten.',
	DNS_ERROR: 'Die DNS-Auflösung für SomaFM ist fehlgeschlagen.',
	TLS_ERROR: 'Die Zertifikatsprüfung der Verbindung zu SomaFM ist fehlgeschlagen.',
	NETWORK_ERROR: 'Die Netzwerkverbindung zu SomaFM ist fehlgeschlagen.',
};

function trackError(code, details = {}) {
	return { error: 'Current track unavailable', code, message: TRACK_ERROR_MESSAGES[code], ...details };
}

function classifyFetchError(error) {
	const cause = error?.cause;
	const nestedCode = cause?.code ?? (Array.isArray(cause?.errors) ? cause.errors.find((item) => item?.code)?.code : null);
	const rawCode = nestedCode ?? error?.code;
	const nodeCode = typeof rawCode === 'string' && /^[A-Z0-9_]{1,80}$/.test(rawCode) ? rawCode : null;
	const errorName = `${error?.name ?? ''} ${cause?.name ?? ''}`;
	let code = 'NETWORK_ERROR';

	if (/TimeoutError|AbortError/.test(errorName) || ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'].includes(nodeCode)) {
		code = 'TIMEOUT';
	} else if (['ENOTFOUND', 'EAI_AGAIN'].includes(nodeCode)) {
		code = 'DNS_ERROR';
	} else if (nodeCode && /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(nodeCode)) {
		code = 'TLS_ERROR';
	}

	return trackError(code, nodeCode ? { nodeCode } : {});
}

function respond(response, status, message, headers = {}) {
	response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
	response.end(message);
}

function respondJson(response, status, body) {
	const content = JSON.stringify(body);
	response.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
	});
	response.end(content);
}

async function serve(request, response, currentTrack) {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		respond(response, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
		return;
	}

	let url;
	let decodedPath;
	try {
		if (typeof request.url !== 'string' || !request.url.startsWith('/') ||
			request.url.startsWith('//') || request.url.includes('#') || /[\u0000-\u0020]/.test(request.url)) {
			throw new TypeError('Invalid request target');
		}
		url = new URL(request.url, 'http://127.0.0.1');
		const rawPath = request.url.split(/[?#]/, 1)[0];
		decodedPath = decodeURIComponent(rawPath);
		decodeURIComponent(url.search);
	} catch {
		respond(response, 400, 'Bad request');
		return;
	}

	if (decodedPath.includes('\\') || decodedPath.includes('\0') ||
		decodedPath.split('/').some((segment) => segment === '..')) {
		respond(response, 403, 'Forbidden');
		return;
	}

	const requestPath = decodedPath === '/' ? '/index.html' : decodedPath;
	const filePath = resolve(PUBLIC_ROOT, `.${requestPath}`);
	const relativePath = relative(PUBLIC_ROOT, filePath);
	if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		respond(response, 403, 'Forbidden');
		return;
	}

	if (decodedPath === '/api/current-track') {
		if (request.method === 'HEAD') {
			response.writeHead(200, {
				'Content-Type': 'application/json; charset=utf-8',
				'Cache-Control': 'no-store',
			});
			response.end();
			return;
		}

		const track = await currentTrack();
		if (track.error) {
			respondJson(response, 502, track);
			return;
		}
		respondJson(response, 200, track);
		return;
	}

	try {
		const metadata = await fs.stat(filePath);
		if (!metadata.isFile()) {
			respond(response, 404, 'Not found');
			return;
		}
		const contentType = MIME_TYPES.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream';
		response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': metadata.size });
		if (request.method === 'HEAD') {
			response.end();
			return;
		}
		createReadStream(filePath).on('error', () => {
			if (!response.headersSent) respond(response, 500, 'Internal server error');
			else response.destroy();
		}).pipe(response);
	} catch (error) {
		if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
			respond(response, 404, 'Not found');
			return;
		}
		respond(response, 500, 'Internal server error');
	}
}

export function createServer({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
	let cachedTrack = null;
	let cacheExpiresAt = 0;
	let inFlight = null;

	async function retrieveTrack() {
		let upstream;
		try {
			upstream = await fetchImpl(CURRENT_TRACK_URL, { signal: AbortSignal.timeout(5_000) });
		} catch (error) {
			return classifyFetchError(error);
		}

		if (!upstream.ok) {
			const status = Number.isInteger(upstream.status) ? upstream.status : null;
			return trackError('UPSTREAM_HTTP', status === null ? {} : {
				upstreamStatus: status,
				message: `SomaFM meldet HTTP ${status}.`,
			});
		}

		let payload;
		try {
			payload = await upstream.json();
		} catch {
			return trackError('INVALID_RESPONSE');
		}

		if (payload?.id !== 'groovesalad' || !Array.isArray(payload.songs)) {
			return trackError('INVALID_RESPONSE');
		}
		const song = payload.songs[0];
		if (!song) return trackError('MISSING_TRACK');
		if (song.artist == null || song.title == null) return trackError('MISSING_TRACK');
		if (typeof song.artist !== 'string' || typeof song.title !== 'string') {
			return trackError('INVALID_RESPONSE');
		}

		const artist = song.artist.trim();
		const title = song.title.trim();
		if (!artist || !title) return trackError('MISSING_TRACK');
		if (artist.length > 300 || title.length > 300) return trackError('INVALID_RESPONSE');

		const track = { artist, title };
		cachedTrack = track;
		cacheExpiresAt = now() + CURRENT_TRACK_CACHE_MS;
		return track;
	}

	function getCurrentTrack() {
		if (cachedTrack && cacheExpiresAt > now()) return Promise.resolve(cachedTrack);
		cachedTrack = null;
		cacheExpiresAt = 0;
		if (inFlight) return inFlight;

		const pending = Promise.resolve().then(retrieveTrack).finally(() => {
			if (inFlight === pending) inFlight = null;
		});
		inFlight = pending;
		return pending;
	}

	return createHttpServer((request, response) => {
		void serve(request, response, getCurrentTrack);
	});
}

function readPort(value) {
	if (value === undefined || value === '') return 3000;
	if (!/^\d+$/.test(value)) return null;
	const port = Number(value);
	return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
	// Browser und Node benötigen denselben konfigurierten Netzwerkzugang für SomaFM.
	setGlobalProxyFromEnv();
	const port = readPort(process.env.PORT);
	if (port === null) {
		console.error('PORT muss eine Zahl zwischen 1 und 65535 sein.');
		process.exitCode = 1;
	} else {
		const server = createServer();
		server.once('error', () => {
			console.error('Der lokale Pomodoro-Server konnte nicht gestartet werden.');
			process.exitCode = 1;
		});
		server.listen(port, '127.0.0.1', () => {
			console.log(`Pomodoro läuft unter http://127.0.0.1:${port}`);
		});
	}
}
