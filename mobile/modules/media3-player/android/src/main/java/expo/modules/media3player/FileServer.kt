package expo.modules.media3player

import android.content.Context
import android.content.res.AssetFileDescriptor
import android.net.Uri
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.Executors
import kotlin.concurrent.thread

/**
 * Songs from this phone's own folders, for a speaker, receiver or TV on the same network: it fetches
 * them from here, as it would from a server. Only what was handed to a device, under a name nobody can
 * guess, and only to addresses of the local network. It runs while devices play from here, the way the
 * computer's cast.ts serves its files.
 */
internal class FileServer(private val context: Context) {
  private class Shared(val uri: Uri, val mime: String)

  /** The last songs handed out, newest kept: a device asks again for the song it plays, now and then. */
  private val shared = object : LinkedHashMap<String, Shared>(32, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Shared>?): Boolean = size > KEEP
  }
  private var server: ServerSocket? = null
  private val workers = Executors.newCachedThreadPool()
  private val random = SecureRandom()

  /** Where a device on the network fetches this file: an address of this phone it can reach. */
  fun share(uri: String, mime: String, ext: String, deviceHost: String): String {
    val own = ownAddressFor(deviceHost) ?: error("This phone has no way to that device")
    val port = start()
    val token = ByteArray(16).also(random::nextBytes).joinToString("") { "%02x".format(it) }
    synchronized(shared) { shared[token] = Shared(Uri.parse(uri), mime) }
    val name = ext.lowercase().takeIf { Regex("^[a-z0-9]{1,5}$").matches(it) } ?: "bin"
    return "http://$own:$port/song/$token.$name"
  }

  /** Nothing is handed out from here any more. */
  @Synchronized
  fun stop() {
    runCatching { server?.close() }
    server = null
    synchronized(shared) { shared.clear() }
  }

  @Synchronized
  private fun start(): Int {
    server?.takeIf { !it.isClosed }?.let { return it.localPort }
    // IPv4 on every network this phone is on; who may ask is checked for each connection.
    val any = InetAddress.getByName("0.0.0.0")
    val socket = runCatching { ServerSocket(PORT, BACKLOG, any) }.getOrElse { ServerSocket(0, BACKLOG, any) }
    server = socket
    thread(name = "songsta-files", isDaemon = true) { accept(socket) }
    return socket.localPort
  }

  private fun accept(socket: ServerSocket) {
    while (!socket.isClosed) {
      val client = try {
        socket.accept()
      } catch (e: IOException) {
        break
      }
      val from = client.inetAddress
      if (!(from.isSiteLocalAddress || from.isLinkLocalAddress || from.isLoopbackAddress)) {
        runCatching { client.close() }
        continue
      }
      workers.execute {
        runCatching { serve(client) }
        runCatching { client.close() }
      }
    }
  }

  private fun serve(client: Socket) {
    client.soTimeout = READ_TIMEOUT_MS
    val head = readHead(BufferedInputStream(client.getInputStream())) ?: return
    val lines = head.split("\r\n")
    val request = lines.first().split(" ")
    val out = client.getOutputStream()
    if (request.size < 2) return reply(out, "400 Bad Request")
    val method = request[0]
    if (method != "GET" && method != "HEAD") return reply(out, "405 Method Not Allowed")
    val token = SONG_PATH.find(request[1])?.groupValues?.get(1)
    val file = token?.let { synchronized(shared) { shared[it] } } ?: return reply(out, "404 Not Found")
    val asked = lines.drop(1).firstOrNull { it.startsWith("range:", ignoreCase = true) }?.substringAfter(":")?.trim()
    val afd = runCatching { context.contentResolver.openAssetFileDescriptor(file.uri, "r") }.getOrNull() ?: return reply(out, "404 Not Found")
    afd.use {
      val size = if (afd.length != AssetFileDescriptor.UNKNOWN_LENGTH) afd.length else afd.parcelFileDescriptor.statSize
      if (size < 0) return reply(out, "500 Internal Server Error")
      val range = rangeOf(asked, size) ?: return reply(out, "416 Range Not Satisfiable", "Content-Range: bytes */$size\r\n")
      val length = range.last - range.first + 1
      val partial = asked != null
      val headers = StringBuilder()
        .append("HTTP/1.1 ").append(if (partial) "206 Partial Content" else "200 OK").append("\r\n")
        .append("Content-Type: ").append(file.mime).append("\r\n")
        .append("Content-Length: ").append(length).append("\r\n")
        .append("Accept-Ranges: bytes\r\n")
      if (partial) headers.append("Content-Range: bytes ${range.first}-${range.last}/$size\r\n")
      headers
        .append("transferMode.dlna.org: Streaming\r\n")
        .append("contentFeatures.dlna.org: DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000\r\n")
        .append("Connection: close\r\n\r\n")
      out.write(headers.toString().toByteArray(Charsets.ISO_8859_1))
      if (method == "HEAD" || length <= 0) return out.flush()
      FileInputStream(afd.fileDescriptor).use { stream ->
        stream.channel.position(afd.startOffset + range.first)
        val buffer = ByteArray(CHUNK)
        var left = length
        while (left > 0) {
          val read = stream.read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
          if (read < 0) break
          out.write(buffer, 0, read)
          left -= read
        }
        out.flush()
      }
    }
  }

  /** The request's head, up to the empty line; null when it never comes or is too long. */
  private fun readHead(input: InputStream): String? {
    val bytes = ByteArrayOutputStream()
    var matched = 0
    while (bytes.size() < MAX_HEAD) {
      val b = input.read()
      if (b < 0) return null
      bytes.write(b)
      matched = when {
        b == HEAD_END[matched].toInt() -> matched + 1
        b == HEAD_END[0].toInt() -> 1
        else -> 0
      }
      if (matched == HEAD_END.size) return bytes.toString("ISO-8859-1")
    }
    return null
  }

  private fun reply(out: OutputStream, status: String, extra: String = "") {
    out.write("HTTP/1.1 $status\r\nContent-Length: 0\r\nConnection: close\r\n$extra\r\n".toByteArray(Charsets.ISO_8859_1))
    out.flush()
  }

  /** The address of this phone on the way to that device. */
  private fun ownAddressFor(host: String): String? = runCatching {
    DatagramSocket().use { socket ->
      runCatching { LocalNet.lan(context)?.bindSocket(socket) }
      socket.connect(InetAddress.getByName(host), DISCARD_PORT)
      (socket.localAddress as? Inet4Address)?.takeIf { !it.isAnyLocalAddress }?.hostAddress
    }
  }.getOrNull()

  internal companion object {
    private const val PORT = 8188
    private const val BACKLOG = 16
    private const val KEEP = 64
    private const val CHUNK = 64 * 1024
    private const val MAX_HEAD = 8 * 1024
    private const val READ_TIMEOUT_MS = 15_000
    private const val DISCARD_PORT = 9
    private val HEAD_END = byteArrayOf(13, 10, 13, 10)
    private val SONG_PATH = Regex("^/song/([0-9a-f]{32})(\\.[a-z0-9]{1,5})?$")

    /** What a device asked for, as bytes of the file: all of it without a range. Null when it can't be had. */
    fun rangeOf(header: String?, size: Long): LongRange? {
      if (header == null) return 0L..(size - 1)
      if (!header.startsWith("bytes=", ignoreCase = true)) return null
      val spec = header.substring(6).split(",").first().trim()
      val dash = spec.indexOf('-')
      if (dash < 0) return null
      val from = spec.substring(0, dash).trim()
      val to = spec.substring(dash + 1).trim()
      val first: Long
      val last: Long
      if (from.isEmpty()) {
        val suffix = to.toLongOrNull() ?: return null
        if (suffix <= 0) return null
        first = maxOf(0L, size - suffix)
        last = size - 1
      } else {
        first = from.toLongOrNull() ?: return null
        last = if (to.isEmpty()) size - 1 else (to.toLongOrNull() ?: return null).coerceAtMost(size - 1)
      }
      if (first < 0 || first > last || first >= size) return null
      return first..last
    }
  }
}
