package app.example.media

import ae.video.VideoSession
import android.content.Context
import io.livekit.android.events.BroadcastEventBus
import io.livekit.android.events.RoomEvent
import io.livekit.android.room.Room
import io.livekit.android.room.participant.LocalParticipant
import io.livekit.android.room.track.LocalAudioTrackOptions
import io.livekit.android.room.track.LocalVideoTrackOptions
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.StandardTestDispatcher
import org.junit.Assert.*
import org.junit.Test
import org.mockito.Mockito.*
import kotlin.coroutines.Continuation
import kotlin.coroutines.intrinsics.COROUTINE_SUSPENDED
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

// Local simulation exercises the real session against controlled LiveKit objects.
@OptIn(ExperimentalCoroutinesApi::class)
class RoomLifecycleTest {
    private class Harness {
        val dispatcher = StandardTestDispatcher()
        val job = SupervisorJob()
        val scope = CoroutineScope(job + dispatcher)
        val participant = mock(LocalParticipant::class.java) { call ->
            when (call.method.name) {
                "getAudioTrackCaptureDefaults" -> LocalAudioTrackOptions()
                "getVideoTrackCaptureDefaults" -> LocalVideoTrackOptions()
                "setMicrophoneEnabled", "setCameraEnabled" -> true
                else -> RETURNS_DEFAULTS.answer(call)
            }
        }
        val events = BroadcastEventBus<RoomEvent>()
        var pending: Continuation<Nothing?>? = null
        var connects = 0
        var capture = true
        val room = mock(Room::class.java) { call ->
            when (call.method.name) {
                "getEvents" -> events.readOnly()
                "getLocalParticipant" -> participant
                "getRemoteParticipants" -> emptyMap<Any, Any>()
                "connect" -> {
                    connects++
                    @Suppress("UNCHECKED_CAST")
                    pending = call.rawArguments.last() as Continuation<Nothing?>
                    COROUTINE_SUSPENDED
                }
                else -> RETURNS_DEFAULTS.answer(call)
            }
        }
        val session = VideoSession(mock(Context::class.java), { capture }, { room }, scope)
        fun advance() { dispatcher.scheduler.runCurrent() }
        fun connect() { session.connect("wss://unused.invalid", "fixture", "room"); advance() }
        fun joined() { pending!!.resume(null); pending = null; advance() }
        fun calls(name: String): List<Boolean> = mockingDetails(participant).invocations
            .filter { it.method.name == name }.map { it.arguments[0] as Boolean }
    }

    @Test fun lateJoinAfterForgetCannotEnableCapture() {
        val h = Harness()
        h.connect()
        h.session.forget()
        h.joined()
        assertNull(h.session.room.value)
        assertTrue(h.calls("setMicrophoneEnabled").isEmpty())
        assertTrue(h.calls("setCameraEnabled").isEmpty())
        verify(h.room, atLeastOnce()).disconnect()
        verify(h.room).release()
        h.session.close()
        assertFalse(h.job.isActive)
    }

    @Test fun backgroundHoldAndIdleRetainPreferencesAndGrant() {
        val h = Harness()
        h.connect(); h.joined()
        assertEquals(listOf(true), h.calls("setMicrophoneEnabled"))
        assertEquals(listOf(true), h.calls("setCameraEnabled"))
        h.session.background(); h.advance()
        assertEquals(false, h.calls("setCameraEnabled").last())
        assertEquals(listOf(true), h.calls("setMicrophoneEnabled"))
        h.session.hold(true); h.advance()
        assertTrue(h.session.micOn.value)
        assertTrue(h.session.camOn.value)
        h.session.foreground(); h.advance()
        assertEquals(false, h.calls("setCameraEnabled").last())
        h.session.hold(false); h.advance()
        assertEquals(true, h.calls("setMicrophoneEnabled").last())
        assertEquals(true, h.calls("setCameraEnabled").last())
        h.session.pauseForIdle()
        assertTrue(h.session.paused.value)
        h.session.resumeFromPause(); h.advance()
        assertEquals(2, h.connects)
        h.joined()
        h.session.close()
        assertFalse(h.job.isActive)
    }

    @Test fun failureCanRetryAndDisplayDeniesLateCapture() {
        val h = Harness()
        h.connect()
        h.pending!!.resumeWithException(IllegalStateException("fixture failure"))
        h.pending = null
        h.advance()
        assertTrue(h.session.failed.value)
        assertNull(h.session.room.value)
        h.session.resumeFromPause(); h.advance()
        assertEquals(2, h.connects)
        assertFalse(h.session.failed.value)
        h.capture = false
        h.joined()
        assertTrue(h.calls("setMicrophoneEnabled").isEmpty())
        assertTrue(h.calls("setCameraEnabled").isEmpty())
        h.session.forget()
        h.session.close()
    }
}
