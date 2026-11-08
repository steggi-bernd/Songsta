/** What the phone takes from the desktop app's library logic: pure code, one copy for both. */
export type { Track } from "../../src/types";
export { jellyfinStreamPlan } from "../../electron/jellyfin-stream";
export { sameSong, songIdentity } from "../../src/lib/duplicates";
export { artistFromOpenData, OPEN_DATA_AGENT, type ArtistMeta } from "../../electron/artist-facts";
export { GENIUS_HEADERS, geniusFindWith, songFromGenius, songIsBy, type SongInfo } from "../../electron/genius";
export { primaryArtist, queryTitle } from "../../electron/song-names";
export { albumKeyOf as libraryAlbumKey, albumRoute, leadArtist, matchesQuery, splitCredits } from "../../src/lib/libraryCore";
export { hasCyrillic, toLatin } from "../../src/lib/transliterate";
export { lrcRows, sungLines, unfoldStamps } from "../../src/lib/lrc";
export { describePlayback, formatLine } from "../../src/lib/playbackFormat";
export { jellyfinItemToTrack, jellyfinToTrack } from "../../src/lib/jellyfinItem";
export { PLAY_AHEAD_MAX_MS, PLAY_AHEAD_STEP_MS } from "../../src/lib/groupSync";
export { seedPlayed } from "../../src/lib/libraryOrder";
export {
  artistAlbums,
  artistTracks,
  buildAlbums,
  buildArtists,
  buildGenres,
  byPlays,
  likedAmong,
  newestFirst,
  type LibAlbum,
  type LibArtist,
  type LibGenre,
  type PlayCounts,
} from "../../src/lib/catalogBuild";
export {
  addedLabel,
  albumOrders,
  albumRowsOf,
  artistOrders,
  artistRowsOf,
  dayLabel,
  DEFAULT_EXPLORE_SORTS,
  genreOrders,
  genreRowsOf,
  nextSort,
  sortRows,
  type AlbumRow,
  type ArtistRow,
  type ExploreSort,
  type ExploreTab,
  type GenreRow,
} from "../../src/lib/exploreRows";
export { allMixes, type Mix } from "../../src/lib/mixes";
export { recordDeletionChanges, type DeletionChange } from "../../src/lib/deletion-sync";
export { likedInOrder, mergePlaylistDocs, oneCopyEach, songFinder, toPlaylistDoc, toWireTrack, type PlaylistDoc, type WirePlaylist, type WireTrack } from "../../src/lib/playlistSync";
export { createSyncEngine, defaultSyncAddress, DEVICE_ONLINE_MS, type DeviceCommand, type DevicePresence, type PlaybackNote, type QueueDoc, type RemoteDevice, type SyncEngine, type SyncStatus } from "../../src/lib/syncEngine";
export { castPlayer, EndWatch, mimeOf, upnpPlayer, type DevicePlayer } from "../../electron/device-player";
export { describe as describeRenderer, isLanUrl, parseSsdp, type Renderer } from "../../electron/upnp-control";
export {
  bringToInput,
  canSwitchOff,
  inputCode,
  inputName,
  isNetworkInput,
  linksToFollow,
  looksLikeTv as looksLikeATv,
  OWN_INPUT,
  readPower,
  RECEIVER_INPUTS,
  receiverInUse,
  sendToReceiver,
  switchOffAt,
  SwitchOffs,
  wentOffToo,
  type DeviceLink,
  type LeavingDevice,
} from "../../src/lib/devicePower";
export { TV_PAIRING_PORT, TV_REMOTE_PORT, TvCodeRefused, TvPairing, tvSecret, tvState, tvSwitchOff } from "../../src/lib/tvRemote";
export { albumListKey, completeLists, KEPT_LISTS_LOOK_EVERY_MS, LIKED_LIST, missingFromLists, playlistListKey } from "../../src/lib/keptLists";
export { utf8Bytes, utf8Text, type CastSocket } from "../../src/lib/castV2";
export { devicesFromMdns, MDNS_ADDRESS, MDNS_PORT, mdnsQuery, readMdns, SSDP_ADDRESS, SSDP_PORT, SSDP_SEARCH, type MdnsService, type NetDevice } from "../../src/lib/netScan";
export { Zone, type ZoneDriver, type ZoneMember, type ZonePlayState, type ZoneSong } from "../../src/lib/zoneEngine";
export { playCreditSeconds } from "../../src/lib/favoriteSync";
export { fmtLength, fmtTime, plural } from "../../src/lib/format";
export { RELEASE_LABEL } from "../../src/lib/releases";
export { isNewerVersion, latestApk, latestVersion, lookForNewVersion, NEW_VERSION_FIRST_LOOK_MS, NEW_VERSION_LOOK_EVERY_MS, NO_VERSION_MEMORY, RELEASE_PAGE, type NewVersionMemory, type ReleaseApk } from "../../src/lib/newVersion";
export { handRows, jumpTarget, lineInList, listAround, placeOf, putBack, tendedBranches, withoutSongs, type HandRow, type QueueBranch } from "../../src/lib/queueSections";
export { currentLanguage, languageOf, LANGUAGES, setLanguage, T, type Language, type LanguageChoice } from "../../src/lib/i18n";
