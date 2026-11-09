/**
 * What Explore was showing: tab, layout and every tab's order, remembered as on the desktop; and
 * Explore's own groups, one set per tab, this phone's own (lib/libraryGroups.ts).
 */
import { create } from "zustand";
import { DEFAULT_EXPLORE_SORTS, NO_EXPLORE_GROUPS, readExploreGroups, type ExploreGroups, type ExploreSort, type ExploreTab, type Group } from "../shared";
import { readJson, writeJson } from "../storage";

const FILE = "explore.json";

export type ExploreLayout = "list" | "grid";

interface Saved {
  tab: ExploreTab;
  layout: ExploreLayout;
  sorts: Record<ExploreTab, ExploreSort>;
  groups: ExploreGroups;
}

interface ExploreState extends Saved {
  setTab(tab: ExploreTab): void;
  setLayout(layout: ExploreLayout): void;
  setSort(tab: ExploreTab, sort: ExploreSort): void;
  setGroups(tab: ExploreTab, groups: Group[]): void;
}

export const useExplore = create<ExploreState>((set) => ({
  tab: "albums",
  layout: "grid",
  sorts: DEFAULT_EXPLORE_SORTS,
  groups: NO_EXPLORE_GROUPS,
  setTab: (tab) => set({ tab }),
  setLayout: (layout) => set({ layout }),
  setSort: (tab, sort) => set((s) => ({ sorts: { ...s.sorts, [tab]: sort } })),
  setGroups: (tab, groups) => set((s) => ({ groups: { ...s.groups, [tab]: groups } })),
}));

void readJson<Partial<Saved>>(FILE).then((saved) => {
  if (saved) useExplore.setState({ ...saved, groups: readExploreGroups(saved.groups) });
});
useExplore.subscribe(({ tab, layout, sorts, groups }) => writeJson(FILE, { tab, layout, sorts, groups }));
