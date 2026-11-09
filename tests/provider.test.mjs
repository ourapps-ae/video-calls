import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { videoGrant, listRooms } from '../implementation/server/video.ts';
import { Video } from '../implementation/web/video.ts';
import { verifyMedia } from '../implementation/verification/provider.mjs';
import { createServiceAdapter, createProviderDependencies, providerEndpoints, readSecrets, validateApplicationClients } from '../implementation/verification/adapters.mjs';
import { recordIntent, recordCreated } from '../implementation/verification/result.mjs';
import { createVideoBinding } from '../implementation/verification/binding.ts';

const assertions = ['publisher-joined','subscriber-joined','subscriber-publish-denied','synthetic-track-received','board-capture-denied','reconnected','media-stopped-on-close','room-deleted','room-listed'].sort();
function context() {
  return { format:1, runId:'a'.repeat(64), package:'b'.repeat(64), id:'provider-fixture', mode:'simulation', simulationKind:'fixture',
    settings:{livekitUrl:'ws://127.0.0.1:7880/base/',ephemeralRoomPrefix:'fixture',maximumSeconds:1}, resources:[], secrets:{},
    operations:['create-room','delete-created-room','join-room','list-account-rooms','publish-synthetic-media','subscribe-media'],
    origins:['http://127.0.0.1:7880','ws://127.0.0.1:7880'], assertions };
}
async function fixture(callback, options={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'media-provider-fixture-'));
  const previous=process.env.AEPM_OWNERSHIP_DIRECTORY;
  process.env.AEPM_OWNERSHIP_DIRECTORY=directory;
  const rooms=new Map(); const calls=[]; const ctx=context();
  const name=`fixture-${ctx.runId}-0`;
  if(options.preexisting) rooms.set(name,{id:name,metadata:{aepmRunId:'other-run'}});
  const dependencies={
    Video,videoGrant,
    listRooms:(env,now,prefix)=>listRooms(env,now,prefix,async(url)=>Response.json(url.endsWith('ListRooms')?{rooms:[...rooms.keys()].map(name=>({name}))}:{participants:[]})),
    createRoom:async({name,metadata})=>{calls.push('create'); const room={id:name,metadata};rooms.set(name,room);if(options.uncertain)throw Error('fixture failure');return room;},
    getRoom:async id=>rooms.get(id)??null,
    deleteRoom:async id=>{calls.push('delete');if(options.cleanupFails)throw Error('fixture failure');rooms.delete(id);},
    readSecrets:async()=>({livekitKey:'fixture-key',livekitSecret:'fixture-secret-never-log'}),now:()=>100000,
    createClients:async grants=>{
      const clients={};
      for(const role of ['publisher','subscriber','spectator']) {
        let capture=0;let connected=false;
        const grant=JSON.parse(Buffer.from(grants[role+'Grant'].token.split('.')[1],'base64url'));
        clients[role]={
          async connect(){connected=true;calls.push(role+'-connect');},
          async publishSynthetic(){capture=1;},
          async waitForFrames(){assert.equal(connected,true);return options.noFrames?0:2;},
          async attemptPublish(){return options.invalidPermission ? undefined : grant.video.canPublish;},
          async disconnect(){connected=false;},
          async reconnect(){connected=true;calls.push(role+'-reconnect');},
          async enterDisplay(){capture=0;},
          async activeCaptureCount(){return capture;},
          async close(){capture=0;connected=false;calls.push(role+'-close');},
        };
      }
      return clients;
    },
  };
  try { await callback({ctx,dependencies,rooms,calls,directory}); }
  finally { if(previous===undefined)delete process.env.AEPM_OWNERSHIP_DIRECTORY;else process.env.AEPM_OWNERSHIP_DIRECTORY=previous;await fs.rm(directory,{recursive:true,force:true}); }
}

test('fixture uses actual grants/listing and records assertions and owned cleanup without credentials',async()=>{
  await fixture(async({ctx,dependencies,rooms,calls,directory})=>{
    const result=await verifyMedia(ctx,dependencies);
    assert.ok(result.assertions.every(item=>item.passed));
    assert.equal(result.assertions.find(item=>item.id==='synthetic-track-received').actual,2);
    assert.equal(rooms.size,0);
    assert.ok(calls.includes('subscriber-reconnect'));
    assert.equal(result.resources[0].cleaned,true);
    assert.equal(result.cleanup.completed,false);
    assert.deepEqual((await fs.readdir(directory)).sort(),['created-0.json','intent-0.json']);
    assert.doesNotMatch(JSON.stringify(result),/fixture-secret|fixture-key|token/);
  });
});

