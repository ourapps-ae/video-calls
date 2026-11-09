import AVFoundation
import LiveKit
import Observation

struct CameraDevice: Identifiable, Equatable {
    let id: String
    let name: String
}

@MainActor
protocol CameraCaptureProviding {
    func devices() async throws -> [CameraDevice]
    func apply(enabled: Bool, deviceID: String?, in room: Room) async throws
}

@MainActor
private struct LiveCameraCapture: CameraCaptureProviding {
    func devices() async throws -> [CameraDevice] {
        try await CameraCapturer.captureDevices().map { CameraDevice(id: $0.uniqueID, name: $0.localizedName) }
    }

    func apply(enabled: Bool, deviceID: String?, in room: Room) async throws {
        guard enabled else {
            try await room.localParticipant.setCamera(enabled: false)
            return
        }
        let devices = try await CameraCapturer.captureDevices()
        let device = deviceID.flatMap { id in devices.first { $0.uniqueID == id } }
            ?? devices.first { $0.position == .front } ?? devices.first
        let options = CameraCaptureOptions(device: device, position: .front, dimensions: Dimensions(width: 320, height: 240), fps: 15)
        if let track = room.localParticipant.videoTracks.first(where: { $0.source == .camera })?.track as? LocalVideoTrack,
           let capturer = track.capturer as? CameraCapturer,
           capturer.device?.uniqueID != device?.uniqueID {
            try await capturer.set(options: options)
        }
        try await room.localParticipant.setCamera(enabled: true, captureOptions: options)
    }
}

@Observable
@MainActor
final class VideoSession: RoomDelegate {
    private(set) var room = Room()
    private var generation = 0
    var connected = false
    var micOn = true
    var camOn = true
    private(set) var held = false
    var camUsable = true
    var tracksVersion = 0
    var paused = false
    private(set) var failure: String?
    private var current: String?
    private var last: (url: String, token: String, room: String)?
    private(set) var cameras: [CameraDevice] = []
    private(set) var selectedCameraID: String?
    private(set) var cameraFailed = false
    private var backgrounded = false
    private let cameraCapture: any CameraCaptureProviding
    private let cameraDefaults: UserDefaults
    private var cameraTask: Task<Void, Never>?
    private var discoveryGeneration = 0
    private let soundOn: () -> Bool
    private let soundChanged: (Bool) -> Void
    private let canCapture: () -> Bool

    init(cameraCapture: (any CameraCaptureProviding)? = nil, defaults: UserDefaults = .standard,
         soundOn: @escaping () -> Bool, soundChanged: @escaping (Bool) -> Void,
         canCapture: @escaping () -> Bool) {
        self.cameraCapture = cameraCapture ?? LiveCameraCapture()
        self.soundOn = soundOn
        self.soundChanged = soundChanged
        self.canCapture = canCapture
        cameraDefaults = defaults
        selectedCameraID = defaults.string(forKey: "cameraDeviceID")
        room.add(delegate: self)
    }

    static var offersCameraSelection: Bool {
        #if targetEnvironment(macCatalyst)
        true
        #elseif os(tvOS)
        false
        #else
        ProcessInfo.processInfo.isiOSAppOnMac
        #endif
    }

    var availableCameraID: String {
        guard let selectedCameraID, cameras.contains(where: { $0.id == selectedCameraID }) else { return "" }
        return selectedCameraID
    }

    func refreshCameras() async {
        discoveryGeneration += 1
        let expected = discoveryGeneration
        do {
            let found = try await cameraCapture.devices()
            guard expected == discoveryGeneration else { return }
            let changed = found != cameras
            cameras = found
            if changed && connected { updateCamera() }
        } catch {
            guard expected == discoveryGeneration else { return }
            cameras = []
            cameraFailed = true
        }
    }

    func selectCamera(_ id: String) {
        guard id.isEmpty || cameras.contains(where: { $0.id == id }) else { return }
        selectedCameraID = id.isEmpty ? nil : id
        cameraDefaults.set(selectedCameraID, forKey: "cameraDeviceID")
        updateCamera()
    }

    private func updateCamera() {
        let previous = cameraTask
        let activeRoom = room
        let expected = generation
        cameraTask = Task {
            await previous?.value
            guard expected == generation, connected else { return }
            do {
                try await setCameraEnabled(camOn && !held && !backgrounded && canCapture(), in: activeRoom)
                guard expected == generation else { await activeRoom.disconnect(); return }
                cameraFailed = false
                camUsable = true
                tracksVersion += 1
            } catch {
                guard expected == generation else { await activeRoom.disconnect(); return }
                cameraFailed = true
                camUsable = false
            }
        }
    }

    func waitForCameraUpdate() async { await cameraTask?.value }

