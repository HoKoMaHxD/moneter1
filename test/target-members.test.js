'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {fetchTargetMembers}=require('../src/target-members');
function setup(send){const client=new EventEmitter();return {client,guild:{id:'guild',shard:{send:p=>send(p,client)}}};}
const chunk=(p,extra={})=>({t:'GUILD_MEMBERS_CHUNK',d:{guild_id:'guild',nonce:p.d.nonce,chunk_index:0,chunk_count:1,members:[{user:{id:'a'},roles:['role']}],...extra}});
test('listener is registered before send and only requested members are returned',async()=>{
  const {client,guild}=setup((p,c)=>c.emit('raw',chunk(p,{members:[{user:{id:'a'},roles:[]},{user:{id:'unrelated'},roles:[]}]})));
  const result=await fetchTargetMembers(client,guild,['a']);assert.equal(result.completed,true);assert.deepEqual([...result.members.keys()],['a']);
  assert.equal(client.listenerCount('raw'),0);assert.equal(client.listenerCount('shardDisconnect'),0);
});
test('wrong guild/nonce and malformed payloads cannot resolve a member request',async()=>{
  const {client,guild}=setup((p,c)=>{c.emit('raw',chunk(p,{guild_id:'other'}));c.emit('raw',chunk(p,{nonce:'other'}));c.emit('raw',chunk(p,{chunk_count:0}));});
  const result=await fetchTargetMembers(client,guild,['a'],15);assert.equal(result.completed,false);assert.equal(result.members.size,0);assert.equal(client.listenerCount('raw'),0);
});
test('duplicate chunks cannot falsely finish a multichunk response',async()=>{
  const {client,guild}=setup((p,c)=>{c.emit('raw',chunk(p,{chunk_count:2}));c.emit('raw',chunk(p,{chunk_count:2}));});
  const result=await fetchTargetMembers(client,guild,['a'],15);assert.equal(result.completed,false);assert.equal(result.members.size,1);
});
test('not_found or missing members are not silently classified as absent',async()=>{
  const {client,guild}=setup((p,c)=>c.emit('raw',chunk(p,{members:[],not_found:['a']})));
  const result=await fetchTargetMembers(client,guild,['a']);assert.equal(result.completed,true);assert.equal(result.members.has('a'),false);
});
test('disconnect ends a request immediately and removes listeners',async()=>{
  const {client,guild}=setup((p,c)=>c.emit('shardDisconnect',{code:1006}));
  const result=await fetchTargetMembers(client,guild,['a']);assert.equal(result.completed,false);assert.equal(client.listenerCount('raw'),0);
});
test('synchronous send failure cleans up and propagates the error',async()=>{
  const {client,guild}=setup(()=>{throw new Error('socket closed');});
  await assert.rejects(fetchTargetMembers(client,guild,['a']),/socket closed/);assert.equal(client.listenerCount('raw'),0);
});
