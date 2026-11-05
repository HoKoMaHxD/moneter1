'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { jailGroups, jailPages, jailPayload, exportJail } = require('../src/jail');
const { config } = require('../src/config');
const cfg = { roleId: '1470732413112942665', jailRoleId: '766953289513172995', warningRoleId: '1062648452191891466', excludeBots: true };
const member = (id, roles, extra = {}) => ({ id, roles, present: true, ...extra });
const report = (sanctions, complete = true) => ({ sanctions, roleComplete: complete, finished: 10000, notes: complete ? [] : ['بيانات جزئية'] });

test('jail list requires clan role and current presence; overlap appears in both sections', () => {
  const rows = [
    member('jail', [cfg.roleId, cfg.jailRoleId]), member('warn', [cfg.roleId, cfg.warningRoleId]),
    member('both', [cfg.roleId, cfg.jailRoleId, cfg.warningRoleId]), member('clean', [cfg.roleId]),
    member('outsider', [cfg.jailRoleId, cfg.warningRoleId]),
    member('left', [cfg.roleId, cfg.jailRoleId], { present: false }),
    member('unknown', [cfg.roleId, cfg.jailRoleId], { present: null }),
    member('partial', undefined), member('bot', [cfg.roleId, cfg.jailRoleId], { bot: true }),
  ];
  const arena = new Map(rows.map(m => [m.id, m]));
  assert.deepEqual(jailGroups(arena, cfg), { jailed: ['both', 'jail'], warned: ['both', 'warn'] });
  assert.ok(jailGroups(arena, { ...cfg, excludeBots: false }).jailed.includes('bot'));
  const embed = jailPayload(cfg, report(jailGroups(arena, cfg)), 0, 'session').embeds[0].toJSON();
  assert.match(embed.description, /\*\*3\*\*/);
});

test('empty partial report never claims no sanctioned members exist', () => {
  const r = report({ jailed: [], warned: [] }, false);
  const payload = jailPayload(cfg, r, 0, 'session');
  const embed = payload.embeds[0].toJSON();
  assert.match(embed.description, /غير مكتملة/);
  assert.ok(embed.fields.slice(0, 2).every(f => f.value.includes('الحصر غير مكتمل')));
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
  assert.match(exportJail(cfg, r).attachment.toString('utf8'), /نتائج جزئية/);
});

test('large jail report pages every ID within Discord limits and exports complete snapshot', () => {
  const ids = Array.from({ length: 1001 }, (_, i) => String(100000000000000000n + BigInt(i)));
  const r = report({ jailed: ids, warned: ids.slice(0, 51) });
  const seen = [];
  for (let page = 0; page < jailPages(r); page++) {
    const p = jailPayload(cfg, r, page, 'session'), e = p.embeds[0].toJSON();
    let size = e.title.length + e.description.length + e.footer.text.length;
    for (const f of e.fields) { assert.ok(f.value.length <= 1024); size += f.name.length + f.value.length; }
    assert.ok(size <= 6000);
    seen.push(...[...e.fields[0].value.matchAll(/<@(\d+)>/g)].map(m => m[1]));
  }
  assert.deepEqual(seen, ids);
  const text = exportJail(cfg, r).attachment.toString('utf8');
  for (const id of ids) assert.ok(text.includes(id));
  assert.ok(jailPayload(cfg, r, 0, 's', true).components[0].toJSON().components.every(b => b.disabled));
  assert.equal(jailPayload(cfg, r, -1, 's').components[0].toJSON().components[0].disabled, true);
  assert.equal(jailPayload(cfg, r, 999, 's').components[0].toJSON().components[1].disabled, true);
});

test('configured sanction roles default to requested IDs and reject invalid IDs', () => {
  const env = { DISCORD_BOT_TOKEN: 'test', MONGODB_URI: 'mongodb://localhost', ENCRYPTION_KEY: 'a'.repeat(64) };
  assert.equal(config(env).jailRoleId, cfg.jailRoleId);
  assert.equal(config(env).warningRoleId, cfg.warningRoleId);
  assert.throws(() => config({ ...env, JAIL_ROLE_ID: 'invalid' }), /Invalid jailRoleId/);
  assert.throws(() => config({ ...env, WARNING_ROLE_ID: 'invalid' }), /Invalid warningRoleId/);
});
