'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { classify, parseScan, safeError } = require('../src/core');
const { Monitor } = require('../src/monitor');
const { Store } = require('../src/store');
const { reportPayload, pages, eventPayload } = require('../src/ui');
const { config } = require('../src/config');
const roleId = '1470732413112942665';
const cfg = { roleId, excludeBots: true };
const member = (id, roles = [], extra = {}) => ({ id, present: true, roles, at: 1, ...extra });
function setup() {
  const store = { data: { arena: {}, clan: {}, outbox: [] }, enqueue(e) { this.data.outbox.push(e); } };
  return { store, monitor: new Monitor(store, cfg) };
}
test('classification separates all requested groups and refuses to infer absence from missing data', () => {
  const clan = new Map(['match','no-role','absent','unknown','timeout','bot'].map(id => [id,{bot:id==='bot'}]));
  const arena = new Map([
    ['match',member('match',[roleId])], ['outside',member('outside',[roleId])], ['no-role',member('no-role')],
    ['absent',member('absent',[],{present:false})], ['timeout',{present:null}], ['bot',member('bot',[roleId],{bot:true})],
  ]);
  const r = classify(clan, arena, roleId);
  assert.deepEqual(r.outside,['outside']); assert.deepEqual(r.missingRole,['no-role']);
  assert.deepEqual(r.absent,['absent']); assert.deepEqual(r.unknown,['timeout','unknown']);
  assert.deepEqual(r.matched,['match']); assert.deepEqual(r.holders,['match','outside']);
});
test('scan parser handles role IDs and role mentions without accepting extra arguments', () => {
  assert.equal(parseScan('!scan', roleId).roleId, roleId);
  assert.equal(parseScan(`!scan <@&${roleId}>`, roleId).custom, true);
  assert.equal(parseScan('!scanned', roleId), null);
  assert.throws(() => parseScan('!scan abc',roleId)); assert.throws(() => parseScan('!scan 1 2',roleId));
});
test('monitor baseline is silent; duplicate events and polling do not repeat logs', () => {
  const {store,monitor} = setup();
  monitor.arena(member('one'));
  monitor.arena(member('one',[roleId],{at:2}));
  monitor.arena(member('one',[roleId],{at:3}), 'reconcile');
  monitor.arena(member('one',[],{at:4}));
  monitor.arena(member('one',[],{at:5}));
  assert.deepEqual(store.data.outbox.map(e=>e.type), ['role_add','role_remove']);
});
test('unknown, partial and stale observations cannot remove a role', () => {
  const {store,monitor} = setup();
  monitor.arena(member('one',[roleId],{at:10}));
  monitor.arena({id:'one',present:null,at:11});
  monitor.arena({id:'one',present:true,at:12});
  monitor.arena(member('one',[],{at:9}));
  assert.equal(store.data.arena.one.role, true); assert.equal(store.data.outbox.length,0);
});
test('leaving Arena is not falsely logged as a manual role removal', () => {
  const {store,monitor} = setup();
  monitor.arena(member('one',[roleId]));
  monitor.arena(member('one',[],{present:false,at:2}));
  assert.deepEqual(store.data.outbox.map(e=>e.type),['arena_leave']);
});
test('first newly discovered holder is labeled observed, not assigned', () => {
  const {store,monitor} = setup(); store.data.arenaInitialized = true;
  monitor.arena(member('new',[roleId]));
  assert.equal(store.data.outbox[0].type,'role_observed');
});
test('clan reconciliation emits true joins/leaves and refuses a stale snapshot', () => {
  const {store,monitor} = setup();
  monitor.reconcileClan(new Map([['a',{}],['b',{}]]),0);
  assert.equal(store.data.outbox.length,0);
  const revision = monitor.clanRevision;
  monitor.clan('c',true,'live');
  assert.equal(monitor.reconcileClan(new Map([['a',{}]]),revision),false);
  monitor.reconcileClan(new Map([['a',{}],['c',{}]]),monitor.clanRevision);
  assert.deepEqual(store.data.outbox.map(e=>e.type),['clan_join','clan_leave']);
});
test('state and pending logs survive restart, corrupt state fails visibly', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'snow-test-'));
  try {
    const a = new Store(dir,'test'); await a.load(); a.enqueue({key:'one'}); a.data.arena.x={role:true}; await a.flush();
    const b = new Store(dir,'test'); await b.load(); assert.deepEqual(b.data,a.data);
    await assert.rejects(new Store(dir,'different').load());
    await fs.writeFile(path.join(dir,'state.json'),'{broken'); await assert.rejects(new Store(dir,'test').load());
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
test('large reports stay one embed, within Discord limits, and all names can be paged', () => {
  const ids = Array.from({length:1001},(_,i)=>(100000000000000000n+BigInt(i)).toString());
  const report = {roleId,roleName:'SNOW',roleComplete:false,verifiedCount:1001,expected:2000,clanCount:1001,
    started:1,finished:2000,notes:['بيانات جزئية'],groups:{holders:ids,outside:ids,missingRole:ids,absent:ids,unknown:ids,matched:[]}};
  const collected=[];
  for(let page=0;page<pages(report,true);page++) {
    const payload = reportPayload(cfg,report,true,page,'test'); assert.equal(payload.embeds.length,1);
    const embed=payload.embeds[0].toJSON(); let total=(embed.title?.length||0)+(embed.description?.length||0)+(embed.footer?.text?.length||0);
    for(const f of embed.fields){assert.ok(f.value.length<=1024);assert.ok(f.name.length<=256);total+=f.value.length+f.name.length;}
    assert.ok(total<=6000); collected.push(...[...embed.fields[0].value.matchAll(/<@(\d+)>/g)].map(m=>m[1]));
  }
  assert.deepEqual(collected,ids);
});
test('log mentions are inline without pings, reconciliation time is labeled correctly', () => {
  const p = eventPayload(cfg,{type:'role_remove',id:'123',key:'key',at:1,source:'reconcile'});
  assert.deepEqual(p.allowedMentions,{parse:[]}); assert.match(p.embeds[0].toJSON().description,/<@123>/);
  assert.match(p.embeds[0].toJSON().footer.text,/وقت الاكتشاف/);
});
test('secrets are redacted and configuration contains the supplied server IDs', () => {
  assert.equal(safeError(new Error('token SECRET'),'SECRET'.split(' ')), 'token [REDACTED]');
  const c=config({DISCORD_BOT_TOKEN:'x',READER_TOKEN:'y',MONGODB_URI:'mongodb://localhost',ENCRYPTION_KEY:'a'.repeat(64)});
  assert.equal(c.clanId,'1516358993939922994');assert.equal(c.arenaId,'766953289409232896');
  assert.throws(()=>config({DISCORD_BOT_TOKEN:'x',READER_TOKEN:'y',RECONCILE_SECONDS:'1'}));
});
