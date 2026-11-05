'use strict';
const {EventEmitter}=require('node:events');
const {spawn}=require('node:child_process');
const {existsSync}=require('node:fs');
const path=require('node:path');
const {snowflake}=require('./core');
const root=path.resolve(__dirname,'..');
const fatalCodes=new Set(['READER_AUTH','READER_VERIFICATION','READER_ACCESS','READER_DEPENDENCY','READER_PYTHON_VERSION','READER_PACKAGE_MISSING','READER_PACKAGE_VERSION','READER_PACKAGE_CONFLICT','READER_IMPORT_FAILED','READER_PYTHON_MISSING','READER_STARTUP','READER_PROTOCOL','READER_TIMEOUT','READER_CLOSED','ARENA_NOT_JOINED','READER_NOT_CONFIGURED']);
const messages={READER_AUTH:'رفض ديسكورد اعتماد القارئ؛ راجع الحساب قبل إعادة تشغيله.',READER_VERIFICATION:'طلب ديسكورد التحقق من الحساب؛ توقف القارئ دون إعادة دخول تلقائية.',READER_ACCESS:'رفض ديسكورد وصول القارئ؛ توقف لهذه الجلسة.',READER_DEPENDENCY:'مكتبة القارئ غير متاحة؛ راجع npm run check:reader.',READER_PYTHON_VERSION:'يلزم Python 3.10 أو أحدث.',READER_PACKAGE_MISSING:'discord.py-self غير مثبتة في بيئة Python المستخدمة.',READER_PACKAGE_VERSION:'يلزم discord.py-self==2.1.0؛ راجع npm run setup:reader.',READER_PACKAGE_CONFLICT:'تعارض في مكتبة discord؛ استخدم بيئة .venv-reader المخصصة.',READER_IMPORT_FAILED:'تعذر تحميل مكتبة القارئ؛ راجع تشخيص بدء التشغيل.',READER_PYTHON_MISSING:'Python غير موجود. تحتاج الاستضافة Python 3.10+ مع Node.',READER_STARTUP:'تعذر بدء اتصال القارئ ضمن المهلة.',READER_PROTOCOL:'توقف القارئ بسبب استجابة داخلية غير صالحة.',READER_TIMEOUT:'توقف القارئ بعد انتهاء مهلة الاستجابة.',READER_CLOSED:'القارئ مغلق لهذه الجلسة؛ راجع سجل الاستضافة.',ARENA_NOT_JOINED:'حساب القارئ ليس موجودًا في سيرفر أرينا المحدد.',READER_NOT_CONFIGURED:'أضف READER_TOKEN أو اربط القارئ من /تحديث التوكن.',OPTIONAL_ACCESS:'المسار الاختياري لحصر الرتبة أو عددها غير متاح؛ سيظهر الحصر جزئيًا.',RATE_LIMIT:'القارئ ينتظر مهلة معدل الطلبات. جرّب لاحقًا.',NETWORK:'تعذر اتصال القارئ مؤقتًا؛ القراءات مؤجلة دقيقة.',UNAVAILABLE:'تعذرت قراءة البيانات مؤقتًا؛ القراءات مؤجلة دقيقة.',NOT_MEMBER:'هذا المستخدم غير موجود في أرينا (Discord 10007).',NOT_FOUND:'تعذر العثور على العضو أو الرتبة المطلوبة.',INVALID_REQUEST:'طلب قراءة غير صالح.',BUSY:'هناك طلبات قراءة قيد التنفيذ؛ انتظر اكتمالها.'};
class ReaderError extends Error{constructor(kind,details={}){super(messages[kind]||messages.UNAVAILABLE);this.kind=kind;this.code=kind==='NOT_MEMBER'&&details.discordCode===10007?10007:kind;if(Number.isFinite(details.httpStatus))this.httpStatus=details.httpStatus;if(Number.isFinite(details.retryAfterMs)&&details.retryAfterMs>0)this.retryAfterMs=details.retryAfterMs;}}
function pythonExecutable(explicit){if(explicit)return explicit;const local=path.join(root,process.platform==='win32'?'.venv-reader/Scripts/python.exe':'.venv-reader/bin/python');return existsSync(local)?local:process.platform==='win32'?'python':'python3';}
function validRecord(value){return value&&snowflake(value.id)&&typeof value.id==='string'&&value.present===true&&Array.isArray(value.roles)&&value.roles.length<=250&&value.roles.every(id=>typeof id==='string'&&snowflake(id))&&Number.isFinite(value.at);}
function wrapMember(data){return {id:data.id,roles:{cache:new Map(data.roles.map(id=>[id,{}]))},user:{id:data.id,bot:!!data.bot,displayAvatarURL:()=>data.avatar||null}};}
class PythonReader extends EventEmitter{
  constructor({arenaId,python,worker=path.join(root,'reader/worker.py'),logger=console,startupTimeout=60000,requestTimeout=40000,now=Date.now}={}){
    super();Object.assign(this,{arenaId,python:pythonExecutable(python),worker,logger,startupTimeout,requestTimeout,now});
    this.guilds={cache:new Map()};this.users={cache:new Map()};this.child=null;this.state=false;this.disabledCode=null;this.closed=false;this.sequence=0;this.pending=new Map();this.queue=Promise.resolve();this.queued=0;this.blockUntil=0;this.blockKind='RATE_LIMIT';this.optionalUntil=new Map();
  }
  isReady(){return this.state&&!this.disabledCode&&!this.closed;}
  isBlocked(){return !this.isReady()||this.now()<this.blockUntil;}
  fail(kind){
    if(this.disabledCode)return;
    this.disabledCode=fatalCodes.has(kind)?kind:'READER_CLOSED';this.state=false;
    if(!this.closed)this.logger.warn(`[READER_STOPPED] ${this.disabledCode}`);
    this.rejectStartup?.(new ReaderError(this.disabledCode));
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new ReaderError(this.disabledCode));}this.pending.clear();
    this.child?.stdin.end();this.child?.kill();
    if(!this.closed){this.emit('invalidated');this.emit('stopped',this.disabledCode);}
  }
  makeGuild(meta){
    const members={cache:new Map(),fetch:async options=>{
      const id=options?.user;if(typeof id!=='string'||!snowflake(id))throw new ReaderError('INVALID_REQUEST');
      const data=await this.request('member',{userId:id});if(!validRecord(data))return this.badData();return this.remember(data);
    }};
      const roles={fetch:async roleId=>{const role=await this.request('role',{roleId});if(!role||role.id!==roleId||typeof role.name!=='string')return this.badData();return role;},
      fetchMemberIds:async roleId=>{const rows=await this.request('role_holders',{roleId});if(!Array.isArray(rows)||rows.length>100||rows.some(row=>!validRecord(row)))return this.badData();for(const row of rows)this.remember(row);return rows.map(row=>row.id);},
      fetchMemberCounts:async()=>{const counts=await this.request('role_counts');if(!counts||typeof counts!=='object'||Array.isArray(counts)||Object.entries(counts).some(([id,n])=>!snowflake(id)||!Number.isInteger(n)||n<0))return this.badData();return counts;}};
    return {id:this.arenaId,name:String(meta.name||'Arena').slice(0,100),memberCount:meta.memberCount,members,roles};
  }
  badData(){this.fail('READER_PROTOCOL');throw new ReaderError('READER_PROTOCOL');}
  remember(data){const cache=this.guilds.cache.get(this.arenaId)?.members.cache;const member=wrapMember(data);if(cache){cache.delete(data.id);if(cache.size>=5000)cache.delete(cache.keys().next().value);cache.set(data.id,member);}return member;}
  login(token){
    if(this.closed||this.disabledCode)return Promise.reject(new ReaderError(this.disabledCode||'READER_CLOSED'));
    if(this.starting)return this.starting;
    if(typeof token!=='string'||!token.trim())return Promise.reject(new ReaderError('READER_NOT_CONFIGURED'));
    this.starting=new Promise((resolve,reject)=>{
      let settled=false;const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);this.rejectStartup=null;error?reject(error):resolve(this);};
      this.rejectStartup=finish;const timer=setTimeout(()=>this.fail('READER_STARTUP'),this.startupTimeout);
      const env={};for(const key of ['PATH','HOME','TMPDIR','TEMP','TMP','SystemRoot','WINDIR','LANG','LC_ALL','SSL_CERT_FILE','SSL_CERT_DIR'])if(process.env[key]!==undefined)env[key]=process.env[key];
      Object.assign(env,{READER_TOKEN:token.trim(),ARENA_GUILD_ID:this.arenaId,PYTHONUNBUFFERED:'1',PYTHONNOUSERSITE:'1'});
      try{this.child=spawn(this.python,['-u',this.worker],{env,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});}catch{this.fail('READER_PYTHON_MISSING');return;}
      const child=this.child;child.stdin.on('error',()=>this.fail('READER_CLOSED'));child.stderr.on('data',()=>{});
      child.stdout.setEncoding('utf8');let buffer='';
      child.stdout.on('data',chunk=>{if(this.disabledCode)return;buffer+=chunk;let end;while((end=buffer.indexOf('\n'))!==-1){if(end>1048576){this.fail('READER_PROTOCOL');return;}const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let msg;try{msg=JSON.parse(line);}catch{this.fail('READER_PROTOCOL');return;}
        if(!msg||typeof msg!=='object'||Array.isArray(msg)){this.fail('READER_PROTOCOL');return;}
        if(msg.type==='ready'&&!settled&&msg.protocol===1){if(msg.guild?.id!==this.arenaId||!snowflake(msg.userId)){this.fail('READER_PROTOCOL');return;}this.guilds.cache.set(this.arenaId,this.makeGuild(msg.guild));this.user={id:msg.userId};this.state=true;finish();this.logger.info('[READER_READY] discord.py-self');this.emit('ready');}
        else if(msg.type==='fatal')this.fail(msg.code);
        else if(msg.type==='event')this.event(msg);
        else{const p=this.pending.get(msg.id);if(!p){this.fail('READER_PROTOCOL');return;}this.pending.delete(msg.id);clearTimeout(p.timer);if(msg.ok===true)p.resolve(msg.data);else if(Object.hasOwn(messages,msg.code)){const error=new ReaderError(msg.code,msg);p.reject(error);if(fatalCodes.has(msg.code))this.fail(msg.code);}else{p.reject(new ReaderError('READER_PROTOCOL'));this.fail('READER_PROTOCOL');}}
        if(this.disabledCode)return;
      }if(buffer.length>1048576)this.fail('READER_PROTOCOL');});
      child.once('error',error=>this.fail(error.code==='ENOENT'?'READER_PYTHON_MISSING':'READER_STARTUP'));
      child.once('close',()=>{if(!this.closed)this.fail('READER_CLOSED');});
    });return this.starting;
  }
  event(msg){
    if(msg.event==='rate_limit'&&Number.isFinite(msg.retryAfterMs)&&msg.retryAfterMs>0){this.blockUntil=Math.max(this.blockUntil,this.now()+msg.retryAfterMs);this.blockKind='RATE_LIMIT';return;}
    if(msg.event==='role_delete'&&typeof msg.roleId==='string'&&snowflake(msg.roleId)){this.emit('roleDelete',{id:msg.roleId,guild:{id:this.arenaId}});return;}
    if(msg.event!=='member')return;const d=msg.data;
    if(d?.present===false&&typeof d.id==='string'&&snowflake(d.id)&&Array.isArray(d.roles)&&d.roles.length===0&&Number.isFinite(d.at)){this.guilds.cache.get(this.arenaId)?.members.cache.delete(d.id);this.emit('member',d);}
    else if(validRecord(d)){this.remember(d);this.emit('member',d);}
  }
  request(op,args={}){
    if(this.queued>=12)return Promise.reject(new ReaderError('BUSY'));
    this.queued++;
    const task=this.queue.then(async()=>{
      if(!this.isReady())throw new ReaderError(this.disabledCode||'READER_CLOSED');
      if(this.now()<this.blockUntil)throw new ReaderError(this.blockKind);
      if((this.optionalUntil.get(op)||0)>this.now())throw new ReaderError('OPTIONAL_ACCESS');
      const id=String(++this.sequence);
      try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>this.fail('READER_TIMEOUT'),this.requestTimeout);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,op,...args})+'\n',error=>{if(error)this.fail('READER_CLOSED');});});}
      catch(error){
        if(error.kind==='OPTIONAL_ACCESS')this.optionalUntil.set(op,this.now()+15*60000);
        if(['RATE_LIMIT','NETWORK','UNAVAILABLE'].includes(error.kind)){this.blockUntil=Math.max(this.blockUntil,this.now()+Math.max(60000,error.retryAfterMs||0));this.blockKind=error.kind;}
        throw error;
      }
    });this.queue=task.catch(()=>{});return task.finally(()=>{this.queued--;});
  }
  async fetchTargetMembers(ids,timeoutMs=8000){
    if(!Array.isArray(ids)||ids.length<1||ids.length>100||ids.some(id=>typeof id!=='string'||!snowflake(id)))throw new ReaderError('INVALID_REQUEST');
    const rows=await this.request('members',{userIds:[...new Set(ids)],timeoutMs});
    if(!Array.isArray(rows)||rows.length>ids.length||rows.some(row=>!validRecord(row)||!ids.includes(row.id)))return this.badData();
    for(const row of rows)this.remember(row);
    return {members:new Map(rows.map(row=>[row.id,row])),completed:true};
  }
  destroy(){this.closed=true;this.state=false;this.fail('READER_CLOSED');}
}
async function prepareReaderRuntime(python){
  const env={};for(const key of ['PATH','HOME','TMPDIR','TEMP','TMP','SystemRoot','WINDIR','LANG','LC_ALL','SSL_CERT_FILE','SSL_CERT_DIR'])if(process.env[key]!==undefined)env[key]=process.env[key];
  env.READER_TOKEN='configured';if(python)env.PYTHON_BIN=python;
  await new Promise(resolve=>{const child=spawn(process.execPath,[path.join(root,'scripts/reader-runtime.mjs'),'ensure'],{env,stdio:'inherit',shell:false});child.once('error',()=>{console.warn('[READER_SETUP_UNAVAILABLE] تعذر فحص بيئة القارئ.');resolve();});child.once('close',()=>resolve());});
}
module.exports={PythonReader,ReaderError,pythonExecutable,prepareReaderRuntime};
