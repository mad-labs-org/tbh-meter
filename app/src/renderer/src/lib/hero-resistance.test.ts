import { describe, it, expect } from "vitest";
import { heroResistances } from "./hero-resistance";

// The numbers here are the exact live-confirmed cases (hero 201, 3-9 Torment) used to lock the
// formula — see memory tbh-stage-difficulty-res-penalty. StatType ids: 52=AllElemental, 12=Fire,
// 13=Cold, 14=Lightning, 15=Chaos.

const byEl = (info: ReturnType<typeof heroResistances>) =>
  Object.fromEntries((info?.resistances ?? []).map((r) => [r.element, r.effective]));

describe("heroResistances", () => {
  it("returns null without stats (older reader / hero not deployed)", () => {
    expect(heroResistances(undefined, "Torment")).toBeNull();
    expect(heroResistances(null, "Torment")).toBeNull();
  });

  it("Torment, AllElemental 27 only → F/C/L −33, Chaos −60 (the baseline Mario saw)", () => {
    const info = heroResistances({ 52: 27 }, "Torment")!;
    expect(info.penalty).toBe(60);
    expect(byEl(info)).toEqual({ Fire: -33, Cold: -33, Lightning: -33, Chaos: -60 });
  });

  it("Torment, AllElemental 27 + Fire 10 gem → Fire −23, others unchanged (the decisive test)", () => {
    const info = heroResistances({ 52: 27, 12: 10 }, "Torment")!;
    expect(byEl(info)).toEqual({ Fire: -23, Cold: -33, Lightning: -33, Chaos: -60 });
  });

  it("Chaos resistance reduces only the Chaos penalty (AllElemental never touches Chaos)", () => {
    const info = heroResistances({ 52: 27, 15: 20 }, "Torment")!;
    expect(byEl(info)).toEqual({ Fire: -33, Cold: -33, Lightning: -33, Chaos: -40 });
  });

  it("scales penalty by difficulty; Normal applies none (effective = own resistance)", () => {
    expect(heroResistances({ 52: 27 }, "Hell")!.resistances[0].effective).toBe(27 - 40);
    expect(heroResistances({ 52: 27 }, "Nightmare")!.resistances[0].effective).toBe(27 - 20);
    const normal = heroResistances({ 52: 27, 12: 10 }, "Normal")!;
    expect(normal.penalty).toBe(0);
    expect(byEl(normal)).toEqual({ Fire: 37, Cold: 27, Lightning: 27, Chaos: 0 });
  });

  it("unknown mode → no penalty (degrades to own resistance, never throws)", () => {
    const info = heroResistances({ 52: 15 }, "???")!;
    expect(info.penalty).toBe(0);
    expect(info.resistances.every((r) => r.effective === r.own)).toBe(true);
  });

  it("reports own vs effective separately for the UI", () => {
    const fire = heroResistances({ 52: 27, 12: 10 }, "Torment")!.resistances[0];
    expect(fire).toEqual({ element: "Fire", own: 37, effective: -23 });
  });
});
