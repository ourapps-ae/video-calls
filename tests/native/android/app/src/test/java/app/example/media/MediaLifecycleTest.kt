package app.example.media

import ae.video.VideoSession
import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.mockito.Mockito.mock

@OptIn(ExperimentalCoroutinesApi::class)
class MediaLifecycleTest {
    private val dispatcher = StandardTestDispatcher()
    @Before fun prepare() { Dispatchers.setMain(dispatcher) }
    @After fun cleanup() { Dispatchers.resetMain() }

    @Test fun displayRejectsConnectionAndMediaControls() {
        val session = VideoSession(mock(Context::class.java)) { false }
        session.connect("wss://unused.invalid", "unused-fixture", "fixture")
        session.setMic(false)
        session.setCam(false)
        dispatcher.scheduler.runCurrent()
        assertNull(session.room.value)
        assertTrue(session.micOn.value)
        assertTrue(session.camOn.value)
        assertFalse(session.failed.value)
        session.close()
    }

    @Test fun holdAndBackgroundPreservePreferencesWithoutARoom() {
        val session = VideoSession(mock(Context::class.java)) { true }
        session.setMic(false)
        session.setCam(false)
        session.hold(true)
        session.background()
        dispatcher.scheduler.runCurrent()
        assertTrue(session.held.value)
        assertFalse(session.micOn.value)
        assertFalse(session.camOn.value)
        session.foreground()
        session.hold(false)
        dispatcher.scheduler.runCurrent()
        assertFalse(session.held.value)
        assertFalse(session.micOn.value)
        assertFalse(session.camOn.value)
        session.forget()
        assertNull(session.room.value)
        assertFalse(session.paused.value)
        assertFalse(session.failed.value)
        session.close()
    }
}
