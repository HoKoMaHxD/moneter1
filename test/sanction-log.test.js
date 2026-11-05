'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Monitor } = require('../src/monitor');
const { Store } = require('../src/store');
const { eventPayload } = require('../src/ui');
const cfg = { roleId: '1470732413112942665', jailRoleId: '766953289513172995',
  warningRoleId: '1062648452191891466', excludeBots: true, logId: '1550714406529273936' };
const member = (roles, at = 1, extra = {}) => ({ id: '123456789012345678', roles, at, present: true, ...extra });
const types = store => store.data.outbox.map(e => e.type).filter(t => ['jail_add', 'warning_add'].includes(t));
function setup(config = cfg) {
  const store = { data: { arena: {}, clan: {}, outbox: [], arenaInitialized: true },
    enqueue(event) { this.data.outbox.push(event); } };
  return { store, monitor: new Monitor(store, config) };
}

test('new and legacy members learn existing sanctions silently on the first observation', () => {
  for (const legacy of [false, true]) {
    const { store, monitor } = setup();
    const data = member([cfg.roleId, cfg.jailRoleId, cfg.warningRoleId], 10);
    if (legacy) store.data.arena[data.id] = { present: true, role: true, bot: false, at: 1 };
    monitor.arena(data, 'reconcile');
    monitor.arena({ ...data, at: 11 });
    assert.deepEqual(types(store), []);
    assert.equal(store.data.arena[data.id].sanctions.jailed, true);
    assert.equal(store.data.arena[data.id].sanctions.warned, true);
  }
});

test('clan role holder outside clan server gets one log per newly added sanction', () => {
  const { store, monitor } = setup();
  monitor.arena(member([cfg.roleId]));
  monitor.arena(member([cfg.roleId, cfg.jailRoleId], 2));
  monitor.arena(member([cfg.roleId, cfg.jailRoleId], 3), 'reconcile');
  monitor.arena(member([cfg.roleId, cfg.jailRoleId, cfg.warningRoleId], 4));
  monitor.arena(member([cfg.roleId, cfg.jailRoleId, cfg.warningRoleId], 5));
  assert.deepEqual(types(store), ['jail_add', 'warning_add']);
  assert.equal(store.data.clan[member([]).id], undefined);
  const events = store.data.outbox.filter(e => types(store).includes(e.type));
  assert.deepEqual(events.map(e => e.sanctionRoleId), [cfg.jailRoleId, cfg.warningRoleId]);
  assert.ok(events.every(e => e.source === 'live'));
});

test('simultaneous jail and warning additions create two separate queued logs', () => {
  const { store, monitor } = setup();
  monitor.arena(member([cfg.roleId]));
  monitor.arena(member([cfg.roleId, cfg.jailRoleId, cfg.warningRoleId], 2));
  assert.deepEqual(types(store), ['jail_add', 'warning_add']);
  assert.notEqual(store.data.outbox.at(-1).key, store.data.outbox.at(-2).key);
});

test('removal is silent and a later observed re-addition logs again', () => {
  const { store, monitor } = setup();
  monitor.arena(member([cfg.roleId, cfg.jailRoleId, cfg.warningRoleId]));
  monitor.arena(member([cfg.roleId], 2));
  assert.deepEqual(types(store), []);
  monitor.arena(member([cfg.roleId, cfg.jailRoleId, cfg.warningRoleId], 3));
  assert.deepEqual(types(store), ['jail_add', 'warning_add']);
});

test('clan-server membership alone and excluded bots do not receive sanction logs', () => {
  for (const bot of [false, true]) {
    const { store, monitor } = setup();
    store.data.clan[member([]).id] = {};
    const roles = bot ? [cfg.roleId] : [];
    monitor.arena(member(roles, 1, { bot }));
    monitor.arena(member([...roles, cfg.jailRoleId, cfg.warningRoleId], 2, { bot }));
    assert.deepEqual(types(store), []);
  }
  const { store, monitor } = setup({ ...cfg, excludeBots: false });
  monitor.arena(member([cfg.roleId], 1, { bot: true }));
  monitor.arena(member([cfg.roleId, cfg.jailRoleId], 2, { bot: true }));
  assert.deepEqual(types(store), ['jail_add']);
});

