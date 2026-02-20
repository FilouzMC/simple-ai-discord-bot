import { EmbedBuilder } from 'discord.js';

// Convertit les titres Markdown non supportés par Discord (####, #####, ######)
// en texte en gras. Discord ne supporte que #, ## et ###.
export function sanitizeMarkdownHeadings(text) {
  if (!text) return text;
  // Remplace ####+ (4 niveaux ou plus) par du gras
  return text.replace(/^(#{4,})\s+(.+)$/gm, (_, _hashes, content) => `**${content.trim()}**`);
}

// Split text into chunks respecting max length and trying to cut at boundaries
export function splitText(text, max) {
  if (!text) return [];
  if (text.length <= max) return [text];
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length) {
    let slice = remaining.slice(0, max);
    if (remaining.length > max) {
      const lastBreak = slice.lastIndexOf('\n');
      const lastDot = slice.lastIndexOf('. ');
      const candidate = Math.max(lastBreak, lastDot);
      if (candidate > max * 0.5) slice = slice.slice(0, candidate + 1);
    }
    chunks.push(slice);
    remaining = remaining.slice(slice.length).trimStart();
  }
  return chunks;
}

// withTyping: run async fn while sending typing at interval
export async function withTyping(channel, fn, intervalMs = 7000) {
  let active = true;
  const loop = (async () => {
    while (active) {
      try { await channel.sendTyping(); } catch {}
      await new Promise(r => setTimeout(r, intervalMs));
    }
  })();
  try {
    return await fn();
  } finally {
    active = false;
    try { await loop; } catch {}
  }
}

// sendAIResponse: handles building embeds & sending (answer or suggestion)
// Construit les embeds standardisés pour une réponse IA
export function buildAIEmbeds({ client, text, model, maxChars = 4000, debug = false, ms = null }) {
  const botUser = client?.user;
  const botName = botUser?.username || 'IA Bot';
  const botAvatar = botUser?.displayAvatarURL?.() || null;
  const sanitized = sanitizeMarkdownHeadings(text);
  const chunks = splitText(sanitized, maxChars);
  if (debug) console.log('[debug][buildAIEmbeds]', { model, totalLen: text.length, parts: chunks.length });
  const embeds = chunks.map((part, idx) => {
    const e = new EmbedBuilder()
      .setColor(0x5865F2)
      .setAuthor({ name: botName + (chunks.length > 1 ? ` (part ${idx+1}/${chunks.length})` : ''), iconURL: botAvatar || undefined })
      .setDescription(part)
      .setFooter({ text: `${ms!==null?`Durée: ${ms}ms • `:''}${model} ` })
      .setTimestamp(new Date());
    return e;
  });
  return embeds;
}

// Envoi d'une réponse IA (message normal). Utilise les embeds standardisés.
export async function sendAIResponse({ channel, replyToMessage = null, text, ms, model, maxChars = 4000, debug = false }) {
  const embeds = buildAIEmbeds({ client: channel.client, text, model, maxChars, debug, ms });
  let firstMessage = null;
  for (let i = 0; i < embeds.length; i++) {
    const embed = embeds[i];
    if (replyToMessage && i === 0) {
      firstMessage = await replyToMessage.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
    } else if (replyToMessage && i > 0) {
      await channel.send({ embeds: [embed], reply: { messageReference: firstMessage.id }, allowedMentions: { repliedUser: false } });
    } else {
      await channel.send({ embeds: [embed], allowedMentions: { repliedUser: false } });
    }
  }
}

export async function sendAIError({ channel, replyToMessage, error, ms, model }) {
  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('Erreur génération IA')
    .addFields(
      { name: 'Message', value: (error || '').slice(0,1024) },
      { name: 'Durée ms', value: String(ms), inline: true },
      { name: 'Modèle', value: model, inline: true }
    )
    .setFooter({ text: 'Réessaie plus tard ou modifie ta requête.' })
    .setTimestamp(new Date());
  if (replyToMessage) return replyToMessage.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
  return channel.send({ embeds: [embed], allowedMentions: { repliedUser: false } });
}
