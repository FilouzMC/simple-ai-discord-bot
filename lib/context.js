// Context utilities (channel recent messages filtering)
export async function buildChannelContext({ channel, uptoMessageId, limit, maxOverride, overrideLimit, botId }) {
  if (!channel?.isTextBased?.()) return '';
  try {
    const effLimit = overrideLimit && overrideLimit > 0 ? Math.min(maxOverride, overrideLimit) : limit;
    const fetched = await channel.messages.fetch({ limit: effLimit + 15 });
    const msgs = Array.from(fetched.values())
      .filter(m => !m.author.bot && m.id !== uptoMessageId)
      .sort((a,b)=>a.createdTimestamp - b.createdTimestamp)
      .filter(m => (m.content || '').trim().length > 10);
    const trimmed = [];
    for (const m of msgs) {
      let text = (m.content || '').replace(/<@!?\d+>/g,'').replace(/\n+/g,' ').trim();
      if (text.length <= 10) continue;
      trimmed.push(`${m.author.username}: ${text.slice(0,300)}`);
    }
    return trimmed.slice(-effLimit).join('\n');
  } catch { return ''; }
}
