'use strict';
const path = require('node:path');
const { snowflake } = require('./core');
function config(env = process.env) {
  const number = (key, fallback, min, max) => {
    const value = Number(env[key] || fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key}: expected ${min}..${max}`);
    return value;
  };
  const c = {
    botToken: env.DISCORD_BOT_TOKEN?.trim(), readerToken: env.READER_TOKEN?.trim(),
    mongoUri: env.MONGODB_URI?.trim(), mongoDb: env.MONGODB_DB || 'snow_clan_monitor',
    encryptionKey: env.ENCRYPTION_KEY?.trim(),
    tokenAdmins: (env.TOKEN_ADMIN_IDS || '').split(',').map(x=>x.trim()).filter(Boolean),
    python: env.PYTHON_BIN?.trim() || undefined,
    clanId: env.CLAN_GUILD_ID || '1516358993939922994',
    arenaId: env.ARENA_GUILD_ID || '766953289409232896',
    roleId: env.CLAN_ROLE_ID || '1470732413112942665',
    jailRoleId: env.JAIL_ROLE_ID || '766953289513172995',
    warningRoleId: env.WARNING_ROLE_ID || '1062648452191891466',
    logId: env.LOG_CHANNEL_ID || '1550714406529273936',
    commandChannel: env.COMMAND_CHANNEL_ID || '',
    allowedRoles: (env.SCAN_ALLOWED_ROLE_IDS || '').split(',').map(x => x.trim()).filter(Boolean),
    publicScan: env.ALLOW_EVERYONE_SCAN === 'true', excludeBots: env.EXCLUDE_BOTS !== 'false',
    interval: number('RECONCILE_SECONDS', 300, 60, 86400) * 1000,
    budget: number('SCAN_TIMEOUT_SECONDS', 120, 30, 600) * 1000,
    dataDir: path.resolve(env.DATA_DIR || './data'),
    brandIcon: env.BRAND_ICON_URL || '',
  };
  if (!c.botToken) throw new Error('ضع DISCORD_BOT_TOKEN في متغيرات البيئة.');
  if (!/^mongodb(\+srv)?:\/\//.test(c.mongoUri || '')) throw new Error('MONGODB_URI يجب أن يبدأ بـ mongodb:// أو mongodb+srv://');
  if (!/^[a-fA-F0-9]{64}$/.test(c.encryptionKey || '')) throw new Error('ENCRYPTION_KEY يجب أن يحتوي 64 حرف hex (32 بايت).');
  if (c.tokenAdmins.some(id=>!snowflake(id))) throw new Error('Invalid token admin ID');
  for (const key of ['clanId','arenaId','roleId','jailRoleId','warningRoleId','logId']) if (!snowflake(c[key])) throw new Error(`Invalid ${key}`);
  if (c.commandChannel && !snowflake(c.commandChannel)) throw new Error('Invalid COMMAND_CHANNEL_ID');
  if (c.allowedRoles.some(id => !snowflake(id))) throw new Error('Invalid SCAN_ALLOWED_ROLE_IDS');
  if (c.brandIcon && !/^https:\/\//.test(c.brandIcon)) throw new Error('BRAND_ICON_URL must start with https://');
  return c;
}
module.exports = { config };
