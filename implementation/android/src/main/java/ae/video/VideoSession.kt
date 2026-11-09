package ae.video

import android.content.Context
import android.util.Log
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.track.CameraPosition
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.RemoteAudioTrack
import io.livekit.android.room.track.VideoCaptureParameter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class VideoSession internal constructor(
    private val context: Context,
    private val canCapture: () -> Boolean,
    private val roomFactory: (Context) -> Room,
    private val scope: CoroutineScope,
) {
    constructor(context: Context, canCapture: () -> Boolean) : this(
        context, canCapture, { LiveKit.create(it) }, CoroutineScope(SupervisorJob() + Dispatchers.Main),
    )
    private val _room = MutableStateFlow<Room?>(null)
    val room: StateFlow<Room?> = _room
    private val _micOn = MutableStateFlow(true)
    val micOn: StateFlow<Boolean> = _micOn
    private val _camOn = MutableStateFlow(true)
    val camOn: StateFlow<Boolean> = _camOn
    private val _camUsable = MutableStateFlow(true)
    val camUsable: StateFlow<Boolean> = _camUsable
    private val _paused = MutableStateFlow(false)
    val paused: StateFlow<Boolean> = _paused
    private val _failed = MutableStateFlow(false)
    val failed: StateFlow<Boolean> = _failed
    private var speakerOn = true
    private var backgrounded = false
    private val _held = MutableStateFlow(false)
    val held: StateFlow<Boolean> = _held
    private val _tracksVersion = MutableStateFlow(0)
    val tracksVersion: StateFlow<Int> = _tracksVersion
    private var events: Job? = null
    private var current: String? = null
    private var last: Triple<String, String, String>? = null

    fun connect(url: String, token: String, roomName: String) {
        if (!canCapture()) return
        last = Triple(url, token, roomName)
        _paused.value = false
        _failed.value = false
        if (current == roomName && _room.value != null) return
        disconnect()
        current = roomName
        val room = roomFactory(context)
        _room.value = room
        events = scope.launch {
            room.events.collect { e ->
                if (e is RoomEvent.TrackSubscribed) (e.track as? RemoteAudioTrack)?.setVolume(if (speakerOn) 1.0 else 0.0)
                when (e) {
                    is RoomEvent.TrackSubscribed, is RoomEvent.TrackUnsubscribed, is RoomEvent.TrackMuted, is RoomEvent.TrackUnmuted,
                    is RoomEvent.TrackUnpublished, is RoomEvent.ParticipantDisconnected, is RoomEvent.Reconnected, is RoomEvent.Disconnected -> _tracksVersion.value++
                    else -> Unit
                }
            }
        }
        scope.launch {
            room.videoTrackCaptureDefaults = LocalVideoTrackOptions(position = CameraPosition.FRONT, captureParams = VideoCaptureParameter(320, 240, 15))
            val joined = runCatching { room.connect(url, token) }
            if (joined.isFailure) {
                Log.w("VideoSession", "connect failed", joined.exceptionOrNull())
                if (_room.value === room) {
                    disconnect()
                    _failed.value = true
                }
                return@launch
            }
            if (_room.value !== room || !canCapture()) { room.disconnect(); return@launch }
            applySpeaker(room)
            runCatching { room.localParticipant.setMicrophoneEnabled(_micOn.value && !_held.value && canCapture()) }.onFailure { _micOn.value = false }
            if (_room.value !== room || !canCapture()) { room.disconnect(); return@launch }
            runCatching { room.localParticipant.setCameraEnabled(_camOn.value && !_held.value && !backgrounded && canCapture()) }.onFailure { _camOn.value = false; _camUsable.value = false }
            if (_room.value !== room || !canCapture()) { room.disconnect(); return@launch }
            _tracksVersion.value++
        }
    }

    fun setMic(on: Boolean) {
        if (!canCapture()) return
        _micOn.value = on
        scope.launch { _room.value?.localParticipant?.setMicrophoneEnabled(on && !_held.value && canCapture()) }
    }

    fun setCam(on: Boolean) {
        if (!canCapture()) return
        _camOn.value = on
        scope.launch { _room.value?.localParticipant?.setCameraEnabled(on && !_held.value && !backgrounded && canCapture()); _tracksVersion.value++ }
    }

    fun setSpeaker(on: Boolean) {
        speakerOn = on
        _room.value?.let { applySpeaker(it) }
    }

    private fun applySpeaker(room: Room) {
        for (p in room.remoteParticipants.values) for ((_, t) in p.audioTrackPublications) (t as? RemoteAudioTrack)?.setVolume(if (speakerOn) 1.0 else 0.0)
    }

    fun hold(on: Boolean) {
        if (_held.value == on) return
        _held.value = on
        scope.launch {
            val p = _room.value?.localParticipant ?: return@launch
            runCatching { p.setMicrophoneEnabled(_micOn.value && !on && canCapture()) }
            runCatching { p.setCameraEnabled(_camOn.value && !on && !backgrounded && canCapture()) }
            _tracksVersion.value++
        }
    }

    fun background() {
        backgrounded = true
        scope.launch { _room.value?.localParticipant?.setCameraEnabled(false); _tracksVersion.value++ }
    }

    fun foreground() {
        backgrounded = false
        scope.launch { _room.value?.localParticipant?.setCameraEnabled(_camOn.value && !_held.value && canCapture()); _tracksVersion.value++ }
    }

    fun pauseForIdle() {
        if (_room.value == null) return
        disconnect()
        _paused.value = true
    }

    fun resumeFromPause() {
        val l = last ?: return
        connect(l.first, l.second, l.third)
    }

    fun disconnect() {
        events?.cancel()
        events = null
        _room.value?.disconnect()
        _room.value?.release()
        _room.value = null
        current = null
        _tracksVersion.value++
    }

    fun forget() {
        disconnect()
        last = null
        _paused.value = false
        _failed.value = false
    }

    fun close() {
        forget()
        scope.cancel()
    }
}
