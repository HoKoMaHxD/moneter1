'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Scanner } = require('../src/scanner');
const { Monitor } = require('../src/monitor');
const { EventEmitter } = require('node:events');
const roleId = '1470732413112942665';
function fakeMember(id, roles=[]) {
  return { id, roles: {cache:new Map(roles.map(r=>[r,{}]))}, user:{bot:false,displayAvatarURL:()=>null} };
}
function fixture(options={}) {
  const clanIds=options.clanIds || ['a','b'];
  const clanMembers=new Map(clanIds.map(id=>[id,fakeMember(id)]));
  const arenaMembers=options.arenaMembers || new Map([['a',fakeMember('a',[roleId])],['outside',fakeMember('outside',[roleId])]]);
  const reader=new EventEmitter(), calls=[];
  const cfg={roleId,clanId:'clan',arenaId:'arena',excludeBots:true,budget:120000};
  const store={data:{arena:{},clan:{},outbox:[]},enqueue(e){this.data.outbox.push(e);},flush:async()=>{}};
  const monitor=new Monitor(store,cfg);
  const arenaGuild={id:'arena',memberCount:270000,shard:{send(packet){
    calls.push(packet);
    if(options.onBulk) options.onBulk();
    const members=packet.d.user_ids.filter(id=>arenaMembers.has(id)).map(id=>({user:{id,bot:false},roles:[...arenaMembers.get(id).roles.cache.keys()]}));
    queueMicrotask(()=>reader.emit('raw',{t:'GUILD_MEMBERS_CHUNK',d:{guild_id:'arena',nonce:packet.d.nonce,chunk_index:0,chunk_count:1,members}}));
  }},members:{cache:new Map(),fetchByMemberSafety:async()=>{throw new Error('Must never enumerate Arena');},fetch:async o=>{
    if(Array.isArray(o.user)) {
      if(options.onBulk) options.onBulk();
      return new Map(o.user.filter(id=>arenaMembers.has(id)).map(id=>[id,arenaMembers.get(id)]));
    }
    if(options.forbidden) throw Object.assign(new Error('Missing Access'),{code:50001});
    throw Object.assign(new Error('Unknown Member'),{code:10007});
  }},roles:{fetch:async()=>({name:'SNOW'}),fetchMemberIds:async()=>options.ids||['a','outside'],fetchMemberCounts:async()=>({[roleId]:options.count??2})}};
  const clanGuild={memberCount:options.clanCount??clanMembers.size,members:{cache:clanMembers,fetch:async()=>clanMembers}};
  const bot={isReady:()=>true,guilds:{cache:new Map([['clan',clanGuild]])}};
  Object.assign(reader,{isReady:()=>true,guilds:{cache:new Map([['arena',arenaGuild]])}});
  const scanner=new Scanner(bot,reader,cfg,monitor);
  return {scanner,monitor,store,calls,reader};
}
test('integrated scan verifies all role holders and explicit absent member',async()=>{
  const {scanner}=fixture(); const r=await scanner.scan(roleId);
  assert.equal(r.roleComplete,true);assert.deepEqual(r.groups.outside,['outside']);
  assert.deepEqual(r.groups.absent,['b']);assert.deepEqual(r.groups.unknown,[]);
});
test('permission failure is unknown, never an absent member',async()=>{
  const {scanner}=fixture({forbidden:true});const r=await scanner.scan(roleId);
  assert.deepEqual(r.groups.absent,[]);assert.deepEqual(r.groups.unknown,['b']);
});
test('partial role enumeration does not claim a complete result',async()=>{
  const {scanner}=fixture({ids:['a'],count:500});const r=await scanner.scan(roleId);
  assert.equal(r.roleComplete,false);assert.equal(r.verifiedCount,1);assert.equal(r.expected,500);
  assert.ok(r.notes.some(n=>n.includes('جزئية')));
});
test('incomplete clan list aborts instead of classifying outsiders incorrectly',async()=>{
  const {scanner}=fixture({clanCount:8});await assert.rejects(scanner.scan(roleId),/لم تكتمل قائمة/);
});
test('same-role simultaneous scans share one operation, different role waits',async()=>{
  const {scanner}=fixture();const first=scanner.scan(roleId),second=scanner.scan(roleId);
  assert.strictEqual(first,second);await assert.rejects(scanner.scan('another'),/فحص لرتبة أخرى/);await first;
});
test('a live role removal during a scan wins over an older chunk result',async()=>{
  let f;
  f=fixture({clanIds:['a'],onBulk:()=>{
    const data={id:'a',present:true,roles:[],at:Date.now()+1};
    f.scanner.observe(data);f.monitor.arena(data,'live');
  }});
  const r=await f.scanner.scan(roleId);
  assert.deepEqual(r.groups.missingRole,['a']);assert.equal(f.store.data.arena.a.role,false);
  assert.equal(r.roleComplete,false);
});
test('clan membership changing during Arena requests invalidates the comparison',async()=>{
  let f; f=fixture({clanIds:['a'],onBulk:()=>f.monitor.clan('new',true,'live')});
  await assert.rejects(f.scanner.scan(roleId),/تغيّرت عضوية الكلان/);
});

