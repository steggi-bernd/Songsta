/**
 * Explore's own groups (lib/libraryGroups.ts), apart from the library panel's: one set per tab,
 * made as in Discord. Something dragged onto something else makes a group with it; onto a group,
 * folded or open, it goes in; between a group's own, it takes that place, which is how a group's
 * order changes. The right-click menu does the same. A group stands folded where its first member
 * would, its first covers in a small grid, opens where it stands, and plays all of it, in its own
 * order or shuffled.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, FolderMinus, FolderPlus, Pencil, Play, Plus, Shuffle, Ungroup } from "lucide-react";
import { groupOf, newGroupId, newGroupName, withGroupNamed, withItemIn, withItemOut, withNewGroup, withoutGroup, type ExploreGroups, type Group, type GroupPlace } from "../lib/libraryGroups";
import { useLibraryOrder } from "../stores/libraryOrder";
import { usePlayer } from "../stores/player";
import { trackAvailable } from "../stores/availability";
import { useUI, type MenuItem } from "../stores/ui";
import type { Track } from "../types";
import { PlayOverlay } from "./primitives";
import { T } from "../lib/i18n";

/** Explore's drags stay in Explore: the library panel's groups are others. */
const EXPLORE_MIME = "application/x-bytune-explore-item";

type Drop = "join" | "place" | "pair";

interface Hover {
  /** an item's key, or "group:<id>" */
  target: string;
  drop: Drop;
  /** a place among a group's own: after the target rather than before it */
  after?: boolean;
}

export type ExploreGroupsUi = ReturnType<typeof useExploreGroups>;

/** Everything in a group that can play right now, in the group's order or shuffled. */
function playSongs(group: Group, songs: Track[], shuffled: boolean): void {
  const list = songs.filter((t) => trackAvailable(t));
  if (!list.length) {
    useUI.getState().toast(T("Nothing in “{name}” can play right now", { name: group.name }), "warning");
    return;
  }
  usePlayer.setState({ shuffle: shuffled });
  usePlayer.getState().playAll(list, shuffled);
}

/**
 * One tab's groups and what's done with them. `across`: the tab shows tiles side by side, so a
 * place among a group's own is left or right of a tile rather than above or below a row.
 */
