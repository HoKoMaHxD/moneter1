'use strict';
const { MongoClient } = require('mongodb');
const { randomUUID, createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
class Database {
  constructor(config) {
    this.config=config; this.scope=`${config.clanId}:${config.arenaId}:${config.roleId}`;
    this.client=new MongoClient(config.mongoUri,{serverSelectionTimeoutMS:10000,connectTimeoutMS:10000,maxPoolSize:5});
    this.owner=randomUUID(); this.leaseTimer=null;
  }
  async connect({leaseWaitMs=110000}={}) {
    await this.client.connect();this.db=this.client.db(this.config.mongoDb);
    this.members=this.db.collection('monitor_members');this.state=this.db.collection('monitor_state');
    this.outbox=this.db.collection('monitor_outbox');
    this.settings=this.db.collection('monitor_settings');this.leases=this.db.collection('monitor_leases');
    await Promise.all([this.members.createIndex({scope:1}),this.outbox.createIndex({scope:1,at:1})]);
    await this.waitForLease({timeoutMs:leaseWaitMs});
  }
  async acquireLease() {
    const now=new Date();
    try {
      const result=await this.leases.findOneAndUpdate({_id:this.scope,$or:[{owner:this.owner},{expires:{$lt:now}}]},
        {$set:{owner:this.owner,expires:new Date(Date.now()+90000)}},{upsert:true,returnDocument:'after'});
      if(result?.owner!==this.owner)throw Object.assign(new Error('قفل التشغيل محجوز.'),{code:'LEASE_BUSY'});
    } catch(error) { if(error.code===11000)throw Object.assign(new Error('قفل التشغيل محجوز.'),{code:'LEASE_BUSY'});throw error; }
  }
  async waitForLease({timeoutMs=110000,retryMs=5000,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),onWait=seconds=>console.log(`[startup:lease] انتظار انتهاء قفل التشغيل السابق… المتبقي ${seconds} ثانية. لا تعد تشغيل الخدمة أثناء الانتظار.`)}={}) {
    const deadline=now()+timeoutMs;let waiting=false,lastNotice=-Infinity;
    while(true){
      try{await this.acquireLease();if(waiting)console.log('[startup:lease] تم الحصول على القفل؛ استكمال تشغيل البوت.');return;}
      catch(error){
        if(error.code!=='LEASE_BUSY')throw error;
        const remaining=deadline-now();
        if(remaining<=0)throw Object.assign(new Error('انتهت مهلة انتظار قفل التشغيل. توجد نسخة أخرى تجدد القفل أو يحتاج القفل إلى فحص. أوقف النسخ الأخرى على نفس قاعدة البيانات ثم أعد المحاولة.'),{code:'LEASE_BUSY'});
        waiting=true;if(now()-lastNotice>=15000){onWait(Math.ceil(remaining/1000));lastNotice=now();}
        await sleep(Math.min(retryMs,remaining));
      }
    }
  }
  startLease(onError) {
    this.leaseTimer=setInterval(()=>this.leases.updateOne({_id:this.scope,owner:this.owner},{$set:{expires:new Date(Date.now()+90000)}})
      .then(r=>{if(r.matchedCount!==1)throw new Error('فُقد قفل تشغيل البوت.');}).catch(onError),25000);this.leaseTimer.unref();
  }
  async close(){clearInterval(this.leaseTimer);try{await this.leases.deleteOne({_id:this.scope,owner:this.owner});}finally{await this.client.close();}}
  async loadToken(){const d=await this.settings.findOne({_id:`${this.scope}:reader`});return d?.sealed?decrypt(d.sealed,this.config.encryptionKey,this.scope):null;}
  async saveToken(token,actor){await this.settings.updateOne({_id:`${this.scope}:reader`},{$set:{scope:this.scope,sealed:encrypt(token,this.config.encryptionKey,this.scope),updatedBy:actor,updatedAt:new Date()}},{upsert:true});}
}
function encrypt(text,key,scope){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv);cipher.setAAD(Buffer.from(scope));const body=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);return {v:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),body:body.toString('base64')};}
function decrypt(data,key,scope){if(data.v!==1)throw new Error('إصدار تشفير التوكن غير معروف.');const decipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),Buffer.from(data.iv,'base64'));decipher.setAAD(Buffer.from(scope));decipher.setAuthTag(Buffer.from(data.tag,'base64'));return Buffer.concat([decipher.update(Buffer.from(data.body,'base64')),decipher.final()]).toString('utf8');}
class MongoStore {
  constructor(database){this.database=database;this.scope=database.scope;this.data={version:1,scope:this.scope,arena:{},clan:{},clanInitialized:false,outbox:[]};this.written={arena:{},clan:{},outbox:[]};this.pending=null;this.requested=false;this.lastError=null;}
  async load(){
    const db=this.database,meta=await db.state.findOne({_id:this.scope});
    if(meta){Object.assign(this.data,{clanInitialized:!!meta.clanInitialized,arenaInitialized:!!meta.arenaInitialized});
      for await(const doc of db.members.find({scope:this.scope})){if(['arena','clan'].includes(doc.kind))this.data[doc.kind][doc.userId]=doc.value;}
      this.data.outbox=await db.outbox.find({scope:this.scope}).sort({at:1,_id:1}).toArray();this.data.outbox=this.data.outbox.map(({_id,scope,...event})=>event);
    }else{
      try{const old=JSON.parse(await fs.readFile(path.join(db.config.dataDir,'state.json'),'utf8'));if(old.scope!==this.scope)throw new Error('ملف الحالة السابق يخص إعدادات مختلفة.');this.data=old;}catch(error){if(error.code!=='ENOENT')throw error;}
      await this.flush();
    }
    this.written=structuredClone(this.data);
  }
  enqueue(event){if(this.data.outbox.length>=10000)throw new Error('طابور اللوق ممتلئ؛ راجع MongoDB وصلاحيات اللوق.');this.data.outbox.push(event);}
  flush(){
    this.requested=true;
    if(this.pending)return this.pending;
    this.pending=(async()=>{while(this.requested){this.requested=false;const snapshot=structuredClone(this.data);await this.write(snapshot);this.written=snapshot;this.lastError=null;}})()
      .catch(error=>{this.lastError=error;throw error;}).finally(()=>{this.pending=null;});return this.pending;
  }
  async write(snapshot){
    const db=this.database,ops=[];
    for(const kind of ['clan','arena']){
      for(const [id,value] of Object.entries(snapshot[kind]))if(JSON.stringify(value)!==JSON.stringify(this.written[kind][id]))ops.push({updateOne:{filter:{_id:`${this.scope}:${kind}:${id}`},update:{$set:{scope:this.scope,kind,userId:id,value}},upsert:true}});
      for(const id of Object.keys(this.written[kind]))if(!snapshot[kind][id])ops.push({deleteOne:{filter:{_id:`${this.scope}:${kind}:${id}`}}});
    }
    if(ops.length)await db.members.bulkWrite(ops,{ordered:true});
    if(snapshot.outbox.length)await db.outbox.bulkWrite(snapshot.outbox.map(event=>({updateOne:{filter:{_id:`${this.scope}:${event.key}`},update:{$setOnInsert:{scope:this.scope,...event}},upsert:true}})),{ordered:true});
    const kept=new Set(snapshot.outbox.map(e=>e.key)),acked=this.written.outbox.filter(e=>!kept.has(e.key)).map(e=>`${this.scope}:${e.key}`);
    if(acked.length)await db.outbox.deleteMany({_id:{$in:acked},scope:this.scope});
    await db.state.updateOne({_id:this.scope},{$set:{version:2,clanInitialized:!!snapshot.clanInitialized,arenaInitialized:!!snapshot.arenaInitialized,updatedAt:new Date()}},{upsert:true});
  }
}
module.exports={Database,MongoStore,encrypt,decrypt};
