package expo.modules.media3player

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import kotlin.concurrent.thread
import kotlin.math.min
import kotlin.math.pow

class QueueItem : Record {
  @Field var id: String = ""
  @Field var url: String = ""
  @Field var title: String = ""
  @Field var artist: String = ""
  @Field var album: String = ""
  @Field var artworkUrl: String? = null
  @Field var gainDb: Double? = null
}

private const val TICK_MS = 500L
private const val ZONE_TICK_MS = 1000L
private const val PICK_FOLDER = 7931
private const val PICK_IMAGE = 7932
private const val SAVE_DOCUMENT = 7933
private const val OPEN_DOCUMENT = 7934

/**
 * The player as JavaScript sees it: commands in, one state event out. The
 * app keeps the queue's order itself and hands it over; shuffling is the app
 * reordering what comes next, so the list on screen is what actually plays.
 */
@UnstableApi
class Media3PlayerModule : Module() {
  private var controllerFuture: ListenableFuture<MediaController>? = null
  private val main = Handler(Looper.getMainLooper())
  private var networkWatch: ConnectivityManager.NetworkCallback? = null
  private var lastNetwork: Network? = null
  private var lastNetworkState: Map<String, Boolean>? = null
  private var output: SoundOutput? = null
  private var sockets: LanSockets? = null
  private var files: FileServer? = null
  private var pickingFolder: Promise? = null
  private var pickingImage: Promise? = null
  private var savingDocument: Promise? = null
  private var openingDocument: Promise? = null

  /** Timers in JavaScript stand still in the background; native events still arrive, and the zones need their once a second. */
  private val zoneTick = object : Runnable {
    override fun run() {
      sendEvent("onZoneTick", emptyMap<String, Any>())
      main.postDelayed(this, ZONE_TICK_MS)
    }
  }

  private val tick = object : Runnable {
    override fun run() {
      val player = controllerFuture?.takeIf { it.isDone }?.get() ?: return
      emitState(player)
      if (player.isPlaying) main.postDelayed(this, TICK_MS)
    }
  }

  private val listener = object : Player.Listener {
    override fun onEvents(player: Player, events: Player.Events) {
      emitState(player)
      main.removeCallbacks(tick)
      if (player.isPlaying) main.postDelayed(tick, TICK_MS)
    }

    override fun onPlayerError(error: PlaybackException) {
      sendEvent("onError", mapOf("message" to (error.localizedMessage ?: error.errorCodeName), "code" to error.errorCodeName))
    }
  }

  private fun stateOf(player: Player): Map<String, Any?> = mapOf(
    "isPlaying" to player.isPlaying,
    "playWhenReady" to player.playWhenReady,
    "isBuffering" to (player.playbackState == Player.STATE_BUFFERING),
    "isEnded" to (player.playbackState == Player.STATE_ENDED),
    "index" to player.currentMediaItemIndex,
    "count" to player.mediaItemCount,
    "positionMs" to player.currentPosition.coerceAtLeast(0).toDouble(),
    "durationMs" to (if (player.duration == C.TIME_UNSET) 0.0 else player.duration.toDouble()),
    "bandwidthBps" to Throughput.bitsPerSecond().toDouble(),
    "audio" to listOf(AudioInfo.decoder, AudioInfo.output, "speed ${player.playbackParameters.speed}").filter { it.isNotEmpty() }.joinToString(" · "),
    "repeat" to when (player.repeatMode) {
      Player.REPEAT_MODE_ALL -> "all"
      Player.REPEAT_MODE_ONE -> "one"
      else -> "off"
    }
  )

  private fun emitState(player: Player) {
    sendEvent("onState", stateOf(player))
  }

