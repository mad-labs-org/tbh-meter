import { describe, expect, it } from "vitest";
import { deriveSessions, SESSION_GAP_MS } from "../sessions.js";

const H = 60 * 60 * 1000; // 1h in ms
const base = 1_700_000_000_000; // a v2 (ms) epoch

describe("deriveSessions — gap-based grouping", () => {
  it("groups runs within the 6h gap into ONE session, labelled by the first run's ts", () => {
    const runs = [
      { id: "a", ts: base },
      { id: "b", ts: base + 2 * H },
      { id: "c", ts: base + 5 * H },
    ];
    const m = deriveSessions(runs);
    expect(m.get("a")).toBe(String(base));
    expect(m.get("b")).toBe(String(base)); // same grind
    expect(m.get("c")).toBe(String(base));
  });

  it("starts a NEW session after a gap > 6h (the next run labels it)", () => {
    const gapStart = base + 5 * H + SESSION_GAP_MS + 1; // > 6h after the previous run
    const runs = [
      { id: "a", ts: base },
      { id: "b", ts: base + 5 * H }, // still session A (within 6h)
      { id: "c", ts: gapStart }, // > 6h idle -> new session
    ];
    const m = deriveSessions(runs);
    expect(m.get("a")).toBe(String(base));
    expect(m.get("b")).toBe(String(base));
    expect(m.get("c")).toBe(String(gapStart)); // fresh grind
  });

  it("exactly AT the gap still resumes (boundary: > gap, not >=)", () => {
    const runs = [
      { id: "a", ts: base },
      { id: "b", ts: base + SESSION_GAP_MS }, // exactly 6h -> same session
    ];
    const m = deriveSessions(runs);
    expect(m.get("b")).toBe(String(base));
  });

  it("is order-independent — newest-first input yields the same grouping", () => {
    const runs = [
      { id: "a", ts: base },
      { id: "b", ts: base + 2 * H },
    ];
    const asc = deriveSessions(runs);
    const desc = deriveSessions([...runs].reverse());
    expect(desc).toEqual(asc);
  });
});

describe("deriveSessions — manual cuts (the 'Nova sessão' button)", () => {
  it("a cut between two runs starts a new session at the later run, even within 6h", () => {
    const runs = [
      { id: "a", ts: base },
      { id: "b", ts: base + 2 * H }, // < 6h, but a cut sits before it
    ];
    const cutAt = base + 1 * H; // user pressed "Nova sessão" between a and b
    const m = deriveSessions(runs, [cutAt]);
    expect(m.get("a")).toBe(String(base));
    expect(m.get("b")).toBe(String(base + 2 * H)); // cut forced a new grind
  });

  it("a cut before all runs does not split anything (nothing precedes the first run)", () => {
    const runs = [
      { id: "a", ts: base },
      { id: "b", ts: base + 2 * H },
    ];
    const m = deriveSessions(runs, [base - H]);
    expect(m.get("a")).toBe(String(base));
    expect(m.get("b")).toBe(String(base)); // one session
  });
});

describe("deriveSessions — determinism", () => {
  it("same runs + same cuts yield a deep-equal map", () => {
    const runs = [
      { id: "a", ts: base },
      { id: "b", ts: base + 8 * H }, // gap break
      { id: "c", ts: base + 9 * H },
    ];
    expect(deriveSessions(runs)).toEqual(deriveSessions(runs));
  });

  it("empty input yields an empty map", () => {
    expect(deriveSessions([]).size).toBe(0);
  });
});
