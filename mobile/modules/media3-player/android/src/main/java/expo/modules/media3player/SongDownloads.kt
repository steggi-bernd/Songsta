package expo.modules.media3player

import android.app.DownloadManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.min

/**
 * Songs to keep on the phone, fetched by the app itself, over the same way and
 * with the same login as the player: Android's own download service stayed
 * silent on a real phone where playing worked fine. What's fetched so far stays
 * in a `.part` file, so a broken connection or a closed app goes on from there.
 * [SongDownloadService] keeps the process alive while the app is out of sight.
 */
internal object SongDownloads {
  private const val AT_A_TIME = 2
  private const val TRIES = 5
  private const val WIFI_LOOK_MS = 3000L

  private class Job(
    val id: Long,
    val url: String,
    val headers: Map<String, String>,
    val fileName: String,
    val wifiOnly: Boolean,
    /** the song's name, for the notification */
    val label: String
  ) {
    @Volatile var status = "waiting"
    @Volatile var reason = 0
    @Volatile var problem = ""
    @Volatile var loaded = 0L
    @Volatile var total = -1L
    @Volatile var file: File? = null
    @Volatile var cancelled = false
    /** when it last started fetching: the notification names the song that started last */
    @Volatile var startedAt = 0L
  }

  private class Refused(val code: Int) : IOException("The server answered $code")

  private val pool = Executors.newFixedThreadPool(AT_A_TIME) { work -> Thread(work, "song-download").apply { isDaemon = true } }
  private val jobs = ConcurrentHashMap<Long, Job>()
  private val nextId = AtomicLong(System.currentTimeMillis())

  private fun songs(context: Context): File =
    File(context.getExternalFilesDir(null) ?: context.filesDir, "songs").apply { mkdirs() }

  /**
   * The notification's words in the app's language, handed over by the app (stores/downloads.ts):
   * channel, loading, progress ("{done} of {total}"), doneOne, doneMany and failed ("{count}").
   */
  @Volatile var texts: Map<String, String> = emptyMap()

  fun text(key: String, fallback: String): String = texts[key]?.takeIf { it.isNotBlank() } ?: fallback

  /**
   * This round of downloads, by file: from the first song handed over while nothing was under
   * way to the last one through. Counted here, not by the app, whose timers stand still while
   * it's out of sight: "going", "done" or "failed". Its lock also guards [open] and starting
   * and stopping the service, so a song handed over just as the last one comes through can't
   * be left without it.
   */
  internal val round = LinkedHashMap<String, String>()

  /** Songs handed over whose turn hasn't come and gone yet, taken off ones too: at 0 the round is over. */
  private var open = 0

  /** How the round stands: songs through (done or failed), songs in it, songs done, songs failed. */
  fun roundCount(): IntArray = synchronized(round) {
    val done = round.values.count { it == "done" }
    val failed = round.values.count { it == "failed" }
    intArrayOf(done + failed, round.size, done, failed)
  }

  /** What the notification shows, worked out from the songs themselves whenever it looks. */
  class Standing(
    val through: Int,
    val all: Int,
    /** how far the songs being fetched are, each from 0 to 1, added up */
    val partly: Double,
    /** the song that started last, while one is being fetched */
    val song: String?,
    /** nothing is being fetched, and something waits for Wi-Fi */
    val forWifi: Boolean
  )

  fun standing(): Standing {
    val counts = roundCount()
    var partly = 0.0
    var song: String? = null
    var latest = Long.MIN_VALUE
    var forWifi = false
    for (job in jobs.values) {
      if (job.cancelled) continue
      if (job.status == "wifi") forWifi = true
      if (job.status != "running") continue
      val total = job.total
      if (total > 0) partly += min(1.0, job.loaded.toDouble() / total)
      if (job.startedAt > latest) {
        latest = job.startedAt
        song = job.label
      }
    }
    return Standing(counts[0], counts[1], partly, song, forWifi && song == null)
  }

