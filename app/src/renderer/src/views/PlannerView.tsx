import { useState, useEffect, useMemo, useCallback } from "react";
import { Inbox, ChevronDown, ChevronRight, Minus, Plus, TriangleAlert, Info } from "lucide-react";
import { useT } from "~/lib/i18n";
import type { Translate } from "../../../shared/i18n/index.js";
import { cn } from "~/lib/utils";
import { HeroPortrait } from "~/components/HeroPortrait";
import { formatEta, modeTextClass } from "~/lib/format";
import { stageCode, stageDifficulty, heroName } from "~/lib/game-data";
import {
  loadPlannerInputs,
  type PlannerInputs,
  type AnchorHero,
} from "~/lib/planner-data";
import {
  singleHeroClimb,
  teamClimb,
  rankNextLevel,
  MAX_LEVEL,
  type ClimbHero,
  type ClimbCandidate,
  type PlanBand,
  type TeamPlanBand,
  type CandidateSource,
  type NextLevelRank,
} from "../../../shared/planner-model.js";

/** "team" or a specific heroKey. */
type Subject = { kind: "team" } | { kind: "hero"; heroKey: number };
/** The plan's two zoom levels. Default is Next Level (the "where do I farm the next level-up" answer). */
type PlanTab = "full" | "next";
/** The plan's DATA BASIS. Default "practical" — only stages the player actually farmed (real XP +
 *  real clear time); "theoretical" adds the datamine-estimated stages (today's full behavior). */
type PlanMode = "practical" | "theoretical";

export function PlannerView() {
  const t = useT();
  const [inputs, setInputs] = useState<PlannerInputs | null>(null);
  const [subject, setSubject] = useState<Subject>({ kind: "team" });
  const [target, setTarget] = useState<number | null>(null);

  const load = useCallback(async () => {
    setInputs(await loadPlannerInputs());
  }, []);

  useEffect(() => {
    void load();
    return window.meter.onRunsChanged(() => void load());
  }, [load]);

  // The heroes that can climb (level < MAX_LEVEL). Capped heroes are shown greyed but excluded.
  const climbers = useMemo(() => (inputs?.team ?? []).filter((h) => h.level < MAX_LEVEL), [inputs]);
  const minTarget = useMemo(
    () => (climbers.length ? Math.min(MAX_LEVEL, Math.max(...climbers.map((h) => h.level)) + 1) : MAX_LEVEL),
    [climbers],
  );

  // Default target: a round number above the lowest climber, clamped to MAX_LEVEL.
  const effectiveTarget = useMemo(() => {
    if (target != null) return Math.min(MAX_LEVEL, Math.max(minTarget, target));
    const suggestion = Math.min(MAX_LEVEL, Math.ceil((minTarget + 1) / 5) * 5);
    return Math.max(minTarget, suggestion);
  }, [target, minTarget]);

  // Reset a stale hero-subject if its hero capped or vanished after a reload.
  useEffect(() => {
    if (subject.kind === "hero" && !climbers.some((h) => h.heroKey === subject.heroKey)) {
      setSubject({ kind: "team" });
    }
  }, [subject, climbers]);

  if (inputs == null) {
    return <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">…</div>;
  }

  // Empty / cold-start gate: no counted runs (no DPS, every stage uncalibrated T3) → don't pretend.
  if (inputs.countedRuns === 0 || inputs.partyDpsNow <= 0 || inputs.team.length === 0) {
    return <EmptyState t={t} />;
  }

  // Capped-only team.
  if (climbers.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center">
        <span className="text-sm font-semibold text-zinc-300">{t("planner.maxedTitle")}</span>
        <span className="text-xs text-zinc-500">{t("planner.maxedBody")}</span>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 text-sm">
      {/* The approved layout: two columns on a wide window — LEFT = who + how far + how-it-works,
          RIGHT = the plan (side-by-side, not stacked). Collapses to one column when narrow. */}
      <div className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-[0.9fr_1.1fr] md:items-start">
        {/* LEFT — pick + target + how it works */}
        <div className="flex flex-col gap-5">
          {/* Step 1 — who to level */}
          <section>
            <StepHead num={1}>{t("planner.stepWho")}</StepHead>
            <SubjectPicker t={t} team={inputs.team} subject={subject} onSubject={setSubject} />
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-500">
              <Info className="size-3 shrink-0" />
              {t("planner.heroesCaption", { n: inputs.team.length })}
            </p>
          </section>

          {/* Step 2 — how far */}
          <section>
            <StepHead num={2}>{t("planner.stepHowFar")}</StepHead>
            <TargetStepper t={t} value={effectiveTarget} min={minTarget} onChange={(v) => setTarget(v)} />
          </section>

          <HowItWorks t={t} />
        </div>

        {/* RIGHT — the plan (Full Climb | Next Level). min-w-0 lets the inner table scroll
            instead of blowing out the grid column. */}
        <section className="min-w-0">
          <PlanPanel t={t} inputs={inputs} subject={subject} target={effectiveTarget} climbers={climbers} />
        </section>
      </div>
    </div>
  );
}

