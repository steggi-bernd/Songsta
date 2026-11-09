package expo.modules.media3player

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns

/** Files picked in Android's own dialogs, one to save to or one to open: the app's backup. */
object Documents {
  /** Its address, the name it's shown under and its size in bytes (-1 when the place doesn't say). */
  fun describe(context: Context, uri: Uri): Map<String, Any> {
    var name = uri.lastPathSegment ?: "file"
    var size = -1.0
    runCatching {
      context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { row ->
        if (row.moveToFirst()) {
          row.getString(0)?.let { name = it }
          if (!row.isNull(1)) size = row.getLong(1).toDouble()
        }
      }
    }
    return mapOf("uri" to uri.toString(), "name" to name, "size" to size)
  }

  /** The text, whole, in place of what was in it. */
  fun writeText(context: Context, uri: Uri, text: String) {
    val resolver = context.contentResolver
    // "wt" empties what was there; not every place knows it, and a new file is empty anyway.
    val out = runCatching { resolver.openOutputStream(uri, "wt") }.getOrNull()
      ?: resolver.openOutputStream(uri, "w")
      ?: error("That place can't be written to")
    out.use { it.write(text.toByteArray(Charsets.UTF_8)) }
  }
}
