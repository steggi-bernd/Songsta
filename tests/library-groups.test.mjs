// Groups that fold, as Discord folds servers (src/lib/libraryGroups.ts, one copy for both apps):
// the library's (albums and playlists) and Explore's own (albums, artists, genres).
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const out = await build({ entryPoints: [fileURLToPath(new URL("../src/lib/libraryGroups.ts", import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
const { arrangeGroups, groupOf, newGroupName, readExploreGroups, readGroups, withGroupNamed, withItemIn, withItemMoved, withItemOut, withNewGroup, withoutGroup } = await import(
  `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`
);

const ids = (groups, id) => groups.find((g) => g.id === id)?.items;

test("two things make a group; each is only ever in one", () => {
  let groups = withNewGroup([], "g1", " Live ", ["album:a", "playlist:p"]);
  assert.deepEqual(groups, [{ id: "g1", name: "Live", items: ["album:a", "playlist:p"] }]);
  groups = withNewGroup(groups, "g2", "Studio", ["playlist:p", "album:c", "album:c"]);
  assert.equal(groupOf(groups, "playlist:p")?.id, "g2", "the playlist moved over");
  assert.deepEqual(ids(groups, "g1"), ["album:a"]);
  assert.deepEqual(ids(groups, "g2"), ["playlist:p", "album:c"], "each once");
});

test("put in a group: at the end, or next to one of its items; out of the group it was in", () => {
  let groups = [
    { id: "g1", name: "One", items: ["album:a"] },
    { id: "g2", name: "Two", items: ["album:b", "album:c"] },
  ];
  groups = withItemIn(groups, "g2", "album:a");
  assert.deepEqual(groups, [{ id: "g2", name: "Two", items: ["album:b", "album:c", "album:a"] }], "the group left empty goes");
  assert.deepEqual(ids(withItemIn(groups, "g2", "playlist:p", { before: "album:c" }), "g2"), ["album:b", "playlist:p", "album:c", "album:a"]);
  assert.deepEqual(ids(withItemIn(groups, "g2", "playlist:p", { after: "album:b" }), "g2"), ["album:b", "playlist:p", "album:c", "album:a"]);
  assert.deepEqual(ids(withItemIn(groups, "g2", "playlist:p", { before: "gone" }), "g2"), ["album:b", "album:c", "album:a", "playlist:p"], "an anchor it doesn't have: the end");
  assert.deepEqual(withItemIn(groups, "nope", "album:x"), groups, "no such group");
});

test("a group's own order: moved inside it by putting it in again", () => {
  const groups = [{ id: "g", name: "G", items: ["a", "b", "c", "d"] }];
  assert.deepEqual(ids(withItemIn(groups, "g", "d", { before: "a" }), "g"), ["d", "a", "b", "c"]);
  assert.deepEqual(ids(withItemIn(groups, "g", "a", { after: "c" }), "g"), ["b", "c", "a", "d"]);
  assert.deepEqual(ids(withItemIn(groups, "g", "b", { before: "b" }), "g"), ["a", "b", "c", "d"], "dropped on itself, nothing moves");
  assert.deepEqual(ids(withItemIn(groups, "g", "a"), "g"), ["b", "c", "d", "a"], "without a place: to the end");
});

test("one place up or down, past what's shown only", () => {
  const groups = [{ id: "g", name: "G", items: ["a", "x", "b", "c"] }];
  const shown = (k) => k !== "x";
  assert.deepEqual(ids(withItemMoved(groups, "a", 1, shown), "g"), ["x", "b", "a", "c"], "past the hidden one too");
  assert.deepEqual(ids(withItemMoved(groups, "b", -1, shown), "g"), ["b", "a", "x", "c"]);
  assert.deepEqual(ids(withItemMoved(groups, "a", -1, shown), "g"), ["a", "x", "b", "c"], "first already");
  assert.deepEqual(ids(withItemMoved(groups, "c", 1, shown), "g"), ["a", "x", "b", "c"], "last already");
  assert.deepEqual(ids(withItemMoved(groups, "b", 1), "g"), ["a", "x", "c", "b"]);
});

test("taken out, renamed, dissolved", () => {
  const groups = [{ id: "g1", name: "One", items: ["a", "b"] }];
  assert.deepEqual(withItemOut(groups, "a"), [{ id: "g1", name: "One", items: ["b"] }]);
  assert.deepEqual(withItemOut(withItemOut(groups, "a"), "b"), [], "the last one out, the group goes");
  assert.equal(withGroupNamed(groups, "g1", "  Live  ")[0].name, "Live");
  assert.equal(withGroupNamed(groups, "g1", "   ")[0].name, "One", "no empty names");
  assert.deepEqual(withoutGroup(groups, "g1"), []);
});

test("a new group's name nobody has yet", () => {
  const named = (n) => `Group ${n}`;
  assert.equal(newGroupName([], named), "Group 1");
  assert.equal(newGroupName([{ id: "a", name: "Group 2", items: ["x"] }], named), "Group 3");
  assert.equal(newGroupName([{ id: "a", name: "Mine", items: ["x"] }, { id: "b", name: "Group 3", items: ["y"] }], named), "Group 4");
});

test("arranged: a group stands where its first member would, its members in the group's own order", () => {
  const entries = ["playlist:p", "album:a", "album:b", "album:c", "album:d"].map((key) => ({ key }));
  const groups = [
    { id: "g1", name: "One", items: ["album:c", "playlist:gone", "album:a"] },
    { id: "g2", name: "Two", items: ["album:zz"] },
  ];
  const order = arrangeGroups(groups, entries, (e) => e.key);
  assert.deepEqual(
    order.map((o) => ("group" in o ? `[${o.group.id}: ${o.members.map((m) => m.key).join(", ")}]` : o.entry.key)),
    ["playlist:p", "[g1: album:c, album:a]", "album:b", "album:d"],
    "g1 where album:a would be, in its own order; what the list doesn't have isn't shown, nor a group with none of it"
  );
});

test("arranged under a filter: only the members the list shows", () => {
  const groups = [{ id: "g", name: "G", items: ["album:a", "playlist:p"] }];
  const order = arrangeGroups(groups, [{ key: "playlist:p" }], (e) => e.key);
  assert.deepEqual(order, [{ group: groups[0], members: [{ key: "playlist:p" }] }]);
});

test("read with care: broken entries left out, an item in one group only, the albums-only test builds come along", () => {
  assert.deepEqual(readGroups(null), []);
  assert.deepEqual(readGroups("x"), []);
  assert.deepEqual(
    readGroups([
      { id: "old", name: "Old", albums: ["lp1", "lp2"] },
      { id: "new", name: " New ", items: ["album:lp2", "playlist:p", 3, ""] },
      { id: "new", name: "Twice", items: ["album:z"] },
      { id: "empty", name: "Empty", items: [] },
      { id: "nameless", name: "  ", items: ["album:q"] },
      { name: "No id", items: ["album:r"] },
      null,
    ]),
    [
      { id: "old", name: "Old", items: ["album:lp1", "album:lp2"] },
      { id: "new", name: "New", items: ["playlist:p"] },
    ]
  );
  assert.deepEqual(readExploreGroups({ albums: [{ id: "g", name: "G", items: ["album:a"] }], artists: "x" }), {
    albums: [{ id: "g", name: "G", items: ["album:a"] }],
    artists: [],
    genres: [],
  });
  assert.deepEqual(readExploreGroups(undefined), { albums: [], artists: [], genres: [] });
});
