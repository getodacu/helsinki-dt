import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import mqtt, { type MqttClient } from 'mqtt';
import { RELEASE_BOUNDS } from '../src/lib/area.ts';
import { decodeMarineMqttPosition } from '../src/lib/data/marine.ts';
import { marineDistanceMetres, marineFreshness, MARINE_STATIONARY_SPEED } from '../src/lib/marine.ts';
import { MarineFeed, MARINE_LIMITS, MARINE_TOPICS, type MarineConnection, type MarineFeedUpdate } from '../src/lib/server/marine-feed.ts';
import { TRAFFIC_IDLE_MS, TRAFFIC_MAX_QUEUE_BYTES, type TrafficEvent } from '../src/lib/traffic.ts';
import { TrafficFeed, type TrafficConnection } from '../src/lib/server/traffic.ts';
import { createTrafficResponse } from '../src/lib/server/traffic-stream.ts';
import { RailFeed } from '../src/lib/server/rail-feed.ts';
import { requestText, UpstreamHttpError } from '../src/lib/server/io.ts';
import type { Vehicle } from '../src/lib/types.ts';

const numeric = (name: string, fallback: number, minimum: number, maximum: number) => {
  const raw = process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const value = raw === undefined ? fallback : Number(raw);
  assert(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `Invalid ${name}: ${minimum}..${maximum}`); return value;
};
class Histogram {
  bins = new Uint32Array(1802); count = 0; min: number | null = null; max: number | null = null;
  add(value: number) { assert(Number.isFinite(value)); this.bins[Math.min(1801, Math.floor(Math.max(0, value) / 1000))]++;
    this.count++; this.min = this.min === null ? value : Math.min(this.min, value); this.max = this.max === null ? value : Math.max(this.max, value); }
  percentile(ratio: number) { if (!this.count) return null; let count = 0;
    for (let i = 0; i < this.bins.length; i++) { count += this.bins[i]; if (count >= this.count * ratio) return i * 1000; } return null; }
  summary() { return { count: this.count, bucketWidthMs: 1000, overflowAtMs: 1801000, p50: this.percentile(.5), p95: this.percentile(.95), min: this.min, max: this.max }; }
}
type Point = { reportedAt: string; receivedAt: string; longitude: number; latitude: number; speedMetresPerSecond: number | null; positionSource: string };
const point = (vehicle: Vehicle): Point => ({ reportedAt: vehicle.reportedAt, receivedAt: vehicle.receivedAt,
  longitude: vehicle.longitude!, latitude: vehicle.latitude!, speedMetresPerSecond: vehicle.speedMetresPerSecond, positionSource: vehicle.marine!.positionSource });
