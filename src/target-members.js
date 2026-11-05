'use strict';
const { randomBytes } = require('node:crypto');
const { fromRaw } = require('./core');
/** Request only named members. Never request the entire Arena member list. */
function fetchTargetMembers(client, guild, ids, timeout = 8000) {
  if (!ids.length || ids.length > 100) return Promise.reject(new Error('Target batch must contain 1..100 IDs'));
  if (typeof client.fetchTargetMembers === 'function') return client.fetchTargetMembers(ids, timeout);
  const wanted = new Set(ids), nonce = randomBytes(12).toString('hex'), at = Date.now();
  return new Promise((resolve, reject) => {
    const members = new Map(), seenChunks = new Set();
    let total = null, settled = false;
    const finish = (completed, error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      client.removeListener('raw', onPacket); client.removeListener('shardDisconnect', onDisconnect);
      if (error) reject(error); else resolve({ members, completed });
    };
    const onDisconnect = () => finish(false);
    const onPacket = packet => {
      const d = packet.d;
      if (packet.t !== 'GUILD_MEMBERS_CHUNK' || d?.guild_id !== guild.id || d?.nonce !== nonce) return;
      if (!Number.isInteger(d.chunk_count) || d.chunk_count < 1 || d.chunk_count > 100 ||
          !Number.isInteger(d.chunk_index) || d.chunk_index < 0 || d.chunk_index >= d.chunk_count || !Array.isArray(d.members)) return;
      if (total != null && total !== d.chunk_count) return finish(false);
      total = d.chunk_count;
      for (const data of d.members) {
        if (!wanted.has(data.user?.id) || !Array.isArray(data.roles)) continue;
        members.set(data.user.id, { ...fromRaw(data), at });
      }
      seenChunks.add(d.chunk_index);
      if (seenChunks.size === total) finish(true);
    };
    const timer = setTimeout(() => finish(false), Math.max(1, timeout));
    client.on('raw', onPacket); client.on('shardDisconnect', onDisconnect);
    try {
      guild.shard.send({ op: 8, d: { guild_id: guild.id, user_ids: ids, presences: false, limit: 0, nonce } });
    } catch (error) { finish(false, error); }
  });
}
module.exports = { fetchTargetMembers };
