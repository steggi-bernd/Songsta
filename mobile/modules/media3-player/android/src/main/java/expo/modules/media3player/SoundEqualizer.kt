package expo.modules.media3player

import android.media.audiofx.DynamicsProcessing
import android.media.audiofx.Equalizer
import android.os.Build
import androidx.annotation.RequiresApi
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * The equalizer: the same ten bands as on the computer. Since Android 9 the system
 * can do exactly those; before that, its built-in bands, each with the nearest gain.
 *
 * Also "Even out loud and quiet" (Android 9 and later): after the equalizer, one
 * compressor over the whole range brings loud passages down and the quiet ones up
 * with them, and a limiter catches what's left at the top. Orchestras and film
 * music can lie 20 to 30 dB apart between a quiet passage and a climax; set for
 * the quiet one, the climax is far too loud. Off, the song plays as it was made.
 */
@UnstableApi
internal class SoundEqualizer {
  private var dynamics: Any? = null
  private var plain: Equalizer? = null
  private var session = C.AUDIO_SESSION_ID_UNSET
  /** what the running DynamicsProcessing was built with: its stages can't be added or taken away later */
  private var builtEq = false
  private var builtEvenOut = false

  fun apply(audioSession: Int) {
    if (audioSession != session) release()
    session = audioSession
    val evenOut = PlaybackTuning.evenOut && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
    val bands = PlaybackTuning.eqBands
    val gains = PlaybackTuning.eqGains
    val eqOn = PlaybackTuning.eqOn && bands.isNotEmpty() && bands.size == gains.size
    if ((!eqOn && !evenOut) || audioSession == C.AUDIO_SESSION_ID_UNSET) {
      release()
      return
    }
    runCatching {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) applyDynamics(audioSession, eqOn, bands, gains, evenOut)
      else applyPlain(audioSession, bands, gains)
    }
  }

  @RequiresApi(Build.VERSION_CODES.P)
  private fun applyDynamics(audioSession: Int, eqOn: Boolean, bands: IntArray, gains: FloatArray, evenOut: Boolean) {
    // A band reaches up to halfway to the next one, the last to the end of hearing.
    val edge = { i: Int -> if (i + 1 < bands.size) sqrt(bands[i].toFloat() * bands[i + 1]) else 20_000f }
    val running = dynamics as? DynamicsProcessing
    if (running != null && builtEq == eqOn && builtEvenOut == evenOut) {
      if (eqOn) for (i in bands.indices) running.setPreEqBandAllChannelsTo(i, DynamicsProcessing.EqBand(true, edge(i), gains[i]))
      return
    }
    if (running != null) release()
    val config = DynamicsProcessing.Config.Builder(
      DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION, 2,
      eqOn, if (eqOn) bands.size else 0,
      evenOut, if (evenOut) 1 else 0,
      false, 0,
      evenOut,
    )
      .setPreferredFrameDuration(10f)
      .build()
    if (eqOn) {
      val eq = DynamicsProcessing.Eq(true, true, bands.size)
      for (i in bands.indices) eq.setBand(i, DynamicsProcessing.EqBand(true, edge(i), gains[i]))
      config.setPreEqAllChannelsTo(eq)
    }
    if (evenOut) {
      val mbc = DynamicsProcessing.Mbc(true, true, 1)
      mbc.setBand(0, DynamicsProcessing.MbcBand(true, 20_000f, ATTACK_MS, RELEASE_MS, RATIO, THRESHOLD_DB, KNEE_DB, -90f, 1f, 0f, MAKEUP_DB))
      config.setMbcAllChannelsTo(mbc)
      config.setLimiterAllChannelsTo(DynamicsProcessing.Limiter(true, true, 0, 1f, 60f, 10f, CEILING_DB, 0f))
    }
    dynamics = DynamicsProcessing(0, audioSession, config).apply { enabled = true }
    builtEq = eqOn
    builtEvenOut = evenOut
  }

  private fun applyPlain(audioSession: Int, bands: IntArray, gains: FloatArray) {
    val eq = plain ?: Equalizer(0, audioSession).also { plain = it }
    val (lowest, highest) = eq.bandLevelRange.let { it[0].toInt() to it[1].toInt() }
    for (band in 0 until eq.numberOfBands) {
      val hz = eq.getCenterFreq(band.toShort()) / 1000
      val nearest = bands.indices.minByOrNull { abs(bands[it] - hz) } ?: continue
      eq.setBandLevel(band.toShort(), (gains[nearest] * 100).toInt().coerceIn(lowest, highest).toShort())
    }
    eq.enabled = true
  }

  fun release() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) (dynamics as? DynamicsProcessing)?.let { runCatching { it.release() } }
    dynamics = null
    builtEq = false
    builtEvenOut = false
    plain?.let { runCatching { it.release() } }
    plain = null
  }

  private companion object {
    /** Above this the compressor holds back: a third of what goes over it comes through. */
    const val THRESHOLD_DB = -28f
    const val RATIO = 3f
    const val KNEE_DB = 8f
    /** Quick enough for a crash of the orchestra, slow enough not to pump. */
    const val ATTACK_MS = 30f
    const val RELEASE_MS = 500f
    /** What everything is raised by afterwards, so the quiet passages come up. */
    const val MAKEUP_DB = 7f
    /** Nothing goes over this. */
    const val CEILING_DB = -1.5f
  }
}