class Observations {
  reports = 0; peak = 0; untrackedReports = 0; snapshotBytesPeak = 0; movingReports = 0; stationaryReports = 0;
  reportingAge = new Histogram(); deliveryAge = new Histogram(); flags: Record<string, number> = {};
  records = new Map<string, { mmsi: string; first: Point; last: Point; reports: number; movingReports: number; stationaryReports: number;
    gaps: {count:number; minMs:number|null; maxMs:number|null; totalMs:number}; metadataKnown:boolean; named:boolean; maximumDisplacementMetres:number }>();
  movingTracks = new Map<string, Point[]>();
  update(update: MarineFeedUpdate, now: number) {
    this.peak = Math.max(this.peak, update.vehicles.length); this.snapshotBytesPeak = Math.max(this.snapshotBytesPeak, Buffer.byteLength(JSON.stringify(update)));
    for (const vehicle of update.vehicles) {
      const mmsi = vehicle.marine!.mmsi; let record = this.records.get(mmsi);
      if (record) { record.metadataKnown = !!vehicle.marine!.metadataReportedAt; record.named = !!vehicle.marine!.name;
        if (record.last.reportedAt === vehicle.reportedAt && record.last.positionSource === vehicle.marine!.positionSource) continue; }
      else {
        if (this.records.size >= MARINE_LIMITS.identities) { this.untrackedReports++; continue; }
        record = { mmsi, first:point(vehicle),last:point(vehicle),reports:0,movingReports:0,stationaryReports:0,
          gaps:{count:0,minMs:null,maxMs:null,totalMs:0}, metadataKnown:!!vehicle.marine!.metadataReportedAt,named:!!vehicle.marine!.name,maximumDisplacementMetres:0 };
        this.records.set(mmsi, record);
      }
      this.reports++; record.reports++; this.reportingAge.add(Date.parse(vehicle.receivedAt) - Date.parse(vehicle.reportedAt));
      this.deliveryAge.add(now - Date.parse(vehicle.receivedAt)); for (const flag of vehicle.quality) this.flags[flag] = (this.flags[flag] ?? 0) + 1;
      const previous = record.last, next = point(vehicle), gap = Date.parse(next.reportedAt) - Date.parse(previous.reportedAt);
      if (gap > 0) { record.gaps.count++; record.gaps.totalMs += gap; record.gaps.minMs = Math.min(record.gaps.minMs ?? gap, gap); record.gaps.maxMs = Math.max(record.gaps.maxMs ?? gap, gap); }
      const displacement = marineDistanceMetres(previous, next); record.maximumDisplacementMetres = Math.max(record.maximumDisplacementMetres, displacement);
      const moving = (vehicle.speedMetresPerSecond ?? 0) > MARINE_STATIONARY_SPEED;
      const stationary = marineFreshness(vehicle).removeMs === 1_800_000;
      if (moving) { this.movingReports++; record.movingReports++;
        if (this.movingTracks.has(mmsi) || this.movingTracks.size < 20) {
          const track = this.movingTracks.get(mmsi) ?? [];
          if (!track.length && record.reports > 1) track.push(previous); track.push(next);
          if (track.length > 64) track.shift(); this.movingTracks.set(mmsi, track);
        }
      }
      if (stationary) { this.stationaryReports++; record.stationaryReports++; }
      record.last = next;
    }
  }
  summary() { return { reports:this.reports,peakLocalReports:this.peak,uniqueLocalMmsis:this.records.size,untrackedReports:this.untrackedReports,
    movingReports:this.movingReports,stationaryReports:this.stationaryReports,snapshotBytesPeak:this.snapshotBytesPeak,
    reportingAgeMs:{...this.reportingAge.summary(),meaning:'local position receipt minus provider position record time'},
    receiptToFeedListenerMs:{...this.deliveryAge.summary(),meaning:'server source receipt to this process listener; excludes SSE, network and browser',precision:'whole-second histogram; max/min retain millisecond values'},
    acceptedQualityFlags:this.flags,records:[...this.records.values()],movingTracks:[...this.movingTracks].map(([mmsi,points]) => ({mmsi,points})),
    movingSequenceObserved:[...this.records.values()].some(row => row.movingReports >= 3 && row.maximumDisplacementMetres > 0),
    stationarySequenceObserved:[...this.records.values()].some(row => row.stationaryReports >= 3) }; }
}
function selfCheck() {
  const histogram = new Histogram(); assert.equal(histogram.percentile(.95), null); histogram.add(1); histogram.add(1500); assert.equal(histogram.percentile(.95),1000);
  const now = Date.parse('2026-10-09T12:00:00Z'), observations = new Observations();
  const ship = (at:number,lon:number,sog:number,navStat:number) => decodeMarineMqttPosition('vessels-v2/230123456/location',{time:at/1000,lon,lat:60.18,sog,navStat},new Date(at+200).toISOString(),at+200);
  const status = {state:'live' as const,connectedAt:null,lastPositionAt:null,retryAt:null};
  const first = ship(now,24.94,3,0); observations.update({vehicles:[first],status},now+201); observations.update({vehicles:[{...first,marine:{...first.marine!,name:'Metadata only'}}],status},now+500);
  assert.equal(observations.reports,1); observations.update({vehicles:[ship(now+1000,24.94002,3,0)],status},now+1201);
  observations.update({vehicles:[ship(now+2000,24.94004,3,0)],status},now+2201); assert.equal(observations.summary().movingSequenceObserved,true);
  assert.equal(observations.reportingAge.max,200); assert.equal(observations.deliveryAge.max,1);
  observations.update({vehicles:[ship(now+3000,24.94004,0,5)],status},now+3201); assert.equal(observations.stationaryReports,1);
  assert.equal(observations.records.get('230123456')!.gaps.count,3); console.log('Marine verifier self-check passed (offline).');
}

