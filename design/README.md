# Songsta design exploration · Replay, help and genre graph

This branch holds **design artifacts only**. They are not wired into the running app and do not change production localization.

## Included

- `design/replay-copy.en-de.json`: 20 conditional replay text variations in German and English, with sample triggers. Thresholds are proposed, not validated.
- `design/device-help.en-de.json`: approachable, short help flows for network TV, Bluetooth, Echo/Fire TV and missing devices.
- `design/genre-graph.json`: extensive **684-genre** directed acyclic classification with **21 top-level families**, weighted cross-genre proximity, 100+ hybrid parent relationships and aliases.

## Integration plan

1. Keep separate stable genre IDs from localized display names. Do **not** translate keys, and do **not** treat multi-genre tags as a single genre.
2. Normalize a raw track tag against `aliases` and `name`; preserve unmatched raw values for searching and later mapping. Handle composite labels like "Hip-Hop/Rap" without incorrectly splitting established terms.
3. Use the first listed parent as the navigation family tree and extra parents as crossover semantics. `related` is a **symmetric curated affinity**, not a parent or proof of historical origin. These links are editorial, not acoustically measured.
4. When making a mix, start with tracks matching the exact selected genre, then children, then curated neighbors if the pool is too small. Weigh source confidence, measured tempo/key/energy, historical skips, diversity of artist and album, and available copies.
5. No invented tracks, no recommendations outside the user's library, no auto-relabeling an album solely from a related genre. Avoid overrepresenting a single artist. For small pools, label a selection instead of promising a fully curated mix.
6. Run duplicate/alias collision, DAG cycle, orphan, schema, and bidirectional-neighbor checks before publishing database updates.
7. Replay: choose each headline from real period stats, enforce minimum sample size, and seed the choice from period ID to keep it stable. Use **whole translations** rather than translated sentence fragments. Introduce different period headlines for month/year/all-time.
8. Tutorials should show the correct instructions for the current platform and device capabilities (Bluetooth is paired in the OS, while DLNA/Google Cast are found through network discovery).
9. Use `src/lib/genres.ts` and `src/lib/albumGenres.ts` as integration entry points, `src/lib/mixes.ts` for mix selection and `src/lib/flowOrder.ts` for ordering. Mobile imports common logic from `mobile/src/shared.ts`.

## Editorial cautions

This is a large practical browsing taxonomy, **not a definitive academic genealogy**. Some terms denote movements, regions, scenes or use-cases rather than narrow musical styles. Examples include K-Pop, soundtrack, worship, and regional traditions. Their placement is optimized for usable navigation, not an assertion of exclusive parentage. Rare and niche genre relationships should be reviewed against specialist references and users' actual collections before relying heavily on them.

Proposed cross-family similarity weights are editorial defaults that should be tuned using the user's own library and skip/listen behavior. A curated related link never certifies that two tracks sound similar.
