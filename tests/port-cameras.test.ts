import test from 'node:test';
import assert from 'node:assert/strict';
import { PORT_CAMERAS, PORT_HARBOURS, PORT_SNAPSHOT_REFRESH_MS, portCameraById, portCameraUrl } from '../src/lib/port-cameras.ts';
import { inBounds, RELEASE_BOUNDS } from '../src/lib/area.ts';

test('two harbour access POIs are in bounds and open their expected video cameras', () => {
  assert.deepEqual(PORT_HARBOURS.map(harbour => [harbour.id, harbour.longitude, harbour.latitude, harbour.defaultCameraId]), [
    ['port-south', 24.958939, 60.160694, 'south'], ['port-west', 24.9151515, 60.1503136, 'west-lt2']
  ]);
  for (const harbour of PORT_HARBOURS) {
    assert.ok(inBounds(harbour.longitude, harbour.latitude, RELEASE_BOUNDS));
    const camera = portCameraById(harbour.defaultCameraId)!;
    assert.equal(camera.kind, 'video'); assert.equal(camera.harbour, harbour.id.slice(5));
  }
  assert.equal(portCameraById('unknown'), undefined);
});

test('the six fixed views use permanent privacy-enhanced players or one-minute direct snapshots', () => {
  assert.deepEqual(PORT_CAMERAS.map(camera => [camera.id, camera.kind]), [
    ['south', 'video'], ['west', 'snapshot'], ['west-lt1', 'video'], ['west-lt2', 'video'], ['west-parking', 'snapshot'], ['vuosaari', 'snapshot']
  ]);
  assert.equal(new Set(PORT_CAMERAS.map(camera => camera.id)).size, 6);
  assert.equal(PORT_SNAPSHOT_REFRESH_MS, 60_000);
  const players = ['3ae88840a60d5a4', 'ma52UptmU7U6CRr1ex5jmifyNuHAdoBG5cmVWA5n', 'kWuatAApKSPHkY3E6R4PFZnpuSCJIhHZ1qnzza8I'];
  const snapshots = ['Lansisatama.jpg', 'lansisatama_p_alue.jpg', 'vuosa00001.jpg'];
  for (const camera of PORT_CAMERAS) {
    const page = new URL(camera.pageUrl), url = new URL(portCameraUrl(camera, 1_791_660_001_999));
    assert.equal(page.origin, 'https://www.portofhelsinki.fi'); assert.match(page.pathname, /^\/en\/about-us\/port-of-helsinki\/web-camera-/);
    if (camera.kind === 'video') {
      assert.equal(url.origin, 'https://camstreamer.com'); assert.equal(url.pathname, `/embed/${players.shift()}/S-28179`);
      assert.equal(url.searchParams.get('cookie'), 'off'); assert.equal(url.searchParams.get('autoplay'), '0'); assert.equal(url.searchParams.get('mute'), '1');
      assert.equal(portCameraUrl(camera, 0), portCameraUrl(camera, 60_000));
    } else {
      assert.equal(url.origin, 'https://www.portofhelsinki.fi'); assert.equal(url.pathname, `/webcams/${snapshots.shift()}`);
      assert.equal(url.search, '?1791660001'); assert.notEqual(portCameraUrl(camera, 0), portCameraUrl(camera, 60_000));
    }
  }
  assert.equal(PORT_CAMERAS.filter(camera => camera.harbour === 'vuosaari').length, 1);
  assert.equal(PORT_HARBOURS.length, 2);
});
