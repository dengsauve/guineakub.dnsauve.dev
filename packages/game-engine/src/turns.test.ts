import { describe, expect, it } from "vitest";
import {
  applyRoundCommand,
  assertRoundInventory,
  createDeck,
  resetTurnDraft,
  type Placement,
  type ProposedMeld,
  type RoundState,
  type TurnStep,
  type TileNumber,
  type Color,
} from "./index";
const n = (value: number, color: Color = "red", copy = 1): Placement => ({
  tileId: `number:${copy}:${color}:${value}`,
  color,
  value: value as TileNumber,
});
const j = (value: number, color: Color = "red", copy = 1): Placement => ({
  tileId: `joker:${copy}`,
  color,
  value: value as TileNumber,
});
const run = (id: string, tiles: Placement[]): ProposedMeld => ({
  id,
  kind: "run",
  tiles,
});
const group = (id: string, tiles: Placement[]): ProposedMeld => ({
  id,
  kind: "group",
  tiles,
});
function fixture(
  rack: Placement[],
  board: ProposedMeld[] = [],
  opened = true,
): RoundState {
  const deck = createDeck({ numberedCopies: 2, jokers: 2 });
  const ids = new Set([
    ...rack.map((t) => t.tileId),
    ...board.flatMap((m) => m.tiles.map((t) => t.tileId)),
  ]);
  const find = (id: string) => deck.find((t) => t.id === id)!;
  const opponent = n(13, "orange", 2).tileId;
  return {
    deck,
    board,
    bag: deck.filter((t) => !ids.has(t.id) && t.id !== opponent),
    players: [
      { id: "a", rack: rack.map((t) => find(t.tileId)), opened },
      { id: "b", rack: [find(opponent)], opened: false },
    ],
    turnIndex: 0,
    revision: 7,
    consecutivePasses: 0,
    result: null,
  };
}
function play(state: RoundState, steps: readonly TurnStep[]) {
  return applyRoundCommand(state, {
    type: "play",
    playerId: "a",
    expectedRevision: state.revision,
    steps,
  });
}
function success(state: RoundState, steps: readonly TurnStep[]) {
  const result = play(state, steps);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.code);
  assertRoundInventory(result.state);
  return result.state;
}
function reject(state: RoundState, steps: readonly TurnStep[], code?: string) {
  const before = structuredClone(state);
  const result = play(state, steps);
  expect(result.ok).toBe(false);
  if (code) expect(result).toEqual({ ok: false, code });
  expect(state).toEqual(before);
}
it("commits a winning play once, increments revision and scores remaining racks", () => {
  const meld = run("new", [n(10), n(11), n(12)]);
  const state = fixture(meld.tiles as Placement[]);
  const before = structuredClone(state);
  const next = success(state, [{ type: "lay", melds: [meld] }]);
  expect(next.revision).toBe(8);
  expect(next.result).toEqual({
    reason: "empty-rack",
    winners: ["a"],
    points: { a: 0, b: 13 },
  });
  expect(state).toEqual(before);
  expect(
    applyRoundCommand(next, {
      type: "draw",
      playerId: "a",
      expectedRevision: 8,
    }),
  ).toEqual({ ok: false, code: "ROUND_FINISHED" });
});
describe("opening proof", () => {
  it("rejects 29 points and accepts exactly 30 including joker values", () => {
    const lowA = group("low-a", [n(7), n(7, "blue"), n(7, "black")]);
    const lowB = group("low-b", [
      n(2),
      n(2, "blue"),
      n(2, "black"),
      n(2, "orange"),
    ]);
    reject(
      fixture([...lowA.tiles, ...lowB.tiles], [], false),
      [{ type: "open", melds: [lowA, lowB] }],
      "INVALID_OPENING",
    );
    const exact = group("exact", [n(10), n(10, "blue"), j(10, "black")]);
    const next = success(fixture([...exact.tiles], [], false), [
      { type: "open", melds: [exact] },
    ]);
    expect(next.players[0]!.opened).toBe(true);
  });
  it("accepts multiple rack-only melds totaling exactly 30, not board contributions", () => {
    const a = run("a", [n(3), n(4), n(5)]);
    const b = run("b", [n(5, "blue"), n(6, "blue"), n(7, "blue")]);
    success(fixture([...a.tiles, ...b.tiles], [], false), [
      { type: "open", melds: [a, b] },
    ]);
    const board = run("old", [n(10), n(11), n(12)]);
    reject(
      fixture([n(13)], [board], false),
      [{ type: "open", melds: [run("forged-open", [...board.tiles, n(13)])] }],
      "INVALID_OPENING",
    );
  });
  it("allows manipulating board later in the opening turn, never before opening", () => {
    const opening = group("opening", [
      n(10, "blue"),
      n(10, "black"),
      n(10, "orange"),
    ]);
    const old = run("old", [n(1), n(2), n(3)]);
    const edit: TurnStep = {
      type: "rearrange",
      sourceIds: ["old"],
      melds: [run("old", [...old.tiles, n(4)])],
    };
    const state = fixture([...opening.tiles, n(4), n(5)], [old], false);
    reject(
      state,
      [edit, { type: "open", melds: [opening] }],
      "OPENING_REQUIRED",
    );
    const next = success(state, [{ type: "open", melds: [opening] }, edit]);
    expect(next.turnIndex).toBe(1);
    expect(next.players[0]!.rack.map((t) => t.id)).toEqual([n(5).tileId]);
  });
  it("rejects laying without opening and reopening an already opened player", () => {
    const meld = run("m", [n(10), n(11), n(12)]);
    reject(
      fixture([...meld.tiles], [], false),
      [{ type: "lay", melds: [meld] }],
      "OPENING_REQUIRED",
    );
    reject(
      fixture([...meld.tiles]),
      [{ type: "open", melds: [meld] }],
      "INVALID_OPENING",
    );
  });
});
describe("ownership, atomicity and drafts", () => {
  it("rejects stolen/bag tiles, duplicate IDs, board removal and altered values", () => {
    const old = run("old", [n(1), n(2), n(3)]);
    const state = fixture([n(4)], [old]);
    reject(
      state,
      [{ type: "lay", melds: [run("new", [n(10), n(11), n(12)])] }],
      "TILE_OWNERSHIP",
    );
    reject(state, [{ type: "lay", melds: [run("old", [n(2), n(3), n(4)])] }]);
    reject(
      state,
      [
        {
          type: "rearrange",
          sourceIds: ["old"],
          melds: [run("old", [n(2), n(3), n(4)])],
        },
      ],
      "TILE_CONSERVATION",
    );
    reject(
      state,
      [
        {
          type: "rearrange",
          sourceIds: ["old"],
          melds: [
            run("old", [...old.tiles, { ...n(4), value: 5 as TileNumber }]),
          ],
        },
      ],
      "INVALID_MELD",
    );
  });
  it("requires a rack tile and rolls back an earlier valid draft step on later failure", () => {
    const old = run("old", [n(1), n(2), n(3)]);
    const state = fixture([n(4), n(5)], [old]);
    reject(
      state,
      [{ type: "rearrange", sourceIds: ["old"], melds: [old] }],
      "NO_RACK_TILE_PLAYED",
    );
    reject(
      state,
      [
        {
          type: "rearrange",
          sourceIds: ["old"],
          melds: [run("old", [...old.tiles, n(4)])],
        },
        { type: "lay", melds: [run("bad", [n(10), n(11), n(12)])] },
      ],
      "TILE_OWNERSHIP",
    );
    expect(play(state, [])).toEqual({ ok: false, code: "INVALID_PLAY" });
  });
  it("rejects stale revision, unknown player and wrong turn", () => {
    const state = fixture([n(1)]);
    for (const playerId of ["b", "stranger"])
      expect(
        applyRoundCommand(state, {
          type: "draw",
          playerId,
          expectedRevision: 7,
        }),
      ).toEqual({ ok: false, code: "NOT_YOUR_TURN" });
    expect(
      applyRoundCommand(state, {
        type: "draw",
        playerId: "a",
        expectedRevision: 6,
      }),
    ).toEqual({ ok: false, code: "STALE_REVISION" });
  });
  it("returns detached reset drafts and detached candidate boards", () => {
    const old = run("old", [n(1), n(2), n(3)]);
    const state = fixture([n(4), n(5)], [old]);
    const reset = resetTurnDraft(state, "a");
    expect(reset).toEqual({
      board: state.board,
      rack: state.players[0]!.rack,
      revision: 7,
    });
    expect(reset.board).not.toBe(state.board);
    expect(reset.rack[0]).not.toBe(state.players[0]!.rack[0]);
    expect(() => resetTurnDraft(state, "stranger")).toThrow();
    const proposed = run("old", [...old.tiles, n(4)]);
    const next = success(state, [
      { type: "rearrange", sourceIds: ["old"], melds: [proposed] },
    ]);
    Object.assign(proposed.tiles[0]!, { value: 13 });
    expect(next.board[0]!.tiles[0]!.value).toBe(1);
  });
});
describe("joker retrieval", () => {
  it.each(["black", "orange"] as const)(
    "allows either missing group color (%s) from rack",
    (color) => {
      const old = group("old", [n(2), n(2, "blue"), j(2, "black")]);
      const fresh = run("fresh", [n(10), j(11), n(12)]);
      const state = fixture([n(2, color), n(10), n(12)], [old]);
      success(state, [
        {
          type: "retrieve-joker",
          sourceId: "old",
          jokerId: j(2).tileId,
          replacementId: n(2, color).tileId,
          melds: [group("old", [n(2), n(2, "blue"), n(2, color)])],
        },
        { type: "lay", melds: [fresh] },
      ]);
    },
  );
  it("rejects wrong run replacement and never leaves a retrieved joker in rack", () => {
    const old = run("old", [n(1), j(2), n(3)]);
    const state = fixture([n(2), n(2, "blue")], [old]);
    reject(state, [
      {
        type: "retrieve-joker",
        sourceId: "old",
        jokerId: j(2).tileId,
        replacementId: n(2, "blue").tileId,
        melds: [run("old", [n(1), n(2, "blue"), n(3)])],
      },
    ]);
    reject(
      state,
      [
        {
          type: "retrieve-joker",
          sourceId: "old",
          jokerId: j(2).tileId,
          replacementId: n(2).tileId,
          melds: [run("old", [n(1), n(2), n(3)])],
        },
      ],
      "JOKER_NOT_REUSED",
    );
  });
  it("retrieves from a four-tile group without replacement when three remain", () => {
    const old = group("old", [
      n(2),
      n(2, "blue"),
      n(2, "black"),
      j(2, "orange"),
    ]);
    success(fixture([n(10), n(12)], [old]), [
      {
        type: "retrieve-joker",
        sourceId: "old",
        jokerId: j(2).tileId,
        melds: [group("old", [n(2), n(2, "blue"), n(2, "black")])],
      },
      { type: "lay", melds: [run("new", [n(10), j(11), n(12)])] },
    ]);
  });
  it("splits a run around a joker, leaving two valid runs of three", () => {
    const old = run("old", [n(1), n(2), n(3), j(4), n(5), n(6), n(7)]);
    success(fixture([n(10), n(12)], [old]), [
      {
        type: "retrieve-joker",
        sourceId: "old",
        jokerId: j(4).tileId,
        melds: [
          run("left", [n(1), n(2), n(3)]),
          run("right", [n(5), n(6), n(7)]),
        ],
      },
      { type: "lay", melds: [run("new", [n(10), j(11), n(12)])] },
    ]);
  });
  it("rejects a split with only two tiles on one side or a broken group", () => {
    const old = run("old", [n(1), n(2), j(3), n(4), n(5), n(6)]);
    reject(fixture([n(10), n(12)], [old]), [
      {
        type: "retrieve-joker",
        sourceId: "old",
        jokerId: j(3).tileId,
        melds: [run("left", [n(1), n(2)]), run("right", [n(4), n(5), n(6)])],
      },
    ]);
    const short = group("short", [n(2), n(2, "blue"), j(2, "black")]);
    reject(fixture([n(10), n(12)], [short]), [
      {
        type: "retrieve-joker",
        sourceId: "short",
        jokerId: j(2).tileId,
        melds: [group("short", [n(2), n(2, "blue")])],
      },
    ]);
  });
  it("allows a retained joker to change represented number in its run", () => {
    const old = run("old", [n(1), n(2), j(3)]);
    const next = success(fixture([n(3)], [old]), [
      {
        type: "rearrange",
        sourceIds: ["old"],
        melds: [run("old", [...old.tiles.slice(0, 2), n(3), j(4)])],
      },
    ]);
    expect(next.board[0]!.tiles[3]!.value).toBe(4);
  });
  it("allows retained joker color changes in a group", () => {
    const old = group("old", [n(2), n(2, "blue"), j(2, "black")]);
    success(fixture([n(2, "black")], [old]), [
      {
        type: "rearrange",
        sourceIds: ["old"],
        melds: [
          group("old", [n(2), n(2, "blue"), n(2, "black"), j(2, "orange")]),
        ],
      },
    ]);
  });
  it("rejects direct movement to a different meld without first proving valid remnants", () => {
    const old = group("old", [
      n(2),
      n(2, "blue"),
      n(2, "black"),
      j(2, "orange"),
    ]);
    reject(
      fixture([n(10), n(12)], [old]),
      [
        {
          type: "rearrange",
          sourceIds: ["old"],
          melds: [
            group("old", [n(2), n(2, "blue"), n(2, "black")]),
            run("new", [n(10), j(11), n(12)]),
          ],
        },
      ],
      "JOKER_RETRIEVAL_REQUIRED",
    );
  });
  it("permits joker retrieval after rack-only opening in the same turn", () => {
    const old = run("old", [n(1), j(2), n(3)]);
    const opening = group("opening", [
      n(10, "blue"),
      n(10, "black"),
      n(10, "orange"),
    ]);
    const steps: TurnStep[] = [
      {
        type: "retrieve-joker",
        sourceId: "old",
        jokerId: j(2).tileId,
        replacementId: n(2).tileId,
        melds: [run("old", [n(1), n(2), n(3)])],
      },
      { type: "lay", melds: [run("new", [n(10), j(11), n(12)])] },
    ];
    const state = fixture([...opening.tiles, n(2), n(10), n(12)], [old], false);
    reject(state, steps, "OPENING_REQUIRED");
    success(state, [{ type: "open", melds: [opening] }, ...steps]);
  });
});
describe("draw and pass", () => {
  function command(state: RoundState, type: "draw" | "pass") {
    return applyRoundCommand(state, {
      type,
      playerId: state.players[state.turnIndex]!.id,
      expectedRevision: state.revision,
    });
  }
  it("draws exactly one, resets passes and ends turn without playing the tile", () => {
    const state = { ...fixture([n(1)]), consecutivePasses: 1 };
    const next = command(state, "draw");
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.state.players[0]!.rack).toEqual([
      ...state.players[0]!.rack,
      state.bag[0],
    ]);
    expect(next.state.bag).toEqual(state.bag.slice(1));
    expect(next.state.turnIndex).toBe(1);
    expect(next.state.consecutivePasses).toBe(0);
    expect(command(state, "pass")).toEqual({
      ok: false,
      code: "BAG_NOT_EMPTY",
    });
  });
  it("ends blocked after one complete pass cycle, scores every rack, and resets passes after play", () => {
    const base = fixture([n(10), n(11), n(12), n(13)]);
    const state = {
      ...base,
      bag: [],
      players: [
        base.players[0]!,
        { ...base.players[1]!, rack: [...base.players[1]!.rack, ...base.bag] },
      ],
    };
    expect(command(state, "draw")).toEqual({ ok: false, code: "EMPTY_BAG" });
    const first = command(state, "pass");
    if (!first.ok) throw new Error(first.code);
    expect(first.state.result).toBeNull();
    const second = command(first.state, "pass");
    if (!second.ok) throw new Error(second.code);
    expect(second.state.result?.reason).toBe("blocked");
    expect(second.state.result?.points.a).toBe(46);
    const played = success({ ...state, consecutivePasses: 1 }, [
      { type: "lay", melds: [run("new", [n(10), n(11), n(12)])] },
    ]);
    expect(played.consecutivePasses).toBe(0);
  });
  it("runs an entire 8-player bag depletion and blocked pass cycle with conservation on every transition", () => {
    const deck = createDeck({ numberedCopies: 4, jokers: 6 });
    let state: RoundState = {
      deck,
      board: [],
      players: Array.from({ length: 8 }, (_, i) => ({
        id: `p${i}`,
        rack: deck.slice(i * 14, (i + 1) * 14),
        opened: false,
      })),
      bag: deck.slice(112),
      turnIndex: 0,
      revision: 0,
      consecutivePasses: 0,
      result: null,
    };
    const before = structuredClone(state);
    let count = 0;
    while (!state.result) {
      const next = command(state, state.bag.length ? "draw" : "pass");
      if (!next.ok) throw new Error(next.code);
      assertRoundInventory(next.state);
      state = next.state;
      count++;
    }
    expect(count).toBe(110);
    expect(state.revision).toBe(110);
    expect(state.result?.reason).toBe("blocked");
    expect(before.bag).toHaveLength(102);
  });
});
it("does not let a caller bypass joker retrieval by reusing the source meld ID", () => {
  const old = run("old", [n(1), j(2), n(3)]);
  const state = fixture(
    [n(1, "blue"), n(1, "black"), n(3, "blue"), n(3, "black"), n(10), n(12)],
    [old],
  );
  reject(
    state,
    [
      {
        type: "rearrange",
        sourceIds: ["old"],
        melds: [
          run("old", [n(10), j(11), n(12)]),
          group("ones", [n(1), n(1, "blue"), n(1, "black")]),
          group("threes", [n(3), n(3, "blue"), n(3, "black")]),
        ],
      },
    ],
    "JOKER_RETRIEVAL_REQUIRED",
  );
});
it("splits a valid run without extracting its joker or inventing a new representation constraint", () => {
  const old = run("old", [n(1), n(2), j(3), n(4), n(5), n(6), n(7)]);
  const next = success(fixture([n(8)], [old]), [
    {
      type: "split-run",
      sourceId: "old",
      melds: [
        run("left", [n(1), n(2), j(3)]),
        run("right", [n(4), n(5), n(6), n(7)]),
      ],
    },
    {
      type: "rearrange",
      sourceIds: ["right"],
      melds: [run("right", [n(4), n(5), n(6), n(7), n(8)])],
    },
  ]);
  expect(next.board).toHaveLength(2);
});
it("can move numbered tiles out of a joker group while leaving that joker in a valid meld", () => {
  const old = group("old", [n(2), n(2, "blue"), n(2, "black"), j(2, "orange")]);
  success(fixture([n(1, "black"), n(3, "black")], [old]), [
    {
      type: "detach-numbered",
      sourceId: "old",
      tileId: n(2, "black").tileId,
      melds: [group("old", [n(2), n(2, "blue"), j(2, "orange")])],
    },
    {
      type: "lay",
      melds: [run("new", [n(1, "black"), n(2, "black"), n(3, "black")])],
    },
  ]);
});
it("cannot detach a numbered board tile and fail to reuse it", () => {
  const old = run("old", [n(1), n(2), n(3), n(4)]);
  reject(
    fixture([n(10), n(11), n(12)], [old]),
    [
      {
        type: "detach-numbered",
        sourceId: "old",
        tileId: n(4).tileId,
        melds: [run("old", [n(1), n(2), n(3)])],
      },
      { type: "lay", melds: [run("new", [n(10), n(11), n(12)])] },
    ],
    "BOARD_TILE_NOT_REUSED",
  );
});
it("rejects invalid recovered inventories before attempting any transition", () => {
  const state = fixture([n(1)]);
  for (const invalid of [
    { ...state, bag: state.bag.slice(1) },
    { ...state, deck: state.deck.slice(1) },
    { ...state, revision: -1 },
    { ...state, turnIndex: 99 },
  ]) {
    const result = applyRoundCommand(invalid, {
      type: "draw",
      playerId: "a",
      expectedRevision: invalid.revision,
    });
    expect(result.ok).toBe(false);
  }
});
it("merges two complete joker runs without falsely treating either joker as retrieved", () => {
  const left = run("left", [n(1), n(2), j(3)]);
  const right = run("right", [n(4), n(5), j(6, "red", 2)]);
  success(fixture([n(7)], [left, right]), [
    {
      type: "rearrange",
      sourceIds: ["left", "right"],
      melds: [run("merged", [...left.tiles, ...right.tiles, n(7)])],
    },
  ]);
});
it("retrieves an endpoint joker without replacement when one valid run remains", () => {
  const old = run("old", [j(1), n(2), n(3), n(4)]);
  success(fixture([n(10), n(12)], [old]), [
    {
      type: "retrieve-joker",
      sourceId: "old",
      jokerId: j(1).tileId,
      melds: [run("old", [n(2), n(3), n(4)])],
    },
    { type: "lay", melds: [run("new", [n(10), j(11), n(12)])] },
  ]);
});
it("recombines several numbered melds freely while preserving every board tile", () => {
  const a = group("ones", [n(1), n(1, "blue"), n(1, "black")]);
  const b = group("twos", [n(2), n(2, "blue"), n(2, "black")]);
  const c = group("threes", [n(3), n(3, "blue"), n(3, "black")]);
  success(fixture([n(4)], [a, b, c]), [
    {
      type: "rearrange",
      sourceIds: ["ones", "twos", "threes"],
      melds: [
        run("red", [n(1), n(2), n(3), n(4)]),
        run("blue", [n(1, "blue"), n(2, "blue"), n(3, "blue")]),
        run("black", [n(1, "black"), n(2, "black"), n(3, "black")]),
      ],
    },
  ]);
});
it("rejects a repeated draw and concurrent old-revision command without drawing twice", () => {
  const state = fixture([n(1)]);
  const command = {
    type: "draw" as const,
    playerId: "a",
    expectedRevision: state.revision,
  };
  const first = applyRoundCommand(state, command);
  if (!first.ok) throw new Error(first.code);
  const before = structuredClone(first.state);
  expect(applyRoundCommand(first.state, command)).toEqual({
    ok: false,
    code: "STALE_REVISION",
  });
  expect(applyRoundCommand(first.state, { ...command, playerId: "b" })).toEqual(
    { ok: false, code: "STALE_REVISION" },
  );
  expect(first.state).toEqual(before);
});
