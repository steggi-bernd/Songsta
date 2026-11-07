package expo.modules.media3player

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * A new version of the app: fetched from the release, checked against what the release says about it, and handed to
 * Android, which asks before it installs anything. Android only takes it if it's signed with the same key as what's
 * installed. Kept in the cache: it's of no use once it's in.
 */
internal object AppUpdate {
  private const val FOLDER = "updates"
  private const val BUFFER = 64 * 1024
  private const val TIMEOUT_MS = 30_000

  private fun folder(context: Context): File = File(context.cacheDir, FOLDER).apply { mkdirs() }

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(BUFFER)
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun matches(file: File, expectedSha256: String, expectedSize: Long): Boolean =
    file.isFile &&
      (expectedSize <= 0 || file.length() == expectedSize) &&
      (expectedSha256.isEmpty() || sha256(file).equals(expectedSha256, ignoreCase = true))

  /** On a thread of its own: it says how far it's come through `progress`, and how it ended through `done` (the file) or `failed`. */
  fun fetch(
    context: Context,
    url: String,
    fileName: String,
    expectedSha256: String,
    expectedSize: Long,
    progress: (Int) -> Unit,
    done: (String) -> Unit,
    failed: (String) -> Unit
  ) {
    val dir = folder(context)
    Thread({
      try {
        val target = File(dir, File(fileName).name)
        if (matches(target, expectedSha256, expectedSize)) {
          done(target.path)
          return@Thread
        }
        dir.listFiles()?.forEach { it.delete() }
        val part = File(dir, "${target.name}.part")
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = TIMEOUT_MS
        connection.readTimeout = TIMEOUT_MS
        connection.instanceFollowRedirects = true
        try {
          if (connection.responseCode != HttpURLConnection.HTTP_OK) throw IllegalStateException("The server answered ${connection.responseCode}")
          val total = connection.contentLengthLong.takeIf { it > 0 } ?: expectedSize
          var loaded = 0L
          var told = -1
          connection.inputStream.use { input ->
            FileOutputStream(part).use { output ->
              val buffer = ByteArray(BUFFER)
              while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                output.write(buffer, 0, read)
                loaded += read
                if (total > 0) {
                  val percent = (loaded * 100 / total).toInt().coerceAtMost(100)
                  if (percent != told) {
                    told = percent
                    progress(percent)
                  }
                }
              }
            }
          }
        } finally {
          connection.disconnect()
        }
        if (!matches(part, expectedSha256, expectedSize)) {
          part.delete()
          throw IllegalStateException("The download isn't what the release says it is")
        }
        if (!part.renameTo(target)) throw IllegalStateException("Couldn't keep the download")
        done(target.path)
      } catch (err: Exception) {
        failed(err.message ?: err.javaClass.simpleName)
      }
    }, "app-update").apply { isDaemon = true }.start()
  }

  /** Android's own screen takes it from here. Unless the phone already allows this app to install, it asks that first. */
  fun install(context: Context, path: String) {
    val file = File(path)
    require(file.isFile && file.parentFile?.canonicalPath == folder(context).canonicalPath) { "No such update" }
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.appupdate", file)
    val intent = Intent(Intent.ACTION_VIEW)
      .setDataAndType(uri, "application/vnd.android.package-archive")
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
  }

  /** Whether this app may hand Android something to install. Before Android 8 that was one switch for all apps. */
  fun allowed(context: Context): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()

  /** Android's own page for that switch. */
  fun askToAllow(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    context.startActivity(
      Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    )
  }

  fun clear(context: Context) {
    File(context.cacheDir, FOLDER).listFiles()?.forEach { it.delete() }
  }
}

/** Its own class: two providers of one class name can't sit in the same app, and Expo has one too. */
class AppUpdateFiles : FileProvider()
