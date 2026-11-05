'use strict';
const { randomBytes } = require('node:crypto');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const snowflake = value => /^\d{17,20}$/.test(value);
function record(member) {
  return { id: member.id, roles: [...member.roles.cache.keys()], bot: !!member.user.bot,
    avatar: member.user.displayAvatarURL({ size: 128 }), at: Date.now(), present: true };
}
function fromRaw(d) {
  const user = d.user || {};
  const avatar = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : null;
  return { id: user.id, roles: d.roles, bot: user.bot, avatar, at: Date.now(), present: true };
}
function classify(clan, arena, roleId, excludeBots = true) {
  const result = { holders: [], outside: [], missingRole: [], absent: [], unknown: [], matched: [] };
  for (const [id, a] of arena) {
    if (a.present === true && a.roles?.includes(roleId) && !(excludeBots && a.bot)) {
      result.holders.push(id);
      if (!clan.has(id)) result.outside.push(id);
    }
  }
  for (const [id, c] of clan) {
    if (excludeBots && c.bot) continue;
    const a = arena.get(id);
    if (!a || a.present == null) result.unknown.push(id);
    else if (!a.present) result.absent.push(id);
    else if (!Array.isArray(a.roles)) result.unknown.push(id);
    else if (!a.roles.includes(roleId)) result.missingRole.push(id);
    else result.matched.push(id);
  }
  for (const list of Object.values(result)) list.sort();
  return result;
}
function parseScan(content, defaultRole) {
  const args = content.trim().split(/\s+/);
  if (args[0].toLowerCase() !== '!scan') return null;
  if (args.length > 2) throw new Error('استخدم !scan أو !scan ROLE_ID');
  const roleId = args[1]?.replace(/^<@&(\d+)>$/, '$1') || defaultRole;
  if (!snowflake(roleId)) throw new Error('أدخل آي دي رتبة صحيحًا من سيرفر أرينا.');
  return { roleId, custom: args.length === 2 };
}
function newEvent(type, id, source, data = {}) {
  return { key: randomBytes(12).toString('hex'), type, id, source, at: Date.now(), ...data };
}
function safeError(error, secrets = []) {
  let message = String(error?.message || error);
  for (const secret of secrets) if (secret) message = message.split(secret).join('[REDACTED]');
  return message.replace(/[A-Za-z\d_-]{20,}\.[A-Za-z\d_-]{5,}\.[A-Za-z\d_-]{20,}/g, '[REDACTED]').slice(0, 400);
}
module.exports = { sleep, snowflake, record, fromRaw, classify, parseScan, newEvent, safeError };
