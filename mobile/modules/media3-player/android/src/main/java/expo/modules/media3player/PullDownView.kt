package expo.modules.media3player

import android.content.Context
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import com.facebook.react.uimanager.events.NativeGestureUtil
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.abs

/**
 * A page closed by pulling it down, as the player is (components/PullDownToClose.tsx). It looks at a
 * drag before the list inside does, and takes it only when it goes down and no list in it can scroll
 * up any more; then it follows the finger, and past a quarter of its height, or flung, it goes down
 * and says so. Everything else, scrolling and sideways swipes, stays the list's own. Android hands a
 * drag to a scrolling list before JavaScript sees it, so this has to be a view of its own.
 */
class PullDownView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onClose by EventDispatcher()
  private val slop = ViewConfiguration.get(context).scaledTouchSlop
  private val flung = ViewConfiguration.get(context).scaledMinimumFlingVelocity * FLUNG_TIMES
  private var downX = 0f
  private var downY = 0f
  private var pulling = false
  private var velocity: VelocityTracker? = null

  override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = ev.rawX
        downY = ev.rawY
        pulling = false
      }
      MotionEvent.ACTION_MOVE -> {
        val dy = ev.rawY - downY
        val dx = ev.rawX - downX
        if (!pulling && dy > slop && dy > abs(dx) * 1.5f && !canScrollUp(this)) {
          pulling = true
          // From here on, without a jump by the slop.
          downY = ev.rawY
          animate().cancel()
          velocity = VelocityTracker.obtain()
          NativeGestureUtil.notifyNativeGestureStarted(this, ev)
          return true
        }
      }
    }
    return false
  }

  override fun onTouchEvent(ev: MotionEvent): Boolean {
    if (!pulling) return false
    // In screen terms: the view moves under the finger.
    val screen = MotionEvent.obtain(ev).apply { offsetLocation(ev.rawX - ev.x, ev.rawY - ev.y) }
    velocity?.addMovement(screen)
    screen.recycle()
    when (ev.actionMasked) {
      MotionEvent.ACTION_MOVE -> translationY = maxOf(0f, ev.rawY - downY)
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        velocity?.computeCurrentVelocity(1000)
        val vy = velocity?.yVelocity ?: 0f
        velocity?.recycle()
        velocity = null
        pulling = false
        NativeGestureUtil.notifyNativeGestureEnded(this, ev)
        val far = translationY > height * FAR_ENOUGH || (vy > flung && translationY > slop * 3)
        if (ev.actionMasked == MotionEvent.ACTION_UP && far) {
          animate().translationY(height.toFloat()).setDuration(GO_MS).withEndAction { onClose(mapOf<String, Any>()) }.start()
        } else {
          animate().translationY(0f).setDuration(BACK_MS).setInterpolator(DecelerateInterpolator()).start()
        }
      }
    }
    return true
  }

  /** Some list in here can still scroll up, at the place it shows. */
  private fun canScrollUp(view: View): Boolean {
    if (view !== this && view.isShown && view.canScrollVertically(-1)) return true
    if (view is ViewGroup) for (i in 0 until view.childCount) if (canScrollUp(view.getChildAt(i))) return true
    return false
  }

  private companion object {
    const val FAR_ENOUGH = 0.25f
    const val FLUNG_TIMES = 8
    const val GO_MS = 170L
    const val BACK_MS = 220L
  }
}
