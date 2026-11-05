'use strict';
const { record, classify, sleep } = require('./core');
const { fetchTargetMembers } = require('./target-members');
const { ClanMemberLoader } = require('./clan-members');
const { jailGroups } = require('./jail');
class Scanner {
  constructor(bot, reader, config, monitor) {
    Object.assign(this, { bot, reader, config, monitor });
    this.active = null; this.last = null; this.live = new Map(); this.lastDirty = false; this.health = 'لم يبدأ الفحص';
    this.clanMembers = new ClanMemberLoader({onWait:seconds=>{this.health=`انتظار حد طلب أعضاء الكلان: ${seconds} ثانية`;console.log(`[members:wait] ${this.health}`);}});
  }
  observe(data) {
    if (this.active) this.live.set(data.id, data);
    if (this.last && (this.monitor.store.data.clan[data.id] || data.roles?.includes(this.last.roleId) ||
        this.last.groups.holders.includes(data.id))) this.lastDirty = true;
  }
  scan(roleId, { force = false } = {}) {
    if (this.paused) return Promise.reject(new Error('يجري تحديث اتصال القارئ الآن؛ أعد المحاولة بعد اكتماله.'));
    if (this.active) {
      if (this.active.roleId === roleId) return this.active.promise;
      return Promise.reject(new Error('يوجد فحص لرتبة أخرى الآن؛ انتظر انتهاءه.'));
    }
    if (!force && !this.lastDirty && this.last?.roleId === roleId && Date.now() - this.last.finished < 5000) return Promise.resolve(this.last);
    this.live.clear();
    const promise = Promise.resolve().then(() => this.run(roleId)).finally(() => { this.active = null; this.live.clear(); });
    this.active = { roleId, promise, started: Date.now() };
    return promise;
  }
  async run(roleId) {
    const started = Date.now(), deadline = started + this.config.budget;
    if (!this.bot.isReady() || !this.reader.isReady()) throw new Error('البوت أو القارئ غير متصل الآن. استخدم !status.');
    const clanGuild = this.bot.guilds.cache.get(this.config.clanId);
    const arenaGuild = this.reader.guilds.cache.get(this.config.arenaId);
    if (!clanGuild) throw new Error('أضف البوت الرسمي إلى سيرفر الكلان.');
    if (!arenaGuild) throw new Error('حساب القارئ غير موجود في سيرفر أرينا أو لم يكتمل تحميله.');
    const clanRevision = this.monitor.clanRevision;
    // Independent reads share the Python reader queue; no Arena roster is loaded.
    const metadataPromise = Promise.allSettled([arenaGuild.roles.fetchMemberIds(roleId), arenaGuild.roles.fetchMemberCounts()]);
    const [clanMembers, role] = await Promise.all([
      this.clanMembers.fetch(clanGuild, { deadline }),
      arenaGuild.roles.fetch(roleId, { force: true }),
    ]);
    if (!role) throw new Error('هذه الرتبة غير موجودة في سيرفر أرينا.');
    if (clanMembers.size !== clanGuild.memberCount || clanRevision !== this.monitor.clanRevision)
      throw new Error('لم تكتمل قائمة الكلان أو تغيّرت أثناء التحميل؛ أعد الفحص. لم نصنّف أي عضو بناءً على قائمة ناقصة.');
    const clan = new Map([...clanMembers].map(([id, member]) => [id, record(member)]));
    this.monitor.reconcileClan(clan, clanRevision);
    const stableClanRevision = this.monitor.clanRevision;
    const arena = new Map(), candidates = new Set(clan.keys()), notes = [];
    const [idsResult, countsResult] = await metadataPromise;
    const ids = idsResult.status === 'fulfilled' && Array.isArray(idsResult.value) ? idsResult.value : [];
    for (const id of ids) candidates.add(id);
    const countValue = countsResult.status === 'fulfilled' ? countsResult.value[roleId] : undefined;
    const expected = Number.isInteger(countValue) && countValue >= 0 ? countValue : null;
    if (idsResult.status === 'rejected') notes.push('تعذّر جلب قائمة أصحاب الرتبة مباشرة.');
    if (expected == null) notes.push('تعذّر التحقق من العدد المعلن لأصحاب الرتبة.');
    // Cache is only a source of candidates; never use it to establish current membership.
    for (const member of arenaGuild.members.cache.values()) if (member.roles.cache.has(roleId)) candidates.add(member.id);
    if (roleId === this.config.roleId) for (const [id, state] of Object.entries(this.monitor.store.data.arena))
      if (state.role) candidates.add(id);
    // The 100 role IDs are UNIONED with all 107 clan IDs: the cap need not
    // truncate results if remaining holders are already among clan members.
    const allIds = [...candidates];
    let blocked = false, batchCount = 0, individualChecks = 0;
    for (let offset = 0; offset < allIds.length && Date.now() < deadline && !blocked; offset += 200) {
      const wave = allIds.slice(offset, offset + 200);
      const batches = [wave.slice(0,100), wave.slice(100)].filter(batch => batch.length);
      const results = await Promise.allSettled(batches.map(batch => {
        batchCount++;
        return fetchTargetMembers(this.reader, arenaGuild, batch, Math.min(8000, Math.max(1, deadline-Date.now())));
      }));
      for (const result of results) {
        if (result.status === 'fulfilled') for (const [id, data] of result.value.members) arena.set(id, data);
        else if (Number(result.reason.code) === 40001) throw new Error('توكن القارئ غير صالح. حدّث READER_TOKEN ثم أعد التشغيل.');
      }
      if (!this.reader.isReady()) blocked = true;
      // Missing or not_found in a chunk is not used as proof of guild absence.
      // Confirm these few cases directly; only HTTP API code 10007 means absent.
      const missing = wave.filter(id => !arena.has(id));
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(3, missing.length) }, async () => {
        while (cursor < missing.length && Date.now() < deadline && !blocked) {
          const id = missing[cursor++], at = Date.now(); individualChecks++;
          try { arena.set(id, { ...record(await arenaGuild.members.fetch({ user: id, force: true, cache: true })), at }); }
          catch (error) {
            if (Number(error.code) === 10007) arena.set(id, { id, present: false, roles: [], at });
            else {
              arena.set(id, { id, present: null, at });
              if ([50001, 50013, 40001].includes(Number(error.code)) || [401,403].includes(error.httpStatus) || this.reader.isBlocked?.()) blocked = true;
            }
          }
          if (cursor < missing.length) await sleep(250);
        }
      }));
      if (offset + 200 < allIds.length && !blocked) await sleep(1000);
    }
    const endingCounts = await arenaGuild.roles.fetchMemberCounts().catch(() => null);
    // Apply events after the final await so no newer gateway update is overwritten.
    for (const [id, observed] of this.live) if (!arena.has(id) || observed.at >= arena.get(id).at) arena.set(id, observed);
    const endExpected = Number.isInteger(endingCounts?.[roleId]) ? endingCounts[roleId] : null;
    const verifiedCount = [...arena.values()].filter(m => m.present && m.roles?.includes(roleId)).length;
    const roleComplete = expected != null && expected === endExpected && verifiedCount === expected;
    if (!roleComplete) notes.push('قائمة أصحاب الرتبة جزئية أو غير مؤكدة الاكتمال؛ قد توجد أسماء لم تصل للقارئ.');
    if (Date.now() >= deadline) notes.push('انتهت مهلة الفحص؛ الحالات غير المتحققة تظهر ضمن غير المحسوم.');
    if (blocked) notes.push('القارئ لا يملك وصولًا كافيًا لبعض طلبات الأعضاء.');
    // Clan gateway events may have arrived while Arena was being queried. Abort classification if so.
    if (stableClanRevision !== this.monitor.clanRevision)
      throw new Error('تغيّرت عضوية الكلان أثناء الفحص؛ أعد الفحص للحصول على قائمة متّسقة.');
    for (const data of arena.values()) this.monitor.arena(data, 'reconcile');
    // Build the report before awaiting disk IO, so a live event can mark it dirty.
    const groups = classify(clan, arena, roleId, this.config.excludeBots);
    this.lastDirty = false;
    this.last = { roleId, roleName: role.name, groups, expected, verifiedCount, roleComplete,
      sanctions: jailGroups(arena, this.config),
      targetCount: allIds.length, batchCount, individualChecks,
      clanCount: [...clan.values()].filter(m => !(this.config.excludeBots && m.bot)).length,
      notes: [...new Set(notes)], started, finished: Date.now() };
    this.health = roleComplete && !groups.unknown.length ? 'اكتمل التحقق من النتائج' : 'نتائج جزئية — راجع التقرير';
    const report = this.last;
    await this.monitor.store.flush();
    return report;
  }
}
module.exports = { Scanner };
