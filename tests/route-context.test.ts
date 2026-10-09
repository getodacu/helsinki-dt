import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { boundedShape, journeyIdentity, routeForJourney, RouteContextStore, type RouteIndex } from '../src/lib/server/route-context.ts';
import { routeRequestUrl } from '../src/lib/route-context.ts';
import { prepareRouteIndex, publishRouteIndex, matchingRouteRetrieval } from '../scripts/prepare-routes.ts';
import { decodeHfp } from '../src/lib/data/hfp.ts';
import { RELEASE_BOUNDS, inBounds } from '../src/lib/area.ts';
import type { GtfsSnapshot } from '../src/lib/data/gtfs.ts';
import type { HfpRawSample } from '../scripts/transit.ts';
const samples: HfpRawSample[] = JSON.parse(await readFile(new URL('./fixtures/hfp-samples.json', import.meta.url), 'utf8'));
const feed: GtfsSnapshot = JSON.parse(await readFile(new URL('./fixtures/gtfs-selected.json', import.meta.url), 'utf8'));
const sample = samples.find(sample => sample.topic.includes('/tram/'))!;
const vehicle = decodeHfp(sample.topic, sample.payload, sample.receivedAt);
// Coordinates and the second stop are deterministic synthetic geometry, never live-source evidence.
const fixture = (): RouteIndex => ({ version: 1, generatedAt: '2026-10-08T12:00:00Z', sourceId: 'hsl-gtfs', bounds: [...RELEASE_BOUNDS],
  source: {url:'https://infopalvelut.storage.hsldev.com/gtfs/hsl.zip',archiveSha256:'a'.repeat(64),feedVersion:feed.feedInfo[0].feed_version,validFrom:'2026-10-07',validTo:'2026-12-05',retrievedAt:null},
  routes: { '1009': {label:'9',name:'Fixture route',mode:'tram'} }, calendar: structuredClone(feed.calendar), calendarDates: [], feedInfo: feed.feedInfo,
  trips: [[feed.trips[0].trip_id,'1009',feed.trips[0].service_id,'0','shape','Ilmala','13:27:00',feed.firstStops[0].stop_id,'pattern']],
  shapes: {shape:[[[24.952,60.1695],[24.953,60.17]]]},
  stops: {[feed.firstStops[0].stop_id]:{name:'First fixture stop',longitude:24.952,latitude:60.1695},second:{name:'Second fixture stop',longitude:24.953,latitude:60.17}},
  patterns: {pattern:[[feed.firstStops[0].stop_id,1],['second',3]]} });