// ── small building blocks ──────────────────────────────────────────────────────────────────

function StepHead({ num, children }: { num: number; children: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="flex size-[18px] items-center justify-center rounded bg-brand-600 text-[11px] font-bold text-white">
        {num}
      </span>
      <h2 className="text-[13px] font-semibold text-zinc-100">{children}</h2>
    </div>
  );
}

function EmptyState({ t }: { t: Translate }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-10 text-center">
      <Inbox className="size-8 text-zinc-600" />
      <span className="text-sm font-semibold text-zinc-300">{t("planner.emptyTitle")}</span>
      <span className="max-w-md text-xs leading-relaxed text-zinc-500">{t("planner.emptyBody")}</span>
    </div>
  );
}

// ── subject picker (Team | per-hero) ─────────────────────────────────────────────────────────

function SubjectPicker({
  t,
  team,
  subject,
  onSubject,
}: {
  t: Translate;
  team: AnchorHero[];
  subject: Subject;
  onSubject: (s: Subject) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => onSubject({ kind: "team" })}
        className={cn(
          "cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
          subject.kind === "team"
            ? "bg-brand-600 text-white shadow-[0_2px_8px_-2px] shadow-brand-600/60"
            : "bg-surface-700 text-zinc-300 hover:bg-surface-600",
        )}
      >
        {t("planner.subjectTeamFull")}
      </button>
      {team.map((h) => {
        const capped = h.level >= MAX_LEVEL;
        const active = subject.kind === "hero" && subject.heroKey === h.heroKey;
        return (
          <button
            key={h.heroKey}
            type="button"
            disabled={capped}
            onClick={() => onSubject({ kind: "hero", heroKey: h.heroKey })}
            title={`${h.class} · Lv ${h.level}`}
            className={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-lg py-1 pl-1 pr-2.5 text-xs font-medium transition-colors",
              capped && "cursor-default opacity-50",
              active
                ? "bg-brand-600 text-white shadow-[0_2px_8px_-2px] shadow-brand-600/60"
                : "bg-surface-700 text-zinc-300 hover:bg-surface-600",
            )}
          >
            <HeroPortrait heroKey={h.heroKey} heroClass={h.class} />
            <span className="font-semibold">{h.class}</span>
            <span className="font-mono text-[11px] tabular-nums opacity-80">Lv {h.level}</span>
            {capped && (
              <span className="rounded bg-amber-500/20 px-1 text-[9px] font-bold text-amber-300">{t("planner.maxPill")}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── target stepper ─────────────────────────────────────────────────────────────────────────

function TargetStepper({
  t,
  value,
  min,
  onChange,
}: {
  t: Translate;
  value: number;
  min: number;
  onChange: (v: number) => void;
}) {
  // Presets above the lowest climber, clamped to MAX_LEVEL, de-duplicated.
  const presets = useMemo(() => {
    const cands = [min + 4, min + 5, min + 9, MAX_LEVEL];
    return [...new Set(cands.map((v) => Math.min(MAX_LEVEL, Math.max(min, v))))].sort((a, b) => a - b);
  }, [min]);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-400">{t("planner.targetLabel")}</span>
        <div className="flex items-center gap-1">
          <StepBtn disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
            <Minus className="size-3" />
          </StepBtn>
          <span className="w-9 text-center font-mono text-sm font-bold tabular-nums text-white">{value}</span>
          <StepBtn disabled={value >= MAX_LEVEL} onClick={() => onChange(Math.min(MAX_LEVEL, value + 1))}>
            <Plus className="size-3" />
          </StepBtn>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onChange(p)}
            className={cn(
              "cursor-pointer rounded border px-2 py-0.5 font-mono text-[10.5px] transition-colors",
              p === value
                ? "border-brand-600 bg-brand-600 text-white"
                : "border-surface-600 bg-surface-700 text-zinc-400 hover:bg-surface-600",
            )}
          >
            {p === MAX_LEVEL ? `Max ${MAX_LEVEL}` : `→${p}`}
          </button>
        ))}
      </div>
    </div>
  );
}

function StepBtn({ children, disabled, onClick }: { children: React.ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex size-6 cursor-pointer items-center justify-center rounded bg-surface-700 text-zinc-300 transition-colors hover:bg-surface-600 disabled:cursor-default disabled:opacity-40"
    >
      {children}
    </button>
  );
}

// ── the plan panel (computes + renders, tabbed Full Climb | Next Level) ───────────────────────

function PlanPanel({
  t,
  inputs,
  subject,
  target,
  climbers,
}: {
  t: Translate;
  inputs: PlannerInputs;
  subject: Subject;
  target: number;
  climbers: AnchorHero[];
}) {
  const [tab, setTab] = useState<PlanTab>("next"); // DEFAULT: Next Level (per spec)
  const [mode, setMode] = useState<PlanMode>("practical"); // DEFAULT: Practical (only farmed stages)
  const [showPerHero, setShowPerHero] = useState(false);

  const climbHeroes = useMemo<ClimbHero[]>(
    () => inputs.team.map((h) => ({ heroKey: h.heroKey, level: h.level, expIntoLevel: h.expIntoLevel })),
    [inputs.team],
  );

  // The DATA-BASIS filter: practical keeps only the stages the player actually farmed (measured —
  // real XP + real clear time, no estimates); theoretical keeps every candidate. Applied to BOTH the
  // climb (singleHeroClimb/teamClimb) and the Next-Level rank so the mode is honoured everywhere.
  const filteredByHero = useMemo<Map<number, ClimbCandidate[]>>(() => {
    if (mode === "theoretical") return inputs.candidatesByHero;
    const out = new Map<number, ClimbCandidate[]>();
    for (const [heroKey, cands] of inputs.candidatesByHero) {
      out.set(heroKey, cands.filter((c) => c.source === "measured"));
    }
    return out;
  }, [mode, inputs.candidatesByHero]);

  const computed = useMemo(() => {
    if (subject.kind === "hero") {
      const hero = climbHeroes.find((h) => h.heroKey === subject.heroKey);
      const cands = filteredByHero.get(subject.heroKey) ?? [];
      if (!hero) return null;
      const plan = singleHeroClimb(hero, target, cands, inputs.curve, { excludeUnderLevel: true });
      return { kind: "hero" as const, plan, hero, cands };
    }
    const teamPlan = teamClimb(climbHeroes, target, filteredByHero, inputs.curve, {
      excludeUnderLevel: true,
    });
    return { kind: "team" as const, teamPlan };
  }, [subject, climbHeroes, target, inputs.curve, filteredByHero]);

  if (!computed) return null;

  const subjectLabel =
    subject.kind === "team" ? t("planner.subjectTeam") : heroClassOf(inputs.team, subject.heroKey);

  // The hero whose plan the Next-Level rank is for: the subject hero, or — for the Team — the gating
  // (binding-constraint) hero of the climb, falling back to the lowest-level climber.
  const nextLevelHero: { hero: ClimbHero; gating: boolean } | null = (() => {
    if (computed.kind === "hero") return { hero: computed.hero, gating: false };
    const gateKey =
      computed.teamPlan.gatedByHeroKey ??
      [...climbers].sort((a, b) => a.level - b.level)[0]?.heroKey ??
      null;
    if (gateKey == null) return null;
    const hero = climbHeroes.find((h) => h.heroKey === gateKey);
    return hero ? { hero, gating: true } : null;
  })();

  const status = computed.kind === "team" ? computed.teamPlan.status : computed.plan.status;

  return (
    <div>
      {/* Step-3 heading + sub-tab nav */}
      <div className="mb-2 flex items-center gap-2">
        <span className="flex size-[18px] items-center justify-center rounded bg-brand-600 text-[11px] font-bold text-white">
          3
        </span>
        <h2 className="text-[13px] font-semibold text-zinc-100">
          {t("planner.planForHero", { subject: subjectLabel })}
        </h2>
      </div>

      {/* Mode toggle (DATA BASIS) + an ALWAYS-VISIBLE definition line — not a tooltip, so the
          real-vs-estimated distinction is unmissable. */}
      <div className="mb-1.5 inline-flex gap-0.5 rounded-lg border border-surface-600 bg-surface-700 p-0.5">
        <SubTab active={mode === "practical"} onClick={() => setMode("practical")}>
          {t("planner.modePractical")}
        </SubTab>
        <SubTab active={mode === "theoretical"} onClick={() => setMode("theoretical")}>
          {t("planner.modeTheoretical")}
        </SubTab>
      </div>
      <p className="mb-3 flex items-start gap-1.5 text-[11px] leading-snug text-zinc-500">
        <Info className="mt-px size-3 shrink-0" />
        <span>{mode === "practical" ? t("planner.modePracticalDef") : t("planner.modeTheoreticalDef")}</span>
      </p>

      <div className="mb-3 inline-flex gap-0.5 rounded-lg border border-surface-600 bg-surface-700 p-0.5">
        <SubTab active={tab === "full"} onClick={() => setTab("full")}>
          {t("planner.tabFullClimb")}
        </SubTab>
        <SubTab active={tab === "next"} onClick={() => setTab("next")}>
          {t("planner.tabNextLevel")}
        </SubTab>
      </div>

      {status === "already-at-target" ? (
        <p className="text-xs text-zinc-500">{t("planner.alreadyThere")}</p>
      ) : tab === "next" ? (
        <NextLevelTab
          t={t}
          inputs={inputs}
          hero={nextLevelHero?.hero ?? null}
          cands={nextLevelHero ? filteredByHero.get(nextLevelHero.hero.heroKey) ?? [] : []}
          gating={nextLevelHero?.gating ?? false}
          gatingHeroKey={computed.kind === "team" ? nextLevelHero?.hero.heroKey ?? null : null}
          mode={mode}
          onSwitchToTheoretical={() => setMode("theoretical")}
        />
      ) : (
        <FullClimbTab
          t={t}
          inputs={inputs}
          computed={computed}
          target={target}
          climbers={climbers}
          subject={subject}
          showPerHero={showPerHero}
          onTogglePerHero={() => setShowPerHero((v) => !v)}
          mode={mode}
          onSwitchToTheoretical={() => setMode("theoretical")}
        />
      )}

      <SourceFootnote t={t} />
    </div>
  );
}

function SubTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "cursor-pointer rounded-md px-3.5 py-1.5 text-[11.5px] font-semibold transition-colors",
        active ? "bg-brand-600 text-white shadow-[0_2px_8px_-3px] shadow-brand-600/70" : "text-zinc-400 hover:text-zinc-200",
      )}
    >
      {children}
    </button>
  );
}

