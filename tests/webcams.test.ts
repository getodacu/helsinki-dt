import test from 'node:test';
import assert from 'node:assert/strict';
import { WEBCAMS, webcamImageUrl, WEBCAM_STALE_MS } from '../src/lib/webcams.ts';
import { inBounds, RELEASE_BOUNDS } from '../src/lib/area.ts';
import { WebcamCache, decodeWebcamData } from '../src/lib/server/webcams.ts';
import { GET } from '../src/routes/api/webcams/[stationId]/+server.ts';
import type { RequestOptions } from '../src/lib/server/io.ts';

const camera = WEBCAMS[2];
const now = Date.parse('2026-10-10T17:40:00Z');
const data = (measuredTime: unknown = '2026-10-10T17:31:09Z') => ({ id: camera.id, presets: [{ id: camera.presetId, measuredTime }] });

test('the fixed six camera presets lie in scene bounds and only use the public image host', () => {
  assert.deepEqual(WEBCAMS.map(value => [value.id, value.presetId]), [
    ['C01587', 'C0158700'], ['C01590', 'C0159000'], ['C01674', 'C0167400'],
    ['C01675', 'C0167500'], ['C01680', 'C0168000'], ['C01706', 'C0170602']
  ]);
  assert.equal(new Set(WEBCAMS.map(value => value.id)).size, 6);
  for (const value of WEBCAMS) {
    assert.ok(inBounds(value.longitude, value.latitude, RELEASE_BOUNDS));
    const url = new URL(webcamImageUrl(value, '2026-10-10T17:31:09.000Z'));
    assert.equal(url.origin, 'https://weathercam.digitraffic.fi');
    assert.equal(url.pathname, `/${value.presetId}.jpg`);
    assert.equal(url.searchParams.get('time'), '2026-10-10T17:31:09.000Z');
  }
});

test('camera decoding selects the exact preset and validates its reported time', () => {
  assert.equal(decodeWebcamData(data(), camera, now), '2026-10-10T17:31:09.000Z');
  assert.equal(decodeWebcamData(data('2026-10-10T20:31:09+03:00'), camera, now), '2026-10-10T17:31:09.000Z');
  for (const value of [null, {}, { ...data(), id: 'C01675' }, { id: camera.id, presets: [] },
    { id: camera.id, presets: [{ id: 'C0167500', measuredTime: '2026-10-10T17:31:09Z' }] },
    { id: camera.id, presets: [...data().presets, ...data().presets] },
    ...[null, 0, 'invalid', '10/10/2026', '2026-10-10T17:31:09', '2026-10-10T18:00:00Z'].map(time => data(time))]) {
    assert.throws(() => decodeWebcamData(value, camera, now));
  }
});

test('camera cache deduplicates requests, expires after a minute and bounds request access', async () => {
  let calls = 0, clock = now, finish!: (value: { body: string }) => void;
  const cache = new WebcamCache((url, options: RequestOptions) => {
    calls++;
    assert.equal(url, `https://tie.digitraffic.fi/api/weathercam/v1/stations/${camera.id}/data`);
    assert.equal(options.maxBytes, 32 * 1024); assert.equal(options.timeoutMs, 10_000); assert.equal(options.redirect, 'error');
    const headers = new Headers(options.headers);
    assert.equal(headers.get('Accept-Encoding'), 'gzip'); assert.match(headers.get('Digitraffic-User')!, /HelsinkiLens/);
    assert.equal(headers.get('Authorization'), null);
    return new Promise(resolve => finish = resolve);
  }, () => clock);
  const first = cache.get(camera.id), second = cache.get(camera.id);
  await Promise.resolve(); assert.equal(calls, 1);
  finish({ body: JSON.stringify(data()) });
  const [a, b] = await Promise.all([first, second]); assert.deepEqual(a, b); assert.equal(a.state, 'current');
  clock += 59_999; assert.deepEqual(await cache.get(camera.id), a); assert.equal(calls, 1);
  clock++; const next = cache.get(camera.id); await Promise.resolve(); assert.equal(calls, 2);
  finish({ body: JSON.stringify(data()) }); await next;
  await assert.rejects(cache.get('C99999'), /Unknown camera/); assert.equal(calls, 2);
});

test('refresh errors and invalid or regressing data retain their dated result and recover', async () => {
  let clock = now, mode = 'good', calls = 0;
  const cache = new WebcamCache(async () => {
    calls++;
    if (mode === 'offline') throw new Error('Upstream unavailable.');
    return { body: mode === 'invalid' ? '{' : JSON.stringify(data(mode === 'older' ? '2026-10-10T17:20:00Z' : undefined)) };
  }, () => clock);
  const good = await cache.get(camera.id);
  for (const failure of ['offline', 'invalid', 'older']) {
    clock += 60_000; mode = failure;
    const stale = await cache.get(camera.id);
    assert.equal(stale.state, 'stale'); assert.ok(stale.lastError);
    assert.equal(stale.measuredTime, good.measuredTime); assert.equal(stale.receivedAt, good.receivedAt);
  }
  mode = 'good'; clock += 60_000; assert.equal((await cache.get(camera.id)).state, 'current');
  clock = Date.parse(good.measuredTime!) + WEBCAM_STALE_MS + 1;
  assert.equal((await cache.get(camera.id)).state, 'stale'); assert.equal(calls, 6);
  const empty = new WebcamCache(() => { throw new Error('Offline'); }, () => clock);
  assert.equal((await empty.get(camera.id)).state, 'unavailable');
  clock += 60_000; assert.equal((await empty.get(camera.id)).measuredTime, null);
});

test('unknown camera route IDs return 404 without contacting an upstream', async () => {
  for (const stationId of ['C99999', 'C0167400', '../C01674', 'https://example.com']) {
    const response = await GET({ params: { stationId } });
    assert.equal(response.status, 404); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'Unknown camera.' });
  }
});
