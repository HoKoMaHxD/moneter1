'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {PythonReader}=require('../src/python-reader');
const {Scanner}=require('../src/scanner');
const {Monitor}=require('../src/monitor');
const GUILD='766953289409232896',ROLE='1470732413112942665',A='141947703742562301',B='141947703742562302',OUTSIDE='141947703742562303';
function fixture(t,options={}){
  const logs=[];
  const reader=new PythonReader({arenaId:GUILD,worker:path.join(__dirname,'fixtures/reader.py'),python:process.env.TEST_PYTHON_BIN||'python3',logger:{info:x=>logs.push(x),warn:x=>logs.push(x)},...options});
  t.after(()=>reader.destroy());return {reader,logs};
}
test('Python reader uses one child, minimal member records and targeted IDs without forwarding bot/DB credentials',async t=>{
  const old=process.env.FIXTURE_SECRET;process.env.FIXTURE_SECRET='must-not-be-forwarded';t.after(()=>{old===undefined?delete process.env.FIXTURE_SECRET:process.env.FIXTURE_SECRET=old;});
  const {reader,logs}=fixture(t);await reader.login('fixture-good');const pid=reader.child.pid;
  const {members}=await reader.fetchTargetMembers([A,B]);assert.deepEqual([...members.keys()],[A]);
  const guild=reader.guilds.cache.get(GUILD);assert.deepEqual(await guild.roles.fetchMemberIds(ROLE),[A,OUTSIDE]);
  assert.equal((await guild.members.fetch({user:A,force:true})).id,A);assert.equal(reader.child.pid,pid);
  await assert.rejects(guild.members.fetch({user:B,force:true}),{code:10007});
  assert.equal(logs.some(x=>x.includes('fixture-good')),false);
  const sent=reader.sequence;await assert.rejects(reader.fetchTargetMembers(['invalid']),{code:'INVALID_REQUEST'});assert.equal(reader.sequence,sent);
});
test('verification/auth/access errors disable all future reads and never restart the process',async t=>{
  for(const [token,code] of [['fixture-auth','READER_AUTH'],['fixture-verification','READER_VERIFICATION'],['fixture-access','READER_ACCESS']]){
    const {reader}=fixture(t);await reader.login(token);const child=reader.child;
    const results=await Promise.allSettled([reader.fetchTargetMembers([A]),reader.fetchTargetMembers([B])]);
    for(const result of results){assert.equal(result.status,'rejected');assert.equal(result.reason.code,code);}
    assert.equal(reader.isReady(),false);await assert.rejects(reader.login(token),{code});assert.equal(reader.child,child);
  }
});
test('optional count permission failure does not terminate membership reads or repeatedly request that endpoint',async t=>{
  const {reader}=fixture(t);await reader.login('fixture-optional');const guild=reader.guilds.cache.get(GUILD);
  await assert.rejects(guild.roles.fetchMemberCounts(),{code:'OPTIONAL_ACCESS'});const count=reader.sequence;
  await assert.rejects(guild.roles.fetchMemberCounts(),{code:'OPTIONAL_ACCESS'});assert.equal(reader.sequence,count);assert.equal(reader.isReady(),true);
  assert.equal((await reader.fetchTargetMembers([A])).members.size,1);
});
test('long server rate limits block every queued/new read for the full duration',async t=>{
  let now=100000;const {reader}=fixture(t,{now:()=>now});await reader.login('fixture-rate');
  await assert.rejects(reader.fetchTargetMembers([A]),{code:'RATE_LIMIT'});assert.equal(reader.blockUntil,280000);
  now=279999;await assert.rejects(reader.fetchTargetMembers([A]),{code:'RATE_LIMIT'});assert.equal(reader.sequence,1);
  now=280000;await assert.rejects(reader.fetchTargetMembers([A]),{code:'RATE_LIMIT'});assert.equal(reader.sequence,2);
});
test('dependency error and missing Python are explicit and closing before/after login prevents reads',async t=>{
  const bad=fixture(t).reader;await assert.rejects(bad.login('fixture-dependency'),{code:'READER_PACKAGE_MISSING'});
  const missing=fixture(t,{python:'/no-such-reader-python'}).reader;await assert.rejects(missing.login('fixture-good'),{code:'READER_PYTHON_MISSING'});
  const closed=fixture(t).reader;closed.destroy();await assert.rejects(closed.login('fixture-good'),{code:'READER_CLOSED'});
});
test('existing scanner consumes the Python adapter and keeps absence, outsiders, counts and sanctions correct',async t=>{
  const {reader}=fixture(t);await reader.login('fixture-good');
  const makeMember=id=>({id,user:{bot:false,displayAvatarURL:()=>null},roles:{cache:new Map()}});
  const clanMembers=new Map([A,B].map(id=>[id,makeMember(id)]));
  const clan={memberCount:2,members:{cache:clanMembers,fetch:async()=>clanMembers}};
  const bot={isReady:()=>true,guilds:{cache:new Map([['clan',clan]])}};
  const config={clanId:'clan',arenaId:GUILD,roleId:ROLE,jailRoleId:'766953289513172995',warningRoleId:'1062648452191891466',budget:120000,excludeBots:true};
  const store={data:{clan:{},arena:{},outbox:[]},enqueue(e){this.data.outbox.push(e);},flush:async()=>{}};
  const monitor=new Monitor(store,config),scanner=new Scanner(bot,reader,config,monitor);
  reader.on('member',data=>{scanner.observe(data);monitor.arena(data,'live');});
  const report=await scanner.scan(ROLE);
  assert.equal(report.roleComplete,true);assert.deepEqual(report.groups.absent,[B]);assert.deepEqual(report.groups.outside,[OUTSIDE]);
  assert.deepEqual(report.groups.matched,[A]);assert.deepEqual(report.sanctions.jailed,[OUTSIDE]);assert.equal(report.groups.unknown.length,0);
});