  fun start(context: Context, url: String, headers: Map<String, String>, fileName: String, wifiOnly: Boolean, label: String): Long {
    val app = context.applicationContext
    val job = Job(nextId.incrementAndGet(), url, headers, fileName, wifiOnly, label)
    jobs[job.id] = job
    synchronized(round) {
      if (open == 0) round.clear()
      open += 1
      round[fileName] = "going"
      SongDownloadService.keepAlive(app)
    }
    SongDownloadService.nudge()
    pool.execute {
      run(app, job)
      // The round's count once it's over, read before a new round can start.
      val through = synchronized(round) {
        open -= 1
        // Taken off by hand: it doesn't count (cancel took it out of the round).
        if (!job.cancelled) round[job.fileName] = if (job.status == "done") "done" else "failed"
        if (open == 0) {
          SongDownloadService.letGo()
          roundCount()
        } else {
          null
        }
      }
      if (through != null) SongDownloadService.roundOver(app, through[2], through[3]) else SongDownloadService.nudge()
    }
    return job.id
  }

  private fun run(context: Context, job: Job) {
    val folder = songs(context)
    val done = File(folder, job.fileName)
    if (done.exists() && done.length() > 0) {
      // Fetched before, and the app closed before it heard.
      job.file = done
      job.status = "done"
      return
    }
    val part = File(folder, "${job.fileName}.part")
    var failures = 0
    while (!job.cancelled) {
      if (job.wifiOnly && isMetered(context)) {
        job.status = "wifi"
        Thread.sleep(WIFI_LOOK_MS)
        continue
      }
      try {
        job.status = "running"
        job.startedAt = System.nanoTime()
        SongDownloadService.nudge()
        fetch(job, part)
        if (job.cancelled) break
        if (!part.renameTo(done)) throw IOException("The finished file couldn't be moved")
        job.file = done
        job.status = "done"
        return
      } catch (err: Refused) {
        job.reason = err.code
        job.problem = when (err.code) {
          401, 403 -> "The server refused this login"
          404 -> "The server doesn't have this song any more"
          else -> "The server answered ${err.code}"
        }
        job.status = "failed"
        return
      } catch (err: IOException) {
        failures += 1
        job.problem = wordsFor(err)
        if (failures >= TRIES) {
          job.status = "failed"
          return
        }
        job.status = "waiting"
        Thread.sleep(min(30_000L, 2000L * failures))
      }
    }
    part.delete()
  }

  private fun fetch(job: Job, part: File) {
    val connection = URL(job.url).openConnection() as HttpURLConnection
    try {
      connection.connectTimeout = 15_000
      connection.readTimeout = 30_000
      job.headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
      connection.setRequestProperty("Accept-Encoding", "identity")
      val have = if (part.exists()) part.length() else 0L
      if (have > 0) connection.setRequestProperty("Range", "bytes=$have-")
      val code = connection.responseCode
      // Asked for what comes after the end: it was all there already.
      if (code == 416 && have > 0) return
      if (code != 200 && code != 206) throw Refused(code)
      val resuming = code == 206
      val length = connection.contentLengthLong
      job.total = if (length < 0) -1 else if (resuming) have + length else length
      job.loaded = if (resuming) have else 0
      FileOutputStream(part, resuming).use { out ->
        connection.inputStream.use { input ->
          val buffer = ByteArray(64 * 1024)
          while (!job.cancelled) {
            val count = input.read(buffer)
            if (count < 0) break
            out.write(buffer, 0, count)
            job.loaded += count
          }
        }
      }
      if (!job.cancelled && job.total > 0 && part.length() < job.total) throw IOException("The connection broke off")
    } finally {
      connection.disconnect()
    }
  }

  private fun wordsFor(err: IOException): String = when {
    err is UnknownHostException -> "Can't reach the server"
    err is SocketTimeoutException -> "The server stopped answering"
    err.message?.contains("ENOSPC") == true || err.message?.contains("No space") == true -> "There's no room left on the phone"
    else -> err.message ?: "The connection broke off"
  }

  private fun isMetered(context: Context): Boolean =
    context.getSystemService(ConnectivityManager::class.java).isActiveNetworkMetered

