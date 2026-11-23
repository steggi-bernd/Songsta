# Songsta: five new languages — first editorial pass

**Branch:** `localization/intl-first-pass-2026-11-23`  
**Status:** Expanded translation draft; **not app-integrated** and **not ready for a release**.

## Scope and coverage

| Locale | Language | Translated existing lookup keys | Base keys | Coverage |
| --- | --- | ---: | ---: | ---: |
| `fr` | French (informal `tu`) | 1298 | 2045 | 63.5% |
| `es` | Spanish (neutral informal `tú`) | 1298 | 2045 | 63.5% |
| `ru` | Russian | 1298 | 2045 | 63.5% |
| `zh` | Simplified Chinese (`zh-Hans`, expected `zh-CN`) | 1298 | 2045 | 63.5% |
| `ja` | Japanese | 1298 | 2045 | 63.5% |

The five `*.ts` files now include 1298 translated keys each, including navigation, album/library management, playback controls, queue, downloads, device selection, synchronization, search, lyric handling, common Replay copy, i18n swipe actions, and actionable errors. Translation batches are retained in `intl-core.tsv`, `intl-batch2-core.tsv` and `intl-batch3-core.tsv`, `intl-batch4-connections.tsv` and `intl-batch5-setup-help.tsv`, `intl-batch6-audio-genres.tsv` and `intl-batch7-privacy-library.tsv`, `intl-batch8-playlists-library.tsv`, `intl-batch9-spotify-liked.tsv` and `intl-batch10-explanations.tsv`, `intl-batch11-replay-mixes.tsv`, `intl-batch12-status-counts.tsv` and `intl-batch13-general-ui.tsv` for review.

The `replay-samples.fr-es-ru-zh-ja.json` file adds **10 more localized Replay variants per language** as a *separate editorial exercise*, not as keys in the 1298-entry dictionaries. The originals are in `design/replay-copy-v2.en-de.json` in branch `design/replay-personality-genre-graph-v1`.

### Important boundaries

- Approximately **747 of 2,045** existing message keys **are still untranslated in each target language**. These will fall back to English if the languages are registered in the current `T()` function.
- **Do not present these as complete translations.** A mixed-language application is not release-ready.
- The default branch is unchanged; source files `src/lib/i18n.ts` and `src/locales/de.ts` have not been modified or wired to these drafts.
- Some source English messages are awkward sentence fragments. Before adding their translation, change the code to stable semantic keys / complete translatable sentences, especially in Replay.
- The example `{count} songs` uses simple interpolation; Russian needs plural categories, and numeric-count grammar in other languages may vary. Add Intl.PluralRules or ICU-message formatting before production.
- Date, time and numeric localization should use `Intl` with the selected locale, not English strings embedded in UI logic.
- Japanese and Chinese layouts need font and line-wrap checks. Russian, French and Spanish often need longer text boxes.
- French uses `tu` for the approved friendly tone; Russian avoids unnecessary gendered statements; Japanese uses natural neutral language without over-familiar slang.
- Review in-context strings, especially buttons, sources, singular/plural, placeholders, and provider names.
- Online machine-translation output should never bypass human and automated QA when doing the remaining ~747 entries.

## Suggested completion sequence

1. Finish the core navigation and frequent UI strings in all five languages.
2. Translate all Replay variants as complete semantic messages, not code fragments.
3. Translate setup, server, devices and short help messages.
4. Translate long settings descriptions, privacy, destructive actions and troubleshooting accurately.
5. Run key / placeholder / Unicode checks and test desktop/mobile surfaces.
6. Once coverage is near-complete, register locales in `src/lib/i18n.ts`, add language-picker labels, locale aliases (zh-Hans vs zh-Hant), and plural support.

## Usage

Each locale exports `Record<string, string>` with keys matching `T("English source text")`. These can later be moved under `src/locales/<lang>.ts` and added to the language table after translation coverage and UI checks.

The script `check-locales.mjs` checks key parity and placeholders against the 2,045-key draft in `en.ts`.

## Follow-up from the 2026-11-23 larger pass

This pass added **398** keys per language, primarily original Replay slides, mixed recommendations, playback controls, counters, empty states, device messages, and settings labels. The source has **2,045** keys; each target file now has **1,298** verified keys (**63.5% coverage**), leaving **747** keys per language to translate.

### High-priority integration debt

1. **Replay translated fragments:** `T("{period} was")`, `T("loud.")`, `T("Five you")`, `T("couldn't stop.")`, `T("song") + T("were new to you.")`, etc. are grammatically unsound when translated separately. The first-pass values are provisional and often unnatural in Japanese, Chinese, French and Russian. Replace with **full translated sentence / headline IDs**, then connect the approved contextual headline variants.
2. **Count-based English suffix keys:** `{n} song{s}`, `{count} song{value}`, `{artist} · {count} song{value}`, and other adjective-noun mixes cannot be made consistently grammatical through string substitution. In particular Russian requires grammatical plural categories. Use `Intl.PluralRules` and stable message IDs for **0, 1, 2–4, 5+** and locale-specific rules.
3. **Technical QA is not linguistic QA:** key parity, identical placeholder names, no duplicates and nonempty strings are necessary but do not prove correctness of grammar or UI context.
4. **Special key preservation:** even leading/trailing whitespace is significant in English-as-key lookups. A leading-space key accidentally lost in TSV normalization was restored and verified.
5. These are editorial drafts, not ready for merge into `src/lib/i18n.ts` or distribution. Confirm the final English/German terminology and layout first.