test('selected route preserves A exact journey identity and uses actual bounded shape/stop identities', () => {
  const index = fixture(), route = routeForJourney(vehicle,index);
  assert.equal(route.status,'exact'); assert.equal(route.tripId,feed.trips[0].trip_id); assert.equal(route.routeLabel,'9');
  assert.equal(route.destination,'Ilmala'); assert.equal(route.departureAt,'2026-10-08T10:27:00.000Z');
  assert.deepEqual(route.shape,index.shapes.shape); assert.deepEqual(route.stops.map(stop=>[stop.id,stop.sequence]),index.patterns.pattern);
  assert.ok(route.shape.flat().every(([lon,lat])=>inBounds(lon,lat,RELEASE_BOUNDS)));
  // HSL publishes no owner/operator crosswalk: different owners retain the same explicit schedule match rules.
  assert.equal(routeForJourney({...vehicle,id:'0099/00100',ownerOperatorId:'0099'},index).status,'exact');
});
test('direction, service exceptions and ambiguity never produce guessed geometry', () => {
  const index = fixture();
  assert.equal(routeForJourney({...vehicle,directionId:'2'},index).status,'missing');
  index.calendarDates=[{service_id:feed.trips[0].service_id,date:'20261008',exception_type:'2'}];
  assert.equal(routeForJourney(vehicle,index).status,'missing'); index.calendarDates=[];
  index.trips.push([...index.trips[0]]); index.trips[1][0]='competing-trip';
  const ambiguous=routeForJourney(vehicle,index); assert.equal(ambiguous.status,'ambiguous');
  assert.equal(ambiguous.tripId,null); assert.deepEqual(ambiguous.shape,[]); assert.deepEqual(ambiguous.stops,[]); assert.match(ambiguous.reason!,/More than one/);
  assert.equal(routeForJourney({...vehicle,serviceDate:'2026-12-06'},index).status,'unavailable');
});
test('overnight 25:10 departure keeps the previous service date and wraps only the Helsinki matching clock', () => {
  const index=fixture(); index.trips[0][6]='25:10:00';
  const overnight={...vehicle,startTime:'01:10',serviceDate:'2026-10-08'};
  const route=routeForJourney(overnight,index);
  assert.equal(route.status,'exact'); assert.equal(route.departureAt,'2026-10-08T22:10:00.000Z');
  assert.equal(routeForJourney({...overnight,serviceDate:'2026-10-09'},index).status,'missing');
  assert.equal(routeForJourney({...overnight,startTime:'25:10'},index).status,'missing');
});
test('shape clipping retains boundary crossings and separate reentries without connecting an outside gap', () => {
  const west=RELEASE_BOUNDS[0];
  const clipped=boundedShape([[west-0.01,60.17],[west+0.01,60.17],[west-0.01,60.18],[west+0.01,60.18]]);
  assert.equal(clipped.length,2); assert.ok(clipped.flat().every(([lon,lat])=>inBounds(lon,lat,RELEASE_BOUNDS)));
  assert.equal(clipped[0][0][0],RELEASE_BOUNDS[0]); assert.equal(clipped[1][0][0],RELEASE_BOUNDS[0]);
  assert.deepEqual(boundedShape([[west-0.06,60.17],[west-0.02,60.17]]),[]);
});
test('journey query validates exact bounded identifiers, duplicate inputs and calendar dates', () => {
  const url=new URL(routeRequestUrl(vehicle),'http://fixture'); assert.equal(journeyIdentity(url.searchParams).id,vehicle.id);
  for (const [key,value] of [['ownerOperatorId','40'],['vehicleId','x'],['routeId','../archive'],['directionId','0'],['serviceDate','2026-02-30'],['startTime','25:10']]) {
    const query=new URLSearchParams(url.searchParams); query.set(key,value); assert.throws(()=>journeyIdentity(query));
  }
  const repeated=new URLSearchParams(url.searchParams); repeated.append('routeId','1009'); assert.throws(()=>journeyIdentity(repeated));
  const unknown=new URLSearchParams(url.searchParams); unknown.set('archive','/etc/passwd'); assert.throws(()=>journeyIdentity(unknown));
});
test('prepared store shares bounded cached lookups, reloads new assets and exposes malformed source as unavailable', async () => {
  const directory=await mkdtemp(join(tmpdir(),'helsinki-route-store-')); let now=0; const path=join(directory,'index.json');
  try {
    await writeFile(path,JSON.stringify(fixture())); const store=new RouteContextStore(path,()=>now);
    const catalogs=await Promise.all([store.catalog(),store.catalog()]); assert.ok(catalogs.every(c=>c.status==='ready')); assert.equal(catalogs[0].routes[0].label,'9');
    const [one,two]=await Promise.all([store.journey(vehicle),store.journey(vehicle)]); assert.equal(one.status,'exact'); assert.equal(one,two);
    const invalid=fixture(); invalid.patterns.pattern=[['missing-stop',1]]; await writeFile(path,JSON.stringify(invalid)); now+=60_001;
    assert.equal((await store.catalog()).status,'unavailable'); assert.deepEqual((await store.journey(vehicle)).shape,[]);
    await writeFile(path,JSON.stringify(fixture())); now+=60_001; assert.equal((await store.journey(vehicle)).status,'exact');
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test('prepared input validation rejects bad routes, calendars, shapes, stops, patterns and metadata independently', async () => {
  const directory=await mkdtemp(join(tmpdir(),'helsinki-invalid-route-')); const path=join(directory,'index.json');
  const mutations: ((index:RouteIndex)=>void)[] = [
    i=>{i.routes['1009'].mode='other' as never;}, i=>{i.calendar[0].thursday='unknown';},
    i=>{i.calendarDates=[{service_id:'service',date:'20261008',exception_type:'3'}];},
    i=>{i.shapes.shape[0][0][0]=25.5;},i=>{i.stops.second.latitude=0;},i=>{i.patterns.pattern=[['second',2],['second',1]];},
    i=>{i.source.archiveSha256='unknown';},i=>{i.feedInfo=[{feed_start_date:'20261008',feed_end_date:'20261007'}];},
    i=>{i.trips[0][6]='bad';},i=>{i.trips.push([...i.trips[0]]);},
  ];
  try { for (const mutate of mutations) { const index=fixture(); mutate(index); await writeFile(path,JSON.stringify(index)); assert.equal((await new RouteContextStore(path).catalog()).status,'unavailable'); } }
  finally {await rm(directory,{recursive:true,force:true});}
});
test('route preparation streams a tiny shuffled fixture into sorted real stop sequences and atomic bounded publication', async () => {
  const directory=await mkdtemp(join(tmpdir(),'helsinki-route-preparation-')); const archive=join(directory,'tiny.zip'), output=join(directory,'route-index.json');
  const source={
    'routes.txt':'route_id,route_type,route_short_name,route_long_name\n1009,0,9,Fixture route\n',
    'calendar.txt':Object.keys(feed.calendar[0]).join(',')+'\n'+Object.values(feed.calendar[0]).join(',')+'\n',
    'feed_info.txt':Object.keys(feed.feedInfo[0]).join(',')+'\n'+Object.values(feed.feedInfo[0]).join(',')+'\n',
    'trips.txt':`route_id,service_id,trip_id,direction_id,shape_id,trip_headsign\n1009,${feed.trips[0].service_id},${feed.trips[0].trip_id},0,shape,Ilmala\n`,
    'shapes.txt':'shape_id,shape_pt_lon,shape_pt_lat,shape_pt_sequence\nshape,24.953,60.17,2\nshape,24.952,60.1695,1\n',
    'stops.txt':`stop_id,stop_name,stop_lon,stop_lat\n${feed.firstStops[0].stop_id},Fixture first,24.952,60.1695\nsecond,Fixture second,24.953,60.17\noutside,Outside,26,60\n`,
    'stop_times.txt':`trip_id,departure_time,stop_id,stop_sequence\n${feed.trips[0].trip_id},13:30:00,second,3\n${feed.trips[0].trip_id},13:27:00,${feed.firstStops[0].stop_id},1\n${feed.trips[0].trip_id},13:40:00,outside,4\n`,
  };
  try {
    execFileSync('python3',['-c','import sys,json,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); [z.writestr(k,v) for k,v in json.load(sys.stdin).items()]; z.close()',archive],{input:JSON.stringify(source)});
    const index=await prepareRouteIndex(archive); assert.equal(index.trips.length,1); assert.equal(index.stops.outside,undefined);
    assert.deepEqual(routeForJourney(vehicle,index).stops.map(s=>s.sequence),[1,3]);
    assert.equal(index.source.retrievedAt,null); assert.match(index.source.archiveSha256,/^[a-f0-9]{64}$/);
    assert.ok(await publishRouteIndex(index,output)>0); assert.equal((await new RouteContextStore(output).journey(vehicle)).status,'exact');
    source['trips.txt']+=`1009,${feed.trips[0].service_id},outside-trip,0,outside-shape,Outside destination\n`;
    source['shapes.txt']+='outside-shape,26,60,1\noutside-shape,26.1,60,2\n';
    source['stop_times.txt']+='outside-trip,13:27:00,outside,1\n';
    execFileSync('python3',['-c','import sys,json,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); [z.writestr(k,v) for k,v in json.load(sys.stdin).items()]; z.close()',archive],{input:JSON.stringify(source)});
    const competing=await prepareRouteIndex(archive);
    assert.equal(competing.trips.length,2); assert.deepEqual(competing.shapes['outside-shape'],[]);
    const ambiguous=routeForJourney(vehicle,competing); assert.equal(ambiguous.status,'ambiguous'); assert.deepEqual(ambiguous.shape,[]);
    assert.ok(ambiguous.candidates.includes('outside-trip'));
    await publishRouteIndex(competing,output); assert.equal((await new RouteContextStore(output).journey(vehicle)).status,'ambiguous');
    for (const [type, mode] of [['701', 'bus'], ['702', 'bus'], ['704', 'bus'], ['3', 'bus'], ['900', 'tram'], ['4', 'ferry']]) {
      source['routes.txt'] = `route_id,route_type,route_short_name,route_long_name\n1009,${type},9,Fixture route\n`;
      execFileSync('python3',['-c','import sys,json,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); [z.writestr(k,v) for k,v in json.load(sys.stdin).items()]; z.close()',archive],{input:JSON.stringify(source)});
      const modes = await prepareRouteIndex(archive);
      assert.equal(modes.routes['1009'].mode, mode); assert.equal(modes.routes['1009'].label, '9');
      assert.equal(modes.trips.length, 2);
    }
  } finally {await rm(directory,{recursive:true,force:true});}
});


test('retrieval time is recovered only from a source record with the same archive checksum', () => {
  const retrievedAt='2026-10-08T10:54:54.985Z';
  assert.equal(matchingRouteRetrieval('same',{checksum:'same',retrievedAt}),retrievedAt);
  assert.equal(matchingRouteRetrieval('new',{checksum:'old',retrievedAt}),null);
  assert.equal(matchingRouteRetrieval('same',{checksum:'same',retrievedAt:'unknown'}),null);
  assert.equal(matchingRouteRetrieval('same',null),null);
});
