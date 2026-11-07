# Songsta Architecture

A high-level map of how Songsta works, for contributors. This document intentionally goes deeper than the README.

## Layers

```
UI  (React 18 + Tailwind)
  views/        home, explore, search, album, artist, playlist, library,
                local music, servers, replay, settings
  components/   design-system primitives, sidebar, player bar,
                queue, lyrics, devices, context menus, toasts
  pip/          mini player (picture-in-picture) window app
        │
Application state  (Zustand stores)
  stores/       player · library · catalog · settings · ui · recents
        │
Audio engine  (src/lib/audio.ts)
  two <audio> elements ⇄ store: fades, error recovery across a song's copies,
  MediaSession (media keys + SMTC overlay), play-event logging
        │  IPC (contextBridge preload, electron/preload.ts)
Main process  (Electron, electron/)
  main.ts           app lifecycle, window, IPC routing
  local-library.ts  folders, scanning, tags and covers (music-metadata)
  jellyfin.ts       Jellyfin server
  subsonic.ts       Navidrome / Subsonic server
  stream-proxy.ts   local 127.0.0.1 range-aware proxy the <audio> elements play from
  downloads.ts      offline copies of server songs
  cast.ts, upnp.ts  speakers on the network
  firewall.ts       the rule that lets them fetch local files on Windows
  lyrics.ts         open lyric providers (genius-page.ts reads a Genius page, node-html-parser, the computer only)
  persist.ts        JSON persistence for renderer stores
  home-sync.ts      the login for the sync service (sync-server/)
```

The phone app (`mobile/`) is Expo and React Native with a Media3 native module; it shares the logic that isn't tied to a platform through `mobile/src/shared.ts`.

## Playback

Everything plays through `library:trackurl`: the main process answers with a localhost URL of the stream proxy, which serves a local file (and its converted copy where Chromium can't decode the format) or pipes a server's response. The server's token stays in the main process. A song found in several places is one song with several copies (`src/lib/duplicates.ts`), played from the local file first.

## Persistence

- Library, settings and recents are persisted as JSON in the app's user-data directory and restored on launch (`persist.ts`); the listening history lives next to them (`stats.ts`, `listens.ts`).
- Offline copies of server songs go to a library folder of their own, and merge with their server songs on the next scan. Lists downloaded as a whole are remembered (`src/lib/keptLists.ts`, shared with the phone) and completed when they or the library change.
- A device gets a Jellyfin song straight from the server when both are on the same network and the server hands it out without a login. Everything else goes through a small media server in `cast.ts`; a device that never comes for its song there is the sign of a firewall (`status.unreachable`).
- Switching a device off (`src/lib/devicePower.ts`, shared with the phone) goes by brand, because UPnP has no word for it: Denon and Marantz have a control port. The same port switches inputs, so a device that hangs on a receiver (`deviceLinks` in the settings) brings it along when it gets music, and takes it along when it loses it. A Google TV or Android TV has no such port: it's switched off over the Android TV remote protocol (`src/lib/tvRemote.ts`, shared), TLS with a key of this app's own, paired once with a code on its screen (`pairedTvs`, per app; `electron/tv-remote.ts`, on the phone `TvIdentity.kt`). The same connection says which app is open, so a film keeps a TV and its receiver on.
- A group of devices is brought together by `src/lib/groupSync.ts`, shared: it reads where each stands (a report in whole seconds says more by the moment it turns over: found roughly, then the next one closely), moves the late ones on, and learns what a seek costs each and how much later each starts a song, so the next one is handed to the quick ones that much later. A device can be set by hand to play ahead or behind (`playAhead` in the settings; on the computer the main process holds the groups and gets it over `cast:playAhead`): the group then goes by what's heard, and is held closer.
- Playlists and where playback stopped travel between devices through the sync service (`sync-server/`, `src/lib/syncEngine.ts`). Nothing else leaves the device: see Privacy in the README.

## Beat-aware Auto Mix

`src/lib/analysis.ts` decodes a track and estimates tempo (BPM) from the onset-energy envelope via autocorrelation. Auto Mix uses that beat grid to land crossfades on the incoming track's tempo; the plain Crossfade setting uses fixed-duration fades instead.

## Local music

Folders are imported through an approved-directories list, scanned with tag + artwork extraction via `music-metadata`, and indexed into songs/albums/artists. A non-music filter hides short recordings, clips and voice notes (re-applied on rescan).

## Updates

Both apps ask GitHub once a day for the newest version (`src/lib/newVersion.ts`). On Windows the desktop app can replace itself: `electron/app-update.ts` wraps electron-updater, which reads `latest.yml` and fetches only what changed since the installed version if the old release has its `.blockmap`. The installer starts on the app's `quit` event, after everything is saved. On the phone, `mobile/src/newVersion.ts` fetches the `Songsta.apk` of the release and hands it to Android (`AppUpdate.kt`). Android only takes it if it's signed with the same key as what's installed, and `versionCode` has to go up.

Looking, fetching by itself (`autoUpdate`) and telling about it (`checkNewVersion`) are separate: the look runs if either wants it.

A release therefore needs `latest.yml` and `Songsta-Setup.exe.blockmap` next to the installer. Without them the desktop app falls back to the note with the link. macOS and Linux get that note too: macOS doesn't take unsigned updates, a .deb needs a password, and the AppImage's way of replacing itself is untested so far.

## The installer

`build/installer.nsh` makes electron-builder's one-click NSIS installer look like the app: its own first page in the template's `licensePage` slot, and a dark progress page. The template puts a small banner of its own over the progress page, which is hidden again from the `customCheckAppRunning` hook, the first thing that runs after it. So that hook has to bring along what the template only includes without it. Silent updates (`/S --updated`) show no page at all.
