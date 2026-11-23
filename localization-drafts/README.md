# Songsta localization · English & German editorial draft

**Branch:** `localization/review-en-de-2026-11-23`  
**Base:** `feat/local-player` · snapshot dated 2026-11-23

This is a **review draft**, not yet wired into the running app. No production files are replaced.

## Files

- `en.ts`: complete English-key-based dictionary (2045 entries). English wording improvements are applied as values; translation IDs are unchanged.
- `de.ts`: complete German dictionary (2045 entries). Existing translations are retained except for editorial improvements.

The draft edits **76 keys**, with consistent placeholders across both languages. These are a first editorial pass, **not** a claim that every one of the 2045 source messages has been reviewed in context.

## Important integration work remaining

1. Import `en` into `src/lib/i18n.ts` in place of the embedded five-entry English table, and merge/replace `src/locales/de.ts` only once text reviews are approved.
2. Audit all desktop and mobile calls to `T(...)`; many messages are dynamically split into phrases. Replay should use complete sentence keys or semantic IDs rather than translated grammatical fragments.
3. Fix the desktop Replay singular/plural handling: the new-song slide currently always uses the plural phrase.
4. Verify each string in its actual UI, including narrow mobile widths, pluralization, accessibility, and context-specific placeholders.
5. After approval of the source language, add French, Spanish, Russian, Simplified Chinese and Japanese as complete language packs and update language selection, date formatting and font/layout coverage.

### Proposed voice

- Replay: personal and musical, but not overly clever.
- Settings: clear and precise, without unexplained jargon.
- Errors: explain what happened and what can be done next.
- Use established music terms consistently: Song, Playlist, Album, Bibliothek, Wiedergabe, Songtext.

## Caveat

The English strings are currently also lookup keys. Changing them directly in a component would break dictionary lookups unless the keys are migrated. This draft deliberately leaves all keys untouched and puts improved English copy in the values.
