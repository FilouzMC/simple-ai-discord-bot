import { SlashCommandBuilder, ChannelType } from 'discord.js';

/**
 * Construit la sous-commande /autoprompt avec tous ses sous-commandes.
 * Importé dans commands.js et ajouté à cmds[].
 */
export function buildAutopromptCommand() {
  return new SlashCommandBuilder()
    .setName('autoprompt')
    .setDescription('Gérer les automatisations de prompt IA (admin)')

    // ── list ──────────────────────────────────────────────────────────────────
    .addSubcommand(sc => sc
      .setName('list')
      .setDescription('Lister toutes les automatisations'))

    // ── show ──────────────────────────────────────────────────────────────────
    .addSubcommand(sc => sc
      .setName('show')
      .setDescription('Afficher le détail d\'une automatisation')
      .addStringOption(o => o.setName('id').setDescription('ID de l\'automatisation').setRequired(true)))

    // ── add ───────────────────────────────────────────────────────────────────
    .addSubcommand(sc => sc
      .setName('add')
      .setDescription('Créer une nouvelle automatisation')
      .addStringOption(o => o
        .setName('name')
        .setDescription('Nom de l\'automatisation')
        .setRequired(true)
        .setMaxLength(80))
      .addStringOption(o => o
        .setName('prompt')
        .setDescription('Texte du prompt envoyé à l\'IA')
        .setRequired(true)
        .setMaxLength(3000))
      .addChannelOption(o => o
        .setName('channel')
        .setDescription('Salon cible pour la réponse')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true))
      .addStringOption(o => o
        .setName('type')
        .setDescription('Fréquence de déclenchement')
        .setRequired(true)
        .addChoices(
          { name: '📅 Chaque jour (daily)',      value: 'daily'    },
          { name: '📆 Chaque semaine (weekly)',   value: 'weekly'   },
          { name: '🗓️ Chaque mois (monthly)',     value: 'monthly'  },
          { name: '🎆 Chaque année (yearly)',     value: 'yearly'   },
          { name: '⏱️ Toutes les N minutes',      value: 'interval' },
        ))
      .addIntegerOption(o => o
        .setName('hour')
        .setDescription('Heure de déclenchement (0-23) — ignoré pour type=interval')
        .setMinValue(0).setMaxValue(23))
      .addIntegerOption(o => o
        .setName('minute')
        .setDescription('Minute de déclenchement (0-59) — ignoré pour type=interval')
        .setMinValue(0).setMaxValue(59))
      .addIntegerOption(o => o
        .setName('day_of_week')
        .setDescription('Jour semaine pour weekly : 0=Dim 1=Lun … 6=Sam')
        .setMinValue(0).setMaxValue(6))
      .addIntegerOption(o => o
        .setName('day_of_month')
        .setDescription('Jour du mois (1-31) pour monthly/yearly')
        .setMinValue(1).setMaxValue(31))
      .addIntegerOption(o => o
        .setName('month')
        .setDescription('Mois (1-12) pour yearly')
        .setMinValue(1).setMaxValue(12))
      .addIntegerOption(o => o
        .setName('interval_minutes')
        .setDescription('Intervalle en minutes (≥1) pour type=interval')
        .setMinValue(1).setMaxValue(525600))
      .addStringOption(o => o
        .setName('model')
        .setDescription('Modèle IA (vide = modèle courant du bot)')
        .setMaxLength(100))
      .addRoleOption(o => o
        .setName('role')
        .setDescription('Rôle à mentionner (@role) avant la réponse (facultatif)')))

    // ── edit ──────────────────────────────────────────────────────────────────
    .addSubcommand(sc => sc
      .setName('edit')
      .setDescription('Modifier une automatisation existante')
      .addStringOption(o => o.setName('id').setDescription('ID de l\'automatisation').setRequired(true))
      .addStringOption(o => o.setName('name').setDescription('Nouveau nom').setMaxLength(80))
      .addStringOption(o => o.setName('prompt').setDescription('Nouveau prompt').setMaxLength(3000))
      .addChannelOption(o => o
        .setName('channel')
        .setDescription('Nouveau salon cible')
        .addChannelTypes(ChannelType.GuildText))
      .addStringOption(o => o
        .setName('model')
        .setDescription('Nouveau modèle (vide = modèle courant)')
        .setMaxLength(100))
      .addStringOption(o => o
        .setName('type')
        .setDescription('Nouveau type de fréquence')
        .addChoices(
          { name: '📅 Chaque jour (daily)',      value: 'daily'    },
          { name: '📆 Chaque semaine (weekly)',   value: 'weekly'   },
          { name: '🗓️ Chaque mois (monthly)',     value: 'monthly'  },
          { name: '🎆 Chaque année (yearly)',     value: 'yearly'   },
          { name: '⏱️ Toutes les N minutes',      value: 'interval' },
        ))
      .addIntegerOption(o => o.setName('hour').setDescription('Heure (0-23)').setMinValue(0).setMaxValue(23))
      .addIntegerOption(o => o.setName('minute').setDescription('Minute (0-59)').setMinValue(0).setMaxValue(59))
      .addIntegerOption(o => o.setName('day_of_week').setDescription('Jour semaine 0-6').setMinValue(0).setMaxValue(6))
      .addIntegerOption(o => o.setName('day_of_month').setDescription('Jour du mois 1-31').setMinValue(1).setMaxValue(31))
      .addIntegerOption(o => o.setName('month').setDescription('Mois 1-12').setMinValue(1).setMaxValue(12))
      .addIntegerOption(o => o.setName('interval_minutes').setDescription('Intervalle minutes').setMinValue(1).setMaxValue(525600))
      .addRoleOption(o => o
        .setName('role')
        .setDescription('Nouveau rôle à mentionner (laisser vide = supprimer le ping)'))
      .addBooleanOption(o => o
        .setName('clear_role')
        .setDescription('Supprimer le ping de rôle existant')))

    // ── delete ────────────────────────────────────────────────────────────────
    .addSubcommand(sc => sc
      .setName('delete')
      .setDescription('Supprimer une automatisation')
      .addStringOption(o => o.setName('id').setDescription('ID de l\'automatisation').setRequired(true)))

    // ── enable / disable ──────────────────────────────────────────────────────
    .addSubcommand(sc => sc
      .setName('enable')
      .setDescription('Activer une automatisation')
      .addStringOption(o => o.setName('id').setDescription('ID de l\'automatisation').setRequired(true)))

    .addSubcommand(sc => sc
      .setName('disable')
      .setDescription('Désactiver une automatisation')
      .addStringOption(o => o.setName('id').setDescription('ID de l\'automatisation').setRequired(true)))

    // ── run ───────────────────────────────────────────────────────────────────
    .addSubcommand(sc => sc
      .setName('run')
      .setDescription('Déclencher manuellement une automatisation maintenant')
      .addStringOption(o => o.setName('id').setDescription('ID de l\'automatisation').setRequired(true)));
}
