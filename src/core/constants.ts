export const ELECTION_KIND_LABEL = { GENERAL: "総選挙", BY: "補欠選挙" } as const;
export type ElectionKind = keyof typeof ELECTION_KIND_LABEL;

export const ELECTION_STATUS_LABEL = {
  REGISTRATION: "立候補受付中",
  VOTING: "投票受付中",
  COMPLETED: "確定",
  CANCELLED: "中止",
} as const;
export type ElectionStatus = keyof typeof ELECTION_STATUS_LABEL;

export const OFFICE_LABEL = {
  SPEAKER: "議長",
  VICE_SPEAKER: "副議長",
  PRIME_MINISTER: "内閣総理大臣",
} as const;
export type Office = keyof typeof OFFICE_LABEL;

export const BILL_KIND_LABEL = {
  ORDINARY: "法律案",
  NO_CONFIDENCE: "内閣不信任決議案",
  IMPEACHMENT: "弾劾決議案",
} as const;
export type BillKind = keyof typeof BILL_KIND_LABEL;

export const BILL_ORIGIN_LABEL = { MEMBER: "議員提出", CABINET: "内閣提出", PETITION: "請願" } as const;
export type BillOrigin = keyof typeof BILL_ORIGIN_LABEL;

export const BILL_STATUS_LABEL = {
  DELIBERATION: "審議中",
  VOTING: "採決中",
  PASSED: "可決",
  REJECTED: "否決",
  VETOED: "拒否権行使",
  ENACTED: "成立",
  IMPLEMENTED: "施行済",
  WITHDRAWN: "撤回",
  LAPSED: "廃案",
} as const;
export type BillStatus = keyof typeof BILL_STATUS_LABEL;

export const OPEN_BILL_STATUSES: BillStatus[] = ["DELIBERATION", "VOTING", "PASSED", "VETOED"];

export function billStatusLabel(status: string, kind: string): string {
  if (status === "PASSED" && kind === "ORDINARY") return "可決（裁可待ち）";
  return BILL_STATUS_LABEL[status as BillStatus] ?? status;
}

export const MAJORITY_LABEL = { MAJORITY: "過半数", TWO_THIRDS: "3分の2以上" } as const;
export type Majority = keyof typeof MAJORITY_LABEL;

export const VOTE_CHOICE_LABEL = { FOR: "賛成", AGAINST: "反対", ABSTAIN: "棄権" } as const;
export type VoteChoice = keyof typeof VOTE_CHOICE_LABEL;

export const CASE_STATUS_LABEL = {
  FILED: "受理（担当未定）",
  IN_TRIAL: "審理中",
  VERDICT: "判決（上告期間中）",
  APPEALED: "上告審",
  FINAL: "確定",
  WITHDRAWN: "取下げ",
} as const;
export type CaseStatus = keyof typeof CASE_STATUS_LABEL;

export const CASE_RESULT_LABEL = {
  PLAINTIFF_WINS: "原告勝訴",
  DEFENDANT_WINS: "請求棄却（被告勝訴）",
  SETTLED: "和解",
  DISMISSED: "却下",
} as const;
export type CaseResult = keyof typeof CASE_RESULT_LABEL;

export const PENALTY_LABEL = {
  NONE: "なし",
  WARNING: "警告",
  TIMEOUT_1H: "タイムアウト1時間",
  TIMEOUT_1D: "タイムアウト1日",
  TIMEOUT_7D: "タイムアウト7日",
} as const;
export type Penalty = keyof typeof PENALTY_LABEL;

export const PENALTY_DURATION_MS: Partial<Record<Penalty, number>> = {
  TIMEOUT_1H: 60 * 60 * 1000,
  TIMEOUT_1D: 24 * 60 * 60 * 1000,
  TIMEOUT_7D: 7 * 24 * 60 * 60 * 1000,
};

export const PENALTY_STATUS_LABEL = {
  PENDING: "執行待ち",
  EXECUTED: "執行済",
  SKIPPED: "執行なし",
  FAILED: "執行失敗",
} as const;
export type PenaltyStatus = keyof typeof PENALTY_STATUS_LABEL;

export const PETITION_STATUS_LABEL = { OPEN: "署名受付中", SUBMITTED: "国会へ送付済", EXPIRED: "期限切れ" } as const;
export type PetitionStatus = keyof typeof PETITION_STATUS_LABEL;

export const GAZETTE_CATEGORY_LABEL = {
  ELECTION: "選挙",
  PERSONNEL: "人事",
  LEGISLATION: "立法",
  CABINET: "内閣",
  JUDICIARY: "司法",
  PETITION: "請願",
  ADMIN: "管理者",
  CITIZEN: "市民",
} as const;
export type GazetteCategory = keyof typeof GAZETTE_CATEGORY_LABEL;

export const GAZETTE_COLOR: Record<GazetteCategory, number> = {
  ELECTION: 0x3498db,
  PERSONNEL: 0xe67e22,
  LEGISLATION: 0x9b59b6,
  CABINET: 0xe74c3c,
  JUDICIARY: 0x1abc9c,
  PETITION: 0x2ecc71,
  ADMIN: 0xf1c40f,
  CITIZEN: 0x95a5a6,
};

export const MAX_OPEN_PETITIONS_PER_CITIZEN = 3;
export const MINISTRY_SUGGESTIONS = [
  "総務大臣",
  "外務大臣",
  "法務大臣",
  "防衛大臣",
  "財務大臣",
  "文部科学大臣",
  "デジタル大臣",
  "経済産業大臣",
  "広報大臣",
  "イベント担当大臣",
  "新人歓迎担当大臣",
  "治安担当大臣",
];
