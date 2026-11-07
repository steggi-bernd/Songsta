# The phone app

Android first, built with Expo and React Native. It plays your Jellyfin server's music and folders on the phone itself. To just use it, take `Songsta.apk` from the [Releases page](https://github.com/steggi-bernd/Songsta/releases/latest); the rest of this page is for building it yourself.

- `src/`: the screens and stores. What albums, artists and mixes are comes from the desktop app's own code (`../src/lib`, `src/shared.ts` names what is used), so both apps agree.
- `modules/media3-player/`: the audio engine, a small native module around Google's Media3: background playback, lock screen and headset controls, songs in a row without a gap.

## What it does beyond playing

- **First start:** where the music is, a folder on the phone and a server counting the same, then notifications and installing updates, each only if Android hasn't got an answer yet. Signed out and without a folder, the app comes back to where the music is.
- **The player's page:** as on Spotify. The title leads to its album, the artist to the artist, "Playing from" to the list it started from. The bottom row shows where the sound goes (tap it for the devices), what really plays, in signal colours from gold for lossless down to red, and the download arrow, which also takes the song off again. Under the page lie the lyrics, what comes next, and about the song and the artist, as in the desktop app's side panel.
- **Sync:** playlists, where you stopped, muted songs and the order of Liked Songs stay the same as on the desktop, through the [sync service](../sync-server/README.md). There is one stream: a phone that isn't playing shows what another device plays and steers it, a new song and the volume too, the volume keys included, and the other way round, also while the phone plays in your pocket. *This phone* under Devices brings the music here and stops it there; *Start a second stream* in that tile's menu lets each device go its own way until you end it.
- **Devices** (the speaker in the mini player or the player): tiles for this phone and Android's own list of outputs, your other devices with Songsta, and what's on your Wi-Fi: receivers and network speakers over UPnP/DLNA, Chromecast, Google TV and Nest speakers over Cast. A press moves the music there; the plus lets another one play along, each with its own volume. Holding a tile starts choosing several devices at once, this phone among them. A tile's ⋯ holds the rest: choose music for that device right there, which gives it its own queue next to yours; a song's menu has *Play on a device* too. A receiver still coming out of standby is waited for: the card says so until it really plays, it gets the song again if it forgot it on the way up, and after a minute without a start you're told and the music is back on the phone, paused. Those devices fetch the songs from your server's home address themselves, always as the file itself, so the phone can sleep; a notification keeps it running to say what's next, the lock screen and headset buttons steer it, and the volume keys reach the device. A group of separate devices isn't sample-exact: each one fetches and buffers by itself. Songsta looks at where each one really stands, moves the late ones on, and remembers how much later each tends to start, so the next song starts closer. What's left you can still hear between two speakers in one room. If one still sounds behind or ahead, a tile's ⋯ has *Fine-tune timing*, this phone's too (for a Bluetooth speaker on it, say), and while they play, the group card's ⋯: earlier or later in steps of 50 ms. A Cast group made in Google's own app is exact, and shows up here as one device. Amazon lets no app send music to an Echo or Fire TV directly, so those are listed with how to pair them over Bluetooth. Each device's volume is on its card here; the volume keys reach it from anywhere. A Denon or Marantz receiver goes off half a minute after the music has left it, unless you press *Keep on*, it plays again, or it has been switched to another input; its ⋯ does it right away. A Google TV on one of its HDMI inputs only sounds there: a tile's ⋯ says where it's plugged in (*Plugged into a receiver*: first the receiver, then the input), and music to it brings the receiver along, on and over to that input. When the music is gone from both, both go off. Pair a Google TV or Android TV once in that same place, with a code on its screen, and it goes off too, also when the music goes back to the receiver alone; with a film or an app open on it, it stays on.
- **Quality** (tap what's playing in the player): *Original* plays the file itself, *Compact* a 128 kbps copy, *Automatic* the best the connection carries, measured while data flows, and over mobile data up to AAC 256 kbps, Jellyfin's highest. The line at the bottom of that sheet says what the sound goes through: decoder, output, speed. *24-bit output* in the settings keeps the full resolution of 24-bit files up to the phone's mixer; it is off by default, because one phone played songs far too fast and this may be why.
- **Sound** (Settings): fades between songs (a fade out and in, not yet overlapping), skip silence, playback speed with the pitch kept, autoplay when the queue ends, and a ten-band equalizer with presets. They work on this phone's player, not on devices on the network.
- **Volume leveling** (Settings): Jellyfin measures every song; the app brings loud ones down to −14 LUFS, Spotify's usual level, or −18 or −11 if you prefer. It only ever turns down.
- **Shuffle** mixes what's coming, so the queue you see is what plays, and *Previous* goes back to the song you really heard. *Settings → Vibration* answers your touches: pulled songs, buttons, likes, menus and the queue's handles.
- **Language** (Settings → Appearance): English or German, following your phone unless you choose.
- **Away from home** (Settings): a second address for your server, say a tunnel or proxy. The app asks both when the network changes and takes the direct way when it can; songs under way go on from the other address.
- **Swipes:** pull a song right in any list: let go quickly and it joins the queue, behind everything you asked for before it, in order; if it's further down the list already, it comes up from there. Hold it a moment and it branches off, with the rest of its list behind it, as in the desktop app: a small mark shows the song you chose until it comes on, pulling that song again takes the branch back, and holding another song of the list starts the branch there instead. Pull it left to mute it: greyed out with a red name, skipped everywhere, and played only when you tap it or queue it yourself. The same pull unmutes it. *Settings → Gestures* has two feels: a rubber band that snaps home when let go, and a tauter one that gives less.
- **Queue:** what you asked for by hand stands in an area of its own above the rest of the list, first come, first played: songs, and branches as a block with the list's name. Long branches fold, and a branch's cross takes it back. A song goes by its small cross or a pull to the right, and moves by its handle.
- **Your Library:** pull a playlist, album, mix or artist to the right to pin it on top; the same pull unpins it.
- **Folders on the phone** (Settings): one or more, picked with Android's own picker and read once; a rescan finds what changed. Their songs join the library with their tags, covers and any `.lrc` beside them. A song your server has too stays one song and plays from the file. Without a server the app works from the folders alone. A device on the network can't play a song that's only in a folder, since it fetches songs from the server by itself.
- **Downloads:** the arrow in the player, the ⋮ on a song, or the arrow on an album or playlist. Each song's row shows how far it is. The app fetches them itself, over the same way as the player, also with the screen off, and goes on where it stopped when a connection breaks. A kept song brings its cover and lyrics. Settings choose the file itself or a 192 kbps MP3, and whether mobile data may be used. A playlist, album or Liked Songs downloaded as a whole stays whole: the app looks when it starts or comes back, after a pull-down, when the list or the library changes, when the server is back, and every quarter of an hour, and fetches what's missing. A song taken off by hand stays off.
- **Without a connection** the app opens from what it remembers: the library, playlists, the small covers it fetched on Wi-Fi, lyrics it has shown. Downloaded songs play, the rest is greyed out. Likes and plays from that time wait in the app and reach the server when it's back.
- **What goes online:** your server; for a player that's open, Genius for the song and MusicBrainz, Wikidata and Wikipedia for the artist; LRCLIB for lyrics your server doesn't have. Each is asked once and the answer stays on the phone. The devices page looks around your Wi-Fi only while it's open, and only what you send to a device goes there.

## Running it

You need Node, Android Studio with its SDK, and a phone or emulator.

```bash
npm install
npx expo run:android
```

`android/` is generated (`npx expo prebuild`) and not kept in Git.

On Windows the native build breaks on long folder paths: keep the project close to the drive's root (`C:\bt` works). A `subst` drive doesn't help, because Gradle then sees the same files under two different roots.

## An APK for your phone

```bash
npx expo prebuild --platform android
cd android
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

The file lands in `android/app/build/outputs/apk/release/`. It is signed with the debug key, which is fine for your own phone and not for a store.