    nonisolated func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) {
        Task { @MainActor in
            (publication.track as? RemoteAudioTrack)?.volume = self.soundOn() ? 1 : 0
            self.tracksVersion += 1
        }
    }

    func setSound(_ on: Bool) {
        soundChanged(on)
        for participant in room.remoteParticipants.values {
            for publication in participant.audioTracks { (publication.track as? RemoteAudioTrack)?.volume = on ? 1 : 0 }
        }
    }

    var canReconnect: Bool { !connected && last != nil && (paused || failure != nil) }

    nonisolated func room(_ room: Room, participant: RemoteParticipant, didUnsubscribeTrack publication: RemoteTrackPublication) {
        Task { @MainActor in self.tracksVersion += 1 }
    }
    nonisolated func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        Task { @MainActor in self.tracksVersion += 1 }
    }
    nonisolated func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        Task { @MainActor in self.tracksVersion += 1 }
    }
    nonisolated func room(_ room: Room, participant: LocalParticipant, didPublishTrack publication: LocalTrackPublication) {
        Task { @MainActor in self.tracksVersion += 1 }
    }
    nonisolated func room(_ room: Room, participant: LocalParticipant, didUnpublishTrack publication: LocalTrackPublication) {
        Task { @MainActor in self.tracksVersion += 1 }
    }
    nonisolated func room(_ room: Room, participant: Participant, trackPublication: TrackPublication, didUpdateIsMuted isMuted: Bool) {
        Task { @MainActor in self.tracksVersion += 1 }
    }

    func hasVideo(_ playerId: String, isMe: Bool) -> Bool {
        _ = tracksVersion
        guard connected else { return false }
        let participant: Participant? = isMe ? room.localParticipant : room.remoteParticipants.values.first { $0.identity?.stringValue == playerId }
        guard let pub = participant?.videoTracks.first(where: { $0.source == .camera }) else { return false }
        return !pub.isMuted && pub.track != nil && (!isMe || (camOn && !held))
    }

    func connect(url: String, token: String, roomName: String) {
        guard canCapture() else { return }
        last = (url, token, roomName)
        paused = false
        failure = nil
        if current == roomName && connected { return }
        generation += 1
        let expected = generation
        connected = false
        let oldRoom = room
        Task { await oldRoom.disconnect() }
        room = Room()
        room.add(delegate: self)
        let activeRoom = room
        current = roomName
        Task {
            guard expected == generation else { return }
            do {
                try await activeRoom.connect(url: url, token: token)
                guard expected == generation, canCapture() else { await activeRoom.disconnect(); return }
                connected = true
            } catch {
                guard expected == generation else { return }
                connected = false
                current = nil
                failure = error.localizedDescription
                return
            }
            do { try await activeRoom.localParticipant.setMicrophone(enabled: micOn && !held && canCapture()) } catch { if expected == generation { micOn = false } }
            guard expected == generation, canCapture() else { await activeRoom.disconnect(); return }
            await refreshCameras()
            guard expected == generation else { await activeRoom.disconnect(); return }
            updateCamera()
            if expected != generation { await activeRoom.disconnect() }
        }
    }

    private func setCameraEnabled(_ on: Bool, in activeRoom: Room) async throws {
        try await cameraCapture.apply(enabled: on, deviceID: availableCameraID.isEmpty ? nil : availableCameraID, in: activeRoom)
    }

    func setMic(_ on: Bool) {
        guard canCapture() else { return }
        micOn = on
        guard connected else { return }
        let activeRoom = room
        let expected = generation
        Task {
            guard expected == generation, connected else { return }
            _ = try? await activeRoom.localParticipant.setMicrophone(enabled: on && !held && canCapture())
            if expected != generation { await activeRoom.disconnect() }
        }
    }

    func setCam(_ on: Bool) {
        guard canCapture() else { return }
        camOn = on
        updateCamera()
    }

    func hold(_ on: Bool) {
        guard on != held else { return }
        held = on
        guard connected else { return }
        let activeRoom = room
        let expected = generation
        Task {
            guard expected == generation, connected else { return }
            _ = try? await activeRoom.localParticipant.setMicrophone(enabled: micOn && !on && canCapture())
            guard expected == generation else { await activeRoom.disconnect(); return }
            updateCamera()
            guard expected == generation else { await activeRoom.disconnect(); return }
            tracksVersion += 1
        }
    }

    func background() { backgrounded = true; updateCamera() }
    func foreground() {
        backgrounded = false
        updateCamera()
        Task { await refreshCameras() }
    }

    func pauseForIdle() {
        guard connected else { return }
        let saved = last
        disconnect()
        last = saved
        paused = true
    }

    func resumeFromPause() {
        guard let l = last else { return }
        connect(url: l.url, token: l.token, roomName: l.room)
    }

    func disconnect() {
        generation += 1
        current = nil
        connected = false
        last = nil
        failure = nil
        let activeRoom = room
        Task { await activeRoom.disconnect() }
    }
}