export function useExploreGroups(tab: keyof ExploreGroups, across: boolean) {
  const groups = useLibraryOrder((s) => s.exploreGroups[tab]);
  const now = (): Group[] => useLibraryOrder.getState().exploreGroups[tab];
  const save = (next: Group[]): void => useLibraryOrder.getState().setExploreGroups(tab, next);
  const toast = useUI.getState().toast;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const opening = useRef<number | null>(null);

  const stopOpening = (): void => {
    if (opening.current !== null) window.clearTimeout(opening.current);
    opening.current = null;
  };
  useEffect(() => {
    const clear = (): void => {
      setDrag(null);
      setHover(null);
      stopOpening();
    };
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, []);

  const openGroup = (id: string): void => setOpen((prev) => new Set(prev).add(id));
  const toggle = (id: string): void =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  /** Held over a folded group mid-drag, it opens after a beat, so the drag can go on to a place inside. */
  const openSoon = (id: string): void => {
    if (open.has(id) || opening.current !== null) return;
    opening.current = window.setTimeout(() => {
      opening.current = null;
      openGroup(id);
    }, 650);
  };

  const groupName = (n: number): string => T("Group {count}", { count: n });

  const putIn = (group: Group, key: string, place?: GroupPlace): void => {
    const before = groupOf(now(), key)?.id;
    save(withItemIn(now(), group.id, key, place));
    if (before !== group.id) toast(T("Put in “{name}”", { name: group.name }), "success");
  };

  const pair = (target: string, key: string): void => {
    const id = newGroupId();
    const name = newGroupName(now(), groupName);
    save(withNewGroup(now(), id, name, [target, key]));
    openGroup(id);
    toast(T("Made the group “{name}”", { name }), "success");
  };

  const askNewGroup = (key: string): void => {
    const suggested = newGroupName(now(), groupName);
    useUI.getState().openDialog({
      title: T("New group"),
      body: T("Give your group a name."),
      initialValue: suggested,
      placeholder: T("Group name"),
      confirmLabel: T("Create"),
      onConfirm: (value) => {
        const id = newGroupId();
        save(withNewGroup(now(), id, value.trim() || suggested, [key]));
        openGroup(id);
      },
    });
  };

  const dropOn = (key: string, target: { item?: string; group?: Group; inGroup?: string }): Drop | null => {
    if (target.group) return groupOf(groups, key)?.id !== target.group.id ? "join" : null;
    if (!target.item || target.item === key) return null;
    return target.inGroup ? "place" : "pair";
  };

  const isAfter = (e: React.DragEvent): boolean => {
    const box = e.currentTarget.getBoundingClientRect();
    return across ? e.clientX > box.left + box.width / 2 : e.clientY > box.top + box.height / 2;
  };

  const itemMenu = (e: React.MouseEvent, key: string, extra: MenuItem[] = []): void => {
    e.preventDefault();
    e.stopPropagation();
    const mine = groupOf(now(), key);
    const items: MenuItem[] = [
      ...extra,
      {
        label: T("Add to group"),
        icon: FolderPlus,
        separatorBefore: extra.length > 0,
        children: [
          { label: T("New group…"), icon: Plus, action: () => askNewGroup(key) },
          ...now()
            .filter((g) => g.id !== mine?.id)
            .map((g, i) => ({ label: g.name, separatorBefore: i === 0, action: () => putIn(g, key) })),
        ],
      },
    ];
    if (mine) items.push({ label: T("Take out of “{name}”", { name: mine.name }), icon: FolderMinus, action: () => save(withItemOut(now(), key)) });
    useUI.getState().openContextMenu(e.clientX, e.clientY, items);
  };

  const groupMenu = (e: React.MouseEvent, group: Group, songs: () => Track[]): void => {
    e.preventDefault();
    e.stopPropagation();
    useUI.getState().openContextMenu(e.clientX, e.clientY, [
      { label: T("Play in order"), icon: Play, action: () => playSongs(group, songs(), false) },
      { label: T("Shuffle"), icon: Shuffle, action: () => playSongs(group, songs(), true) },
      {
        label: T("Rename group"),
        icon: Pencil,
        separatorBefore: true,
        action: () =>
          useUI.getState().openDialog({
            title: T("Rename group"),
            initialValue: group.name,
            placeholder: T("Group name"),
            confirmLabel: T("Save"),
            onConfirm: (value) => save(withGroupNamed(now(), group.id, value)),
          }),
      },
      {
        label: T("Dissolve group"),
        icon: Ungroup,
        action: () => {
          save(withoutGroup(now(), group.id));
          toast(T("What was in “{name}” stands on its own again", { name: group.name }));
        },
      },
    ]);
  };

  /** A row or a tile: dragged, dropped on, right-clicked. `extra`: its own menu entries, above the group ones. */
  const itemProps = (key: string, inGroup?: string, extra?: MenuItem[]) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(EXPLORE_MIME, key);
      e.dataTransfer.effectAllowed = "move";
      setDrag(key);
    },
    onDragEnd: () => {
      setDrag(null);
      setHover(null);
    },
    onDragOver: (e: React.DragEvent) => {
      const drop = drag ? dropOn(drag, { item: key, inGroup }) : null;
      if (!drop) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      const after = drop === "place" ? isAfter(e) : undefined;
      setHover((h) => (h?.target === key && h.drop === drop && h.after === after ? h : { target: key, drop, after }));
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setHover((h) => (h?.target === key ? null : h));
    },
    onDrop: (e: React.DragEvent) => {
      const dragged = drag;
      const drop = dragged ? dropOn(dragged, { item: key, inGroup }) : null;
      if (!dragged || !drop) return;
      e.preventDefault();
      e.stopPropagation();
      setDrag(null);
      setHover(null);
      const group = now().find((g) => g.id === inGroup);
      if (drop === "place" && group) putIn(group, dragged, isAfter(e) ? { after: key } : { before: key });
      else if (drop === "pair") pair(key, dragged);
    },
    onContextMenu: (e: React.MouseEvent) => itemMenu(e, key, extra),
  });

  /** A group's row or card: dropped on (it goes in, at the end), right-clicked. */
  const groupProps = (group: Group, songs: () => Track[]) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!drag || dropOn(drag, { group }) !== "join") return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      const target = `group:${group.id}`;
      setHover((h) => (h?.target === target ? h : { target, drop: "join" }));
      openSoon(group.id);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node)) return;
      setHover((h) => (h?.target === `group:${group.id}` ? null : h));
      stopOpening();
    },
    onDrop: (e: React.DragEvent) => {
      const dragged = drag;
      if (!dragged || dropOn(dragged, { group }) !== "join") return;
      e.preventDefault();
      e.stopPropagation();
      stopOpening();
      setDrag(null);
      setHover(null);
      putIn(group, dragged);
    },
    onContextMenu: (e: React.MouseEvent) => groupMenu(e, group, songs),
  });

  /** How a drag shows on a row or a tile: lifted while it's the one dragged, ringed as a new group's partner. */
  const look = (key: string): string =>
    drag === key ? "opacity-40" : hover?.target === key && hover.drop === "pair" ? "ring-2 ring-inset ring-accent/60 bg-ink-hi/[0.06]" : "";
  /** The line where it would land among a group's own. */
  const lineAt = (key: string): "before" | "after" | null => (hover?.target === key && hover.drop === "place" ? (hover.after ? "after" : "before") : null);
  const groupLook = (group: Group): string => (hover?.target === `group:${group.id}` ? "ring-2 ring-inset ring-accent/60 bg-ink-hi/[0.06]" : "");

  return {
    groups,
    isOpen: (id: string) => open.has(id),
    toggle,
    itemProps,
    groupProps,
    look,
    lineAt,
    groupLook,
    play: (group: Group, songs: Track[], shuffled: boolean) => playSongs(group, songs, shuffled),
  };
}