  /** Connects to the playback service on first use and runs the command once it answers. */
  private fun withPlayer(block: (MediaController) -> Unit) {
    val context = appContext.reactContext ?: return
    val future = controllerFuture ?: MediaController.Builder(
      context,
      SessionToken(context, ComponentName(context, PlaybackService::class.java))
    ).buildAsync().also {
      controllerFuture = it
      it.addListener({ runCatching { it.get().addListener(listener) } }, MoreExecutors.directExecutor())
    }
    future.addListener({
      runCatching { future.get() }
        .onSuccess(block)
        .onFailure { sendEvent("onError", mapOf("message" to (it.message ?: "The player did not start"))) }
    }, ContextMainExecutor(main))
  }

  private fun networkState(caps: NetworkCapabilities?): Map<String, Boolean> = mapOf(
    "connected" to (caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true),
    "metered" to (caps != null && !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED))
  )

  /** Signal strength comes through here too: only a real change goes on. */
  private fun networkReport(network: Network?, caps: NetworkCapabilities?) {
    val state = networkState(caps)
    if (network != lastNetwork) Throughput.forget()
    if (network == lastNetwork && state == lastNetworkState) return
    lastNetwork = network
    lastNetworkState = state
    sendEvent("onNetwork", state)
  }

  private fun watchNetwork() {
    val context = appContext.reactContext ?: return
    val watch = object : ConnectivityManager.NetworkCallback() {
      override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
        networkReport(network, networkCapabilities)
      }

      override fun onLost(network: Network) {
        networkReport(null, null)
      }
    }
    context.getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(watch)
    networkWatch = watch
  }

  private val context: Context
    get() = appContext.reactContext as Context

  /** After a failed stream the player stands idle, and seeking alone would not start it again. */
  private fun prepareIfIdle(player: Player) {
    if (player.playbackState == Player.STATE_IDLE) player.prepare()
  }

  private fun QueueItem.toMediaItem(): MediaItem {
    val extras = Bundle()
    gainDb?.let { extras.putDouble(GAIN_EXTRA, it) }
    val meta = MediaMetadata.Builder()
      .setTitle(title)
      .setArtist(artist)
      .setAlbumTitle(album)
      .setIsPlayable(true)
      .setIsBrowsable(false)
      .setExtras(extras)
    artworkUrl?.takeIf { it.isNotEmpty() }?.let { meta.setArtworkUri(Uri.parse(it)) }
    val uri = Uri.parse(url)
    return MediaItem.Builder()
      .setMediaId(id)
      .setUri(uri)
      .setRequestMetadata(MediaItem.RequestMetadata.Builder().setMediaUri(uri).build())
      .setMediaMetadata(meta.build())
      .build()
  }

  override fun definition() = ModuleDefinition {
    Name("Media3Player")

    // A page closed by pulling it down (PullDownView.kt).
    View(PullDownView::class) {
      Events("onClose")
    }

    Events("onState", "onError", "onNetwork", "onOutput", "onSocket", "onZoneTick", "onZoneControl", "onLocalScan", "onAppUpdate")

    OnActivityResult { _, payload ->
      if (payload.requestCode == PICK_IMAGE) {
        val promise = pickingImage ?: return@OnActivityResult
        pickingImage = null
        val image = payload.data?.data
        if (payload.resultCode != Activity.RESULT_OK || image == null) {
          promise.resolve(null)
          return@OnActivityResult
        }
        thread(isDaemon = true) {
          promise.resolve(runCatching { PickedImage.asDataUrl(context, image) }.getOrNull())
        }
        return@OnActivityResult
      }
      if (payload.requestCode == SAVE_DOCUMENT || payload.requestCode == OPEN_DOCUMENT) {
        val saving = payload.requestCode == SAVE_DOCUMENT
        val promise = (if (saving) savingDocument else openingDocument) ?: return@OnActivityResult
        if (saving) savingDocument = null else openingDocument = null
        val doc = payload.data?.data
        promise.resolve(if (payload.resultCode == Activity.RESULT_OK && doc != null) Documents.describe(context, doc) else null)
        return@OnActivityResult
      }
      if (payload.requestCode != PICK_FOLDER) return@OnActivityResult
      val promise = pickingFolder ?: return@OnActivityResult
      pickingFolder = null
      val tree = payload.data?.data
      if (payload.resultCode != Activity.RESULT_OK || tree == null) {
        promise.resolve(null)
        return@OnActivityResult
      }
      // Kept across restarts of the phone; only what the picker just gave can be kept.
      runCatching { context.contentResolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
      promise.resolve(mapOf("uri" to tree.toString(), "name" to LocalFiles.nameOf(tree)))
    }

    /** Android's folder picker; null when somebody changed their mind. */
    AsyncFunction("pickFolder") { promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.resolve(null)
      } else {
        pickingFolder?.resolve(null)
        pickingFolder = promise
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
        activity.startActivityForResult(intent, PICK_FOLDER)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("pickImage") { promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.resolve(null)
      } else {
        pickingImage?.resolve(null)
        pickingImage = promise
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*")
        activity.startActivityForResult(intent, PICK_IMAGE)
      }
    }.runOnQueue(Queues.MAIN)

    /** Android's own "save as": where a file goes and its name; null when somebody changed their mind. */
    AsyncFunction("pickSaveDocument") { name: String, mimeType: String, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.resolve(null)
      } else {
        savingDocument?.resolve(null)
        savingDocument = promise
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mimeType).putExtra(Intent.EXTRA_TITLE, name)
        activity.startActivityForResult(intent, SAVE_DOCUMENT)
      }
    }.runOnQueue(Queues.MAIN)

    /** Android's own picker for a file to open; null when somebody changed their mind. */
    AsyncFunction("pickDocument") { mimeTypes: List<String>, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.resolve(null)
      } else {
        openingDocument?.resolve(null)
        openingDocument = promise
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
        if (mimeTypes.isNotEmpty()) intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toTypedArray())
        activity.startActivityForResult(intent, OPEN_DOCUMENT)
      }
    }.runOnQueue(Queues.MAIN)

    /** Text into a file picked with pickSaveDocument, in place of what was in it. */
    AsyncFunction("writeText") { uri: String, text: String ->
      Documents.writeText(context, Uri.parse(uri), text)
    }

    /** What's in a picked folder; `known`: file address to when it last changed. */
    AsyncFunction("localScan") { folder: String, known: Map<String, Double>, promise: Promise ->
      thread(isDaemon = true) {
        runCatching {
          LocalFiles.scan(context, Uri.parse(folder), known) { read, total -> sendEvent("onLocalScan", mapOf("folder" to folder, "read" to read, "total" to total)) }
        }.onSuccess { promise.resolve(it) }
          .onFailure { promise.reject("ERR_LOCAL_SCAN", it.message ?: "That folder can't be read", it) }
      }
    }

    AsyncFunction("localForget") { folder: String ->
      runCatching { context.contentResolver.releasePersistableUriPermission(Uri.parse(folder), Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }

    AsyncFunction("readText") { uri: String ->
      LocalFiles.readText(context, Uri.parse(uri))
    }

    /** What Settings asks of the sound. */
    AsyncFunction("setTuning") { skipSilence: Boolean, speed: Double, fadeSeconds: Int, seamless: Boolean ->
      PlaybackTuning.skipSilence = skipSilence
      PlaybackTuning.speed = speed.toFloat()
      PlaybackTuning.fadeSeconds = fadeSeconds
      PlaybackTuning.seamless = seamless
      PlaybackTuning.service?.applyTuning()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setEqualizer") { on: Boolean, bands: List<Int>, gains: List<Double> ->
      PlaybackTuning.eqOn = on
      PlaybackTuning.eqBands = bands.toIntArray()
      PlaybackTuning.eqGains = gains.map { it.toFloat() }.toFloatArray()
      PlaybackTuning.service?.applyTuning()
    }.runOnQueue(Queues.MAIN)

    /** For what only applies when the app starts anew: the accent colour. */
    AsyncFunction("restartApp") {
      context.packageManager.getLaunchIntentForPackage(context.packageName)?.let { start ->
        context.startActivity(start.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        Runtime.getRuntime().exit(0)
      }
    }.runOnQueue(Queues.MAIN)

    OnCreate {
      watchNetwork()
      appContext.reactContext?.let { reactContext ->
        output = SoundOutput(reactContext) { now -> sendEvent("onOutput", now) }.also { watch -> main.post { watch.start() } }
        sockets = LanSockets(reactContext) { news -> sendEvent("onSocket", news) }
        files = FileServer(reactContext)
        ZoneKeepAliveService.controls = { action -> sendEvent("onZoneControl", mapOf("action" to action)) }
      }
    }

    OnDestroy {
      output?.stop()
      output = null
      sockets?.closeAll()
      sockets = null
      files?.stop()
      files = null
      main.removeCallbacks(zoneTick)
      ZoneKeepAliveService.controls = null
      appContext.reactContext?.let { ZoneKeepAliveService.hide(it) }
      main.removeCallbacks(tick)
      controllerFuture?.let { MediaController.releaseFuture(it) }
      controllerFuture = null
      networkWatch?.let { watch ->
        appContext.reactContext?.getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(watch)
      }
      networkWatch = null
    }

    AsyncFunction("setAuth") { server: String, headers: Map<String, String>, addresses: List<String> ->
      PlaybackAuth.server = server
      PlaybackAuth.addresses = addresses
      PlaybackAuth.headers = headers
    }

    /** `restart`: the decoder hears of it when it starts anew, so the song under way starts it anew. */
    AsyncFunction("setKeep24Bit") { on: Boolean, restart: Boolean ->
      AudioInfo.keep24Bit = on
      if (restart) {
        withPlayer { player ->
          if (player.mediaItemCount > 0) {
            player.stop()
            player.prepare()
          }
        }
      }
    }.runOnQueue(Queues.MAIN)

    /** The playing song's gain now; each next song brings its own. */
    AsyncFunction("setGain") { gainDb: Double ->
      val volume = min(1.0, 10.0.pow(gainDb / 20.0)).toFloat()
      val service = PlaybackTuning.service
      if (service != null) service.setSongVolume(volume)
      else withPlayer { player -> player.volume = volume }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("getNetwork") {
      val manager = (appContext.reactContext as Context).getSystemService(ConnectivityManager::class.java)
      networkState(manager.getNetworkCapabilities(manager.activeNetwork))
    }

    AsyncFunction("getOutput") {
      output?.current() ?: mapOf("kind" to "phone", "name" to "")
    }

    AsyncFunction("chooseOutput") {
      output?.choose()
    }.runOnQueue(Queues.MAIN)

    /** One question to the local network and all its answers within the time; null without such a network. */
    AsyncFunction("netAsk") { address: String, port: Int, question: String, waitMs: Int, promise: Promise ->
      thread(isDaemon = true) {
        runCatching { LocalNet.ask(context, address, port, Base64.decode(question, Base64.NO_WRAP), waitMs) }
          .onSuccess { promise.resolve(it) }
          .onFailure { promise.reject("ERR_LOCAL_NET", it.message ?: "Couldn't look around the network", it) }
      }
    }

    AsyncFunction("socketOpen") { host: String, port: Int, asThisApp: Boolean, promise: Promise ->
      thread(isDaemon = true) {
        runCatching { sockets?.connect(host, port, asThisApp) ?: error("The app is closing") }
          .onSuccess { promise.resolve(it) }
          .onFailure { promise.reject("ERR_SOCKET", it.message ?: "The device doesn't answer", it) }
      }
    }

    AsyncFunction("socketWrite") { id: Int, data: String ->
      sockets?.write(id, Base64.decode(data, Base64.NO_WRAP))
    }

    AsyncFunction("socketClose") { id: Int ->
      sockets?.close(id)
    }

    AsyncFunction("socketPeerKey") { id: Int ->
      sockets?.peerKey(id)
    }

    /** A song from this phone's folders, for a device on the network: the address it fetches it from. */
    AsyncFunction("fileShare") { uri: String, mime: String, ext: String, deviceHost: String, promise: Promise ->
      thread(isDaemon = true) {
        runCatching { files?.share(uri, mime, ext, deviceHost) ?: error("The app is closing") }
          .onSuccess { promise.resolve(it) }
          .onFailure { promise.reject("ERR_FILE_SHARE", it.message ?: "Can't hand that song out", it) }
      }
    }

    AsyncFunction("fileShareStop") {
      files?.stop()
    }

    AsyncFunction("tvOwnKey") { promise: Promise ->
      thread(isDaemon = true) {
        runCatching { TvIdentity.ownKey() }
          .onSuccess { promise.resolve(it) }
          .onFailure { promise.reject("ERR_TV_KEY", it.message ?: "No key for the TV", it) }
      }
    }

    /** While devices on the network play: the once a second, and with `keepAwake` the notification that keeps the app running. */
    AsyncFunction("zonesWatch") { ticking: Boolean, keepAwake: Boolean, title: String, text: String, playing: Boolean, volume: Int ->
      main.removeCallbacks(zoneTick)
      if (ticking) main.postDelayed(zoneTick, ZONE_TICK_MS)
      if (keepAwake) ZoneKeepAliveService.show(context, title, text, playing, volume)
      else ZoneKeepAliveService.hide(context)
    }.runOnQueue(Queues.MAIN)

    /** The volume of music on this phone, 0 to 1: for another device that steers it. */
    AsyncFunction("getMediaVolume") {
      val audio = context.getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
      val most = audio.getStreamMaxVolume(android.media.AudioManager.STREAM_MUSIC).coerceAtLeast(1)
      audio.getStreamVolume(android.media.AudioManager.STREAM_MUSIC).toDouble() / most
    }

    AsyncFunction("setMediaVolume") { level: Double ->
      val audio = context.getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
      val most = audio.getStreamMaxVolume(android.media.AudioManager.STREAM_MUSIC)
      audio.setStreamVolume(android.media.AudioManager.STREAM_MUSIC, Math.round(level.coerceIn(0.0, 1.0) * most).toInt(), 0)
    }

    /** While this phone steers another device, from the front: the volume keys are for that one. Below 0: they're this phone's again. */
    AsyncFunction("followVolumeKeys") { level: Int ->
      FollowVolumeKeys.set(context, level)
    }.runOnQueue(Queues.MAIN)

    /** What a touch or a gesture feels like: "tick", "press", "arm", "charge", "charged", "commit" or "cancel". */
    AsyncFunction("haptic") { kind: String ->
      Haptics.play(context, kind)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("appUpdateFetch") { url: String, fileName: String, sha256: String, size: Double ->
      AppUpdate.fetch(
        context,
        url,
        fileName,
        sha256,
        size.toLong(),
        progress = { sendEvent("onAppUpdate", mapOf("percent" to it)) },
        done = { sendEvent("onAppUpdate", mapOf("file" to it)) },
        failed = { sendEvent("onAppUpdate", mapOf("problem" to it)) }
      )
    }

    AsyncFunction("appUpdateInstall") { file: String ->
      AppUpdate.install(context, file)
    }

    AsyncFunction("appUpdateAllowed") {
      AppUpdate.allowed(context)
    }

    AsyncFunction("appUpdateAskToAllow") {
      AppUpdate.askToAllow(context)
    }

    AsyncFunction("appUpdateClear") {
      AppUpdate.clear(context)
    }

    AsyncFunction("downloadStart") { url: String, headers: Map<String, String>, fileName: String, wifiOnly: Boolean, label: String ->
      SongDownloads.start(context, url, headers, fileName, wifiOnly, label).toDouble()
    }

    AsyncFunction("downloadTexts") { texts: Map<String, String> ->
      SongDownloads.texts = texts
    }

    AsyncFunction("downloadQuery") { jobs: List<Double> ->
      SongDownloads.query(jobs.map { it.toLong() })
    }

    AsyncFunction("downloadFinish") { job: Double ->
      SongDownloads.finish(job.toLong())
    }

    AsyncFunction("downloadCancel") { job: Double ->
      SongDownloads.cancel(context, job.toLong())
    }

    AsyncFunction("downloadDelete") { path: String ->
      SongDownloads.delete(context, path)
    }

    AsyncFunction("downloadExisting") { paths: List<String> ->
      SongDownloads.existing(paths)
    }

    AsyncFunction("setQueue") { items: List<QueueItem>, startIndex: Int, startMs: Double, play: Boolean ->
      withPlayer { player ->
        player.setMediaItems(items.map { it.toMediaItem() }, startIndex, startMs.toLong())
        player.prepare()
        player.playWhenReady = play
      }
    }.runOnQueue(Queues.MAIN)

    /** Replaces everything after the playing song; the song itself plays on undisturbed. */
    AsyncFunction("replaceUpcoming") { items: List<QueueItem> ->
      withPlayer { player ->
        val next = player.currentMediaItemIndex + 1
        if (next < player.mediaItemCount) player.removeMediaItems(next, player.mediaItemCount)
        player.addMediaItems(items.map { it.toMediaItem() })
      }
    }.runOnQueue(Queues.MAIN)

    /** Another copy of the playing song, from the same place in it. */
    AsyncFunction("replaceCurrent") { item: QueueItem, positionMs: Double ->
      withPlayer { player ->
        val index = player.currentMediaItemIndex
        // A queue that had ended stays over: another copy of its last song is no reason to start again.
        if (player.playbackState == Player.STATE_ENDED) player.playWhenReady = false
        player.replaceMediaItem(index, item.toMediaItem())
        player.seekTo(index, positionMs.toLong())
        prepareIfIdle(player)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("addItems") { items: List<QueueItem> ->
      withPlayer { player -> player.addMediaItems(items.map { it.toMediaItem() }) }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("insertItems") { at: Int, items: List<QueueItem> ->
      withPlayer { player -> player.addMediaItems(at, items.map { it.toMediaItem() }) }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("removeItem") { index: Int ->
      withPlayer { player -> player.removeMediaItem(index) }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("moveItem") { from: Int, to: Int ->
      withPlayer { player -> player.moveMediaItem(from, to) }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("play") {
      withPlayer { player ->
        if (player.playbackState == Player.STATE_ENDED) player.seekToDefaultPosition(0)
        prepareIfIdle(player)
        player.play()
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("pause") {
      withPlayer { player -> player.pause() }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("seekTo") { positionMs: Double ->
      withPlayer { player -> player.seekTo(positionMs.toLong()) }
    }.runOnQueue(Queues.MAIN)

    /** To a song of the queue: playing, or as it was when a swipe leaves a paused player paused. */
    AsyncFunction("skipTo") { index: Int, play: Boolean ->
      withPlayer { player ->
        player.seekTo(index, 0)
        prepareIfIdle(player)
        player.playWhenReady = play
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("next") {
      withPlayer { player ->
        player.seekToNext()
        prepareIfIdle(player)
      }
    }.runOnQueue(Queues.MAIN)

    /** Back to the song's start, or to the song before when it has only just begun. */
    AsyncFunction("previous") {
      withPlayer { player ->
        player.seekToPrevious()
        prepareIfIdle(player)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setRepeat") { mode: String ->
      withPlayer { player ->
        player.repeatMode = when (mode) {
          "all" -> Player.REPEAT_MODE_ALL
          "one" -> Player.REPEAT_MODE_ONE
          else -> Player.REPEAT_MODE_OFF
        }
      }
    }.runOnQueue(Queues.MAIN)

    /** The service outlives the app's own screens: what it is doing right now. */
    AsyncFunction("getState") { promise: Promise ->
      withPlayer { player -> promise.resolve(stateOf(player)) }
    }.runOnQueue(Queues.MAIN)
  }
}

/** Runs the future's callback on the main thread, where the controller lives. */
private class ContextMainExecutor(private val handler: Handler) : java.util.concurrent.Executor {
  override fun execute(command: Runnable) {
    handler.post(command)
  }
}
