/**
 * Englische Namen für japanische/chinesische Sets.
 *
 * Hintergrund, offen gesagt: TCGdex pflegt für die Asien-Sets KEINE englischen
 * Namen (geprüft im Quell-Repo, z. B. SV2a und S12a haben nur ja/ko/zh-tw/id/th).
 * Diese Tabelle ist deshalb von Hand kuratiert und enthält die offiziellen
 * bzw. etablierten englischen Namen der Sword/Shield- (S), Scarlet/Violet- (SV)
 * und Mega- (M) Ära. Die zh-tw-Ausgaben nutzen dieselben Set-IDs.
 *
 * Sets ohne Eintrag (ältere Ären, Festlandchina-exklusive Sets) zeigen in der
 * Auswahl den Set-Code plus Originalnamen — Code ist immer lateinisch lesbar.
 *
 * Keys werden kleingeschrieben verglichen.
 */
export const ASIA_SET_NAMES_EN: Record<string, string> = {
  // --- Sword & Shield (S) ---
  's1w': 'Sword',
  's1h': 'Shield',
  's1a': 'VMAX Rising',
  's2': 'Rebellion Crash',
  's2a': 'Explosive Walker',
  's3': 'Infinity Zone',
  's3a': 'Legendary Heartbeat',
  's4': 'Amazing Volt Tackle',
  's4a': 'Shiny Star V',
  's5i': 'Single Strike Master',
  's5r': 'Rapid Strike Master',
  's5a': 'Peerless Fighters',
  's6h': 'Silver Lance',
  's6k': 'Jet-Black Spirit',
  's6a': 'Eevee Heroes',
  's7d': 'Skyscraping Perfection',
  's7r': 'Blue Sky Stream',
  's8': 'Fusion Arts',
  's8a': '25th Anniversary Collection',
  's8b': 'VMAX Climax',
  's9': 'Star Birth',
  's9a': 'Battle Region',
  's10d': 'Time Gazer',
  's10p': 'Space Juggler',
  's10a': 'Dark Phantasma',
  's10b': 'Pokémon GO',
  's11': 'Lost Abyss',
  's11a': 'Incandescent Arcana',
  's12': 'Paradigm Trigger',
  's12a': 'VSTAR Universe',
  's-p': 'S-Era Promos',

  // --- Scarlet & Violet (SV) ---
  'sv1s': 'Scarlet ex',
  'sv1v': 'Violet ex',
  'sv1a': 'Triplet Beat',
  'sv2d': 'Clay Burst',
  'sv2p': 'Snow Hazard',
  'sv2a': 'Pokémon Card 151',
  'sv3': 'Ruler of the Black Flame',
  'sv3a': 'Raging Surf',
  'sv4k': 'Ancient Roar',
  'sv4m': 'Future Flash',
  'sv4a': 'Shiny Treasure ex',
  'sv5k': 'Wild Force',
  'sv5m': 'Cyber Judge',
  'sv5a': 'Crimson Haze',
  'sv6': 'Mask of Change',
  'sv6a': 'Night Wanderer',
  'sv7': 'Stellar Miracle',
  'sv7a': 'Paradise Dragona',
  'sv8': 'Super Electric Breaker',
  'sv8a': 'Terastal Festival ex',
  'sv9': 'Battle Partners',
  'sv9a': 'Heat Wave Arena',
  'sv10': 'Glory of Team Rocket',
  'sv11b': 'Black Bolt',
  'sv11w': 'White Flare',
  'sv-p': 'SV-Era Promos',

  // --- Mega (M) ---
  'm1l': 'Mega Brave',
  'm1s': 'Mega Symphonia',
  'm-p': 'M-Era Promos',
};

export function asiaSetNameEn(setId: string): string | undefined {
  return ASIA_SET_NAMES_EN[setId.toLowerCase()];
}