  /** How they stand; one this run of the app doesn't know isn't in the list. */
  fun query(ids: List<Long>): List<Map<String, Any>> = ids.mapNotNull { id ->
    jobs[id]?.let { job ->
      mapOf(
        "job" to job.id.toDouble(),
        "status" to job.status,
        "reason" to job.reason,
        "problem" to job.problem,
        "loaded" to job.loaded.toDouble(),
        "total" to job.total.toDouble()
      )
    }
  }

  /** The finished file; null when there is none after all. */
  fun finish(id: Long): Map<String, Any>? {
    val file = jobs.remove(id)?.file ?: return null
    return mapOf("file" to file.absolutePath, "bytes" to file.length().toDouble())
  }

  /** A number from before this run may still lie with Android's own download service, from older versions of the app. */
  fun cancel(context: Context, id: Long) {
    val job = jobs.remove(id)
    if (job != null) {
      job.cancelled = true
      File(songs(context), "${job.fileName}.part").delete()
      // Out of the count at once; its turn still comes and goes (start), and then the round may be over.
      synchronized(round) { round.remove(job.fileName) }
      SongDownloadService.nudge()
    } else {
      runCatching { context.getSystemService(DownloadManager::class.java).remove(id) }
    }
  }

  fun delete(context: Context, path: String) {
    val file = File(path)
    if (file.canonicalPath.startsWith(songs(context).canonicalPath + File.separator)) file.delete()
  }

  fun existing(paths: List<String>): List<String> = paths.filter { File(it).exists() }
}

/**
 * Keeps the app's process going while songs download and nobody is looking. Its notification
 * says how far the round is ("12 of 30 · Departure Bell", with a bar that moves along with the
 * songs being fetched), and when the round is through a note of its own says how many came and
 * how many didn't. Tapping either opens the app.
 *
 * The notification follows the songs from here, not from the app: a look every second, and one
 * right away when a song starts or comes through. It shows at once: newer Androids otherwise hold
 * a service's notification back for ten seconds, and songs were through before it said anything.
 * Android also takes only a handful of changes a second from an app and quietly drops the rest,
 * the last one too; so the service starts once per round instead of once per song, a change shows
 * at most every half second, and the latest one always does.
 */
class SongDownloadService : Service() {
  private val tick = object : Runnable {
    override fun run() {
      refreshSoon()
      main.postDelayed(this, TICK_MS)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val note = progressNote(this)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTE_ID, note.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    else startForeground(NOTE_ID, note.build())
    shown = note.key
    shownAt = SystemClock.uptimeMillis()
    synchronized(SongDownloads.round) {
      running = this
      starting = false
      // The round was over before the service came up. Only now: stopped before it went to the
      // foreground, Android would take the whole app down.
      if (!wanted) stopSelf()
    }
    main.removeCallbacks(tick)
    main.postDelayed(tick, TICK_MS)
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    main.removeCallbacks(tick)
    synchronized(SongDownloads.round) {
      if (running === this) running = null
    }
    shown = null
    // A count shown while it was stopping mustn't stay behind.
    runCatching { getSystemService(NotificationManager::class.java).cancel(NOTE_ID) }
    super.onDestroy()
  }

  /** Android's limit for this kind of work per day: what's fetched so far stays for later. */
  override fun onTimeout(startId: Int, fgsType: Int) {
    stopSelf()
  }

  /** A notification, with what tells it apart from the one shown before. */
  private class Note(val key: String, val build: () -> Notification)

  companion object {
    private const val NOTE_ID = 7402
    /** The note once a round is through, apart from the one that goes with the work. */
    private const val DONE_ID = 7403
    private const val CHANNEL = "downloads"
    private const val TICK_MS = 1000L
    /** Changes come at most this often; Android drops what comes faster than about five a second. */
    private const val GAP_MS = 500L

    private val main = Handler(Looper.getMainLooper())

    // Guarded by SongDownloads.round, like the round itself.
    private var running: SongDownloadService? = null
    /** asked to start for this round, and not asked to stop since */
    private var wanted = false
    /** asked to start, not up yet: songs handed over meanwhile don't ask again */
    private var starting = false

    // The main thread's own.
    private var shown: String? = null
    private var shownAt = 0L
    private var coming = false

    private fun builder(context: Context): Notification.Builder {
      val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val channel = NotificationChannel(CHANNEL, SongDownloads.text("channel", "Downloads"), NotificationManager.IMPORTANCE_LOW)
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        Notification.Builder(context, CHANNEL)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(context)
      }
      val open = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
        android.app.PendingIntent.getActivity(context, 0, it, android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT)
      }
      return builder.setSmallIcon(R.drawable.notification_mark).setContentIntent(open)
    }

