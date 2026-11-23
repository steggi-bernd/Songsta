# Songsta · Genre enrichment / improved classification (design v1)

**Status:** Proposed architecture. No live library, tags or production code are changed.

## What is already in Songsta

- `src/lib/genres.ts` normalizes a few spellings, splits joined genre tags and maps one genre into one of 12 families using regular expressions.
- `electron/album-genres.ts` looks up albums online; `electron/metadata.ts:lookupAlbumGenres()` searches MusicBrainz release groups by album title/artist, accepts a high-scoring match, obtains community genre votes and can follow a Wikidata link for P136 genre values. This happens in a rate-limited queue, cached locally.
- `src/lib/albumGenres.ts` votes between local track tags, MusicBrainz album genre votes and Wikidata album genres; keeps up to three genres **per album**. `genresOfTrack()` returns these album genre results in preference to the track's own genre field. A hybrid or varied compilation may be inaccurately assigned one album-wide genre.
- `mobile/src/replayStory.ts:storyFacts()` takes just `splitGenres(facts.genre)[0]` for mobile Replay statistics. Other tags receive no credit.
- `src/lib/mixes.ts` makes genre mixes only from tracks matching the tags returned by the supplied genre getter; these pools do not yet expand into related genres.
- `src/lib/flowOrder.ts` and `src/lib/soundMatch.ts` already have tempo, key and energy logic for ordering candidate songs. These measure *sound properties*, not definitive genres.
- `src/types.ts:Track` presently contains `genre?: string` but no first-class MusicBrainz recording or release-group IDs.

## Proposed separation: taxonomy vs evidence vs recommendations

1. **Genre taxonomy** `design/genre-graph.json`: stable genre IDs, multilingual display labels, aliases, navigation parents, crossover parents and *related* edges. It is editorial knowledge, not a classification of a user's tracks.
2. **Genre evidence**: multiple sourced genre claims per **track**, **release group** and **artist** with exact source, timestamp and confidence.
3. **Track classification**: the ranked merged result of (1) and (2), including the user's overrides.
4. **Recommendation expansion**: use genre graph neighbors **only** when selecting related songs; do not relabel a track as Trip-Hop because its real genre is adjacent to Trip-Hop.

## Source recommendations (start with the most reliable and easiest)

| Source | Practical use | Level / reliability | Limits and compliance |
| --- | --- | --- | --- |
| Existing tags (local FLAC/MP3, Jellyfin/Navidrome) | Read genre arrays and MusicBrainz IDs; preserve raw tags | Song, album | Do not overwrite files by default. Normalize aliases but keep originals. |
| MusicBrainz genre and tag API | Recording > release/release-group > artist fallback, with vote counts | Strong if exact MusicBrainz ID; weaker by fuzzy names | Roughly 1 request per second average for public API; identify app through User-Agent. Metadata licensing differs for core vs supplementary fields, notably genre/tag contributions. |
| Wikidata | P136 on matched album/recording/artist entity, linked IDs | Useful corroboration, sporadic coverage | Structured data CC0; do not overfetch or perform huge live SPARQL lookups for every track. |
| AcoustID/Chromaprint | Identify local audio as a recording when title/artist or IDs are missing | Identity, NOT genre | Fingerprint is uploaded for match; ask user before online lookup and check commercial API conditions. |
| Last.fm top tags | Album/track/artist tags; potential genre candidates after filtering | Especially useful for popular music, noisy user tags | Requires API key; non-commercial default, attribution and other API terms; make an **optional source only after policy review**. |
| Discogs styles | Specific release styles with good subgenre coverage | Release, style | Discogs API mixes CC0 and restricted data, with strong caching, attribution and usage conditions. **Not a default source** until legal/operational fit is settled. |
| Essentia + genre model | Local multi-label audio genre/mood prediction, useful for obscure or untagged files | Audio-derived probability, not fact | Main Essentia library AGPLv3 / proprietary licensing options; many MTG models CC BY-NC-SA 4.0. Confirm licenses before bundling or distributing. |
| Historical AcousticBrainz | Some available precomputed features | Older, uneven coverage | Project stopped collecting data in 2022; don't design a new real-time dependency around it. |

Official links:
- https://musicbrainz.org/doc/MusicBrainz_API and https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting
- https://musicbrainz.org/doc/About/Data_License
- https://www.wikidata.org/wiki/Wikidata:Licensing
- https://acoustid.org/ and https://acoustid.org/webservice
- https://www.last.fm/api/show/track.getTopTags and https://www.last.fm/api/tos
- https://support.discogs.com/hc/en-us/articles/360009334593-API-Terms-of-Use
- https://essentia.upf.edu/models.html and https://essentia.upf.edu/licensing_information.html
- https://acousticbrainz.org/

## Provenance data model

