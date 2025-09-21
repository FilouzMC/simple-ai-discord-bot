// Context utilities (channel recent messages filtering)
export async function buildChannelContext({ channel, uptoMessageId, limit, threadLimit, maxOverride, overrideLimit, botId, maxAgeMs }) {
  if (!channel?.isTextBased?.()) return '';
  // Types texte supportés
  const baseAllowed = ['GUILD_TEXT','GUILD_VOICE'];
  const threadTypes = ['GUILD_PUBLIC_THREAD','GUILD_PRIVATE_THREAD','GUILD_NEWS_THREAD'];
  const forumTypes = ['GUILD_FORUM','GUILD_NEWS'];
  const isThread = threadTypes.includes(channel.type);
  const isForumLike = forumTypes.includes(channel.type);
  try {
    if (!(baseAllowed.includes(channel.type) || isThread || isForumLike)) return '';
  } catch {}
  try {
    const baseLimit = isThread || isForumLike ? (threadLimit || limit) : limit;
    const effLimit = overrideLimit && overrideLimit > 0 ? Math.min(maxOverride, overrideLimit) : baseLimit;
    const fetched = await channel.messages.fetch({ limit: Math.min(100, effLimit + 30) });
    let msgs = Array.from(fetched.values())
      .filter(m => !m.author.bot && m.id !== uptoMessageId)
      .sort((a,b)=>a.createdTimestamp - b.createdTimestamp)
      .filter(m => (m.content || '').trim().length > 5);
    if (maxAgeMs) {
      msgs = msgs.filter(m => (Date.now() - m.createdTimestamp) <= maxAgeMs);
    }
    const trimmed = [];
    for (const m of msgs) {
      let text = (m.content || '').replace(/<@!?\d+>/g,'').replace(/\n+/g,' ').trim();
      if (text.length <= 5) continue;
      trimmed.push(`${m.author.username}: ${text.slice(0,300)}`);
    }
    return trimmed.slice(-effLimit).join('\n');
  } catch { return ''; }
}
