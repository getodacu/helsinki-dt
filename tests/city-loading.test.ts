import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetRetries, ViewLoading, type AssetProgress, type BackgroundProgress } from '../src/lib/city-loading.ts';
const background: BackgroundProgress = { phase: 'loading', completed: 0, total: 100, failed: 0 };
const progress: AssetProgress = { discovering: false, completed: 1, total: 2, failed: 0 };

test('semantic readiness waits for discovery, every visible chunk, and the actual rendered revision', () => {
  const loading = new ViewLoading();
  assert.equal(loading.update('city', 1, { ...progress, discovering: true }, background, '', null).phase, 'discovering');
  loading.rendered(1, 0);
  assert.equal(loading.update('city', 1, progress, background, '', null).phase, 'loading');
  assert.equal(loading.update('city', 2, { ...progress, completed: 2 }, background, '', null).phase, 'rendering');
  loading.rendered(2, 0);
  const coarse = loading.update('city', 2, { ...progress, completed: 2 }, background, '', null);
  assert.equal(coarse.phase, 'ready'); assert.equal(coarse.refinement.phase, 'waiting');
  assert.equal(loading.update('harbour', 2, { ...progress, completed: 2 }, background, '', null).phase, 'rendering');
  loading.rendered(2, 0);
  assert.equal(loading.update('harbour', 2, { ...progress, completed: 2 }, background, '', null).phase, 'ready');
});

test('optional discovery, downloads, errors and rendered detail never block a complete semantic map', () => {
  const loading = new ViewLoading(), semantic = { ...progress, completed: 2 };
  loading.update('city', 1, semantic, background, '', null); loading.rendered(1, 0);
  for (const [detail, phase] of [
    [{ ...progress, discovering: true }, 'discovering'], [progress, 'loading'], [{ ...progress, failed: 1 }, 'error']
  ] as const) {
    const state = loading.update('city', 1, semantic, background, '', { revision: 2, progress: detail });
    assert.equal(state.phase, 'ready'); assert.equal(state.refinement.phase, phase);
  }
  const detail = { revision: 3, progress: semantic };
  assert.equal(loading.update('city', 1, semantic, background, '', detail).refinement.phase, 'rendering');
  loading.rendered(1, 3);
  assert.equal(loading.update('city', 1, semantic, background, '', detail).refinement.phase, 'ready');
  loading.retry();
  const retry = loading.update('city', 1, semantic, background, '', detail);
  assert.equal(retry.phase, 'rendering'); assert.equal(retry.refinement.phase, 'rendering');
  loading.rendered(1, 3);
  assert.equal(loading.update('city', 1, semantic, background, '', detail).refinement.phase, 'ready');
});

test('semantic failures remain distinct from complete coverage and quietly recover without covering retained data', () => {
  const loading = new ViewLoading(), failed = { ...progress, failed: 1 };
  assert.equal(loading.update('city', 1, failed, background, '', null).phase, 'rendering');
  loading.rendered(1, 0);
  const partial = loading.update('city', 1, failed, background, '', null);
  assert.equal(partial.phase, 'available'); assert.equal(partial.failed, 1);
  assert.equal(loading.update('city', 2, { ...progress, failed: 0 }, background, '', null).phase, 'available');
  assert.equal(loading.update('city', 3, { ...progress, completed: 2 }, background, '', null).phase, 'available');
  loading.rendered(3, 0);
  assert.equal(loading.update('city', 3, { ...progress, completed: 2 }, background, '', null).phase, 'ready');
  assert.equal(loading.update('energy', 3, progress, background, '', null).phase, 'loading');
});

test('failed assets retry with bounded backoff and successful recovery resets the delay', () => {
  const retries = new AssetRetries();
  assert.equal(retries.ready('tile', 0), true);
  retries.fail('tile', 0); assert.equal(retries.ready('tile', 999), false); assert.equal(retries.ready('tile', 1000), true);
  retries.fail('tile', 1000); assert.equal(retries.ready('tile', 2999), false); assert.equal(retries.ready('tile', 3000), true);
  for (let i = 0; i < 20; i++) retries.fail('tile', 3000);
  assert.equal(retries.ready('tile', 62999), false); assert.equal(retries.ready('tile', 63000), true);
  retries.delete('tile'); assert.equal(retries.has('tile'), false); retries.fail('tile', 0); assert.equal(retries.ready('tile', 1000), true);
});

test('disabled layers do not block readiness and background failures do not cover a complete view', () => {
  const loading = new ViewLoading(), empty = { discovering: false, completed: 0, total: 0, failed: 0 };
  loading.update('empty', 0, empty, background, '', null); loading.rendered(0, 0);
  const state = loading.update('empty', 0, empty, { ...background, phase: 'partial', failed: 3 }, 'storage full', { revision: 0, progress: empty });
  assert.equal(state.phase, 'ready'); assert.equal(state.background.failed, 3); assert.equal(state.cacheIssue, 'storage full');
  assert.equal(state.refinement.phase, 'ready');
});
