package expo.modules.media3player

import android.animation.ValueAnimator
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
 *
 * The page beneath shows through above it, under the shade PullDownToClose puts right before this
 * view: dark while the page has only just moved, lighter the further it goes, gone when it's down.
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
          shadeFor(translationY)
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
      MotionEvent.ACTION_MOVE -> {
        translationY = maxOf(0f, ev.rawY - downY)
        shadeFor(translationY)
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        velocity?.computeCurrentVelocity(1000)
        val vy = velocity?.yVelocity ?: 0f
        velocity?.recycle()
        velocity = null
        pulling = false
        NativeGestureUtil.notifyNativeGestureEnded(this, ev)
        val far = translationY > height * FAR_ENOUGH || (vy > flung && translationY > slop * 3)
        // The shade goes along with the page, frame by frame, on its way out or back.
        val follow = ValueAnimator.AnimatorUpdateListener { shadeFor(translationY) }
        if (ev.actionMasked == MotionEvent.ACTION_UP && far) {
          animate().translationY(height.toFloat()).setDuration(GO_MS).setUpdateListener(follow).withEndAction { onClose(mapOf<String, Any>()) }.start()
        } else {
          animate().translationY(0f).setDuration(BACK_MS).setInterpolator(DecelerateInterpolator()).setUpdateListener(follow).start()
        }
      }
    }
    return true
  }

  /** The shade PullDownToClose puts right before this view, over the page beneath. */
  private fun shade(): View? {
    val parent = parent as? ViewGroup ?: return null
    val at = parent.indexOfChild(this)
    return if (at > 0) parent.getChildAt(at - 1) else null
  }

  /** Dark while the page has only just moved, lighter the further it is down, clear once it's gone. */
  private fun shadeFor(down: Float) {
    val gone = (down / maxOf(1, height)).coerceIn(0f, 1f)
    shade()?.alpha = SHADE * (1f - gone)
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
    const val GO_MS = 200L
    const val BACK_MS = 220L
    /** How dark the page beneath is while this one has only just begun to move. */
    const val SHADE = 0.6f
  }
}
