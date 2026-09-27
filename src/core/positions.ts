export const POSITION_KEYS = [
  "SOVEREIGN",
  "PRIME_MINISTER",
  "SPEAKER",
  "CHIEF_JUSTICE",
  "ADMINISTRATOR",
  "VICE_SPEAKER",
  "DEPUTY_PRIME_MINISTER",
  "CHIEF_CABINET_SECRETARY",
  "MINISTER",
  "ELECTION_COMMISSIONER",
  "JUDGE",
  "REPRESENTATIVE",
  "ELECTION_COMMISSION_MEMBER",
  "AIDE",
] as const;

export type PositionKey = (typeof POSITION_KEYS)[number];

export type Faction = "ADMIN" | "REPRESENTATIVE" | "NEUTRAL";
export type Branch = "ADMIN" | "LEGISLATIVE" | "EXECUTIVE" | "JUDICIAL" | "ELECTORAL";

export const AIDES_PER_REPRESENTATIVE = 2;

export interface PositionDef {
  key: PositionKey;
  label: string;
  emoji: string;
  /** 序列: lower is higher. */
  rank: number;
  faction: Faction;
  branch: Branch;
  /** Max concurrent holders. SEATS = guild seat count (filled by elections), PER_REP = per appointing representative. */
  capacity: number | "SEATS" | "PER_REP";
  selection: string;
  powers: string[];
  color: number;
}

export const POSITIONS: Record<PositionKey, PositionDef> = {
  SOVEREIGN: {
    key: "SOVEREIGN",
    label: "元首",
    emoji: "👑",
    rank: 1,
    faction: "ADMIN",
    branch: "ADMIN",
    capacity: 1,
    selection: "管理者が任命（初期設定時はサーバーオーナー）",
    powers: ["国の象徴であり管理者派閥の代表", "他のいかなる役職とも兼任しない"],
    color: 0xf1c40f,
  },
  PRIME_MINISTER: {
    key: "PRIME_MINISTER",
    label: "内閣総理大臣",
    emoji: "🎌",
    rank: 2,
    faction: "REPRESENTATIVE",
    branch: "EXECUTIVE",
    capacity: 1,
    selection: "議員の中から国会の首班指名選挙（過半数）で選出",
    powers: ["副総理・内閣官房長官・国務大臣・裁判官の任命", "閣僚の罷免と内閣総辞職", "談話の発表、内閣提出法案、法律の施行"],
    color: 0xe74c3c,
  },
  SPEAKER: {
    key: "SPEAKER",
    label: "議長",
    emoji: "🔔",
    rank: 3,
    faction: "REPRESENTATIVE",
    branch: "LEGISLATIVE",
    capacity: 1,
    selection: "議員の互選（過半数）",
    powers: ["法案の採決を開始する（議事整理権）", "可否同数のときの決裁権"],
    color: 0x9b59b6,
  },
  CHIEF_JUSTICE: {
    key: "CHIEF_JUSTICE",
    label: "最高裁判所長官",
    emoji: "⚖️",
    rank: 4,
    faction: "NEUTRAL",
    branch: "JUDICIAL",
    capacity: 1,
    selection: "管理者が任命",
    powers: ["事件の配点（担当裁判官の指定）", "上告審の判決", "自ら事件を担当する"],
    color: 0x1abc9c,
  },
  ADMINISTRATOR: {
    key: "ADMINISTRATOR",
    label: "管理官",
    emoji: "🛡️",
    rank: 5,
    faction: "ADMIN",
    branch: "ADMIN",
    capacity: 10,
    selection: "管理者が任命",
    powers: ["管理者派閥の一員であることを示す称号", "/admin の利用可否はDiscordの管理者権限で判定"],
    color: 0xe67e22,
  },
  VICE_SPEAKER: {
    key: "VICE_SPEAKER",
    label: "副議長",
    emoji: "🎙️",
    rank: 6,
    faction: "REPRESENTATIVE",
    branch: "LEGISLATIVE",
    capacity: 1,
    selection: "議員の互選（過半数）",
    powers: ["議長に代わって法案の採決を開始する"],
    color: 0xaf7ac5,
  },
  DEPUTY_PRIME_MINISTER: {
    key: "DEPUTY_PRIME_MINISTER",
    label: "副総理",
    emoji: "🎖️",
    rank: 7,
    faction: "REPRESENTATIVE",
    branch: "EXECUTIVE",
    capacity: 1,
    selection: "内閣総理大臣が任命",
    powers: ["内閣のナンバー2", "内閣提出法案・法律の施行"],
    color: 0xec7063,
  },
  CHIEF_CABINET_SECRETARY: {
    key: "CHIEF_CABINET_SECRETARY",
    label: "内閣官房長官",
    emoji: "📣",
    rank: 8,
    faction: "REPRESENTATIVE",
    branch: "EXECUTIVE",
    capacity: 1,
    selection: "内閣総理大臣が任命",
    powers: ["政府の公式発表（談話）", "内閣提出法案・法律の施行"],
    color: 0xf1948a,
  },
  MINISTER: {
    key: "MINISTER",
    label: "国務大臣",
    emoji: "💼",
    rank: 9,
    faction: "REPRESENTATIVE",
    branch: "EXECUTIVE",
    capacity: 12,
    selection: "内閣総理大臣が担当分野つきで任命（例: 外務大臣）",
    powers: ["担当分野の政策の実行", "内閣提出法案・法律の施行"],
    color: 0xe59866,
  },
  ELECTION_COMMISSIONER: {
    key: "ELECTION_COMMISSIONER",
    label: "選挙管理委員長",
    emoji: "🗳️",
    rank: 10,
    faction: "NEUTRAL",
    branch: "ELECTORAL",
    capacity: 1,
    selection: "管理者が任命",
    powers: ["選挙の告示・進行・中止", "中立義務のため立候補できない"],
    color: 0x3498db,
  },
  JUDGE: {
    key: "JUDGE",
    label: "裁判官",
    emoji: "🧑‍⚖️",
    rank: 11,
    faction: "NEUTRAL",
    branch: "JUDICIAL",
    capacity: 9,
    selection: "内閣総理大臣が任命",
    powers: ["事件の審理と判決", "身分保障: 罷免は国会の弾劾のみ"],
    color: 0x48c9b0,
  },
  REPRESENTATIVE: {
    key: "REPRESENTATIVE",
    label: "国民代表（議員）",
    emoji: "🏛️",
    rank: 12,
    faction: "REPRESENTATIVE",
    branch: "LEGISLATIVE",
    capacity: "SEATS",
    selection: "市民による選挙",
    powers: ["法案の提出と採決", "議長・副議長・内閣総理大臣の選出", "内閣不信任決議・弾劾の発議", `補佐官の任命（${AIDES_PER_REPRESENTATIVE}名まで）`],
    color: 0x2ecc71,
  },
  ELECTION_COMMISSION_MEMBER: {
    key: "ELECTION_COMMISSION_MEMBER",
    label: "選挙管理委員",
    emoji: "📋",
    rank: 13,
    faction: "NEUTRAL",
    branch: "ELECTORAL",
    capacity: 4,
    selection: "管理者が任命",
    powers: ["選挙の告示・進行・中止", "中立義務のため立候補できない"],
    color: 0x85c1e9,
  },
  AIDE: {
    key: "AIDE",
    label: "補佐官",
    emoji: "📎",
    rank: 14,
    faction: "REPRESENTATIVE",
    branch: "LEGISLATIVE",
    capacity: "PER_REP",
    selection: `議員が任命（議員1人につき${AIDES_PER_REPRESENTATIVE}名まで）`,
    powers: ["議員の補佐", "任命した議員の失職とともに退任"],
    color: 0x82e0aa,
  },
};

