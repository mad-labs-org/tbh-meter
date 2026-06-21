import { useState, useEffect } from "react";
import { ListHeader } from "~/components/Header";
import type { ListTab } from "~/components/Header";
import type { AppSettings } from "../../shared/ipc-types.js";
import { DEFAULT_SETTINGS } from "../../shared/ipc-types.js";
import { RunListView } from "~/views/RunListView";
import { RunDetailView } from "~/views/RunDetailView";
import { SettingsView } from "~/views/SettingsView";
import { CooldownsView } from "~/views/CooldownsView";
import { PlannerView } from "~/views/PlannerView";
import { SignInPromptModal } from "~/components/SignInPromptModal";

export default function ListApp() {
  const [activeTab, setActiveTab] = useState<ListTab>("runs");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    window.meter.getSettings().then(setSettings);
    // Main can change settings on its own (e.g. dragging the live strip turns
    // follow-game off) — keep this window's copy in sync.
    return window.meter.onSettingsChanged(setSettings);
  }, []);

  const handleSettingsChange = (partial: Partial<AppSettings>) => {
    setSettings((s) => ({ ...s, ...partial }));
    window.meter.setSettings(partial);
  };

  const handleTabChange = (tab: ListTab) => {
    setActiveTab(tab);
    if (tab !== "runs") setSelectedRunId(null);
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-surface-900 text-white">
      <ListHeader
        activeTab={activeTab}
        onTabChange={handleTabChange}
        onClose={() => window.meter.windowControls.close()}
      />

      <main className="flex flex-1 overflow-hidden">
        {activeTab === "runs" &&
          (selectedRunId ? (
            <RunDetailView runId={selectedRunId} onBack={() => setSelectedRunId(null)} />
          ) : (
            <RunListView
              onSelectRun={setSelectedRunId}
              runColumns={settings.runColumns}
              onRunColumnsChange={(cols) => handleSettingsChange({ runColumns: cols })}
              hideNonCounted={settings.hideNonCounted}
              minDurationSec={settings.minDurationSec}
              onToggleHideNonCounted={() =>
                handleSettingsChange({ hideNonCounted: !settings.hideNonCounted })
              }
              onClearDurationFilter={() => handleSettingsChange({ minDurationSec: null })}
            />
          ))}
        {activeTab === "cooldowns" && <CooldownsView />}
        {activeTab === "planner" && <PlannerView />}
        {activeTab === "settings" && (
          <SettingsView settings={settings} onSettingsChange={handleSettingsChange} />
        )}
      </main>

      <SignInPromptModal />
    </div>
  );
}
