'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events');
const discord=require('discord.js');
const CLAN='1516358993939922994',ARENA='766953289409232896',ROLE='1470732413112942665';
async function boot(){
  let bot;const order=[];
  class FakeBot extends EventEmitter{
    constructor(options){super();this.options=options;bot=this;const members=new Map();this.guilds={cache:new Map([[CLAN,{memberCount:0,commands:{create:async()=>{}},members:{fetch:async()=>members}}]])};}
    isReady(){return !!this.online;}
    async login(){order.push('bot-login');this.online=true;this.emit('clientReady');}
  }
  class FakeReader extends EventEmitter{constructor(){super();this.guilds={cache:new Map()};}isReady(){return false;}destroy(){}}
  class FakeDatabase{async connect(){order.push('db-connect');}startLease(){}async loadToken(){return null;}}
  class FakeStore{constructor(){this.data={arena:{},clan:{},outbox:[]};}async load(){}async flush(){}enqueue(e){this.data.outbox.push(e);}}
  const cfg={botToken:'fixture-bot-secret',mongoUri:'fixture-db-secret',encryptionKey:'fixture-key-secret',clanId:CLAN,arenaId:ARENA,roleId:ROLE,logId:'1550714406529273936',excludeBots:true,publicScan:true,allowedRoles:[],tokenAdmins:[],interval:300000,budget:120000};
  const module={exports:{}};
  const localRequire=name=>{
    if(name==='discord.js')return {...discord,Client:FakeBot};
    if(name==='./python-reader')return {PythonReader:FakeReader,prepareReaderRuntime:async()=>order.push('reader-setup')};
    if(name==='./config')return {config:()=>cfg};
    if(name==='./database')return {Database:FakeDatabase,MongoStore:FakeStore};
    return require(name.startsWith('./')?path.join(__dirname,'../src',name.slice(2)):name);
  };
  localRequire.main={};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/index.js'),'utf8'),{require:localRequire,module,exports:module.exports,console:{log(){},warn(){},error(){}},process:{on(){},env:{},memoryUsage:()=>({rss:1000000})},setTimeout:()=>({}),clearTimeout(){},setInterval:()=>({unref(){}})});
  await module.exports.main();await new Promise(resolve=>setImmediate(resolve));
  const replies=[];let counter=0;
  async function send(content,id){
    const message={id:id||String(1559008734322364000n+BigInt(++counter)),content,guildId:CLAN,channelId:'1559008734322364486',author:{bot:false,id:'141947703742562304'},member:{permissions:{has:()=>true}},reply:async payload=>{replies.push(payload);return {edit:async next=>replies.push(next)};}};
    await bot.listeners('messageCreate')[0](message);
  }
  return {bot,replies,send,order};
}
test('removed activity command and its old variants produce no response or tracking',async()=>{
  const f=await boot();
  for(const command of ['!تفاعل','!تفاعل @عضو','!تفاعل خامل 14','!تفاعل نشط 7'])await f.send(command);
  assert.equal(f.replies.length,0);assert.equal(f.bot.listenerCount('voiceStateUpdate'),0);
  assert.equal(f.bot.options.intents.includes(discord.GatewayIntentBits.GuildVoiceStates),false);
});
test('help and status retain scan/jail commands and show the new reader without activity reports',async()=>{
  const f=await boot();await f.send('!help');await f.send('!status');
  const text=f.replies.map(p=>JSON.stringify(p.embeds.map(e=>e.toJSON()))).join('\n');
  assert.match(text,/!scan/);assert.match(text,/!سجن/);assert.match(text,/discord\.py-self/);assert.match(text,/2\.1\.0/);assert.doesNotMatch(text,/!تفاعل/);
  assert.ok(f.order.indexOf('reader-setup')<f.order.indexOf('bot-login'));
});
test('one Discord message ID is answered once; a new message with the same text is independent',async()=>{
  const f=await boot();const id='1559008734322364010';await f.send('!status',id);await f.send('!status',id);assert.equal(f.replies.length,1);
  assert.equal(f.replies[0].nonce,id);assert.equal(f.replies[0].enforceNonce,true);
  await f.send('!status','1559008734322364011');assert.equal(f.replies.length,2);
});
