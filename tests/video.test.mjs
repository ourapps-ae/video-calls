import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createHmac } from 'node:crypto';
import { videoGrant, listRooms, videoEnvironment } from '../implementation/server/video.ts';
import { Room, RoomEvent } from './fixtures/livekit.mjs';

registerHooks({resolve(specifier, context, next) {
  if (specifier === 'livekit-client') return {url:new URL('./fixtures/livekit.mjs',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
const { Video } = await import('../implementation/web/video.ts');
const env = {LIVEKIT_URL:'wss://media.example',LIVEKIT_API_KEY:'local-fixture',LIVEKIT_API_SECRET:'test-only-not-a-credential'};

test('close unregisters the exact supplied mode listener', () => {
  const calls=[];
  globalThis.window={
    addEventListener:(name,listener)=>calls.push(['add',name,listener]),
    removeEventListener:(name,listener)=>calls.push(['remove',name,listener]),
  };
  const video=new Video(()=>{}, {canCapture:()=>true,soundOn:()=>true,modeEvent:'ourpoker-mode'});
  video.close();
  assert.equal(calls.length,2);
  assert.deepEqual(calls.map(([action,name])=>[action,name]),[['add','ourpoker-mode'],['remove','ourpoker-mode']]);
  assert.equal(calls[0][2],calls[1][2]);
  assert.equal(video.granted,false);
});

test('grants bind identity, prefix, lifetime and spectator restrictions with a valid signature', async () => {
  for (const publish of [true,false]) {
    const grant = await videoGrant(env,'room','person','Example',1234567,publish,'example-');
    const [head,body,sig] = grant.token.split('.');
    const payload = JSON.parse(Buffer.from(body,'base64url'));
    assert.equal(sig,createHmac('sha256',env.LIVEKIT_API_SECRET).update(`${head}.${body}`).digest('base64url'));
    assert.equal(payload.sub,'person');
    assert.equal(payload.video.room,'example-room');
    assert.equal(payload.video.canPublish,publish);
    assert.equal(payload.video.canSubscribe,true);
    assert.equal(payload.video.canPublishData,false);
    assert.equal(payload.exp-payload.iat,21600);
    assert.equal(payload.nbf,payload.iat-10);
  }
  assert.equal(await videoGrant({},'r','p','N',0,true,'example-'),null);
});

test('room listing filters the injected prefix and retains participant names', async () => {
  const calls=[];
  const fetcher = async (url,options) => {
    calls.push([url,JSON.parse(options.body)]);
    return Response.json(url.endsWith('ListRooms') ? {rooms:[{name:'example-r'},{name:'other-r'}]} : {participants:[{identity:'one',name:'Guest'},{identity:'two'}]});
  };
  assert.deepEqual(await listRooms(env,0,'example-',fetcher),[{room:'example-r',participants:['Guest','two']}]);
  assert.equal(calls.length,2);
  assert.equal(calls[1][1].room,'example-r');
});

test('room listing maps supported protocols and preserves loopback and base paths', async () => {
  for (const [address,base] of [
    ['ws://127.0.0.1:7880','http://127.0.0.1:7880'],
    ['wss://media.example/base/','https://media.example/base'],
    ['http://127.0.0.1:7880/base','http://127.0.0.1:7880/base'],
    ['https://media.example/base///','https://media.example/base'],
  ]) {
    const calls=[];
    const fetcher=async (url,options)=>{
      calls.push([url,JSON.parse(options.body)]);
      return Response.json(url.endsWith('ListRooms') ? {rooms:[{name:'test-room'},{name:'other-room'}]} : {participants:[{identity:'one'}]});
    };
    assert.deepEqual(await listRooms({...env,LIVEKIT_URL:address},0,'test-',fetcher),[{room:'test-room',participants:['one']}]);
    assert.deepEqual(calls,[[base+'/twirp/livekit.RoomService/ListRooms',{}],[base+'/twirp/livekit.RoomService/ListParticipants',{room:'test-room'}]]);
  }
  for (const address of ['not an address','file:///tmp/media','ftp://media.example','https://user:password@media.example','https://media.example/?key=fixture']) {
    assert.equal(await listRooms({...env,LIVEKIT_URL:address},0,'test-',()=>{throw new Error('Must not fetch');}),null);
  }
});

function setup() {
  let capture=true;
  const events=new EventTarget();
  const timers=[];
  globalThis.window=Object.assign(events,{setTimeout:fn => { timers.push(fn); return 0; }});
  globalThis.document={body:{append() {}},createElement:() => ({style:{},append(){},textContent:''})};
  Room.connect=async () => {};
  const video=new Video(()=>{}, {canCapture:()=>capture,soundOn:()=>false,modeEvent:'example:mode'});
  return {video,timers,display:()=>{capture=false; events.dispatchEvent(new Event('example:mode'));}};
}

test('capture, hold, sound, idle and cleanup retain caller preferences', async () => {
  const {video,timers}=setup();
  await video.connect('wss://example','token','r');
  const room=video.room;
  assert.deepEqual(room.calls,[['mic',true],['cam',true]]);
  video.hold(true);
  await new Promise(setImmediate);
  assert.deepEqual(room.calls.slice(-2),[['mic',false],['cam',false]]);
  assert.equal(video.micOn,true);
  video.hold(false);
  await new Promise(setImmediate);
  let removed=false;
  const audio={muted:false,pause(){},remove(){removed=true;},srcObject:{}};
  room.emit(RoomEvent.TrackSubscribed,{kind:'audio',attach:()=>audio,detach:()=>[]},{},{identity:'remote'});
  assert.equal(audio.muted,true);
  video.setSpeaker(true);
  assert.equal(audio.muted,false);
  timers.at(-1)();
  assert.equal(video.stalled,true);
  assert.equal(removed,true);
  assert.equal(audio.srcObject,null);
  video.resume();
  await new Promise(setImmediate);
  assert.equal(video.connected,true);
  video.close();
  assert.equal(video.granted,false);
});

test('late connect and media operations cannot restore display capture', async () => {
  const {video,display}=setup();
  let release;
  Room.connect=()=>new Promise(resolve=>{release=resolve;});
  const pending=video.connect('wss://example','token','r');
  const room=video.room;
  display(); release(); await pending;
  assert.equal(video.connected,false);
  assert.equal(room.disconnected,true);
  assert.deepEqual(room.calls,[]);
  await video.setMic(false);
  assert.equal(video.micOn,true);
  await video.connect('wss://example','token','r');
  assert.equal(video.room,null);
  video.close();
});

test('camera refusal keeps the room and failed connection retains retry grant', async () => {
  const {video}=setup();
  Room.connect=async ()=>{throw new Error('offline');};
  await video.connect('wss://example','token','r');
  assert.equal(video.stalled,true);
  Room.connect=async ()=>{};
  const pending=video.connect('wss://example','token','r');
  video.room.localParticipant.setCameraEnabled=async ()=>{throw new Error('denied');};
  await pending;
  assert.equal(video.connected,true);
  assert.equal(video.camUsable,false);
  video.close();
});

test('settings and secrets build the grant environment, and anything missing or disabled yields no grant', async () => {
  const secrets = {apiKey:'local-fixture', apiSecret:'test-only-not-a-credential'};
  assert.deepEqual(videoEnvironment({serviceUrl:'https://media.example'}, secrets), env);
  assert.deepEqual(videoEnvironment({enabled:true, serviceUrl:'http://127.0.0.1:7880/base/'}, secrets), {...env, LIVEKIT_URL:'ws://127.0.0.1:7880/base'});
  for (const [settings, given] of [[{enabled:false, serviceUrl:'https://media.example'}, secrets], [{}, secrets], [{serviceUrl:'https://media.example'}, {apiKey:'k'}], [{serviceUrl:'ftp://media.example'}, secrets], [{serviceUrl:'https://u:p@media.example'}, secrets], [{serviceUrl:'not a url'}, secrets]]) {
    assert.deepEqual(videoEnvironment(settings, given), {});
  }
  assert.equal(await videoGrant(videoEnvironment({enabled:false, serviceUrl:'https://media.example'}, secrets), 'one', 'p1', 'Ada', 1_700_000_000_000, true, 'demo-'), null);
  assert.equal((await videoGrant(videoEnvironment({serviceUrl:'https://media.example'}, secrets), 'one', 'p1', 'Ada', 1_700_000_000_000, true, 'demo-')).room, 'demo-one');
});
