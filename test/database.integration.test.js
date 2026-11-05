'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Database,MongoStore}=require('../src/database');
test('real MongoDB: monitor state, outbox, encrypted token, lease and restart recovery',{skip:!process.env.MONGO_TEST_URI},async()=>{
  const uri=process.env.MONGO_TEST_URI;
  assert.match(uri,/^mongodb:\/\/127\.0\.0\.1:/,'Integration test only accepts a temporary local MongoDB');
  const config={mongoUri:uri,mongoDb:'snow_test_'+randomUUID().replaceAll('-',''),clanId:'clan',arenaId:'arena',roleId:'role',encryptionKey:'ab'.repeat(32),dataDir:'/tmp/snow-no-legacy-'+randomUUID()};
  const db=new Database(config);await db.connect();
  try{
    const store=new MongoStore(db);await store.load();store.data.clan.a={at:1,bot:false};store.data.arena.a={at:1,present:true,role:true};store.data.clanInitialized=true;store.enqueue({key:'event1',at:1,type:'role_add',id:'a'});await store.flush();
    const loaded=new MongoStore(db);await loaded.load();assert.deepEqual(loaded.data,store.data);
    store.data.outbox.shift();delete store.data.clan.a;await store.flush();const loaded2=new MongoStore(db);await loaded2.load();assert.equal(loaded2.data.outbox.length,0);assert.equal(loaded2.data.clan.a,undefined);
    const secret='testing-token-not-a-real-account';await db.saveToken(secret,'owner');assert.equal(await db.loadToken(),secret);assert.ok(!JSON.stringify(await db.settings.findOne({_id:db.scope+':reader'})).includes(secret));
    const competing=new Database(config);try{await assert.rejects(competing.connect({leaseWaitMs:0}),/نسخة أخرى/);}finally{await competing.client.close();}
  }finally{await db.db.dropDatabase();await db.close();}
});