// ── Next Level tab — ranked "where to farm the next level-up" ────────────────────────────────

function NextLevelTab({
  t,
  inputs,
  hero,
  cands,
  gating,
  gatingHeroKey,
  mode,
  onSwitchToTheoretical,
}: {
  t: Translate;
  inputs: PlannerInputs;
  hero: ClimbHero | null;
  /** The MODE-FILTERED candidates for this hero (practical = measured only). */
  cands: ClimbCandidate[];
  gating: boolean;
  gatingHeroKey: number | null;
  mode: PlanMode;
  onSwitchToTheoretical: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const ranked = useMemo<NextLevelRank[]>(() => {
    if (!hero) return [];
    return rankNextLevel(hero, cands, inputs.curve, { excludeUnderLevel: true });
  }, [hero, cands, inputs.curve]);

  if (!hero) return null;
  if (ranked.length === 0) {
    // Practical with nothing farmed for this hero → guide the user to Theoretical instead of the
    // generic "clear a higher stage" banner (which doesn't apply — the stages exist, just unfarmed).
    if (mode === "practical") return <PracticalEmptyHint t={t} onSwitch={onSwitchToTheoretical} />;
    return (
      <Banner tone="warn" icon={<TriangleAlert className="size-3.5" />}>
        {t("planner.noFarmStage", { level: hero.level })}
      </Banner>
    );
  }

  const best = ranked[0];
  // The Next Level tab is a DECISION view — show the 5 fastest by default, with a "show all" so
  // measured (● your runs) stages that sit below the top 5 stay reachable (review: don't hide them).
  const VISIBLE = 5;
  const shown = showAll ? ranked : ranked.slice(0, VISIBLE);
  const gatingLabel = gating && gatingHeroKey != null ? heroClassOf(inputs.team, gatingHeroKey) : null;

  return (
    <div>
      <div className="mb-2 flex items-end justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-brand-400">{t("planner.nextLevelUp")}</div>
          <div className="text-base font-bold leading-tight text-white">
            {t("planner.nextLevelJump", { from: hero.level, to: hero.level + 1 })}
            {gatingLabel && (
              <span className="ml-1.5 align-middle text-[10px] font-medium text-zinc-500">
                · {gatingLabel} ({t("planner.gatingHero")})
              </span>
            )}
          </div>
        </div>
        <div className="text-right text-[11px] text-zinc-400">
          {t("planner.nextBestRoute")}
          <div className="font-mono text-sm font-bold text-white">{formatEta(best.seconds)}</div>
        </div>
      </div>
      <p className="mb-2 text-[11px] text-zinc-500">{t("planner.nextWhereToFarm")}</p>

      <div className="flex flex-col gap-1.5">
        {shown.map((r, i) => (
          <div
            key={r.stageKey}
            className={cn(
              "grid grid-cols-[18px_1fr_auto_auto] items-center gap-2.5 rounded-lg border px-2.5 py-2",
              i === 0
                ? "border-emerald-500/30 bg-emerald-500/[0.07]"
                : "border-surface-700 bg-surface-800/40",
            )}
          >
            <span
              className={cn(
                "flex size-[18px] items-center justify-center rounded font-mono text-[10px] font-bold",
                i === 0 ? "bg-emerald-400 text-emerald-950" : "bg-surface-600 text-zinc-400",
              )}
            >
              {i + 1}
            </span>
            <StageCell stageKey={r.stageKey} stageLevel={r.stageLevel} />
            <span className="text-right font-mono text-[13px] font-semibold text-white">
              {r.source === "estimated" ? "~" : ""}
              {formatEta(r.seconds)}
            </span>
            <SourceBadge t={t} source={r.source} />
          </div>
        ))}
      </div>
      {ranked.length > VISIBLE && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-2 cursor-pointer text-[11px] font-medium text-zinc-400 transition-colors hover:text-zinc-200"
        >
          {showAll ? t("planner.showFewer") : t("planner.showAllStages", { n: ranked.length })}
        </button>
      )}
    </div>
  );
}

