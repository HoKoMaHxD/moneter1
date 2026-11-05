'use strict';
const {ReaderError}=require('./python-reader');
class ReaderSwitch {
  constructor({makeClient,database,arenaId,scanner,getCurrent,promote,onSecret}){Object.assign(this,{makeClient,database,arenaId,scanner,getCurrent,promote,onSecret});this.busy=false;}
  async replace(token,actor){
    if(this.busy)throw new Error('يوجد تحديث توكن جارٍ الآن.');
    token=token.trim();if(token.length<20||token.length>300||/\s/.test(token))throw new Error('صيغة التوكن غير صحيحة.');
    this.busy=true;this.scanner.paused=true;this.onSecret(token);
    let candidate;
    try{
      candidate=this.makeClient();candidate.on('error',()=>{});
      await ready(candidate,token,65000);
      if(!candidate.guilds.cache.has(this.arenaId))throw new Error('الحساب الجديد ليس موجودًا في أرينا.');
      if(this.scanner.active)await this.scanner.active.promise.catch(()=>{});
      await this.database.saveToken(token,actor);
      const old=this.getCurrent();await this.promote(candidate);candidate=null;
      if(old)old.destroy();return true;
    }finally{if(candidate)candidate.destroy();this.scanner.paused=false;this.busy=false;}
  }
}
function ready(client,token,timeout){
  return new Promise((resolve,reject)=>{
    let done=false;
    const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);client.removeListener('ready',onReady);client.removeListener('invalidated',onInvalid);client.removeListener('shardDisconnect',onDisconnect);error?reject(error):resolve();};
    const onReady=()=>finish(),onInvalid=()=>finish(client.disabledCode?new ReaderError(client.disabledCode):new Error('جلسة القارئ غير صالحة.'));
    const onDisconnect=e=>{if(e.code===4004)finish(new Error('توكن القارئ غير صالح.'));};
    const timer=setTimeout(()=>finish(new Error('انتهت مهلة التحقق من حساب القارئ.')),timeout);
    client.once('ready',onReady);client.once('invalidated',onInvalid);client.on('shardDisconnect',onDisconnect);
    Promise.resolve().then(()=>client.login(token)).then(()=>{if(client.isReady())finish();}).catch(error=>finish(error instanceof ReaderError?error:new Error('تعذّر تسجيل دخول القارئ؛ تحقق من التوكن وحالة الحساب.')));
  });
}
module.exports={ReaderSwitch,ready};
