'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
class Store {
  constructor(directory, scope) {
    this.directory = directory; this.file = path.join(directory, 'state.json'); this.scope = scope;
    this.data = { version: 1, scope, arena: {}, clan: {}, clanInitialized: false, outbox: [] };
    this.chain = Promise.resolve();
  }
  async load() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (data.version !== 1 || data.scope !== this.scope || !data.arena || !data.clan || !Array.isArray(data.outbox))
        throw new Error('ملف الحالة غير متوافق. احفظ نسخة منه ثم انقله قبل تغيير إعدادات السيرفر.');
      this.data = data;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  flush() {
    const serialized = JSON.stringify(this.data);
    this.chain = this.chain.then(async () => {
      const temp = this.file + '.tmp';
      const handle = await fs.open(temp, 'w', 0o600);
      try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, this.file);
    });
    return this.chain;
  }
  enqueue(event) {
    if (this.data.outbox.length >= 10000) throw new Error('طابور اللوق ممتلئ؛ أصلح صلاحيات شات اللوق قبل المتابعة.');
    this.data.outbox.push(event);
  }
}
module.exports = { Store };