```ts
type GenreSource =
  | 'user-override'
  | 'embedded-track'
  | 'musicbrainz-recording'
  | 'musicbrainz-release-group'
  | 'wikidata'
  | 'lastfm-track'
  | 'lastfm-artist'
  | 'audio-model';

type GenreClaim = {
  trackId?: string;
  recordingMbid?: string;
  releaseGroupMbid?: string;
  genreId: string;
  source: GenreSource;
  score: number;             // 0–1, source-specific, calibrated
  verifiedMatch?: boolean;   // metadata entity matching confidence
  fetchedAt?: number;
  rawLabel?: string;         // preserve the original
};

type SongGenreProfile = {
  trackId: string;
  primary?: string;
  secondary: string[];
  evidence: GenreClaim[];
  confidence: number;
  explicitUserGenres?: string[];
  unmappedRawGenres: string[];
};
```

Store these in Songsta's **local catalogue index**, separately from audio files. User tags and overrides can survive a re-scan. Optionally offer a deliberate "write tags into my files" action with a preview and backup warning.

## Matching pipeline

1. Read `GENRE` and relevant MusicBrainz IDs (recording, release, release group), where present, from the library source. Avoid destructively splitting established slash names.
2. Use exact MBIDs first. Otherwise search release group by artist+album+year and recording by artist+title+duration; accept only well-supported matches. Keep ambiguous matches unknown instead of selecting a likely wrong artist with a common name.
3. Fetch genre votes and folksonomy tags for the **recording first** where available, followed by release group and artist. Respect public API quotas.
4. Obtain Wikidata genre signals when linked to a matched entity; treat broad styles as coarse evidence rather than a second precise vote.
5. Map **genre names to canonical IDs** using the taxonomy's aliases and explicit mappings; preserve unknown labels for future mapping.
6. Merge evidence per track with transparent source weighting. Example starting priorities: explicit user override > embedded track genre / verified recording > verified release-group > artist fallback. Scores are heuristic seeds only and must be tuned against real collections.
7. Keep up to 3–5 reasonable genre labels. Store a primary + secondary genres and confidence. Don't automatically assign 5 labels just to fill slots.
8. Use conditional precedence: a more specific and reliable track label is **not replaced** by broad album labels; compilation albums should generally emphasize track-level evidence.
9. Record source provenance and explanation, e.g. "Trip-Hop – file tag + MusicBrainz recording". Offer user confirmation/rejection and "Don't suggest this genre for this track".
10. Recompute genre index when metadata or graph version changes, not on every song playback.

## Classification vs recommendations

- **Classification:** A recording tagged Trip-Hop stays Trip-Hop, even if Downtempo is its closest neighbor. The album and artist can have broader category labels without changing the track.
- **Genre-page expansion:** Search exact genre tracks first, descendants second, closely related genres third; show users when songs were brought in through a neighboring genre.
- **Smart playlists:** Begin with high-confidence matches, optionally widen once the list has too few tracks. Existing `flowOrder` can sequence by tempo/key/energy; avoid repeating the same artist.
- **Search:** Index `genreId`, its parents, synonyms, local raw labels, and optionally accents/transliterations. Keep searchable source and role distinct so asking for `jazz` needn't mislabel `jazz rap` as pure jazz.
- **Replay:** Only show specific genre claims when a meaningful share of listening minutes have *reliable* genre labels. Track-level multi-genre durations may contribute fractionally (e.g. two tags at 0.5 each), so genre shares cannot exceed 100%.
- **Do not use a track's related genres to inflate Replay genre counts.** Relatedness is an exploration tool, not evidence of classification.

## Proposed privacy / UX

- "Genre-Erkennung verbessern" on/off; explain online artist, album and track metadata are sent to providers **only when online matching is enabled**.
- Separate consent for audio fingerprint lookups; no upload of the complete audio file. Audio-model inference should be entirely on-device where feasible.
- Show progress and number of recognized vs remaining tracks; support retry and cancellation.
- "Warum dieses Genre?" shows source, confidence, editable assignment.
- "Unsicher" remains a valid state, not automatically "Other".
- A single "genre quality" report: % classified tracks, % listened minutes with credible tags, % track-level vs album-only, % disputed tags, and a list to review.

## Sensible roll-out

**Milestone A — correctness:** consume the existing 684-node graph, fix `genresOfTrack` track-vs-album precedence, fix mobile first-genre-only handling, add provenance/confidence, preserve unknown tags. No new online providers.

**Milestone B — richer online metadata:** harvest MusicBrainz IDs, recording-level genres, robust matching, and Wikidata. Keep rate limits, incremental queue and local cache; test on a curated sample before processing the full library.

**Milestone C — recommendation engine:** make mix generation genre graph aware while retaining strict "only from own library" semantics. Add genre search, neighbor explanations, user confirmation and curated seed mixes.

**Milestone D — optional sources:** Last.fm for suitable use cases and permissions; local ML tagging for remaining unclassified songs if model/license footprint is acceptable. Discogs only if API conditions can actually be met.

## Acceptance criteria

- Every saved genre link resolves to a known taxonomy ID, or explicitly remains unmapped.
- No graph cycles, orphaned parents or duplicate/conflicting synonyms.
- Track-level specific tags survive broad album metadata.
- Replays never claim genres for low-confidence unknown tracks.
- At least one regression test for compilation albums, genre crossovers, multi-valued tags, identical artist/song names, non-English names and missing metadata.
- Enrichment does **not** mutate user's media files without explicit approval.
- All online providers follow opt-in privacy controls, attribution, cache, rate limits and licensing requirements.
