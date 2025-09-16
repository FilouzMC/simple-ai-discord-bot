import { REST, Routes, SlashCommandBuilder, ChannelType } from 'discord.js';
import { CONFIG, AVAILABLE_MODELS, CURRENT_MODEL, setCurrentModel, saveConfig } from './lib/config.js';
import { addBlacklist, removeBlacklist, isUserBlacklisted, listBlacklist } from './lib/blacklist.js';

export function buildSlashCommands() {
  const cmds = [];
  const blacklistCmd = new SlashCommandBuilder()
    .setName('blacklist')
    .setDescription('Gérer la blacklist IA')
    .addSubcommand(sc => sc.setName('add').setDescription('Ajouter un utilisateur').addUserOption(o=>o.setName('utilisateur').setDescription('Utilisateur').setRequired(true)))
    .addSubcommand(sc => sc.setName('remove').setDescription('Retirer un utilisateur').addUserOption(o=>o.setName('utilisateur').setDescription('Utilisateur').setRequired(true)))
    .addSubcommand(sc => sc.setName('list').setDescription('Lister les utilisateurs blacklists'));
  cmds.push(blacklistCmd);

  if (CONFIG.enablePromptCommand) {
    const promptCmd = new SlashCommandBuilder()
      .setName('prompt')
      .setDescription('Gérer le system prompt')
      .addSubcommand(sc=>sc.setName('show').setDescription('Afficher le prompt système actuel'))
      .addSubcommand(sc=>sc.setName('set').setDescription('Définir un nouveau prompt système').addStringOption(o=>o.setName('texte').setDescription('Nouveau prompt').setRequired(true).setMaxLength(1800)));
    cmds.push(promptCmd);
  }

  const optionsCmd = new SlashCommandBuilder()
    .setName('options')
    .setDescription('Met à jour des options IA (admin)')
    .addIntegerOption(o=>o.setName('maxanswerchars').setDescription('Taille max (500-4000)').setMinValue(500).setMaxValue(4000))
    .addStringOption(o=>{ o.setName('model').setDescription('Changer modèle'); AVAILABLE_MODELS.forEach(m=>o.addChoices({ name:m, value:m })); return o; })
    .addBooleanOption(o=>o.setName('enablechannelcontext').setDescription('Activer contexte salon'))
    .addIntegerOption(o=>o.setName('channelcontextlimit').setDescription('Nb msgs récents (1-25)').setMinValue(1).setMaxValue(25))
    .addIntegerOption(o=>o.setName('channelcontextmaxoverride').setDescription('Limite override (1-50)').setMinValue(1).setMaxValue(50))
    .addIntegerOption(o=>o.setName('channelcontextautoforget').setDescription('Auto-forget (sec,0=jamais)').setMinValue(0).setMaxValue(86400))
  .addBooleanOption(o=>o.setName('debug').setDescription('Mode debug (logs détaillés)'))
  .addBooleanOption(o=>o.setName('enableautoresponse').setDescription('Activer réponses automatiques pertinentes'))
  .addIntegerOption(o=>o.setName('autoresponseinterval').setDescription('Intervalle min auto (sec, 30-3600)').setMinValue(30).setMaxValue(3600))
  .addNumberOption(o=>o.setName('autoresponseprobability').setDescription('Proba tentative (0-1 ex:0.3)').setMinValue(0).setMaxValue(1));
  cmds.push(optionsCmd);

  const opCmd = new SlashCommandBuilder()
    .setName('op').setDescription('Gérer la liste des admins utilisateurs')
    .addSubcommand(sc=>sc.setName('add').setDescription('Ajouter un utilisateur admin').addUserOption(o=>o.setName('utilisateur').setDescription('Utilisateur').setRequired(true)))
    .addSubcommand(sc=>sc.setName('remove').setDescription('Retirer un utilisateur admin').addUserOption(o=>o.setName('utilisateur').setDescription('Utilisateur').setRequired(true)))
    .addSubcommand(sc=>sc.setName('list').setDescription('Lister les utilisateurs admin'));
  cmds.push(opCmd);

  const wlCmd = new SlashCommandBuilder()
    .setName('whitelistchannels').setDescription('Gérer la whitelist des salons IA (admin)')
    .addSubcommand(sc=>sc.setName('add').setDescription('Ajouter un salon').addChannelOption(o=>o.setName('salon').setDescription('Salon texte').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(sc=>sc.setName('remove').setDescription('Retirer un salon').addChannelOption(o=>o.setName('salon').setDescription('Salon texte').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(sc=>sc.setName('list').setDescription('Lister les salons whitelists'));
  cmds.push(wlCmd);

  const resetCtx = new SlashCommandBuilder()
    .setName('resetcontext')
    .setDescription('Réinitialiser le contexte récent (admin)')
    .addBooleanOption(o=>o.setName('all').setDescription('Tout oublier (sinon seulement ce salon)'));
  cmds.push(resetCtx);

  const contextCmd = new SlashCommandBuilder()
    .setName('context')
  .setDescription('Afficher les sujets détectés / messages d\'un sujet')
  .addIntegerOption(o=>o.setName('subject').setDescription('ID sujet pour afficher messages'))
  .addBooleanOption(o=>o.setName('full').setDescription('Lister tous les sujets (ignoré si subject)'));
  cmds.push(contextCmd);
  return cmds;
}

export async function registerSlashCommands(client) {
  const commands = buildSlashCommands();
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const scope = CONFIG.guildId ? `guild:${CONFIG.guildId}` : 'global';
  console.log(`[slash] Début enregistrement scope=${scope} total=${commands.length}`);
  try {
    const route = CONFIG.guildId ? Routes.applicationGuildCommands(client.user.id, CONFIG.guildId) : Routes.applicationCommands(client.user.id);
    const data = await rest.put(route, { body: commands.map(c=>c.toJSON()) });
    if (Array.isArray(data)) data.forEach(d=>{ if (d?.name && d?.id) console.log(`[slash] ✔ ${d.name} id=${d.id}`); });
  } catch (e) { console.error('[slash] Échec enregistrement', e); }
}
