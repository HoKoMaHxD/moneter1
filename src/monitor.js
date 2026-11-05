'use strict';
const { newEvent } = require('./core');
class Monitor {
  constructor(store, config) { this.store = store; this.config = config; this.revision = 0; this.clanRevision = 0; }
  arena(record, source = 'live') {
    if (!record?.id || record.present == null) return;
    const previous = this.store.data.arena[record.id];
    // A role-less partial payload is not evidence of removal.
    if (record.present && !Array.isArray(record.roles)) return;
    if (previous && record.at < previous.at) return;
    const next = { present: record.present, role: record.present && record.roles.includes(this.config.roleId),
      bot: record.bot ?? previous?.bot ?? false, avatar: record.avatar || previous?.avatar || null, at: record.at };
    if (record.present) next.sanctions = {
      jailRoleId: this.config.jailRoleId, warningRoleId: this.config.warningRoleId,
      jailed: record.roles.includes(this.config.jailRoleId), warned: record.roles.includes(this.config.warningRoleId),
    };
    const relevant = this.store.data.clan[record.id] || previous?.role || next.role;
    const canLog = !(this.config.excludeBots && next.bot);
    if (!previous && next.role && canLog && this.store.data.arenaInitialized)
      this.emit('role_observed', record.id, 'reconcile', next);
    if (previous && canLog) {
      if (previous.present && !next.present && relevant) this.emit('arena_leave', record.id, source, next);
      else if (!previous.present && next.present && relevant) this.emit('arena_join', record.id, source, next);
      if (previous.present && next.present && previous.role !== next.role)
        this.emit(next.role ? 'role_add' : 'role_remove', record.id, source, next);
      // Join with a role is described as a join, never falsely as a role assignment.
      // Old saved states have no sanction baseline. Learn it silently rather
      // than announcing existing sanctions as new grants after an upgrade.
      // A join or a changed role configuration also needs a fresh baseline.
      if (previous.present && next.present && next.role) {
        for (const [field, roleKey, type] of [['jailed', 'jailRoleId', 'jail_add'], ['warned', 'warningRoleId', 'warning_add']]) {
          const roleId = this.config[roleKey];
          if (roleId && previous.sanctions?.[roleKey] === roleId &&
              previous.sanctions[field] === false && next.sanctions[field])
            this.emit(type, record.id, source, { ...next, sanctionRoleId: roleId });
        }
      }
    }
    this.store.data.arena[record.id] = next;
    this.revision++;
  }
  clan(id, present, source = 'live', data = {}) {
    const previous = this.store.data.clan[id];
    if (present) {
      if (!previous && this.store.data.clanInitialized && !(this.config.excludeBots && data.bot)) this.emit('clan_join', id, source, data);
      this.store.data.clan[id] = { bot: !!data.bot, avatar: data.avatar || previous?.avatar, at: Date.now() };
    } else if (previous) {
      if (!(this.config.excludeBots && previous.bot)) this.emit('clan_leave', id, source, { ...previous, ...data });
      delete this.store.data.clan[id];
    }
    this.clanRevision++;
  }
  reconcileClan(members, observedRevision) {
    // If membership changed during fetch, do not apply a stale snapshot.
    if (observedRevision !== this.clanRevision) return false;
    for (const [id, data] of members) this.clan(id, true, 'reconcile', data);
    for (const id of Object.keys(this.store.data.clan)) if (!members.has(id)) this.clan(id, false, 'reconcile');
    this.store.data.clanInitialized = true;
    return true;
  }
  emit(type, id, source, data) {
    const details = { avatar: data.avatar };
    if (data.sanctionRoleId) details.sanctionRoleId = data.sanctionRoleId;
    this.store.enqueue(newEvent(type, id, source, details));
  }
}
module.exports = { Monitor };
