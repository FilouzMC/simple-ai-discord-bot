import { EmbedBuilder } from 'discord.js';

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
export async function sendAIResponse({
  type = 'answer', // 'answer' | 'suggestion'
  channel,
  replyToMessage = null,
  text,
  ms,
  model,
  maxChars = 4000,
  debug = false
}) {
  const color = type === 'suggestion' ? 0x43B581 : 0x5865F2;
  const titleAuthor = type === 'suggestion' ? 'Suggestion IA' : 'Réponse IA';
  const chunks = splitText(text, maxChars);
  if (debug) {
    console.log('[debug][sendAIResponse]', { type, totalLength: text.length, chunks: chunks.length, ms, model });
  }
  let firstMessage = null;
  for (let i = 0; i < chunks.length; i++) {
    const part = chunks[i];
    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: titleAuthor + (chunks.length > 1 ? ` (partie ${i+1}/${chunks.length})` : '') })
      .setDescription(part)
      .addFields({ name: 'Durée ms', value: String(ms), inline: true })
      .setFooter({ text: type === 'suggestion' ? 'Réponse automatique (autoResponse)' : `Modèle: ${model} • Mentionne de nouveau pour continuer` })
      .setTimestamp(new Date());
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
