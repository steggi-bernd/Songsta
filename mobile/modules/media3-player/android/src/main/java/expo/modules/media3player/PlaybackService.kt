package expo.modules.media3player

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.media.MediaFormat
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.Renderer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.audio.AudioRendererEventListener
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.MediaCodecAudioRenderer
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import kotlin.math.min
import kotlin.math.pow

/** What the streams need from the app: where the server answers now, its other addresses, its login headers. */
object PlaybackAuth {
  @Volatile var server: String = ""
  @Volatile var addresses: List<String> = emptyList()
  @Volatile var headers: Map<String, String> = emptyMap()
}

private const val FADE_TICK_MS = 100L

/** What the sound is going through, for a look when something sounds off. */
object AudioInfo {
  @Volatile var decoder: String = ""
  @Volatile var output: String = ""
  /** a 24-bit file decodes to float and keeps its resolution up to the system's mixer */
  @Volatile var keep24Bit: Boolean = false
}

/**
 * Float is a choice, and only for files that have more than 16 bits to keep.
 * Everything else stays on the way every phone's decoders are used to. One phone
 * played a 24-bit song far too fast, maybe because of this; the emulator never did.
 */
@UnstableApi
private class SongRenderers(context: Context) : DefaultRenderersFactory(context) {
  override fun buildAudioRenderers(
    context: Context,
    extensionRendererMode: Int,
    mediaCodecSelector: MediaCodecSelector,
    enableDecoderFallback: Boolean,
    audioSink: AudioSink,
    eventHandler: Handler,
    eventListener: AudioRendererEventListener,
    out: ArrayList<Renderer>
  ) {
    out.add(object : MediaCodecAudioRenderer(context, codecAdapterFactory, mediaCodecSelector, enableDecoderFallback, eventHandler, eventListener, audioSink) {
      override fun getMediaFormat(format: Format, codecMimeType: String, codecMaxInputSize: Int, codecOperatingRate: Float): MediaFormat {
        val media = super.getMediaFormat(format, codecMimeType, codecMaxInputSize, codecOperatingRate)
        if (!AudioInfo.keep24Bit || !Util.isEncodingHighResolutionPcm(format.pcmEncoding)) {
          if (Build.VERSION.SDK_INT >= 29) media.removeKey(MediaFormat.KEY_PCM_ENCODING)
          else media.setInteger(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
        }
        return media
      }
    })
  }
}

const val GAIN_EXTRA = "gainDb"

/** What Settings asks of the sound; the service takes it whenever it runs. */
@UnstableApi
object PlaybackTuning {
  @Volatile var skipSilence = false
  @Volatile var speed = 1f
  @Volatile var fadeSeconds = 0
  @Volatile var seamless = true
  @Volatile var eqOn = false
  @Volatile var eqBands = IntArray(0)
  @Volatile var eqGains = FloatArray(0)
  /** Settings → Even out loud and quiet: a compressor and a limiter after the equalizer */
  @Volatile var evenOut = false
  @Volatile var service: PlaybackService? = null
}

/**
 * Plays the queue: one ExoPlayer in a media session, so it keeps going in the
 * background and answers the lock screen, the notification and headset
 * buttons. Songs in a row play without a gap.
 */
@UnstableApi
class PlaybackService : MediaSessionService() {
  private var session: MediaSession? = null
  private var exo: ExoPlayer? = null
  private var equalizer: SoundEqualizer? = null
  private val main = Handler(Looper.getMainLooper())
  /** the song's own level, from its leveling gain; a fade works on top of it */
  private var songVolume = 1f
  /** this song came in by a fade */
  private var fadeIn = false
  /** the album of the song that's playing, to tell if the next one runs straight on */
  private var playingAlbum: String? = null

  /** Ten times a second: near a song's end the volume goes down, at the next one's start up again. */
  private val fadeTick = object : Runnable {
    override fun run() {
      val player = exo ?: return
      val fade = PlaybackTuning.fadeSeconds * 1000L
      if (fade <= 0L) {
        player.volume = songVolume
        return
      }
      var part = 1f
      if (player.isPlaying) {
        val at = player.currentPosition
        val left = player.duration - at
        if (player.duration != C.TIME_UNSET && left < fade && fadesIntoNext(player)) part = left.toFloat() / fade
        if (fadeIn && at < fade) part = minOf(part, at.toFloat() / fade)
      }
      player.volume = songVolume * part.coerceIn(0f, 1f)
      main.postDelayed(this, FADE_TICK_MS)
    }
  }

  /** Something comes after it, and it isn't the next song of the same album, which should run on. */
  private fun fadesIntoNext(player: Player): Boolean {
    if (!player.hasNextMediaItem() || player.repeatMode == Player.REPEAT_MODE_ONE) return false
    return !runsOn(player.mediaMetadata.albumTitle?.toString(), player.getMediaItemAt(player.nextMediaItemIndex).mediaMetadata.albumTitle?.toString())
  }

  /** The next song of the same album, which plays without a break. */
  private fun runsOn(album: String?, next: String?): Boolean = PlaybackTuning.seamless && !album.isNullOrEmpty() && album == next

  /** What Settings says now. */
  fun applyTuning() {
    val player = exo ?: return
    player.skipSilenceEnabled = PlaybackTuning.skipSilence
    player.setPlaybackSpeed(PlaybackTuning.speed)
    equalizer?.apply(player.audioSessionId)
    main.removeCallbacks(fadeTick)
    if (PlaybackTuning.fadeSeconds > 0) main.post(fadeTick) else player.volume = songVolume
  }

