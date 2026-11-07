package expo.modules.media3player

import android.annotation.SuppressLint
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.SystemClock
import android.util.Base64
import java.net.DatagramPacket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.NetworkInterface
import java.net.Socket
import java.net.SocketTimeoutException
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.KeyManager
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager
import kotlin.concurrent.thread
import kotlin.math.min

/** The local network itself: questions over UDP for what's around (the answers are read in JavaScript, by the code the computer uses too). */
internal object LocalNet {
  private const val ASK_AGAIN_AFTER_MS = 700L

  /** The Wi-Fi or cable this phone is on; mobile data has nothing of ours on it. */
  @Suppress("DEPRECATION")
  fun lan(context: Context): Network? {
    val manager = context.getSystemService(ConnectivityManager::class.java)
    return manager.allNetworks.firstOrNull { network ->
      val caps = manager.getNetworkCapabilities(network)
      caps != null && (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
    }
  }

  /** Sends one question, twice since UDP may lose it, and takes every answer within the time. Null when there's no such network. */
  fun ask(context: Context, address: String, port: Int, question: ByteArray, waitMs: Int): List<Map<String, String>>? {
    val network = lan(context) ?: return null
    val wifi = context.applicationContext.getSystemService(WifiManager::class.java)
    val lock = wifi?.createMulticastLock("songsta-look-around")?.apply { setReferenceCounted(false) }
    runCatching { lock?.acquire() }
    val socket = MulticastSocket(0)
    try {
      runCatching { network.bindSocket(socket) }
      val manager = context.getSystemService(ConnectivityManager::class.java)
      manager.getLinkProperties(network)?.interfaceName?.let { name ->
        runCatching { socket.networkInterface = NetworkInterface.getByName(name) }
      }
      val packet = DatagramPacket(question, question.size, InetSocketAddress(address, port))
      val started = SystemClock.elapsedRealtime()
      var askedAgain = false
      socket.send(packet)
      val answers = mutableListOf<Map<String, String>>()
      val buffer = ByteArray(9000)
      while (true) {
        val passed = SystemClock.elapsedRealtime() - started
        if (passed >= waitMs) break
        if (!askedAgain && passed >= ASK_AGAIN_AFTER_MS) {
          askedAgain = true
          runCatching { socket.send(packet) }
        }
        val until = if (askedAgain) waitMs.toLong() else min(waitMs.toLong(), ASK_AGAIN_AFTER_MS)
        socket.soTimeout = (until - passed).coerceAtLeast(1).toInt()
        try {
          val answer = DatagramPacket(buffer, buffer.size)
          socket.receive(answer)
          answers += mapOf(
            "from" to (answer.address?.hostAddress ?: ""),
            "data" to Base64.encodeToString(answer.data, answer.offset, answer.length, Base64.NO_WRAP)
          )
        } catch (_: SocketTimeoutException) {
          // The time is up, or it's time to ask again.
        }
      }
      return answers
    } finally {
      socket.close()
      runCatching { lock?.release() }
    }
  }
}

/** Encrypted connections to Cast devices. JavaScript speaks the protocol (lib/castV2.ts); this only carries its bytes. */
internal class LanSockets(private val context: Context, private val report: (Map<String, Any?>) -> Unit) {
  private class Open(val socket: Socket, val writer: ExecutorService)

  private val open = ConcurrentHashMap<Int, Open>()
  private val nextId = AtomicInteger(1)

  /** Blocks until connected. With `asThisApp` it shows this app's own certificate, for a TV's remote control. */
  fun connect(host: String, port: Int, asThisApp: Boolean = false): Int {
    val address = InetAddress.getByName(host)
    require(address.isSiteLocalAddress || address.isLinkLocalAddress || address.isLoopbackAddress) { "That device isn't on the local network" }
    val raw = Socket()
    runCatching { LocalNet.lan(context)?.bindSocket(raw) }
    raw.connect(InetSocketAddress(address, port), CONNECT_MS)
    val context = if (asThisApp) anyCertificate(TvIdentity.keyManagers()) else anyCertificate()
    val socket = context.socketFactory.createSocket(raw, host, port, true) as SSLSocket
    socket.soTimeout = 0
    socket.startHandshake()
    val id = nextId.getAndIncrement()
    open[id] = Open(socket, Executors.newSingleThreadExecutor())
    thread(name = "cast-socket-$id", isDaemon = true) { read(id, socket) }
    return id
  }

  private fun read(id: Int, socket: Socket) {
    val buffer = ByteArray(16 * 1024)
    runCatching {
      val input = socket.getInputStream()
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        report(mapOf("id" to id, "data" to Base64.encodeToString(buffer, 0, count, Base64.NO_WRAP)))
      }
    }
    close(id)
  }

  fun write(id: Int, bytes: ByteArray) {
    val target = open[id] ?: return
    target.writer.execute {
      runCatching {
        val out = target.socket.getOutputStream()
        out.write(bytes)
        out.flush()
      }.onFailure { close(id) }
    }
  }

  fun close(id: Int) {
    val target = open.remove(id) ?: return
    runCatching { target.socket.close() }
    target.writer.shutdown()
    report(mapOf("id" to id, "closed" to true))
  }

  fun closeAll() {
    open.keys.toList().forEach(::close)
  }

  /** The key on the other side's certificate: a TV's pairing code is made of it. */
  fun peerKey(id: Int): Map<String, String>? {
    val socket = open[id]?.socket as? SSLSocket ?: return null
    return TvIdentity.partsOf(socket.session.peerCertificates[0].publicKey)
  }

  /** Cast devices carry certificates only Google's own apps check; this never leaves the local network (see connect). */
  @SuppressLint("CustomX509TrustManager", "TrustAllX509TrustManager")
  private fun anyCertificate(keys: Array<KeyManager>? = null): SSLContext {
    val anyone = object : X509TrustManager {
      override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
      override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
      override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
    return SSLContext.getInstance("TLS").apply { init(keys, arrayOf(anyone), SecureRandom()) }
  }

  private companion object {
    const val CONNECT_MS = 6000
  }
}
