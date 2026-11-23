# Songsta Voice & Tone Guide · v1

Status: **Approved direction — Tone B: locker und sympathisch** (user choice, 2026-11-23).  
Applies to: German and English UI, Replay, tutorials, empty states, tooltips, settings, errors and future localizations.

## Brand voice

Songsta should feel like a welcoming place for music. Friendly, relaxed, clear and unpretentious. Sound like a thoughtful person who enjoys music, not a marketing slogan or a translation engine.

**Core principles**
1. **Warm, not overfamiliar.** Address users with **du** in German. No unnecessary praise, judgment, or personal assumptions.
2. **Relaxed, not slangy.** Familiar everyday language. Avoid exaggerated youth slang, trendy expressions, exclamation marks everywhere, puns for their own sake, or catchphrases.
3. **Clear before clever.** Navigation, controls, safety, privacy and error messages should tell the user exactly what matters.
4. **Musical, not theatrical.** Replay and discoveries can have expressive short headlines. Use personality selectively, not in every button or setting.
5. **Based on data.** Replay copy must be true for the measured listening period. No invented listening habits, no guilt about low activity, no teasing people about repeats.
6. **Short and natural.** Prefer one clear thought per line. Avoid translated grammatical fragments.
7. **Language-native.** English and German are independently written; other language versions later adapt tone and grammar, not word order.

## Context intensity

| Context | Tone | Example DE | Example EN |
| --- | --- | --- | --- |
| Replay hero | Warm, lively | „Dein Monat. Dein Soundtrack.“ | “Your month. Your soundtrack.” |
| Replay repeats | Light smile | „Manche Songs gehen einfach immer.“ | “Some songs never get old.” |
| Replay new music | Friendly, factual | „Ganz schön viel Neues entdeckt.“ | “Plenty of new discoveries.” |
| Discover | Inviting | „Vielleicht ist hier was für dich dabei.“ | “You might find something you like here.” |
| Tutorial | Relaxed and useful | „Verbinden wir deinen Lautsprecher.“ | “Let's connect your speaker.” |
| Settings | Calm and explicit | „Neue Songs automatisch analysieren“ | “Automatically analyze new songs” |
| Error | Reassuring, actionable | „Das Gerät antwortet gerade nicht. Prüfe die Verbindung und versuch es noch einmal.“ | “The device isn't responding. Check the connection and try again.” |
| Empty state | Gentle, zero pressure | „Hier ist noch nichts zu sehen. Sobald du Musik hörst, füllt sich dein Replay.“ | “Nothing here yet. Your Replay will fill up as you listen.” |

## Avoid

- ❌ „Dieser Monat war laut.“ / “This month was loud.” (unsubstantiated, generic)
- ❌ „Schon wieder dieser Song? Können wir verstehen.“ (too jokey as default)
- ❌ „Fünf, die nicht aufhörten.“ / “Five you couldn't stop.” (unnatural fragments)
- ❌ „Die Songtexte werden bei den Anbietern gefragt.“ (translationese)
- ❌ „Du hast zu wenig Musik gehört.“ / “You didn't listen enough.” (judgmental)

## Replay variants

- Prefer **three to five conditional variants per high-impact slide**, not a joke for every statistic.
- Decide from actual period-specific stats and sensible minimum sample sizes. Use a conservative fallback.
- Stable selection for a given period, e.g. deterministic selection based on period key and variant ID.
- Avoid claiming percentages, moods, listening times or comparative habits without corresponding data.
- Keep complete localized headlines and sentences, not concatenated grammatical fragments.
- Use plural-sensitive messages for counts; support more plural categories for Russian and other locales.

## Tutorial pattern

1. A friendly headline that says what the user is trying to do.
2. One inviting sentence at most.
3. Two to four short, device-appropriate actions.
4. One helpful troubleshooting hint, only when needed.
5. Distinguish **Bluetooth paired through operating-system settings** from **Google Cast / DLNA network playback**. Don't promise support for every TV or speaker.

## Localization integration checklist

- Use stable semantic IDs instead of English strings as keys, gradually and safely.
- Preserve placeholders exactly and annotate grammar and inflection requirements.
- Keep native punctuation and capitalization; do not force English title case on German.
- Separate technical product names from translatable prose.
- Validate in desktop and mobile layouts including narrow screens.
- Terms to keep consistent: „Song“, „Album“, „Playlist“, „Bibliothek“, „Wiedergabe“, „Songtext“, „Mix“, „Replay“; use user-visible names based on context.
- Adapt culturally for French, Spanish, Russian, Simplified Chinese, and Japanese, rather than copy the German informal constructions word-for-word.