// ── Full Climb tab — the band schedule to target ─────────────────────────────────────────────

type Computed =
  | { kind: "hero"; plan: ReturnType<typeof singleHeroClimb>; hero: ClimbHero; cands: ClimbCandidate[] }
  | { kind: "team"; teamPlan: ReturnType<typeof teamClimb> };

function FullClimbTab({
  t,
  inputs,
  computed,
  target,
  climbers,
  subject,
  showPerHero,
  onTogglePerHero,
  mode,
  onSwitchToTheoretical,
}: {
  t: Translate;
  inputs: PlannerInputs;
  computed: Computed;
  target: number;
  climbers: AnchorHero[];
  subject: Subject;
  showPerHero: boolean;
  onTogglePerHero: () => void;
  mode: PlanMode;
  onSwitchToTheoretical: () => void;
}) {
  const bands: (PlanBand | TeamPlanBand)[] =
    computed.kind === "team" ? computed.teamPlan.bands : computed.plan.bands;
  const totalSeconds = computed.kind === "team" ? computed.teamPlan.totalSeconds : computed.plan.totalSeconds;
  const status = computed.kind === "team" ? computed.teamPlan.status : computed.plan.status;

  if (status === "no-farmable-stage") {
    // Practical with no farmed stages → guide to Theoretical; theoretical keeps the generic banner.
    if (mode === "practical") return <PracticalEmptyHint t={t} onSwitch={onSwitchToTheoretical} />;
    return (
      <Banner tone="warn" icon={<TriangleAlert className="size-3.5" />}>
        {t("planner.noFarmStage", {
          level: subject.kind === "hero" ? climberLevel(climbers, subject.heroKey) : target,
        })}
      </Banner>
    );
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-xs font-semibold text-zinc-300">
          {t("planner.climbTo", { target })}
        </span>
        <span className="font-mono text-[11px] text-zinc-500">
          {t("planner.climbTotal", { time: formatEta(totalSeconds), dps: humanizeDps(inputs.partyDpsNow) })}
        </span>
      </div>

      <BandTable t={t} bands={bands} />

      {/* gated-by (team only) */}
      {computed.kind === "team" && computed.teamPlan.gatedByHeroKey != null && status === "ok" && (
        <p className="mt-2 text-[11px] text-zinc-500">
          {t("planner.gatedBy", { hero: heroLabel(computed.teamPlan.gatedByHeroKey, inputs.team) })}
        </p>
      )}

      {/* per-hero breakdown (team only) */}
      {computed.kind === "team" && (
        <div className="mt-3">
          <button
            type="button"
            onClick={onTogglePerHero}
            className="flex cursor-pointer items-center gap-1 text-xs font-medium text-zinc-400 hover:text-zinc-200"
          >
            {showPerHero ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            {t("planner.perHeroBreakdown")}
          </button>
          {showPerHero && (
            <div className="mt-2 flex flex-col gap-3 border-l border-surface-700 pl-3">
              {computed.teamPlan.perHero.map((hp) => {
                const finish = computed.teamPlan.perHeroFinishSeconds[hp.heroKey];
                return (
                  <div key={hp.heroKey}>
                    <div className="mb-1 flex items-baseline gap-2">
                      <span className="text-xs font-semibold text-zinc-200">{heroLabel(hp.heroKey, inputs.team)}</span>
                      <span className="text-[11px] text-zinc-500">{formatEta(finish ?? hp.totalSeconds)}</span>
                    </div>
                    {hp.status === "ok" ? (
                      <BandTable t={t} bands={hp.bands} compact />
                    ) : (
                      <span className="text-[11px] text-zinc-500">
                        {hp.status === "already-at-target"
                          ? t("planner.alreadyThere")
                          : t("planner.noFarmStage", { level: climberLevel(climbers, hp.heroKey) })}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── the band schedule table ──────────────────────────────────────────────────────────────────

function BandTable({
  t,
  bands,
  compact,
}: {
  t: Translate;
  bands: (PlanBand | TeamPlanBand)[];
  compact?: boolean;
}) {
  if (bands.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded border border-surface-700">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-surface-700 bg-surface-800/60 text-left text-[10px] uppercase tracking-wide text-zinc-500">
            <th className="px-2 py-1 font-medium">{t("planner.colLevels")}</th>
            <th className="px-2 py-1 font-medium">{t("planner.colStage")}</th>
            <th className="px-2 py-1 text-right font-medium">{t("planner.colTime")}</th>
            {!compact && <th className="px-2 py-1 font-medium">{t("planner.colSource")}</th>}
          </tr>
        </thead>
        <tbody>
          {bands.map((b, i) => (
            <tr key={`${b.fromLevel}-${i}`} className="border-b border-surface-700/50 last:border-0">
              <td className="whitespace-nowrap px-2 py-1.5 font-mono tabular-nums text-zinc-300">
                {b.fromLevel} → {b.toLevel}
              </td>
              <td className="whitespace-nowrap px-2 py-1.5">
                <StageCell stageKey={b.stageKey} stageLevel={b.stageLevel} />
              </td>
              <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono tabular-nums text-zinc-300">
                {b.source === "estimated" ? "~" : ""}
                {formatEta(b.seconds)}
              </td>
              {!compact && (
                <td className="px-2 py-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <SourceBadge t={t} source={b.source} />
                    {b.keepConfidence === "approx" && <KeepWarnBadge t={t} />}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The stage code + difficulty + (Lstagelevel) cell, shared by the band table and the next-level list. */
function StageCell({ stageKey, stageLevel }: { stageKey: number; stageLevel: number }) {
  const code = stageCode(stageKey) ?? `#${stageKey}`;
  const mode = stageDifficulty(stageKey);
  return (
    <span className="text-xs">
      <span className="font-semibold text-zinc-100">{code}</span>{" "}
      {mode && <span className={cn("text-[10px] font-bold uppercase", modeTextClass(mode))}>{mode}</span>}
      <span className="ml-1 font-mono text-[10px] text-zinc-600">L{stageLevel}</span>
    </span>
  );
}

// ── badges ────────────────────────────────────────────────────────────────────────────────

const SOURCE_GLYPH: Record<CandidateSource, string> = { measured: "●", estimated: "◔" };

function SourceBadge({ t, source }: { t: Translate; source: CandidateSource }) {
  const measured = source === "measured";
  return (
    <span
      title={measured ? t("planner.srcMeasuredTip") : t("planner.srcEstimatedTip")}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap text-[10px]",
        measured ? "text-emerald-400" : "text-amber-300",
      )}
    >
      <span aria-hidden>{SOURCE_GLYPH[source]}</span>
      {measured ? t("planner.srcMeasured") : t("planner.srcEstimated")}
    </span>
  );
}

/** The lone keep caveat that survives the rework: a small "above your level" warning on under-level
 *  bands (gap < 0), where the keep model is unvalidated. */
function KeepWarnBadge({ t }: { t: Translate }) {
  return (
    <span title={t("planner.keepApproxTip")} className="inline-flex items-center gap-1 text-[10px] text-amber-300">
      <TriangleAlert className="size-3" />
      {t("planner.keepApprox")}
    </span>
  );
}

function SourceFootnote({ t }: { t: Translate }) {
  return (
    <p className="mt-3 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-zinc-500">
      <Info className="mt-px size-3 shrink-0" />
      <span>{t("planner.footMeasuredVsEstimated")}</span>
    </p>
  );
}

/** Practical mode found no farmed stages for the chosen hero — a hint (not the generic noFarmStage
 *  banner) with an inline, clickable "Theoretical" that flips the mode. */
function PracticalEmptyHint({ t, onSwitch }: { t: Translate; onSwitch: () => void }) {
  return (
    <div className="flex items-start gap-1.5 rounded bg-surface-800/70 px-2 py-1.5 text-[11px] leading-snug text-zinc-400">
      <Info className="mt-px size-3.5 shrink-0" />
      <span>
        {t("planner.practicalEmpty")}{" "}
        <button
          type="button"
          onClick={onSwitch}
          className="cursor-pointer font-semibold text-brand-400 underline-offset-2 hover:underline"
        >
          {t("planner.modeTheoretical")}
        </button>
        .
      </span>
    </div>
  );
}

function Banner({ tone, icon, children }: { tone: "info" | "warn"; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-start gap-1.5 rounded px-2 py-1 text-[11px] leading-snug",
        tone === "warn" ? "bg-amber-500/10 text-amber-300" : "bg-surface-800/70 text-zinc-400",
      )}
    >
      <span className="mt-px shrink-0">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

// ── how it works ─────────────────────────────────────────────────────────────────────────────

function HowItWorks({ t }: { t: Translate }) {
  return (
    <div className="rounded-lg border border-surface-700 bg-surface-800/60 px-3.5 py-3">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-zinc-500">{t("planner.howTitle")}</div>
      <ol className="flex list-decimal flex-col gap-1.5 pl-4 text-[11.5px] text-zinc-400 marker:text-zinc-600">
        <li>{t("planner.how1")}</li>
        <li>{t("planner.how2")}</li>
        <li>{t("planner.how3")}</li>
      </ol>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────

function humanizeDps(dps: number): string {
  if (dps >= 1e6) return `${(dps / 1e6).toFixed(1)}M`;
  if (dps >= 1e3) return `${(dps / 1e3).toFixed(0)}k`;
  return String(Math.round(dps));
}

function heroClassOf(team: AnchorHero[], heroKey: number): string {
  return team.find((h) => h.heroKey === heroKey)?.class ?? heroName(heroKey);
}

function heroLabel(heroKey: number, team: AnchorHero[]): string {
  const h = team.find((x) => x.heroKey === heroKey);
  return h ? h.class : heroName(heroKey);
}

function climberLevel(climbers: AnchorHero[], heroKey: number): number {
  return climbers.find((h) => h.heroKey === heroKey)?.level ?? 0;
}
