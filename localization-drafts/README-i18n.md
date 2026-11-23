# Songsta — localization draft (EN, DE, FR, ES, RU, ZH-Hans, JA)

**Branch:** `localization/intl-first-pass-2026-11-23`  
**Based on:** `feat/local-player`, translation-key snapshot from 2026-11-23  
**Status:** **100% existing key coverage — editorial draft, not release-ready**  
**Production code:** unchanged

## Language dictionaries

| File | Language | Entries | Coverage of 2,045 source keys |
|---|---|---:|---:|
| `en.ts` | English editorial draft | 2,045 | 100% |
| `de.ts` | German editorial draft | 2,045 | 100% |
| `fr.ts` | French (friendly `tu`) | 2,045 | 100% |
| `es.ts` | Spanish (informal `tú`) | 2,045 | 100% |
| `ru.ts` | Russian | 2,045 | 100% |
| `zh.ts` | Simplified Chinese (zh-Hans / zh-CN) | 2,045 | 100% |
| `ja.ts` | Japanese | 2,045 | 100% |

The English and German editorial drafts are from the earlier pass; the five new languages have now all been translated in full to the **existing lookup-key inventory**. These counts do not establish that all unlocalized text across the codebase has been extracted. A complete source-code i18n audit is still recommended.

The last large pass brought each new language from **1,298 to 2,045 translated keys** (+747 each). The incremental source-to-translation batches remain as `intl-core.tsv` and `intl-batch2-core.tsv` through `intl-batch20-final-technical.tsv` for editorial review and traceability.

## Verification performed

At the source snapshot:
- All five new dictionaries have exactly **2,045 unique entries**.
- Every key matches an English source lookup key; zero missing or extraneous keys.
- Every interpolation placeholder matches its source key, including repeated placeholders and case.
- Zero empty-string translations or duplicate keys.
- Initial content audit showed no accidental Japanese text in the French dictionary.
- Unchanged values can be legitimate technical names and terms (e.g. BPM, Bluetooth, Songsta Replay); they are **not automatically considered untranslated**.

This is a **technical structure check, not a native-speaker review**. Meaning, grammatical correctness, device-specific labels, fonts, wrapping and line breaks still need in-context validation.

## Draft implementation pieces

- `i18n-next.ts`: side-by-side design for **stable semantic translation IDs**, interpolation, `Intl.PluralRules` and a seven-language plural-message sample. It is not imported by `src/lib/i18n.ts`.
- `replay-headlines.v2.ts`: **complete, language-specific Replay headlines in all seven languages**, with a contextual introduction selector. The current desktop/mobile Replay screens still use older split keys.
- `replay-samples.fr-es-ru-zh-ja.json`: separate localized variations for editorial approval.
- `check-locales.mjs`: lightweight parity and placeholder test for the drafts.

## Necessary changes before release

1. **Translate whole sentences, not fragments.** Replay currently concatenates separately translated strings such as `T("{period} was")` with `T("loud.")`, and `T("Five you")` with `T("couldn't stop.")`. These produce broken grammar in many languages. Migrate the Replay screens to full message keys and connect the approved variations, while keeping fallback copy for empty or sparse periods.
2. **Migrate count-dependent UI.** Keys such as `{n} song{s}` and `{artist} · {count} song{value}` are an English suffix workaround. Implement locale-aware plural categories (particularly Russian) with full messages, not inserted plural suffixes.
3. **Register locales and language selection.** Update `src/lib/i18n.ts` only after the data and UI changes are ready. Ensure phone language selection, persisted language choice, `textLocale()` and system detection work correctly. Explicitly distinguish Simplified from Traditional Chinese rather than mapping all `zh` locales blindly.
4. **Check every device-specific instruction.** Android / Windows menu paths, Bluetooth pairing, firewall, Denon/Marantz and Echo behavior may depend on OS version or configuration. Verify the actual labels and behavior on supported devices.
5. **Check destructive and privacy copy.** Verify carefully that texts accurately distinguish data deleted from Songsta from files retained on disk and data retained on sync servers. Treat texts describing what is transmitted to third parties as product/security requirements, not merely style.
6. **Responsive UI and typography.** Allow longer strings on narrow screens, test Japanese/Chinese line breaking and fonts, verify accessibility labels, truncation and right-to-left expectations if more locales are added later.
7. **Human linguistic QA.** Especially French and Spanish voice consistency, Russian declensions/plurals, and Chinese/Japanese UI-naturalness.
8. **Source audit.** Search desktop and mobile code for raw literals, missing `T(...)` calls and dynamic text not in the existing 2,045 source keys; avoid reporting 100% application localization until this audit passes.

## Approved tone

Warm, relaxed and clear. No forced slang, no stiff or formal wording. Errors should tell the user what happened and what to do next. Familiar musical terms are preferred. French uses `tu`, Spanish `tú`; Russian copy should avoid needlessly gendered forms, and Japanese should be friendly without overly casual slang.

## Git safety

This branch contains **draft files under `localization-drafts/` only**; no app runtime imports are added or overwritten. Do not merge the dictionaries directly into production before the above migrations and reviews.