test('missing frames cannot pass, and all clients and created room are still cleaned',async()=>{
  await fixture(async({ctx,dependencies,rooms,calls})=>{
    const result=await verifyMedia(ctx,dependencies);
    assert.equal(result.assertions.find(item=>item.id==='synthetic-track-received').passed,false);
    assert.equal(result.assertions.find(item=>item.id==='reconnected').passed,false);
    assert.equal(rooms.size,0);
    for(const role of ['publisher','subscriber','spectator'])assert.ok(calls.includes(role+'-close'));
  },{noFrames:true});
});

test('missing permission observation is not treated as denied publication',async()=>{
  await fixture(async({ctx,dependencies})=>{
    const result=await verifyMedia(ctx,dependencies);
    assert.equal(result.assertions.find(item=>item.id==='subscriber-publish-denied').passed,false);
  },{invalidPermission:true});
});

test('preexisting room is neither adopted nor deleted',async()=>{
  await fixture(async({ctx,dependencies,rooms,calls,directory})=>{
    const result=await verifyMedia(ctx,dependencies);
    assert.equal(result.assertions.some(item=>item.passed),false);
    assert.deepEqual(calls,[]);
    assert.equal(rooms.size,1);
    assert.deepEqual(await fs.readdir(directory),[]);
  },{preexisting:true});
});

test('uncertain creation is cleaned only by matching run metadata; cleanup failure stays failed',async()=>{
  await fixture(async({ctx,dependencies,rooms})=>{
    const result=await verifyMedia(ctx,dependencies);
    assert.equal(rooms.size,0);
    assert.equal(result.resources[0].created,false);
    assert.equal(result.resources[0].cleaned,true);
    assert.equal(result.assertions.find(item=>item.id==='publisher-joined').passed,false);
  },{uncertain:true});
  await fixture(async({ctx,dependencies})=>{
    const result=await verifyMedia(ctx,dependencies);
    assert.equal(result.cleanup.reason,'cleanup-failed');
    assert.equal(result.assertions.find(item=>item.id==='room-deleted').passed,false);
  },{cleanupFails:true});
});

test('paired origins, namespace and zero redirects constrain real service adapters',async()=>{
  const ctx=context(); const secrets={livekitKey:'synthetic',livekitSecret:'synthetic'};
  for(const url of ['ws://127.0.0.1:7880/base/','http://127.0.0.1:7880/base/']) {
    const endpoints=providerEndpoints({...ctx,settings:{...ctx.settings,livekitUrl:url}});
    assert.equal(endpoints.serviceBase,'http://127.0.0.1:7880/base');
    assert.equal(endpoints.socket.origin,'ws://127.0.0.1:7880');
  }
  const secure={...ctx,mode:'live',simulationKind:null,settings:{...ctx.settings,livekitUrl:'wss://media.example/base/'},origins:['https://media.example','wss://media.example']};
  assert.equal(providerEndpoints(secure).serviceBase,'https://media.example/base');
  assert.throws(()=>providerEndpoints({...ctx,origins:['ws://127.0.0.1:7880']}),/authorization-denied/);
  const calls=[];
  const service=createServiceAdapter(ctx,secrets,async(url,options)=>{calls.push([url,options]);return Response.json({rooms:[]});});
  await service.getRoom(`fixture-${ctx.runId}-0`);
  assert.equal(calls[0][0],'http://127.0.0.1:7880/base/twirp/livekit.RoomService/ListRooms');
  assert.equal(calls[0][1].redirect,'error');
  await assert.rejects(service.getRoom('someone-elses-room'),/authorization-denied/);
  await assert.rejects(service.checkingFetch('http://other.invalid/twirp/livekit.RoomService/ListRooms',{body:'{}'}),/authorization-denied/);
  const redirect=createServiceAdapter(ctx,secrets,async()=>new Response(null,{status:302,headers:{location:'https://other.invalid'}}));
  await assert.rejects(redirect.getRoom(`fixture-${ctx.runId}-0`),/assertion-failed/);
});

test('application bridge rejects duplicate identities and missing awaited observations',()=>{
  const bridge={pages:{publisher:{},subscriber:{},spectator:{}},identities:{publisher:{id:'p',name:'P'},subscriber:{id:'s',name:'S'},spectator:{id:'v',name:'V'}},applyGrants:async()=>{},enterDisplay:async()=>{},observe:async()=>{}};
  validateApplicationClients(bridge);
  assert.throws(()=>validateApplicationClients({...bridge,observe:undefined}),/context-invalid/);
  assert.throws(()=>validateApplicationClients({...bridge,identities:{...bridge.identities,subscriber:bridge.identities.publisher}}),/context-invalid/);
});

