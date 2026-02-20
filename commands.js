import { REST, Routes, SlashCommandBuilder, ChannelType } from 'discord.js';
import { CONFIG, AVAILABLE_MODELS, CURRENT_MODEL, setCurrentModel, saveConfig } from './lib/config.js';
import { addBlacklist, removeBlacklist, isUserBlacklisted, listBlacklist } from './lib/blacklist.js';
import { buildAutopromptCommand } from './lib/autoprompt_commands.js';

// Fonction helper pour générer les choix de modèles pour la commande /ask
function getAskModelChoices() {
  const choices = [];
  
  // Si AskModel est configuré, créer des choix basés sur les groupes
  if (CONFIG.AskModel && typeof CONFIG.AskModel === 'object') {
    for (const [groupName, models] of Object.entries(CONFIG.AskModel)) {
      if (Array.isArray(models) && models.length > 0) {
        // Prendre le premier modèle du groupe comme représentant
        const primaryModel = models.find(m => AVAILABLE_MODELS.includes(m));
        if (primaryModel) {
          choices.push({
            name: groupName,
            value: primaryModel
          });
        }
      }
    }
  }
  
  // Si aucun choix n'a été généré, utiliser les modèles disponibles directement
  if (choices.length === 0) {
    for (const model of AVAILABLE_MODELS.slice(0, 25)) { // Discord limite à 25 choix
      choices.push({
        name: model,
        value: model
      });
    }
  }
  
  return choices.slice(0, 25); // Assurer qu'on ne dépasse pas la limite Discord
}

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
  .addStringOption(o=> o.setName('model').setDescription('Changer modèle (texte libre)'))
    .addBooleanOption(o=>o.setName('enablechannelcontext').setDescription('Activer contexte salon'))
    .addIntegerOption(o=>o.setName('channelcontextlimit').setDescription('Nb msgs récents (1-25)').setMinValue(1).setMaxValue(25))
  .addIntegerOption(o=>o.setName('channelcontextthreadlimit').setDescription('Nb msgs threads/forums (1-100)').setMinValue(1).setMaxValue(100))
    .addIntegerOption(o=>o.setName('channelcontextmaxoverride').setDescription('Limite override (1-50)').setMinValue(1).setMaxValue(50))
    .addIntegerOption(o=>o.setName('channelcontextautoforget').setDescription('Auto-forget (sec,0=jamais)').setMinValue(0).setMaxValue(86400))
  .addIntegerOption(o=>o.setName('channelcontextmaxage').setDescription('Âge max messages contexte (sec, 60-86400)').setMinValue(60).setMaxValue(86400))
  .addBooleanOption(o=>o.setName('debug').setDescription('Mode debug (logs détaillés)'))
  .addBooleanOption(o=>o.setName('autosummaryenabled').setDescription('Activer l\'auto résumé'))
  .addIntegerOption(o=>o.setName('autosummaryidleseconds').setDescription('Inactivité avant résumé (sec)').setMinValue(60).setMaxValue(10800))
  .addIntegerOption(o=>o.setName('autosummaryminmessages').setDescription('Nb min messages avant résumé').setMinValue(3).setMaxValue(500))
  .addIntegerOption(o=>o.setName('autosummarycontextlimit').setDescription('Nb msgs max contexte pour résumé').setMinValue(10).setMaxValue(200))
  .addStringOption(o=>o.setName('resumesetprompt').setDescription('Définir prompt résumé').setMaxLength(3000))
  .addBooleanOption(o=>o.setName('showresumeprompt').setDescription('Afficher prompt résumé actuel'))
  .addStringOption(o=>o.setName('autosummarymodel').setDescription('Modèle IA pour /resume (vide = aucun)'))
  .addBooleanOption(o=>o.setName('autoprompt').setDescription('Activer/désactiver le moteur autoprompt globalement'))
  // (options autoResponse supprimées)
  ;
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

  // Commande channelprompt (admin)
  const chPrompt = new SlashCommandBuilder()
    .setName('channelprompt')
    .setDescription('Gérer le prompt spécifique du salon (admin)')
    .addSubcommand(sc=>sc.setName('show').setDescription('Afficher le prompt de ce salon'))
    .addSubcommand(sc=>sc.setName('set').setDescription('Définir le prompt de ce salon').addStringOption(o=>o.setName('texte').setDescription('Texte du prompt').setRequired(true).setMaxLength(3000)))
    .addSubcommand(sc=>sc.setName('clear').setDescription('Supprimer le prompt de ce salon'))
    .addSubcommand(sc=>sc.setName('list').setDescription('Lister les salons ayant un prompt (id + longueur)'));
  cmds.push(chPrompt);

  const modelRate = new SlashCommandBuilder()
    .setName('ratelimit')
    .setDescription('Limiter usage des modèles (admin)')
    .addSubcommand(sc=>sc.setName('show').setDescription('Afficher limites d\'un modèle').addStringOption(o=>o.setName('model').setDescription('Nom modèle').setRequired(true)))
    .addSubcommand(sc=>sc.setName('setcooldown').setDescription('Définir cooldown (s) pour un modèle').addStringOption(o=>o.setName('model').setDescription('Nom modèle').setRequired(true)).addIntegerOption(o=>o.setName('seconds').setDescription('Secondes (0-3600)').setRequired(true).setMinValue(0).setMaxValue(3600)))
    .addSubcommand(sc=>sc.setName('setmaxhour').setDescription('Définir max appels par heure').addStringOption(o=>o.setName('model').setDescription('Nom modèle').setRequired(true)).addIntegerOption(o=>o.setName('count').setDescription('Nombre (0=illimité)').setRequired(true).setMinValue(0).setMaxValue(10000)))
    .addSubcommand(sc=>sc.setName('clear').setDescription('Supprimer limites d\'un modèle').addStringOption(o=>o.setName('model').setDescription('Nom modèle').setRequired(true)))
    .addSubcommand(sc=>sc.setName('list').setDescription('Lister limites existantes'));
  cmds.push(modelRate);

  // Commande /ask (question directe sans mention obligatoire)
  const askModelChoices = getAskModelChoices();
  const askCmd = new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Poser une question à l\'IA')
    .addStringOption(o=>o.setName('texte').setDescription('Question à poser').setRequired(true).setMaxLength(4000));
  
  // Ajouter l'option model avec des choix si disponibles
  if (askModelChoices.length > 0) {
    askCmd.addStringOption(o => {
      const option = o.setName('model').setDescription('Modèle IA à utiliser');
      for (const choice of askModelChoices) {
        option.addChoices(choice);
      }
      return option;
    });
  } else {
    askCmd.addStringOption(o => o.setName('model').setDescription('Modèle (facultatif, texte libre)'));
  }
  
  askCmd.addBooleanOption(o=>o.setName('usecontext').setDescription('Inclure contexte récent du salon'))
  .addBooleanOption(o=>o.setName('public').setDescription('Rendre visible à tout le monde (sinon seulement toi)'));
  cmds.push(askCmd);

  // Commande pour forcer un résumé (admin)
  const forceResume = new SlashCommandBuilder()
    .setName('forceresume')
    .setDescription('Forcer la génération d\'un résumé (admin)');
  cmds.push(forceResume);

  // Commande autoprompt (admin)
  cmds.push(buildAutopromptCommand());

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

/**
 * Vide toutes les commandes enregistrées puis re-register depuis zéro.
 * Utile pour corriger des doublons ou des options invalides côté Discord.
 */
export async function clearAndRegisterSlashCommands(client) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const scope = CONFIG.guildId ? `guild:${CONFIG.guildId}` : 'global';
  const route = CONFIG.guildId
    ? Routes.applicationGuildCommands(client.user.id, CONFIG.guildId)
    : Routes.applicationCommands(client.user.id);

  console.log(`[slash] 🧹 Clear de toutes les commandes (scope=${scope})...`);
  try {
    await rest.put(route, { body: [] });
    console.log('[slash] ✅ Toutes les commandes supprimées.');
  } catch (e) {
    console.error('[slash] Échec du clear', e);
    return;
  }

  await registerSlashCommands(client);
}