if (process.argv.includes('--self-check')) selfCheck();
else {
  const allowed = ['seconds','max-bytes','max-messages','interrupt-at','interrupt-for','peak','output'];
  for (const arg of process.argv.slice(2)) assert(arg === '--fixture' || arg === '--integrated' || allowed.some(name => arg.startsWith(`--${name}=`)), `Unknown option: ${arg}`);
  const durationMs = numeric('seconds',1800,1,1800)*1000, maxBytes = numeric('max-bytes',64*1024*1024,1,256*1024*1024), maxMessages = numeric('max-messages',200000,1,1000000);
  const interruptAt = numeric('interrupt-at',0,0,durationMs/1000), interruptFor = numeric('interrupt-for',30,1,120);
  const integrated = process.argv.includes('--integrated');
  const fixture = process.argv.includes('--fixture'), fixtureSize = fixture ? numeric('peak',40,1,Math.floor(MARINE_LIMITS.vehicles/2))*2 : 0;
  const startedAt = new Date().toISOString(), output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9) ?? `.cache/task-f/marine-${fixture?'fixture':'live'}-${startedAt.replaceAll(':','-')}.json`;
  assert(output && !output.startsWith('-'), 'Invalid output path');
  const observations = new Observations(), statuses: {at:string;status:MarineFeedUpdate['status']}[] = [], memory: object[] = [];
  const payload = {messages:0,bytes:0,mqttBytes:0,restBytes:0,peakMessagesPerSecond:0,peakBytesPerSecond:0,
    topics:{location:0,metadata:0,status:0,other:0},windowSecond:0,windowMessages:0,windowBytes:0};
  const requests: Record<string,{starts:number;successes:number;bytes:number;failures:number;statusCounts:Record<string,number>;maxDurationMs:number}> = {};
  const inputFieldSignals:Record<string,number>={};const signal=(name:string)=>{inputFieldSignals[name]=(inputFieldSignals[name]??0)+1;};
  const inspectFields=(topic:string,bytes:Buffer)=>{
    if(bytes.length>MARINE_LIMITS.payloadBytes){signal('payload-over-32KiB');return;}
    try{const row=JSON.parse(bytes.toString('utf8'));if(!row||typeof row!=='object'||Array.isArray(row)){signal('non-object-payload');return;}
      if(topic.endsWith('/location')){for(const [field,sentinel]of [['sog',102.3],['cog',360],['heading',511]]as const){if(row[field]===sentinel)signal(field+'-unavailable');if(row[field]==null)signal(field+'-missing');}
        if(row.sog===102.2)signal('sog-capped');if(row.lon===181||row.lat===91)signal('position-unavailable');
        if(typeof row.lon!=='number'||!Number.isFinite(row.lon)||typeof row.lat!=='number'||!Number.isFinite(row.lat))signal('coordinates-invalid');
        if(typeof row.time!=='number'||!Number.isFinite(row.time))signal('location-time-invalid');else if(row.time*1000>Date.now()+5000)signal('location-time-future');
      }else if(topic.endsWith('/metadata')){if(typeof row.timestamp!=='number'||!Number.isFinite(row.timestamp))signal('metadata-time-invalid');
        if(typeof row.name==='string'&&!row.name.replaceAll('@','').trim())signal('metadata-name-blank');}
      else if(topic==='vessels-v2/status'&&(typeof row.updated!=='number'||!Number.isFinite(row.updated)))signal('status-time-invalid');
    }catch{signal('malformed-json');}
  };
  const failures: string[] = []; let collecting=true, connections=0, previousStatus='', injected=0, activeClient: MarineConnection|null=null, blockedUntil=0;
  const sse = {events:[0,0],marineReports:[0,0],parseBufferBytesPeak:0,frameBytesPeak:0,receiptToReader:new Histogram(),latest:[new Map<string,string>(),new Map<string,string>()],received:[new Map<string,string>(),new Map<string,string>()]};
  let delivery:TrafficFeed|null=null;const controllers:AbortController[]=[],readers:Promise<void>[]=[];let afterIdle:ReturnType<TrafficFeed['diagnostics']>|null=null;
  let finish!: (reason:string) => void; const finished = new Promise<string>(resolve => { finish=resolve; });
  const interruption: {plannedAtSeconds:number;durationSeconds:number;startedAt:string|null;eligibleToReconnectAt:string|null;restFallbackAt:string|null;mqttRecoveredAt:string|null} = {
    plannedAtSeconds:interruptAt,durationSeconds:interruptFor,startedAt:null,eligibleToReconnectAt:null,restFallbackAt:null,mqttRecoveredAt:null };
  const feed = new MarineFeed({connector:() => {
    if (Date.now()<blockedUntil) throw new Error('Verifier controlled MQTT interruption'); connections++;
    let client: MarineConnection;
    if (fixture) {
      const broker = new EventEmitter(); Object.assign(broker,{subscribe:(topics:string[],_options:unknown,done:(error:Error|null,granted:{topic:string;qos:number}[])=>void) => done(null,topics.map(topic=>({topic,qos:0}))),
        end:() => {broker.emit('close');broker.removeAllListeners();}}); client=broker as unknown as MarineConnection; queueMicrotask(()=>broker.emit('connect'));
    } else client=mqtt.connect('wss://meri.digitraffic.fi:443/mqtt',{clientId:`HelsinkiLens-verify-${randomUUID()}`,connectTimeout:12000,reconnectPeriod:0,resubscribe:false,rejectUnauthorized:true,protocolVersion:4,clean:true,queueQoSZero:false});
    activeClient=client;
    client.on('message',(topic,bytes) => {
      if(!collecting)return;inspectFields(topic,bytes);
      payload.messages++; payload.bytes+=bytes.length;payload.mqttBytes+=bytes.length;
      const second=Math.floor(Date.now()/1000); if(second!==payload.windowSecond){payload.windowSecond=second;payload.windowMessages=0;payload.windowBytes=0;}
      payload.windowMessages++;payload.windowBytes+=bytes.length;payload.peakMessagesPerSecond=Math.max(payload.peakMessagesPerSecond,payload.windowMessages);payload.peakBytesPerSecond=Math.max(payload.peakBytesPerSecond,payload.windowBytes);
      const kind=topic==='vessels-v2/status'?'status':topic.endsWith('/location')?'location':topic.endsWith('/metadata')?'metadata':'other';payload.topics[kind]++;
      if(payload.messages>=maxMessages||payload.bytes>=maxBytes){feed.stop();finish(payload.messages>=maxMessages?'message-cap':'byte-cap');}
    });return client;
  },fetcher:async(url,options) => {
    if(!collecting)return fixture?{body:'null'}:requestText(url,options);
    const endpoint=url.includes('/locations?')?'locations':'vessels/{mmsi}',row=requests[endpoint]??={starts:0,successes:0,bytes:0,failures:0,statusCounts:{},maxDurationMs:0};row.starts++;const before=Date.now();
    try {const response=fixture?{body:JSON.stringify(endpoint==='locations'?{type:'FeatureCollection',features:[]}:null),status:200}:await requestText(url,options);
      const bytes=Buffer.byteLength(response.body);payload.bytes+=bytes;payload.restBytes+=bytes;row.bytes+=bytes;row.successes++;row.statusCounts[String(response.status)]=(row.statusCounts[String(response.status)]??0)+1;
      if(payload.bytes>=maxBytes){feed.stop();finish('byte-cap');}return response;
    } catch(error){row.failures++;const status=error instanceof UpstreamHttpError?String(error.status):'transport';row.statusCounts[status]=(row.statusCounts[status]??0)+1;throw error;}
    finally{row.maxDurationMs=Math.max(row.maxDurationMs,Date.now()-before);}
  }});
  const consume = async(index:number,response:Response) => {
    const reader=response.body!.getReader(),decoder=new TextDecoder();let remainder='';
    try {for(;;){const {done,value}=await reader.read();if(done)return;remainder+=decoder.decode(value,{stream:true});
      const bytes=Buffer.byteLength(remainder);sse.parseBufferBytesPeak=Math.max(sse.parseBufferBytesPeak,bytes);assert(bytes<=TRAFFIC_MAX_QUEUE_BYTES+65536,'SSE parse buffer exceeded bounded queue');
      let end:number;while((end=remainder.indexOf('\n\n'))>=0){const frame=remainder.slice(0,end);remainder=remainder.slice(end+2);sse.frameBytesPeak=Math.max(sse.frameBytesPeak,Buffer.byteLength(frame));
        const data=frame.split('\n').find(line=>line.startsWith('data: '));if(!data)continue;const event=JSON.parse(data.slice(6)) as TrafficEvent;sse.events[index]++;
        if(event.type==='snapshot')sse.latest[index].clear();else for(const id of event.removed)sse.latest[index].delete(id);
        for(const vehicle of event.vehicles){sse.latest[index].set(vehicle.id,JSON.stringify(vehicle));if(vehicle.mode!=='ship')continue;
          const version=vehicle.reportedAt+'|'+vehicle.receivedAt;if(sse.received[index].get(vehicle.id)===version)continue;
          sse.received[index].set(vehicle.id,version);sse.marineReports[index]++;if(index===0)sse.receiptToReader.add(Date.now()-Date.parse(vehicle.receivedAt));}
      }}
    }finally{reader.releaseLock();}
  };
  const record = () => {
    const diagnostic=feed.diagnostics();assert(diagnostic.upstreamConnections<=1&&diagnostic.vehicles<=MARINE_LIMITS.vehicles&&diagnostic.identities<=MARINE_LIMITS.identities&&diagnostic.metadata<=MARINE_LIMITS.metadata&&diagnostic.metadataQueue<=MARINE_LIMITS.metadataQueue&&diagnostic.metadataFlight<=MARINE_LIMITS.metadataConcurrent,'Marine retained state exceeded budget');
    const usage=process.memoryUsage(),sample={at:new Date().toISOString(),heapUsed:usage.heapUsed,rss:usage.rss,diagnostics:diagnostic,delivery:delivery?.diagnostics(),localReports:feed.snapshot().vehicles.length};
    assert(memory.length<=32,'Verifier sampling exceeded budget');memory.push(sample);console.log(JSON.stringify(sample));
  };
  const timers: ReturnType<typeof setTimeout>[]=[]; let sample:ReturnType<typeof setInterval>|null=null,replay:ReturnType<typeof setInterval>|null=null;
  let stopReason='duration';
  try {
    const observe=(update:MarineFeedUpdate)=>{
      if(!collecting)return;observations.update(update,Date.now());const key=JSON.stringify([update.status.state,update.status.connectedAt,update.status.periodic,update.status.stale,update.status.degraded,update.status.positionError,update.status.metadataError]);
      if(key!==previousStatus){if(statuses.length<100)statuses.push({at:new Date().toISOString(),status:update.status});previousStatus=key;}
      if(interruption.startedAt&&update.status.periodic&&!interruption.restFallbackAt)interruption.restFallbackAt=new Date().toISOString();
      if(interruption.startedAt&&update.status.connectedAt&&update.status.connectedAt>interruption.startedAt&&!interruption.mqttRecoveredAt)interruption.mqttRecoveredAt=update.status.connectedAt;
    };
    if(integrated){
      const source={start:(listener:(update:MarineFeedUpdate)=>void)=>feed.start(update=>{observe(update);listener(update);}),stop:()=>feed.stop(),diagnostics:()=>feed.diagnostics()};
      const hsl=fixture?(()=>{const broker=new EventEmitter();Object.assign(broker,{subscribe:(_topics:unknown,_options:unknown,done:(error:Error|null)=>void)=>done(null),end:()=>broker.removeAllListeners()});queueMicrotask(()=>broker.emit('connect'));return broker as unknown as TrafficConnection;}):undefined;
      delivery=new TrafficFeed(hsl,fixture?null:new RailFeed(),source);
      for(let index=0;index<2;index++){const controller=new AbortController();controllers.push(controller);const response=createTrafficResponse(new Request('http://localhost/api/traffic/stream',{signal:controller.signal}),delivery);
        readers.push(consume(index,response).catch(error=>{failures.push(String(error));finish('sse-validation-failed');}));}
    }else feed.start(observe);
    record(); sample=setInterval(()=>{try{record();}catch(error){failures.push(String(error));finish('validation-failed');}},60000);
    timers.push(setTimeout(()=>finish('duration'),durationMs));
    if(interruptAt)timers.push(setTimeout(()=>{interruption.startedAt=new Date().toISOString();blockedUntil=Date.now()+interruptFor*1000;interruption.eligibleToReconnectAt=new Date(blockedUntil).toISOString();activeClient?.end(true);},interruptAt*1000));
    if(fixture){let sequence=0;replay=setInterval(()=>{sequence++;const now=Math.floor(Date.now()/1000)*1000,broker=activeClient as unknown as EventEmitter;
      for(let i=0;i<fixtureSize;i++){const mmsi=String(230100000+i),moving=i%2===0;
        broker.emit('message',`vessels-v2/${mmsi}/location`,Buffer.from(JSON.stringify({time:now/1000,lon:24.94+(moving?sequence*.00001:0)+i*.000001,lat:60.18,sog:moving?3:0,cog:moving?90:360,heading:511,navStat:moving?0:5})));injected++;
        if(sequence===1)broker.emit('message',`vessels-v2/${mmsi}/metadata`,Buffer.from(JSON.stringify({timestamp:now,name:`Synthetic ${i}`,type:70})));
      }broker.emit('message','vessels-v2/status',Buffer.from(JSON.stringify({updated:now/1000})));},1000);}
    stopReason=await finished;record();
  } catch(error){failures.push(String(error));stopReason='validation-failed';}
  finally{for(const timer of timers)clearTimeout(timer);if(sample)clearInterval(sample);if(replay)clearInterval(replay);}
  collecting=false;const endedAt=new Date().toISOString(),during=feed.diagnostics(),latest=feed.snapshot(),deliveryDuring=delivery?.diagnostics();
  if(delivery){for(const controller of controllers)controller.abort();await Promise.all(readers);
    assert.equal(delivery.diagnostics().consumers,0,'SSE consumers retained demand');
    try{assert.equal(sse.events[0],sse.events[1],'SSE readers received different event counts');assert.deepEqual([...sse.latest[0]],[...sse.latest[1]],'SSE latest states diverged');}
    catch(error){failures.push(String(error));stopReason='sse-validation-failed';}
    await new Promise(resolve=>setTimeout(resolve,TRAFFIC_IDLE_MS+100));afterIdle=delivery.diagnostics();
    assert.equal(afterIdle.upstreamConnections,0,'Shared idle shutdown retained HSL');assert.equal(afterIdle.timers,0,'Shared idle shutdown retained timers');delivery.close();
  }
  feed.stop();
  assert.equal(feed.diagnostics().timers,0);assert.equal(feed.diagnostics().upstreamConnections,0);assert.equal(feed.diagnostics().restFlight,0);assert.equal(feed.diagnostics().metadataFlight,0);
  if(fixture&&durationMs>=3000){try{assert.equal(observations.peak,fixtureSize,'Synthetic double peak did not reach requested fleet');if(!interruptAt)assert.equal(connections,1,'Fixture opened duplicate marine sockets');}catch(error){failures.push(String(error));stopReason='fixture-validation-failed';}}
  const summary=observations.summary(),gaps:string[]=[];
  if(!summary.movingSequenceObserved)gaps.push('No real moving vessel with at least three reports and observed displacement.');
  if(!summary.stationarySequenceObserved)gaps.push('No stationary vessel with at least three reports.');
  if(interruptAt&&!interruption.mqttRecoveredAt)gaps.push('Controlled interruption did not demonstrate MQTT recovery.');
  if(stopReason!=='duration')gaps.push(`Observation ended early: ${stopReason}.`);
  gaps.push(integrated?'These are two in-process SSE readers, not browser clients; browser/network latency, rendering FPS, accessibility and hidden-tab resume are unmeasured.':'This direct MarineFeed probe does not measure SSE/browser latency, two browser clients, rendering FPS, accessibility, hidden-tab resume or the shared idle grace.');
  const result={integration:integrated?'shared HSL/rail/marine TrafficFeed with two in-process SSE readers':'MarineFeed directly',mode:fixture?'explicit-offline-synthetic-double-peak':'real-digitraffic-marine',startedAt,endedAt,cleanupEndedAt:new Date().toISOString(),observedDurationMs:Date.parse(endedAt)-Date.parse(startedAt),requestedDurationMs:durationMs,stopReason,
    limits:{maxBytes,maxMessages,budgetScope:'marine MQTT payloads plus decoded AIS REST bodies; HSL/rail retain production source bounds',...MARINE_LIMITS},bounds:RELEASE_BOUNDS,upstream:{mqtt:'wss://meri.digitraffic.fi:443/mqtt',topics:MARINE_TOPICS,rest:['https://meri.digitraffic.fi/api/ais/v1/locations?latitude=60.18&longitude=25&radius=15&from=<retention-start-ms>','https://meri.digitraffic.fi/api/ais/v1/vessels/{known-local-mmsi}']},
    inputFieldSignals:{scope:'bounded national MQTT payload field signals; unavailable sentinels are distinct from decoder rejections',counts:inputFieldSignals},fixture:{observedPeak:fixture?fixtureSize/2:null,twicePeak:fixtureSize,injected},payload,requests,connections,interruption:{...interruption,method:'End this verifier socket and refuse reconnect locally for the requested interval; public upstream is unchanged.'},
    observations:summary,finalMetadataCoverage:{localReports:latest.vehicles.length,matched:latest.vehicles.filter(vehicle=>!!vehicle.marine?.metadataReportedAt).length,named:latest.vehicles.filter(vehicle=>!!vehicle.marine?.name).length},
    statuses,memory,during,deliveryDuring,afterIdle,sse:integrated?{events:sse.events,marineReports:sse.marineReports,parseBufferBytesPeak:sse.parseBufferBytesPeak,frameBytesPeak:sse.frameBytesPeak,queueLimitBytes:TRAFFIC_MAX_QUEUE_BYTES,latestStatesEqual:JSON.stringify([...sse.latest[0]])===JSON.stringify([...sse.latest[1]]),receiptToSseReaderMs:{...sse.receiptToReader.summary(),meaning:'local marine position receipt to first in-process shared SSE reader; excludes browser/network latency'}}:null,final:feed.diagnostics(),failures,gaps,interpretation:'A zero local count does not prove no ships. Provider age, source freshness and position receipt remain separate; national payloads are not stored.'};
  await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({saved:output,startedAt,endedAt,stopReason,peakLocalReports:summary.peakLocalReports,movingSequenceObserved:summary.movingSequenceObserved,stationarySequenceObserved:summary.stationarySequenceObserved}));
  if(failures.length)process.exitCode=1;
}
