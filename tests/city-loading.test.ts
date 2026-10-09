import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetRetries, ViewLoading, type AssetProgress, type BackgroundProgress } from '../src/lib/city-loading.ts';
const background: BackgroundProgress = { phase: 'loading', completed: 0, total: 100, failed: 0 };
const progress: AssetProgress = { discovering: false, completed: 1, total: 2, failed: 0 };

test('view readiness waits for discovery, every required asset, and the actual rendered revision', () => {
  const loading = new ViewLoading();
  assert.equal(loading.update('city', 1, { ...progress, discovering: true }, background, '').phase, 'discovering');
  loading.rendered(1);
  assert.equal(loading.update('city', 1, progress, background, '').phase, 'loading');
  assert.equal(loading.update('city', 2, { ...progress, completed: 2 }, background, '').phase, 'rendering');
  loading.rendered(2);
  assert.equal(loading.update('city', 2, { ...progress, completed: 2 }, background, '').phase, 'ready');
  assert.equal(loading.update('harbour', 2, { ...progress, completed: 2 }, background, '').phase, 'rendering');
  loading.rendered(2);
  assert.equal(loading.update('harbour', 2, { ...progress, completed: 2 }, background, '').phase, 'ready');
});

test('settled source failures reveal available data and quietly recover without covering it again', () => {
  const loading = new ViewLoading(), failed = { ...progress, failed: 1 };
  assert.equal(loading.update('city', 1, failed, background, '').phase, 'rendering');
  loading.rendered(1);
  assert.equal(loading.update('city', 1, failed, background, '').phase, 'available');
  assert.equal(loading.update('city', 2, { ...progress, failed: 0 }, background, '').phase, 'available');
  assert.equal(loading.update('city', 3, { ...progress, completed: 2 }, background, '').phase, 'available');
  loading.rendered(3);
  assert.equal(loading.update('city', 3, { ...progress, completed: 2 }, background, '').phase, 'ready');
  assert.equal(loading.update('energy', 3, progress, background, '').phase, 'loading');
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
  loading.update('empty', 0, empty, background, ''); loading.rendered(0);
  const state = loading.update('empty', 0, empty, { ...background, phase: 'partial', failed: 3 }, 'storage full');
  assert.equal(state.phase, 'ready'); assert.equal(state.background.failed, 3); assert.equal(state.cacheIssue, 'storage full');
});
