'use strict';
const {sleep}=require('./core');
function retryDelay(error){
  const d=error?.data;
  if(d?.opcode!==8||typeof d.retry_after!=='number'||!Number.isFinite(d.retry_after)||d.retry_after<0)return null;
  return Math.ceil(d.retry_after*1000)+500;
}
class ClanMemberLoader {
  constructor({now=Date.now,wait=sleep,onWait=()=>{}}={}){Object.assign(this,{now,wait,onWait});this.pending=null;this.cached=null;this.nextAt=0;this.generation=0;}
  invalidate(){this.cached=null;this.generation++;}
  fetch(guild,{deadline=this.now()+120000}={}){
    if(this.pending)return this.pending;
    const cached=this.cached;
    if(cached&&cached.guild===guild&&this.now()-cached.at<30000&&cached.members.size===guild.memberCount)return Promise.resolve(new Map(cached.members));
    this.pending=this.run(guild,deadline).finally(()=>{this.pending=null;});return this.pending;
  }
  async run(guild,deadline){
    while(true){
      const delay=Math.max(0,this.nextAt-this.now());
      if(this.now()+delay>=deadline)throw new Error(`طلب أعضاء الكلان مؤجل بسبب حد Discord. جرّب بعد ${Math.max(1,Math.ceil(delay/1000))} ثانية.`);
      if(delay){this.onWait(Math.ceil(delay/1000));await this.wait(delay);}
      const generation=this.generation;this.nextAt=this.now()+31000;
      try{
        const members=new Map(await guild.members.fetch({withPresences:false,time:Math.max(1,Math.min(30000,deadline-this.now()))}));
        if(generation===this.generation&&members.size===guild.memberCount)this.cached={guild,members,at:this.now()};
        return members;
      }catch(error){
        const retry=retryDelay(error);if(retry===null)throw error;
        this.nextAt=Math.max(this.nextAt,this.now()+retry);
      }
    }
  }
}
module.exports={ClanMemberLoader,retryDelay};
