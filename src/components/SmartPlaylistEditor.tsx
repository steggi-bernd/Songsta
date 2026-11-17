/**
 * Smart playlist editor: name, all/any, one row per rule (field · comparison
 * · value), sort order and song cap, with a live count of matching songs.
 * New playlists can start from a preset. Opened from the create menu, the
 * sidebar and the smart playlist page through useSmartEditor.
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Sparkles, X } from "lucide-react";
import { create } from "zustand";
import { FIELDS, OP_LABEL, SMART_PRESETS, SORT_LABEL, evaluateSmartPlaylist } from "../lib/smartPlaylists";
import { useCatalog } from "../stores/catalog";
import { useLibrary } from "../stores/library";
import { soundOf, useSound } from "../stores/sound";
import { useSmartPlaylists, type RuleField, type SmartPlaylist, type SmartRule, type SmartSort } from "../stores/smartPlaylists";
import { useUI } from "../stores/ui";
import { T } from "../lib/i18n";

interface EditorState {
  editing: SmartPlaylist | null;
  isNew: boolean;
  open(p: SmartPlaylist, isNew: boolean): void;
  close(): void;
}

export const useSmartEditor = create<EditorState>((set) => ({
  editing: null,
  isNew: false,
  open: (p, isNew) => set({ editing: structuredClone(p), isNew }),
  close: () => set({ editing: null }),
}));

const INPUT =
  "h-9 px-3 rounded-lg bg-ink-hi/[0.06] border border-ink-hi/10 text-[13px] text-ink-hi outline-none focus:border-accent/60 transition-colors";

function RuleRow({ rule, onChange, onRemove }: { rule: SmartRule; onChange: (r: SmartRule) => void; onRemove: () => void }) {
  const def = FIELDS[rule.field];
  const setField = (field: RuleField): void => {
    const next = FIELDS[field];
    onChange({ field, op: next.ops[0], value: next.choices?.[0]?.value ?? "", value2: undefined });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select value={rule.field} onChange={(e) => setField(e.target.value as RuleField)} className={`${INPUT} w-[140px]`}>
        {(Object.keys(FIELDS) as RuleField[]).map((f) => (
          <option key={f} value={f}>
            {FIELDS[f].label}
          </option>
        ))}
      </select>
      <select value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as SmartRule["op"] })} className={`${INPUT} w-[150px]`}>
        {def.ops.map((op) => (
          <option key={op} value={op}>
            {T(OP_LABEL[op])}
          </option>
        ))}
      </select>
      {def.kind === "choice" ? (
        <select value={rule.value} onChange={(e) => onChange({ ...rule, value: e.target.value })} className={`${INPUT} w-[160px]`}>
          {def.choices?.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          value={rule.value}
          onChange={(e) => onChange({ ...rule, value: e.target.value })}
          inputMode={def.kind === "text" ? "text" : "decimal"}
          placeholder={def.kind === "text" ? T("e.g. rock") : "0"}
          className={`${INPUT} ${def.kind === "text" ? "w-[180px]" : "w-[90px]"}`}
        />
      )}
      {rule.op === "between" && (
        <>
          <span className="text-[13px] text-ink-dim">{T("and")}</span>
          <input
            value={rule.value2 ?? ""}
            onChange={(e) => onChange({ ...rule, value2: e.target.value })}
            inputMode="decimal"
            className={`${INPUT} w-[90px]`}
          />
        </>
      )}
      {def.unit && <span className="text-[13px] text-ink-dim">{def.unit}</span>}
      <button onClick={onRemove} title={T("Remove rule")} aria-label={T("Remove rule")} className="ml-auto w-8 h-8 grid place-items-center rounded-full text-ink-dim hover:text-ink-hi hover:bg-ink-hi/[0.08]">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

function Editor({ initial, isNew }: { initial: SmartPlaylist; isNew: boolean }) {
  const [sp, setSp] = useState<SmartPlaylist>(initial);
  const close = useSmartEditor((s) => s.close);
  const tracks = useCatalog((s) => s.tracks);
  const counts = useCatalog((s) => s.playCounts);
  const liked = useLibrary((s) => s.liked);
  const likedIds = useMemo(() => new Set(liked.map((t) => t.id)), [liked]);
  const facts = useSound((s) => s.facts);
  const matches = useMemo(() => evaluateSmartPlaylist({ ...sp, sort: "title" }, tracks, counts, likedIds, (t) => soundOf(t, facts)).length, [sp, tracks, counts, likedIds, facts]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  const setRule = (i: number, r: SmartRule): void => setSp((s) => ({ ...s, rules: s.rules.map((x, j) => (j === i ? r : x)) }));
  const save = (): void => {
    const name = sp.name.trim() || T("Smart playlist");
    useSmartPlaylists.getState().save({ ...sp, name });
    close();
    useUI.getState().navigate({ name: "smart", param: sp.id });
  };

  return (
    <div className="fixed inset-0 z-[120] grid place-items-center animate-fade-in" role="dialog" aria-modal="true" aria-label={T("Smart playlist")}>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[3px]" onClick={close} aria-hidden />
      <div className="relative w-[min(720px,calc(100vw-48px))] max-h-[calc(100vh-80px)] overflow-y-auto rounded-2xl glass-strong p-6 animate-pop-in">
        <div className="flex items-center gap-2.5">
          <Sparkles className="w-5 h-5 text-accent" />
          <h2 className="font-display text-lg font-bold tracking-tight text-ink-hi">{isNew ? T("New smart playlist") : T("Edit smart playlist")}</h2>
        </div>

        {isNew && (
          <div className="flex flex-wrap gap-1.5 mt-4">
            {SMART_PRESETS.map((p) => (
              <button
                key={p.name}
                onClick={() => setSp((s) => ({ ...s, name: s.name || p.name, rules: structuredClone(p.rules), sort: p.sort, limit: p.limit }))}
                className="text-[12px] rounded-full px-3 py-1 bg-ink-hi/[0.08] text-ink-hi hover:bg-ink-hi/[0.14] transition-colors"
              >
                {p.name}
              </button>
            ))}
          </div>
        )}

        <input
          autoFocus
          value={sp.name}
          onChange={(e) => setSp((s) => ({ ...s, name: e.target.value }))}
          placeholder={T("Name")}
          className={`${INPUT} w-full mt-4 h-10 text-[14px]`}
        />

        <div className="flex items-center gap-2 mt-5 text-[13px] text-ink-hi/80">{T("Songs that match")}<select value={sp.match} onChange={(e) => setSp((s) => ({ ...s, match: e.target.value as "all" | "any" }))} className={INPUT}>
            <option value="all">{T("all")}</option>
            <option value="any">{T("any")}</option>
          </select>{T("of these rules:")}</div>

        <div className="space-y-2.5 mt-3">
          {sp.rules.map((r, i) => (
            <RuleRow key={i} rule={r} onChange={(nr) => setRule(i, nr)} onRemove={() => setSp((s) => ({ ...s, rules: s.rules.filter((_, j) => j !== i) }))} />
          ))}
          <button
            onClick={() => setSp((s) => ({ ...s, rules: [...s.rules, { field: "artist", op: "contains", value: "" }] }))}
            className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-ink-dim hover:text-ink-hi transition-colors"
          >
            <Plus className="w-4 h-4" />{" "}{T("Add rule")}</button>
        </div>

        <div className="flex flex-wrap items-center gap-3 mt-5 text-[13px] text-ink-hi/80">
          <label className="flex items-center gap-2">{T("Order")}<select value={sp.sort} onChange={(e) => setSp((s) => ({ ...s, sort: e.target.value as SmartSort }))} className={INPUT}>
              {(Object.keys(SORT_LABEL) as SmartSort[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">{T("Limit to")}<input
              value={sp.limit ?? ""}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                setSp((s) => ({ ...s, limit: Number.isFinite(n) && n > 0 ? n : null }));
              }}
              placeholder={T("no limit")}
              inputMode="numeric"
              className={`${INPUT} w-[100px]`}
            />{T("songs")}</label>
        </div>

        <div className="flex items-center justify-between gap-3 mt-6">
          <span className="text-[13px] text-ink-dim">
            {matches} {matches === 1 ? T("song matches") : T("songs match")}
            {sp.limit && matches > sp.limit ? T(" · first {limit} are kept", { limit: sp.limit }) : ""}
          </span>
          <div className="flex items-center gap-2">
            <button onClick={close} className="h-9 px-4 rounded-xl text-[13px] font-semibold text-ink-hi/80 hover:bg-ink-hi/[0.08] transition-colors">{T("Cancel")}</button>
            <button onClick={save} className="h-9 px-4 rounded-xl text-[13px] font-bold bg-primary text-on-primary hover:brightness-110 transition-all">
              {isNew ? T("Create") : T("Save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Mount once (App): renders the editor while one is open. */
export function SmartPlaylistEditorHost() {
  const editing = useSmartEditor((s) => s.editing);
  const isNew = useSmartEditor((s) => s.isNew);
  if (!editing) return null;
  return createPortal(<Editor key={editing.id} initial={editing} isNew={isNew} />, document.body);
}