/** A group folded: its first covers in a small grid, the way Discord shows a folder of servers. */
export function GroupCover({ covers, className, round = false }: { covers: string[]; className: string; round?: boolean }) {
  return (
    <span className={`${className} grid grid-cols-2 grid-rows-2 gap-[3px] p-[4px] bg-accent/15`}>
      {covers.slice(0, 4).map((src, i) =>
        src ? (
          <img key={i} src={src} alt="" loading="lazy" decoding="async" className={`w-full h-full max-w-none object-cover ${round ? "rounded-full" : "rounded-[3px]"}`} />
        ) : (
          <span key={i} className={`bg-ink-hi/[0.12] ${round ? "rounded-full" : "rounded-[3px]"}`} />
        )
      )}
    </span>
  );
}

/** The line where something dragged would land: above or below a row, left or right of a tile. */
export function DropLine({ at, across }: { at: "before" | "after" | null; across: boolean }) {
  if (!at) return null;
  const where = across ? (at === "before" ? "left-0 top-3 bottom-3 w-0.5" : "right-0 top-3 bottom-3 w-0.5") : at === "before" ? "left-2 right-2 -top-[1px] h-0.5" : "left-2 right-2 -bottom-[1px] h-0.5";
  return <span aria-hidden className={`pointer-events-none absolute rounded-full bg-accent ${where}`} />;
}

/** A small round button on a group's row or card. */
export function GroupButton({ label, onPress, children }: { label: string; onPress: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      draggable={false}
      onClick={(e) => {
        e.stopPropagation();
        onPress();
      }}
      className="w-8 h-8 grid place-items-center rounded-full text-ink-hi/65 hover:text-ink-hi hover:bg-ink-hi/[0.1] transition-colors"
    >
      {children}
    </button>
  );
}

/** A group in the tiles: its covers, its name and count, its play buttons; a click opens it where it stands. */
export function GroupCard({
  group,
  covers,
  line,
  open,
  ui,
  songs,
  round,
}: {
  group: Group;
  covers: string[];
  line: string;
  open: boolean;
  ui: ExploreGroupsUi;
  songs: () => Track[];
  round?: boolean;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={() => ui.toggle(group.id)}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        ui.toggle(group.id);
      }}
      {...ui.groupProps(group, songs)}
      className={`group relative w-[184px] shrink-0 text-left cursor-pointer select-none rounded-xl p-2 transition-colors duration-200 hover:bg-ink-hi/[0.08] ${open ? "bg-ink-hi/[0.06]" : ""} ${ui.groupLook(group)}`}
    >
      <div className="relative">
        <GroupCover covers={covers} round={round} className="w-full aspect-square rounded-xl" />
        <PlayOverlay title={T("Play in order")} onClick={() => ui.play(group, songs(), false)} />
        <button
          type="button"
          title={T("Shuffle")}
          aria-label={T("Shuffle")}
          onClick={(e) => {
            e.stopPropagation();
            ui.play(group, songs(), true);
          }}
          className="absolute bottom-3 right-16 w-9 h-9 rounded-full bg-black/55 text-white grid place-items-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
        >
          <Shuffle className="w-4 h-4" />
        </button>
      </div>
      <div className="mt-2.5 flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold text-ink-hi truncate leading-snug" title={group.name}>
            {group.name}
          </div>
          <div className="text-[13px] text-ink-dim truncate mt-0.5">{line}</div>
        </div>
        {open ? <ChevronDown className="w-4 h-4 mt-1 text-ink-hi/45 shrink-0" /> : <ChevronRight className="w-4 h-4 mt-1 text-ink-hi/45 shrink-0" />}
      </div>
    </div>
  );
}
