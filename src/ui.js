'use strict';
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, escapeMarkdown } = require('discord.js');
const PAGE_SIZE = 20;
const titles = { outside: '1️⃣ معهم الرتبة في أرينا • خارج الكلان', missingRole: '2️⃣ بالكلان وأرينا • بدون الرتبة',
  absent: '3️⃣ بالكلان • غير موجودين في أرينا', unknown: '❔ عضوية غير محسومة', holders: '👥 جميع أصحاب الرتبة', matched: '✅ بالكلان وأرينا • معهم الرتبة' };
function base(config, title, color = 0x55D5FF) {
  const e = new EmbedBuilder().setTitle(title).setColor(color).setFooter({ text: 'SNOW • CLAN MONITOR' }).setTimestamp();
  if (config.brandIcon) e.setThumbnail(config.brandIcon);
  return e;
}
function keys(report, custom) { return custom ? ['holders'] : ['outside', 'missingRole', 'absent', ...(report.groups.unknown.length ? ['unknown'] : [])]; }
function pages(report, custom) { return Math.max(1, ...keys(report, custom).map(key => Math.ceil(report.groups[key].length / PAGE_SIZE))); }
function reportPayload(config, report, custom, page, sessionId, disabled = false) {
  const total = pages(report, custom); page = Math.max(0, Math.min(page, total - 1));
  const uncertain = !report.roleComplete || (!custom && report.groups.unknown.length > 0);
  const e = base(config, custom ? (uncertain ? '🔎 تقرير الرتبة • توجد بيانات غير مكتملة' : '👥 تقرير أصحاب الرتبة') : (uncertain ? '🔎 تقرير الفحص • توجد بيانات غير مكتملة' : '❄️ تقرير فحص أعضاء الكلان'), uncertain ? 0xF6BA4B : 0x55D5FF);
  const roleName = escapeMarkdown(report.roleName).slice(0, 100);
  e.setDescription(`**${roleName}** · \`${report.roleId}\`\n` +
    (custom ? '' : `أعضاء الكلان: **${report.clanCount}**  |  المتطابقون: **${report.groups.matched.length}**\n`) +
    `العدد: **${report.expected ?? 'غير معروف'}**\n` +
    (report.roleComplete ? '✅ عدد أصحاب الرتبة يطابق العدد المعلن وقت الفحص.' : '⚠️ العدد المعروض ليس حصرًا نهائيًا لأصحاب الرتبة.') +
    `\nالتحقق المستهدف: **${report.targetCount ?? '—'}** عضو · **${report.batchCount ?? '—'}** دفعات\nآخر فحص: <t:${Math.floor(report.finished / 1000)}:R> · المدة: **${((report.finished-report.started)/1000).toFixed(1)} ث**`);
  for (const key of keys(report, custom)) {
    const list = report.groups[key], part = list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const partial = !report.roleComplete && ['outside','holders'].includes(key);
    e.addFields({ name: `${titles[key]} (${partial ? 'المتحقق: ' : ''}${list.length})`, value: part.length ? part.map(id => `<@${id}>`).join(' · ') : (list.length ? '— لا توجد أسماء إضافية في هذه الصفحة' : partial ? '— لم يُرصد أحد ضمن البيانات المتاحة؛ الحصر غير مكتمل.' : '— لا يوجد'), inline: false });
  }
  if (report.notes.length) e.addFields({ name: '📌 حالة البيانات', value: report.notes.join('\n').slice(0, 1000) });
  e.setFooter({ text: `SNOW • صفحة ${page+1}/${total} • ${config.excludeBots ? 'قوائم الأعضاء تستبعد البوتات' : 'القوائم تشمل البوتات'}${disabled ? ' • انتهت صلاحية الأزرار' : ''}` });
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`scan:${sessionId}:prev`).setLabel('السابق').setStyle(ButtonStyle.Secondary).setDisabled(disabled || page === 0),
    new ButtonBuilder().setCustomId(`scan:${sessionId}:next`).setLabel('التالي').setStyle(ButtonStyle.Secondary).setDisabled(disabled || page >= total - 1),
    new ButtonBuilder().setCustomId(`scan:${sessionId}:refresh`).setLabel('تحديث الفحص').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`scan:${sessionId}:export`).setLabel('تحميل الأسماء').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
  return { embeds: [e], components: [buttons], allowedMentions: { parse: [], repliedUser: false } };
}
function exportReport(report, custom = false) {
  let text = `SNOW CLAN MONITOR\nRole ID: ${report.roleId}\nScan: ${new Date(report.finished).toISOString()}\nRole list: ${report.roleComplete ? 'count-verified' : 'PARTIAL / UNVERIFIED'}\n`;
  for (const key of (custom ? ['holders'] : Object.keys(titles))) text += `\n${titles[key]} (${report.groups[key].length})\n${report.groups[key].join('\n') || '—'}\n`;
  text += '\n' + report.notes.join('\n');
  return new AttachmentBuilder(Buffer.from('\uFEFF' + text), { name: `scan-${report.roleId}.txt` });
}
function eventPayload(config, event) {
  const mention = `<@${event.id}>`;
  const types = {
    role_observed: ['🔎 رصد حامل رتبة الكلان', `رُصدت رتبة الكلان لدى ${mention} في أرينا.\nلا توجد حالة سابقة مؤكدة لتحديد وقت إعطائها.`, 0x55D5FF],
    role_add: ['✅ إعطاء رتبة الكلان', `تم إعطاء رتبة الكلان لـ ${mention}\nفي سيرفر أرينا.`, 0x43D68C],
    role_remove: ['❌ إزالة رتبة الكلان', `تمت إزالة رتبة الكلان من ${mention}\nفي سيرفر أرينا.`, 0xED5368],
    clan_join: ['✨ انضمام إلى الكلان', `العضو ${mention} انضم إلى سيرفر سنو.`, 0x55D5FF],
    clan_leave: ['🚪 خروج من الكلان', `العضو ${mention} غادر سيرفر سنو.`, 0xFF9B50],
    arena_join: ['📥 انضمام إلى أرينا', `رُصد وجود العضو ${mention} في أرينا بعد غيابه.`, 0x55D5FF],
    arena_leave: ['📤 خروج من أرينا', `العضو ${mention} لم يعد موجودًا في أرينا.`, 0xD69AFF],
    jail_add: ['🔒 سجن عضو من الكلان', `حصل العضو ${mention} على رتبة السجن في سيرفر أرينا.\n**معرّف العضو:** \`${event.id}\`\n**رتبة السجن:** <@&${event.sanctionRoleId || config.jailRoleId}>`, 0xED5368],
    warning_add: ['⚠️ تحذير عضو من الكلان', `حصل العضو ${mention} على رتبة التحذير في سيرفر أرينا.\n**معرّف العضو:** \`${event.id}\`\n**رتبة التحذير:** <@&${event.sanctionRoleId || config.warningRoleId}>`, 0xF6BA4B],
  };
  const [title, description, color] = types[event.type] || ['ℹ️ حالة المراقبة', event.text || '', 0x55D5FF];
  const e = base(config, title, color).setDescription(description).setTimestamp(event.at);
  if (event.avatar) e.setThumbnail(event.avatar);
  e.setFooter({ text: `SNOW • ${event.source === 'live' ? 'حدث مباشر' : 'اكتُشف بالمراجعة • الوقت هو وقت الاكتشاف'}` });
  return { embeds: [e], allowedMentions: { parse: [] }, nonce: event.key, enforceNonce: true };
}
module.exports = { base, pages, reportPayload, eventPayload, exportReport };