test('generic application binding preserves identity without connecting or enabling capture',()=>{
  const calls=[];
  const make=()=>({room:null,connected:false,micOn:true,camOn:true,connect(){calls.push('connect');},disconnect(){calls.push('disconnect');},close(){calls.push('close');},hasVideo(){return false;},monitor(){}});
  const binding=createVideoBinding(true,()=>{throw Error('Must not construct an application replacement');});
  assert.throws(()=>binding.session(),/assertion-failed/);
  assert.throws(()=>binding.bindVideo(null),/assertion-failed/);
  assert.throws(()=>binding.bindVideo({}),/assertion-failed/);
  const actual=make();
  binding.bindVideo(actual);
  assert.equal(binding.session(),actual);
  assert.equal(actual.micOn,false);
  assert.equal(actual.camOn,false);
  assert.deepEqual(calls,[]);
  binding.bindVideo(actual);
  assert.throws(()=>binding.bindVideo(make()),/assertion-failed/);
  binding.session().close();
  assert.deepEqual(calls,['close']);
});

test('service creation requires a durable intent and deletion requires matching ownership metadata',async()=>{
  await fixture(async({ctx})=>{
    const name=`fixture-${ctx.runId}-0`;let current=null;
    const service=createServiceAdapter(ctx,{livekitKey:'fixture',livekitSecret:'fixture'},async(url,options)=>{
      const body=JSON.parse(options.body);
      if(url.endsWith('CreateRoom')){current={name:body.name,metadata:body.metadata};return Response.json(current);}
      if(url.endsWith('DeleteRoom')){current=null;return Response.json({});}
      assert.deepEqual(body.names,[name]);
      return Response.json({rooms:current?[current]:[]});
    });
    await assert.rejects(service.createRoom({name,metadata:{aepmRunId:ctx.runId}}),/authorization-denied/);
    const intent=await recordIntent(ctx,'provider-room',name);
    const created=await service.createRoom({name,metadata:{aepmRunId:ctx.runId}});
    await recordCreated(intent,created.id);
    current.metadata=JSON.stringify({aepmRunId:'other-run'});
    await assert.rejects(service.deleteRoom(name),/authorization-denied/);
    assert.ok(current);
    current.metadata=JSON.stringify({aepmRunId:ctx.runId});
    await service.deleteRoom(name);
    assert.equal(await service.getRoom(name),null);
  });
});

test('secret parsing and provider failures expose only fixed error codes',async()=>{
  await fixture(async({ctx,directory})=>{
    const previous=process.env.AEPM_SECRETS_FILE;
    const file=path.join(directory,'malformed-secret.json');
    await fs.writeFile(file,'{"value":"synthetic-secret-marker"');
    process.env.AEPM_SECRETS_FILE=file;
    try {await assert.rejects(readSecrets(ctx),error=>error.message==='secret-unavailable');}
    finally {if(previous===undefined)delete process.env.AEPM_SECRETS_FILE;else process.env.AEPM_SECRETS_FILE=previous;}
    const service=createServiceAdapter(ctx,{livekitKey:'fixture',livekitSecret:'fixture'},async()=>{throw Error('synthetic-secret-marker');});
    await assert.rejects(service.getRoom(`fixture-${ctx.runId}-0`),error=>error.message==='assertion-failed');
  });
});

