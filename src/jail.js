'use strict';
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { base } = require('./ui');
const PAGE_SIZE = 20;
const groups = [['jailed', '🔒 المسجونون'], ['warned', '⚠️ أصحاب الإنذار']];

// Use the same verified snapshot as the clan-role scan; never infer roles
// from an incomplete member cache or from membership in the clan server.
function jailGroups(arena, config) {
  const result = { jailed: [], warned: [] };
  for (const member of arena.values()) {
    if (member.present !== true || !Array.isArray(member.roles) ||
        !member.roles.includes(config.roleId) || (config.excludeBots && member.bot)) continue;
    if (member.roles.includes(config.jailRoleId)) result.jailed.push(member.id);
    if (member.roles.includes(config.warningRoleId)) result.warned.push(member.id);
  }
  for (const ids of Object.values(result)) ids.sort();
  return result;
}
function jailPages(report) {
  return Math.max(1, ...groups.map(([key]) => Math.ceil(report.sanctions[key].length / PAGE_SIZE)));
}
function jailPayload(config, report, page, sessionId, disabled = false) {
  const total = jailPages(report);
  page = Math.max(0, Math.min(page, total - 1));
  const unique = new Set([...report.sanctions.jailed, ...report.sanctions.warned]).size;
  const embed = base(config, '🔒 سجن وإنذارات أعضاء الكلان', report.roleComplete ? 0x55D5FF : 0xF6BA4B)
    .setDescription(`حاملو رتبة الكلان <@&${config.roleId}> في أرينا فقط.\n` +
      `السجن: <@&${config.jailRoleId}> · الإنذار: <@&${config.warningRoleId}>\n` +
      `الأعضاء المتحقق منهم بإحدى الحالتين: **${unique}**\n` +
      (report.roleComplete ? '✅ عدد حاملي رتبة الكلان متحقق وقت الفحص.' : '⚠️ قائمة حاملي رتبة الكلان غير مكتملة؛ قد توجد حالات لم تظهر.') +
      `\nمن يحمل السجن والإنذار يظهر في القسمين ويُحسب مرة واحدة في الإجمالي.\nآخر فحص: <t:${Math.floor(report.finished / 1000)}:R>`);
  for (const [key, title] of groups) {
    const ids = report.sanctions[key], part = ids.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    embed.addFields({ name: `${title} (${ids.length})`, value: part.length ? part.map(id => `<@${id}>`).join(' · ') :
      ids.length ? '— لا توجد أسماء إضافية في هذه الصفحة.' : report.roleComplete ? '— لا يوجد.' : '— لم تُرصد حالات ضمن البيانات المتاحة؛ الحصر غير مكتمل.' });
  }
  if (report.notes.length) embed.addFields({ name: '📌 حالة البيانات', value: report.notes.join('\n').slice(0, 1000) });
  embed.setFooter({ text: `SNOW • صفحة ${page + 1}/${total}${disabled ? ' • انتهت صلاحية الأزرار' : ''}` });
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`scan:${sessionId}:prev`).setLabel('السابق').setStyle(ButtonStyle.Secondary).setDisabled(disabled || page === 0),
    new ButtonBuilder().setCustomId(`scan:${sessionId}:next`).setLabel('التالي').setStyle(ButtonStyle.Secondary).setDisabled(disabled || page >= total - 1),
    new ButtonBuilder().setCustomId(`scan:${sessionId}:refresh`).setLabel('تحديث الفحص').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`scan:${sessionId}:export`).setLabel('تحميل الأسماء').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
  return { embeds: [embed], components: [buttons], allowedMentions: { parse: [], repliedUser: false } };
}
function exportJail(config, report) {
  let text = `سجن وإنذارات أعضاء الكلان في أرينا\nرتبة الكلان: ${config.roleId}\nرتبة السجن: ${config.jailRoleId}\nرتبة الإنذار: ${config.warningRoleId}\nوقت الفحص: ${new Date(report.finished).toISOString()}\n` +
    (report.roleComplete ? 'عدد حاملي رتبة الكلان متحقق وقت الفحص.\n' : 'نتائج جزئية — قد توجد حالات لم تظهر.\n');
  for (const [key, title] of groups) text += `\n${title} (${report.sanctions[key].length})\n${report.sanctions[key].join('\n') || '—'}\n`;
  text += '\n' + report.notes.join('\n');
  return new AttachmentBuilder(Buffer.from('\uFEFF' + text), { name: 'clan-jail-warnings.txt' });
}
module.exports = { jailGroups, jailPages, jailPayload, exportJail };