export const FACTION_LABEL: Record<Faction, string> = {
  ADMIN: "管理者派閥",
  REPRESENTATIVE: "国民代表派閥",
  NEUTRAL: "独立機関",
};

export const BRANCH_LABEL: Record<Branch, string> = {
  ADMIN: "管理者派閥",
  LEGISLATIVE: "立法府（国会）",
  EXECUTIVE: "行政府（内閣）",
  JUDICIAL: "司法府（裁判所）",
  ELECTORAL: "選挙管理委員会",
};

export const CABINET_KEYS: PositionKey[] = ["PRIME_MINISTER", "DEPUTY_PRIME_MINISTER", "CHIEF_CABINET_SECRETARY", "MINISTER"];
export const PRESIDING_KEYS: PositionKey[] = ["SPEAKER", "VICE_SPEAKER"];
export const ELECTORAL_KEYS: PositionKey[] = ["ELECTION_COMMISSIONER", "ELECTION_COMMISSION_MEMBER"];
export const JUDICIAL_KEYS: PositionKey[] = ["CHIEF_JUSTICE", "JUDGE"];
export const ADMIN_FACTION_KEYS: PositionKey[] = ["SOVEREIGN", "ADMINISTRATOR"];

export function isPositionKey(value: string): value is PositionKey {
  return (POSITION_KEYS as readonly string[]).includes(value);
}

export function positionDef(key: string): PositionDef {
  if (!isPositionKey(key)) throw new Error(`Unknown position key: ${key}`);
  return POSITIONS[key];
}

export function byRank(a: { key: string }, b: { key: string }): number {
  return positionDef(a.key).rank - positionDef(b.key).rank;
}

/**
 * Why holding `a` rules out also holding `b` (三権分立・中立性). Returns null when both may be held together.
 * The admin-faction/representative-faction split is a guild setting and is checked separately.
 */
export function incompatibilityReason(a: PositionKey, b: PositionKey): string | null {
  if (a === b) return "同じ役職にすでに就いています";
  const A = POSITIONS[a];
  const B = POSITIONS[b];
  if (a === "SOVEREIGN" || b === "SOVEREIGN") return "元首は他の役職を兼任できません";
  if (A.branch === "JUDICIAL" || B.branch === "JUDICIAL") return "司法の独立のため裁判官は他の役職を兼任できません";
  if (A.branch === "ELECTORAL" || B.branch === "ELECTORAL") return "選挙管理委員会は中立のため他の役職を兼任できません";
  if (A.branch === "EXECUTIVE" && B.branch === "EXECUTIVE") return "閣僚ポストは1人1つまでです";
  const presidingA = PRESIDING_KEYS.includes(a);
  const presidingB = PRESIDING_KEYS.includes(b);
  if (presidingA && presidingB) return "議長と副議長は兼任できません";
  if ((presidingA && B.branch === "EXECUTIVE") || (presidingB && A.branch === "EXECUTIVE")) {
    return "議長・副議長は行政府の役職を兼任できません（立法と行政の分離）";
  }
  if ((a === "AIDE" && b === "REPRESENTATIVE") || (a === "REPRESENTATIVE" && b === "AIDE")) {
    return "議員は補佐官を兼任できません";
  }
  return null;
}