test('packaged fixture runner and cleanup exchange bound results without retaining synthetic credentials',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'provider-runner-fixture-'));
  try {
    const ctx=context();
    ctx.secrets={livekitKey:{secretRef:'fixture-key',version:'one'},livekitSecret:{secretRef:'fixture-secret',version:'one'}};
    await fs.mkdir(path.join(root,'ownership'));
    await fs.writeFile(path.join(root,'context.json'),JSON.stringify(ctx));
    await fs.writeFile(path.join(root,'secrets.json'),JSON.stringify({format:1,runId:ctx.runId,package:ctx.package,id:ctx.id,values:{livekitKey:{version:'one',value:'synthetic-key-marker'},livekitSecret:{version:'one',value:'synthetic-secret-marker'}}}));
    const env={PATH:process.env.PATH,HOME:root,AEPM_CONTEXT_FILE:path.join(root,'context.json'),AEPM_SECRETS_FILE:path.join(root,'secrets.json'),AEPM_OWNERSHIP_DIRECTORY:path.join(root,'ownership'),AEPM_RESULT_FILE:path.join(root,'result.json'),AEPM_CLEANUP_RESULT_FILE:path.join(root,'cleanup.json')};
    const runner=fileURLToPath(new URL('../implementation/verification/provider-runner.mjs',import.meta.url));
    for(const args of [[],['cleanup']]) {
      const outcome=spawnSync(process.execPath,[runner,...args],{env,encoding:'utf8',timeout:10000});
      assert.equal(outcome.status,0);
      assert.equal(outcome.stdout,'');
      assert.equal(outcome.stderr,'');
    }
    const result=JSON.parse(await fs.readFile(env.AEPM_RESULT_FILE,'utf8'));
    assert.ok(result.assertions.every(assertion=>assertion.passed));
    const cleanup=JSON.parse(await fs.readFile(env.AEPM_CLEANUP_RESULT_FILE,'utf8'));
    assert.equal(cleanup.cleanup.completed,true);
    assert.doesNotMatch(JSON.stringify([result,cleanup]),/synthetic-secret-marker|synthetic-key-marker/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('application bridge maps identities before grants, awaits grant handoff, and preserves caller pages on observation failure',async()=>{
  await fixture(async({ctx,directory})=>{
    ctx.simulationKind='local-provider';
    ctx.secrets={livekitKey:{secretRef:'key',version:'one'},livekitSecret:{secretRef:'secret',version:'one'}};
    const secretFile=path.join(directory,'secrets.json');
    await fs.writeFile(secretFile,JSON.stringify({format:1,runId:ctx.runId,package:ctx.package,id:ctx.id,values:{livekitKey:{version:'one',value:'fixture-key'},livekitSecret:{version:'one',value:'fixture-secret'}}}));
    const previous=process.env.AEPM_SECRETS_FILE;
    process.env.AEPM_SECRETS_FILE=secretFile;
    let applied=false;const events=[];const guards=[];const networkHandlers=[];const networkActions=[];
    const pages={};
    for(const role of ['publisher','subscriber','spectator']) pages[role]={
      url:()=> 'http://127.0.0.1:5173/',
      context:()=>({newCDPSession:async()=>({send:async(method,parameters)=>networkActions.push([method,parameters]),on(event,handler){if(event==='Fetch.requestPaused')networkHandlers.push(handler);},detach:async()=>events.push(role+'-detached')})}),
      async addScriptTag(){events.push(role+'-driver');},
      async close(){throw Error('Caller-owned page must not close');},
      async evaluate(fn,args){
        if(args?.socketOrigin){guards.push(args.applicationOrigins);return;}
        if(args?.method){
          if(args.method==='connect')assert.equal(applied,true);
          events.push(role+'-'+args.method);
          if(args.method==='waitForFrames')return 2;
          if(args.method==='close')return 0;
          return;
        }
        if(args===undefined)return ['http://127.0.0.1:8788/r/casino/join','https://unrelated.invalid/asset'];
      },
    };
    const identities={publisher:{id:'actual-one',name:'One'},subscriber:{id:'actual-two',name:'Two'},spectator:{id:'actual-three',name:'Three'}};
    const applicationClients={pages,identities,
      async applyGrants(grants){
        for(const role of Object.keys(pages))assert.equal(JSON.parse(Buffer.from(grants[role+'Grant'].token.split('.')[1],'base64url')).sub,identities[role].id);
        applied=true;events.push('grants-applied');
      },
      async enterDisplay(){events.push('actual-display-action');},
      async observe(role,phase){if(phase==='frames')throw Error('Negative mapping observation');},
    };
    try {
      const dependencies=await createProviderDependencies(ctx,{applicationClients});
      const env={LIVEKIT_URL:ctx.settings.livekitUrl,LIVEKIT_API_KEY:'fixture-key',LIVEKIT_API_SECRET:'fixture-secret'};
      const grants={room:'fixture'};
      for(const role of Object.keys(pages))grants[role+'Grant']=await dependencies.videoGrant(env,'fixture',role,role,1000,role!=='spectator','');
      const clients=await dependencies.createClients(grants);
      await networkHandlers[0]({requestId:'cached',request:{url:'http://127.0.0.1:5173/client.js'},responseStatusCode:304});
      assert.ok(networkActions.some(([method,parameters])=>method==='Fetch.continueRequest'&&parameters.requestId==='cached'));
      await clients.subscriber.connect();
      await assert.rejects(clients.subscriber.waitForFrames(1,100),/Negative mapping/);
      await Promise.all(Object.values(clients).map(client=>client.close()));
      assert.ok(events.indexOf('grants-applied')<events.indexOf('subscriber-connect'));
      for(const origins of guards)assert.deepEqual(origins,['http://127.0.0.1:5173','http://127.0.0.1:8788']);
      for(const role of Object.keys(pages))assert.ok(events.includes(role+'-close'));
      await networkHandlers[0]({requestId:'redirect',request:{url:'http://127.0.0.1:7880/base/rtc'},responseStatusCode:302});
      assert.ok(networkActions.some(([method,parameters])=>method==='Fetch.failRequest'&&parameters.requestId==='redirect'));
    } finally {if(previous===undefined)delete process.env.AEPM_SECRETS_FILE;else process.env.AEPM_SECRETS_FILE=previous;}
  });
});
