import assert from 'node:assert/strict';
import test from 'node:test';
import { DISTRICT_BOUNDS, RELEASE_BOUNDS, SCENE_ORIGIN, inBounds } from '../src/lib/area.ts';

test('Senate district uses longitude/latitude within release bounds', () => {
  assert.ok(inBounds(SCENE_ORIGIN.longitude, SCENE_ORIGIN.latitude, DISTRICT_BOUNDS));
  assert.ok(inBounds(DISTRICT_BOUNDS[0], DISTRICT_BOUNDS[1], RELEASE_BOUNDS));
  assert.ok(inBounds(DISTRICT_BOUNDS[2], DISTRICT_BOUNDS[3], RELEASE_BOUNDS));
  assert.equal(inBounds(SCENE_ORIGIN.latitude, SCENE_ORIGIN.longitude, DISTRICT_BOUNDS), false);
});

test('bounds include edges and reject nonfinite/outside points', () => {
  assert.equal(inBounds(DISTRICT_BOUNDS[0], DISTRICT_BOUNDS[1], DISTRICT_BOUNDS), true);
  assert.equal(inBounds(DISTRICT_BOUNDS[2], DISTRICT_BOUNDS[3], DISTRICT_BOUNDS), true);
  assert.equal(inBounds(24.96, 60.17, DISTRICT_BOUNDS), false);
  assert.equal(inBounds(NaN, 60.17, DISTRICT_BOUNDS), false);
  assert.equal(inBounds(24.95, Infinity, DISTRICT_BOUNDS), false);
});


test('wider release includes western, northern and eastern districts without extending to the metropolitan area', () => {
  for (const [longitude, latitude] of [[24.88,60.16],[24.875,60.198],[24.932,60.20],[24.945,60.217],[25.04,60.20]]) {
    assert.ok(inBounds(longitude, latitude, RELEASE_BOUNDS));
  }
  assert.equal(inBounds(24.66,60.205,RELEASE_BOUNDS),false);
  assert.equal(inBounds(25.04,60.293,RELEASE_BOUNDS),false);
});
