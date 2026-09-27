export const POSITION_TYPES = {
  REPRESENTATIVE: "REPRESENTATIVE",
  MINISTER: "MINISTER",
  AIDE: "AIDE",
  JUDGE: "JUDGE",
} as const;

export const POSITION_LABELS: Record<string, string> = {
  REPRESENTATIVE: "国民代表（議員）",
  MINISTER: "大臣",
  AIDE: "補佐官",
  JUDGE: "裁判官",
};

export const ELECTION_STATUS = {
  REGISTRATION: "REGISTRATION",
  VOTING: "VOTING",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
} as const;

export const ELECTION_STATUS_LABELS: Record<string, string> = {
  REGISTRATION: "立候補受付中",
  VOTING: "投票中",
  COMPLETED: "終了",
  CANCELLED: "中止",
};

export const PROPOSAL_STATUS = {
  DISCUSSION: "DISCUSSION",
  VOTING: "VOTING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  IMPLEMENTED: "IMPLEMENTED",
} as const;

export const PROPOSAL_STATUS_LABELS: Record<string, string> = {
  DISCUSSION: "議論中",
  VOTING: "投票中",
  APPROVED: "承認",
  REJECTED: "否決",
  IMPLEMENTED: "実施済",
};

export const TRIAL_STATUS = {
  FILED: "FILED",
  IN_PROGRESS: "IN_PROGRESS",
  VERDICT: "VERDICT",
  CLOSED: "CLOSED",
} as const;

export const TRIAL_STATUS_LABELS: Record<string, string> = {
  FILED: "提訴",
  IN_PROGRESS: "審理中",
  VERDICT: "判決",
  CLOSED: "終結",
};

export const FACTION = {
  ADMIN: "管理者派閥",
  REPRESENTATIVE: "国民代表派閥",
} as const;