test('270k Arena: all 107 clan members verified with two targeted requests and no full enumeration', async()=>{
  const ids=Array.from({length:107},(_,i)=>String(100000000000000000n+BigInt(i)));
  const arenaMembers=new Map(ids.map(id=>[id,fakeMember(id,[roleId])]));
  const f=fixture({clanIds:ids,arenaMembers,ids:ids.slice(0,100),count:107});
  const r=await f.scanner.scan(roleId);
  assert.equal(r.roleComplete,true); assert.equal(r.groups.matched.length,107);
  assert.equal(r.targetCount,107); assert.equal(r.batchCount,2); assert.equal(r.individualChecks,0);
  assert.deepEqual(f.calls.map(p=>p.d.user_ids.length),[100,7]);
  assert.ok(f.calls.every(p=>p.op===8 && !('query' in p.d)));
  assert.equal(f.reader.listenerCount('raw'),0);
});
test('unknown holders outside clan remain explicitly incomplete despite checking every clan member', async()=>{
  const ids=Array.from({length:107},(_,i)=>String(100000000000000000n+BigInt(i)));
  const arenaMembers=new Map(ids.map(id=>[id,fakeMember(id,[roleId])]));
  const f=fixture({clanIds:ids,arenaMembers,ids:ids.slice(0,100),count:110});
  const r=await f.scanner.scan(roleId);
  assert.equal(r.roleComplete,false);assert.equal(r.verifiedCount,107);assert.equal(r.groups.unknown.length,0);
});
test('relevant live change invalidates a cached scan immediately', async()=>{
  const f=fixture({clanIds:['a']});await f.scanner.scan(roleId);const previous=f.calls.length;
  f.scanner.observe({id:'a',present:true,roles:[],at:Date.now()});
  await f.scanner.scan(roleId);assert.ok(f.calls.length>previous);
});
test('refresh can force a new scan even within the five-second response cache', async()=>{
  const f=fixture({clanIds:['a']});await f.scanner.scan(roleId);const previous=f.calls.length;
  await f.scanner.scan(roleId);assert.equal(f.calls.length,previous);
  await f.scanner.scan(roleId,{force:true});assert.ok(f.calls.length>previous);
});

test('sanctions use verified clan holders including outsiders, with no separate sanction scan', async()=>{
  const jail='766953289513172995',warning='1062648452191891466';
  const arenaMembers=new Map([
    ['a',fakeMember('a',[roleId,jail])],
    ['outside',fakeMember('outside',[roleId,jail,warning])],
    ['b',fakeMember('b',[warning])],
  ]);
  const f=fixture({arenaMembers});
  Object.assign(f.scanner.config,{jailRoleId:jail,warningRoleId:warning});
  const r=await f.scanner.scan(roleId);
  assert.deepEqual(r.sanctions,{jailed:['a','outside'],warned:['outside']});
  assert.equal(f.calls.length,1);
  arenaMembers.set('outside',fakeMember('outside',[roleId]));
  const updated=await f.scanner.scan(roleId,{force:true});
  assert.deepEqual(updated.sanctions,{jailed:['a'],warned:[]});
  assert.deepEqual(r.sanctions,{jailed:['a','outside'],warned:['outside']});
});

test('live sanction removal wins over an older scan response', async()=>{
  const jail='766953289513172995';let f;
  f=fixture({clanIds:['a'],ids:['a'],count:1,arenaMembers:new Map([['a',fakeMember('a',[roleId,jail])]]),onBulk:()=>{
    const data={id:'a',present:true,roles:[roleId],at:Date.now()+1};
    f.scanner.observe(data);f.monitor.arena(data,'live');
  }});
  Object.assign(f.scanner.config,{jailRoleId:jail,warningRoleId:'1062648452191891466'});
  assert.deepEqual((await f.scanner.scan(roleId)).sanctions,{jailed:[],warned:[]});
});

test('periodic scan logs new sanctions in existing outbox without extra member requests', async()=>{
  const jail='766953289513172995',warning='1062648452191891466';
  const arenaMembers=new Map([['a',fakeMember('a',[roleId])]]);
  const f=fixture({clanIds:['a'],ids:['a'],count:1,arenaMembers});
  Object.assign(f.scanner.config,{jailRoleId:jail,warningRoleId:warning});
  await f.scanner.scan(roleId);
  arenaMembers.set('a',fakeMember('a',[roleId,jail,warning]));
  await f.scanner.scan(roleId,{force:true});
  await f.scanner.scan(roleId,{force:true});
  assert.deepEqual(f.store.data.outbox.map(e=>e.type),['jail_add','warning_add']);
  assert.ok(f.store.data.outbox.every(e=>e.source==='reconcile'));
  assert.equal(f.calls.length,3);
});

test('live sanction addition during scan produces a single log and wins over old response', async()=>{
  const jail='766953289513172995';let emitLive=false,f;
  f=fixture({clanIds:['a'],ids:['a'],count:1,arenaMembers:new Map([['a',fakeMember('a',[roleId])]]),onBulk:()=>{
    if(!emitLive)return;
    const data={id:'a',present:true,roles:[roleId,jail],at:Date.now()+1};
    f.scanner.observe(data);f.monitor.arena(data,'live');
  }});
  Object.assign(f.scanner.config,{jailRoleId:jail,warningRoleId:'1062648452191891466'});
  await f.scanner.scan(roleId);emitLive=true;
  const r=await f.scanner.scan(roleId,{force:true});
  assert.deepEqual(r.sanctions,{jailed:['a'],warned:[]});
  assert.deepEqual(f.store.data.outbox.map(e=>e.type),['jail_add']);
  assert.equal(f.store.data.outbox[0].source,'live');
});
