import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { incompatibilityReason } from "../src/core/positions";
import { decideWinners, legalMinimumVotes, officeMajority, tallyVotes } from "../src/core/tally";

const fixed = (value: number) => () => value;

describe("decideWinners（開票）", () => {
  it("得票順に定数まで当選する", () => {
    const d = decideWinners(
      [
        { id: "a", votes: 5 },
        { id: "b", votes: 9 },
        { id: "c", votes: 2 },
      ],
      2,
    );
    assert.deepEqual(d.winners, ["b", "a"]);
    assert.equal(d.lotteryUsed, false);
  });

  it("最下位当選者が同数ならくじで決める", () => {
    const candidates = [
      { id: "a", votes: 5 },
      { id: "b", votes: 3 },
      { id: "c", votes: 3 },
    ];
    const first = decideWinners(candidates, 2, fixed(0));
    const second = decideWinners(candidates, 2, fixed(0.99));
    assert.equal(first.lotteryUsed, true);
    assert.deepEqual(first.tiedAtCutoff.sort(), ["b", "c"]);
    assert.equal(first.winners[0], "a");
    assert.notEqual(first.winners[1], second.winners[1]);
  });

  it("同数でも全員が定数内に収まるならくじは使わない", () => {
    const d = decideWinners(
      [
        { id: "a", votes: 4 },
        { id: "b", votes: 4 },
        { id: "c", votes: 1 },
      ],
      2,
    );
    assert.deepEqual(d.winners.sort(), ["a", "b"]);
    assert.equal(d.lotteryUsed, false);
  });

  it("法定得票数に届かない候補者は当選せず欠員になる", () => {
    assert.equal(legalMinimumVotes(60, 2), 5);
    const d = decideWinners(
      [
        { id: "a", votes: 55 },
        { id: "b", votes: 4 },
        { id: "c", votes: 1 },
      ],
      2,
    );
    assert.deepEqual(d.winners, ["a"]);
    assert.equal(d.unfilledSeats, 1);
  });

  it("誰も投票しなければ当選者なし", () => {
    const d = decideWinners(
      [
        { id: "a", votes: 0 },
        { id: "b", votes: 0 },
      ],
      1,
    );
    assert.deepEqual(d.winners, []);
    assert.equal(d.unfilledSeats, 1);
  });
});

describe("tallyVotes（採決）", () => {
  const v = (citizenId: string, choice: string) => ({ citizenId, choice });

  it("賛成多数で可決、反対多数で否決", () => {
    assert.equal(tallyVotes([v("a", "FOR"), v("b", "FOR"), v("c", "AGAINST")], 3, "MAJORITY").passed, true);
    assert.equal(tallyVotes([v("a", "FOR"), v("b", "AGAINST"), v("c", "AGAINST")], 3, "MAJORITY").passed, false);
  });

  it("定足数（在籍の3分の1）に満たなければ否決", () => {
    const t = tallyVotes([v("a", "FOR")], 6, "MAJORITY");
    assert.equal(t.quorum, 2);
    assert.equal(t.quorumMet, false);
    assert.equal(t.passed, false);
  });

  it("可否同数は議長の票で決まる", () => {
    const votes = [v("speaker", "FOR"), v("b", "AGAINST"), v("c", "ABSTAIN")];
    assert.equal(tallyVotes(votes, 3, "MAJORITY", "speaker").tieBreak, "SPEAKER_FOR");
    assert.equal(tallyVotes(votes, 3, "MAJORITY", "speaker").passed, true);
    const against = [v("speaker", "AGAINST"), v("b", "FOR")];
    assert.equal(tallyVotes(against, 2, "MAJORITY", "speaker").passed, false);
    assert.equal(tallyVotes([v("a", "FOR"), v("b", "AGAINST")], 2, "MAJORITY", null).tieBreak, "NO_SPEAKER_VOTE");
  });

  it("3分の2は棄権も出席に数える", () => {
    assert.equal(tallyVotes([v("a", "FOR"), v("b", "FOR"), v("c", "AGAINST")], 3, "TWO_THIRDS").passed, true);
    assert.equal(tallyVotes([v("a", "FOR"), v("b", "FOR"), v("c", "ABSTAIN"), v("d", "AGAINST")], 4, "TWO_THIRDS").passed, false);
  });

  it("院内選挙の過半数", () => {
    assert.equal(officeMajority(1), 1);
    assert.equal(officeMajority(4), 3);
    assert.equal(officeMajority(5), 3);
  });
});

describe("兼任ルール（三権分立）", () => {
  it("議員と閣僚は兼任できる", () => {
    assert.equal(incompatibilityReason("REPRESENTATIVE", "MINISTER"), null);
    assert.equal(incompatibilityReason("PRIME_MINISTER", "REPRESENTATIVE"), null);
  });

  it("司法・選挙管理・元首は他と兼任できない", () => {
    assert.ok(incompatibilityReason("JUDGE", "REPRESENTATIVE"));
    assert.ok(incompatibilityReason("CHIEF_JUSTICE", "JUDGE"));
    assert.ok(incompatibilityReason("ELECTION_COMMISSIONER", "AIDE"));
    assert.ok(incompatibilityReason("SOVEREIGN", "ADMINISTRATOR"));
  });

  it("議長は行政府と兼任できず、閣僚ポストは1人1つ", () => {
    assert.ok(incompatibilityReason("SPEAKER", "PRIME_MINISTER"));
    assert.ok(incompatibilityReason("VICE_SPEAKER", "MINISTER"));
    assert.ok(incompatibilityReason("MINISTER", "DEPUTY_PRIME_MINISTER"));
    assert.ok(incompatibilityReason("AIDE", "REPRESENTATIVE"));
  });
});
