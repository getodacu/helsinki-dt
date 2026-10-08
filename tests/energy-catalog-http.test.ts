import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { GET } from '../src/routes/api/energy/catalog/+server.ts';
import { energyCatalogStore } from '../src/lib/server/energy-catalog.ts';
import type { EnergyCatalogState } from '../src/lib/energy-types.ts';

test('catalog transport preserves states and negotiates bounded cached gzip', async () => {
  const load = energyCatalogStore.load;
  let state: EnergyCatalogState = { status: 'unavailable', catalog: null, attemptedAt: null, message: 'No prepared data.' };
  energyCatalogStore.load = async () => state;
  const get = (encoding: string, query = '') => {
    const url = new URL('http://localhost/api/energy/catalog' + query);
    return GET({ url, request: new Request(url, { headers: { 'Accept-Encoding': encoding } }) });
  };
  try {
    for (const encoding of ['', 'identity', 'gzip;q=0', 'gzip;q=0, *;q=1', 'gzip;q=broken', 'gzip;q=2']) {
      const response = await get(encoding);
      assert.equal(response.headers.get('Content-Encoding'), null);
      assert.equal(response.headers.get('Vary'), 'Accept-Encoding');
      assert.deepEqual(await response.json(), state);
    }
    for (const encoding of ['gzip', 'br, gzip;q=0.5', '*', 'GZIP', 'gzip ; q=0.5', 'identity;q=0, gzip;q=1']) {
      const responses = await Promise.all([get(encoding), get(encoding)]);
      for (const response of responses) {
        assert.equal(response.headers.get('Content-Encoding'), 'gzip');
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.deepEqual(JSON.parse(gunzipSync(new Uint8Array(await response.arrayBuffer())).toString()), state);
      }
    }
    for (const encoding of ['identity;q=0, gzip;q=0, *;q=0', 'identity;q=0, br;q=1', '*;q=0']) {
      const response = await get(encoding);
      assert.equal(response.status, 406);
      assert.equal(await response.text(), '');
    }
    assert.deepEqual(await (await get('identity;q=1, *;q=0')).json(), state);
    state = { ...state, status: 'stale', attemptedAt: '2026-10-08T14:00:00.000Z', message: 'A changed dated status.' };
    assert.deepEqual(JSON.parse(gunzipSync(new Uint8Array(await (await get('gzip')).arrayBuffer())).toString()), state);
    assert.equal((await get('gzip', '?extra=1')).status, 400);
  } finally { energyCatalogStore.load = load; }
});
