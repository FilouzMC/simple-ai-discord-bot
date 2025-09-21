import { ChannelType } from 'discord.js';

// Context utilities (channel recent messages filtering)
export async function buildChannelContext({ channel, uptoMessageId, limit, threadLimit, maxOverride, overrideLimit, botId, maxAgeMs }) {
  if (!channel?.isTextBased?.()) return '';
  const type = channel.type;
  const isThread = !!channel.isThread?.();
  const isForumParent = type === ChannelType.GuildForum;
  const allowedBase = type === ChannelType.GuildText || type === ChannelType.GuildVoice;
  if (!(allowedBase || isThread || isForumParent)) return '';
  try {
    const baseLimit = (isThread || isForumParent) ? (threadLimit || limit) : limit;
    const effLimit = overrideLimit && overrideLimit > 0 ? Math.min(maxOverride, overrideLimit) : baseLimit;
    const fetched = await channel.messages.fetch({ limit: Math.min(100, effLimit + 30) });
    let msgs = Array.from(fetched.values())
      .filter(m => !m.author.bot && m.id !== uptoMessageId)
      .sort((a,b)=>a.createdTimestamp - b.createdTimestamp)
      .filter(m => (m.content || '').trim().length > 5);
    if (maxAgeMs) msgs = msgs.filter(m => (Date.now() - m.createdTimestamp) <= maxAgeMs);
    const trimmed = [];
    for (const m of msgs) {
      let text = (m.content || '').replace(/<@!?\d+>/g,'').replace(/\n+/g,' ').trim();
      if (text.length <= 5) continue;
      trimmed.push(`${m.author.username}: ${text.slice(0,300)}`);
    }
    return trimmed.slice(-effLimit).join('\n');
  } catch { return ''; }
}