test('guild rejoin and acquisition of clan role with an existing sanction are not new sanctions', () => {
  const { store, monitor } = setup();
  monitor.arena(member([cfg.jailRoleId, cfg.warningRoleId]));
  monitor.arena(member([cfg.roleId, cfg.jailRoleId, cfg.warningRoleId], 2));
  monitor.arena(member([], 3, { present: false }));
  monitor.arena(member([cfg.roleId, cfg.jailRoleId, cfg.warningRoleId], 4));
  assert.deepEqual(types(store), []);
});

test('unknown, partial and stale data cannot invent a sanction transition', () => {
  const { store, monitor } = setup();
  monitor.arena(member([cfg.roleId, cfg.jailRoleId], 10));
  monitor.arena(member([], 11, { present: null }));
  monitor.arena(member(undefined, 12));
  monitor.arena(member([cfg.roleId], 9));
  monitor.arena(member([cfg.roleId, cfg.jailRoleId], 13));
  assert.deepEqual(types(store), []);
  monitor.arena(member([cfg.roleId], 14));
  monitor.arena(member([cfg.roleId, cfg.jailRoleId], 15));
  assert.deepEqual(types(store), ['jail_add']);
});

test('polling discovers a new sanction with discovery-time labeling and no repeated event', () => {
  const { store, monitor } = setup();
  monitor.arena(member([cfg.roleId]), 'reconcile');
  monitor.arena(member([cfg.roleId, cfg.warningRoleId], 2), 'reconcile');
  monitor.arena(member([cfg.roleId, cfg.warningRoleId], 3), 'reconcile');
  assert.deepEqual(types(store), ['warning_add']);
  const event = store.data.outbox.find(e => e.type === 'warning_add');
  assert.equal(event.source, 'reconcile');
  assert.match(eventPayload(cfg, event).embeds[0].toJSON().footer.text, /وقت الاكتشاف/);
});

test('a changed sanction role ID starts a fresh baseline without a false grant', () => {
  const { store, monitor } = setup();
  monitor.arena(member([cfg.roleId]));
  const changed = { ...cfg, jailRoleId: '111111111111111111' };
  const updated = new Monitor(store, changed);
  updated.arena(member([cfg.roleId, changed.jailRoleId, cfg.warningRoleId], 2));
  assert.deepEqual(types(store), ['warning_add']);
  updated.arena(member([cfg.roleId], 3));
  updated.arena(member([cfg.roleId, changed.jailRoleId], 4));
  assert.deepEqual(types(store), ['warning_add', 'jail_add']);
});

test('sanction embeds show member and the event role, keep nonce and disable mention pings', () => {
  for (const [type, roleId, title] of [['jail_add', cfg.jailRoleId, 'سجن'], ['warning_add', cfg.warningRoleId, 'تحذير']]) {
    const event = { type, id: member([]).id, sanctionRoleId: roleId, at: 10000, source: 'live', key: type };
    const payload = eventPayload({ ...cfg, jailRoleId: 'changed', warningRoleId: 'changed' }, event);
    const embed = payload.embeds[0].toJSON();
    assert.ok(embed.title.includes(title));
    assert.ok(embed.description.includes(`<@${event.id}>`));
    assert.ok(embed.description.includes(`<@&${roleId}>`));
    assert.equal(embed.timestamp, new Date(event.at).toISOString());
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.equal(payload.nonce, type);
    assert.equal(payload.enforceNonce, true);
  }
});

test('saved sanction baseline and pending log survive restart without re-enqueueing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snow-sanction-'));
  try {
    const before = new Store(dir, 'sanction-test');
    await before.load();
    const monitor = new Monitor(before, cfg);
    monitor.arena(member([cfg.roleId]));
    monitor.arena(member([cfg.roleId, cfg.jailRoleId], 2));
    await before.flush();
    const after = new Store(dir, 'sanction-test');
    await after.load();
    assert.deepEqual(after.data, before.data);
    const restarted = new Monitor(after, cfg);
    restarted.arena(member([cfg.roleId, cfg.jailRoleId], 3), 'reconcile');
    assert.deepEqual(types(after), ['jail_add']);
    // Simulate the existing pump acknowledging the delivered log.
    after.data.outbox.length = 0;
    restarted.arena(member([cfg.roleId, cfg.jailRoleId], 4));
    assert.deepEqual(types(after), []);
    restarted.arena(member([cfg.roleId, cfg.jailRoleId, cfg.warningRoleId], 5));
    assert.deepEqual(types(after), ['warning_add']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