  /** The playing song's level, from the leveling setting. */
  fun setSongVolume(volume: Float) {
    songVolume = volume
    if (PlaybackTuning.fadeSeconds <= 0) exo?.volume = volume
  }

  override fun onCreate() {
    super.onCreate()
    val http = DefaultHttpDataSource.Factory()
      .setAllowCrossProtocolRedirects(true)
      .setConnectTimeoutMs(15_000)
      .setReadTimeoutMs(30_000)
      .setTransferListener(Throughput)
    val streams = ResolvingDataSource.Factory(DefaultDataSource.Factory(this, http)) { spec ->
      val server = PlaybackAuth.server
      val uri = spec.uri.toString()
      // What's in the queue keeps the address it was made with; the server may answer elsewhere by now.
      val moved = PlaybackAuth.addresses.firstOrNull { it != server && uri.startsWith(it) }
      when {
        server.isEmpty() -> spec
        moved != null -> spec.withUri(Uri.parse(server + uri.substring(moved.length))).withAdditionalHeaders(PlaybackAuth.headers)
        // The login goes only to the server it belongs to.
        uri.startsWith(server) -> spec.withAdditionalHeaders(PlaybackAuth.headers)
        else -> spec
      }
    }
    // A kept MP3 from the server has no seek table: it seeks by its steady bitrate.
    val extractors = DefaultExtractorsFactory().setConstantBitrateSeekingEnabled(true)
    val renderers = SongRenderers(this).setEnableAudioFloatOutput(true)
    val player = ExoPlayer.Builder(this, renderers)
      .setMediaSourceFactory(DefaultMediaSourceFactory(streams, extractors))
      .setAudioAttributes(
        AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
        /* handleAudioFocus = */ true
      )
      .setHandleAudioBecomingNoisy(true)
      .setWakeMode(C.WAKE_MODE_NETWORK)
      .build()
    exo = player
    equalizer = SoundEqualizer()
    PlaybackTuning.service = this
    player.addListener(object : Player.Listener {
      override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        applyGain(player, mediaItem)
        val album = mediaItem?.mediaMetadata?.albumTitle?.toString()
        fadeIn = reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO && PlaybackTuning.fadeSeconds > 0 && !runsOn(playingAlbum, album)
        playingAlbum = album
      }

      override fun onAudioSessionIdChanged(audioSessionId: Int) {
        equalizer?.apply(audioSessionId)
      }

      override fun onIsPlayingChanged(isPlaying: Boolean) {
        main.removeCallbacks(fadeTick)
        if (isPlaying && PlaybackTuning.fadeSeconds > 0) main.post(fadeTick)
      }

      override fun onIsLoadingChanged(isLoading: Boolean) {
        if (!isLoading) Throughput.playerWaits()
      }
    })
    player.addAnalyticsListener(object : AnalyticsListener {
      override fun onAudioDecoderInitialized(eventTime: AnalyticsListener.EventTime, decoderName: String, initializedTimestampMs: Long, initializationDurationMs: Long) {
        AudioInfo.decoder = decoderName
      }

      override fun onAudioTrackInitialized(eventTime: AnalyticsListener.EventTime, audioTrackConfig: AudioSink.AudioTrackConfig) {
        val samples = when (audioTrackConfig.encoding) {
          C.ENCODING_PCM_16BIT -> "16-bit"
          C.ENCODING_PCM_24BIT -> "24-bit"
          C.ENCODING_PCM_32BIT -> "32-bit"
          C.ENCODING_PCM_FLOAT -> "float"
          else -> "encoding ${audioTrackConfig.encoding}"
        }
        val channels = Integer.bitCount(audioTrackConfig.channelConfig)
        AudioInfo.output = "${audioTrackConfig.sampleRate} Hz ${samples} ${channels}ch"
      }
    })

    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    val builder = MediaSession.Builder(this, player).setCallback(SessionCallback())
    if (open != null) builder.setSessionActivity(open)
    session = builder.build()
    applyTuning()
    // The app's mark in the status bar and on the media notification, not Media3's own.
    setMediaNotificationProvider(
      DefaultMediaNotificationProvider.Builder(this).build().apply { setSmallIcon(R.drawable.notification_mark) }
    )
  }

  /** Quieter songs stay as they are: a gain only ever lowers the volume, so nothing clips. */
  private fun applyGain(player: Player, item: MediaItem?) {
    val extras = item?.mediaMetadata?.extras
    val gain = if (extras?.containsKey(GAIN_EXTRA) == true) extras.getDouble(GAIN_EXTRA) else 0.0
    songVolume = min(1.0, 10.0.pow(gain / 20.0)).toFloat()
    if (PlaybackTuning.fadeSeconds <= 0) player.volume = songVolume
  }

  /** A controller's items carry their address in the request metadata; the player needs it as the URI. */
  private inner class SessionCallback : MediaSession.Callback {
    override fun onAddMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>
    ): ListenableFuture<MutableList<MediaItem>> {
      val playable = mediaItems.map { it.buildUpon().setUri(it.requestMetadata.mediaUri).build() }
      return Futures.immediateFuture(playable.toMutableList())
    }
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

  /** Swiped away from the recent apps: stops unless it is still playing. */
  override fun onTaskRemoved(rootIntent: Intent?) {
    val player = session?.player
    if (player == null || !player.playWhenReady || player.mediaItemCount == 0 || player.playbackState == Player.STATE_ENDED) {
      stopSelf()
    }
  }

  override fun onDestroy() {
    main.removeCallbacks(fadeTick)
    equalizer?.release()
    equalizer = null
    if (PlaybackTuning.service === this) PlaybackTuning.service = null
    exo = null
    session?.run {
      player.release()
      release()
    }
    session = null
    super.onDestroy()
  }
}