    private fun progressNote(context: Context): Note {
      val now = SongDownloads.standing()
      val count = SongDownloads.text("progress", "{done} of {total}").replace("{done}", "${now.through}").replace("{total}", "${now.all}")
      val line = when {
        now.song != null -> "$count · ${now.song}"
        now.forWifi -> "$count · ${SongDownloads.text("wifi", "Waiting for Wi-Fi")}"
        else -> count
      }
      // The bar moves along with the songs being fetched, in thousandths of the round.
      val bar = if (now.all == 0) 0 else (((now.through + now.partly) / now.all) * 1000).toInt().coerceIn(0, 1000)
      val title = SongDownloads.text("loading", "Downloading songs")
      return Note("$title|$line|$bar") {
        val builder = builder(context)
          .setContentTitle(title)
          .setContentText(line)
          .setProgress(1000, bar, now.all == 0)
          .setOngoing(true)
          .setOnlyAlertOnce(true)
          .setShowWhen(false)
          .setCategory(Notification.CATEGORY_PROGRESS)
        // Shown at once, not after the ten seconds newer Androids wait with a service's notification.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        builder.build()
      }
    }

    /**
     * A round has songs: the service starts, once per round. Called with SongDownloads.round held.
     * Not allowed from the background on newer Androids: then it goes on for as long as the app is left alone.
     */
    fun keepAlive(context: Context) {
      // Up, or on its way up. Stopped by Android meanwhile (its daily limit), it starts again here.
      if (wanted && (running != null || starting)) return
      wanted = true
      starting = true
      runCatching {
        val intent = Intent(context, SongDownloadService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
      }.onFailure {
        wanted = false
        starting = false
      }
    }

    /** The round is over: the service stops. Called with SongDownloads.round held. */
    fun letGo() {
      wanted = false
      running?.stopSelf()
    }

    /** Something changed: the notification follows right away, or as soon as it may. */
    fun nudge() {
      main.post { refreshSoon() }
    }

    private fun refreshSoon() {
      if (coming) return
      val wait = GAP_MS - (SystemClock.uptimeMillis() - shownAt)
      if (wait <= 0) {
        refresh()
        return
      }
      coming = true
      main.postDelayed({
        coming = false
        refresh()
      }, wait)
    }

    private fun refresh() {
      val service = synchronized(SongDownloads.round) { running?.takeIf { wanted } } ?: return
      val note = progressNote(service)
      if (note.key == shown) return
      shown = note.key
      shownAt = SystemClock.uptimeMillis()
      runCatching { service.getSystemService(NotificationManager::class.java).notify(NOTE_ID, note.build()) }
    }

    /** The round is through: a note says how many came and how many didn't (the work's notification goes with the service). */
    fun roundOver(context: Context, done: Int, failed: Int) {
      if (done + failed == 0) return
      val missing = SongDownloads.text("failed", "{count} didn't download").replace("{count}", "$failed")
      val title = when {
        done == 1 -> SongDownloads.text("doneOne", "1 song downloaded")
        done > 1 -> SongDownloads.text("doneMany", "{count} songs downloaded").replace("{count}", "$done")
        else -> missing
      }
      val note = builder(context).setContentTitle(title).setAutoCancel(true)
      if (done > 0 && failed > 0) note.setContentText(missing)
      runCatching { context.getSystemService(NotificationManager::class.java).notify(DONE_ID, note.build()) }
    }
  }
}
