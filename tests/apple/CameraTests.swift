import XCTest
import LiveKit

@MainActor
private final class MockCameraCapture: CameraCaptureProviding {
    struct Call: Equatable {
        let enabled: Bool
        let deviceID: String?
    }
    var found = [CameraDevice(id: "built-in", name: "Built-in Camera"), CameraDevice(id: "external", name: "External Camera")]
    var calls: [Call] = []
    var fail = false
    var suspendNext = false
    var suspended: CheckedContinuation<Void, Never>?
    func devices() async throws -> [CameraDevice] { found }
    func apply(enabled: Bool, deviceID: String?, in room: Room) async throws {
        calls.append(Call(enabled: enabled, deviceID: deviceID))
        if suspendNext {
            suspendNext = false
            await withCheckedContinuation { suspended = $0 }
        }
        if fail { throw NSError(domain: "CameraPermissionDenied", code: 1) }
    }
}

final class CameraTests: XCTestCase {
    @MainActor
    private func session(_ capture: MockCameraCapture, _ defaults: UserDefaults) -> VideoSession {
        VideoSession(cameraCapture: capture, defaults: defaults, soundOn: { true }, soundChanged: { _ in }, canCapture: { true })
    }

    @MainActor
    func testNamedSelectionPersistsAndReturnsAfterDisappearance() async throws {
        let domain = "CameraTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let capture = MockCameraCapture()
        let session = session(capture, defaults)
        await session.refreshCameras()
        XCTAssertEqual(session.cameras.map(\.name), ["Built-in Camera", "External Camera"])
        session.connected = true
        session.selectCamera("external")
        await session.waitForCameraUpdate()
        XCTAssertEqual(capture.calls.last, .init(enabled: true, deviceID: "external"))
        XCTAssertTrue(session.micOn)
        let restored = self.session(capture, defaults)
        await restored.refreshCameras()
        XCTAssertEqual(restored.availableCameraID, "external")
        capture.found.removeLast()
        await session.refreshCameras()
        await session.waitForCameraUpdate()
        XCTAssertEqual(capture.calls.last, .init(enabled: true, deviceID: nil))
        XCTAssertEqual(session.selectedCameraID, "external")
        capture.found.append(.init(id: "external", name: "External Camera"))
        await session.refreshCameras()
        await session.waitForCameraUpdate()
        XCTAssertEqual(capture.calls.last, .init(enabled: true, deviceID: "external"))
        session.selectCamera("")
        await session.waitForCameraUpdate()
        XCTAssertNil(defaults.string(forKey: "cameraDeviceID"))
        session.disconnect()
    }

    @MainActor
    func testForegroundAndReconnectUseSelectedCameraWithoutChangingMicPreference() async throws {
        let domain = "CameraTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let capture = MockCameraCapture()
        let session = session(capture, defaults)
        await session.refreshCameras()
        session.connected = true
        session.micOn = false
        session.selectCamera("external")
        await session.waitForCameraUpdate()
        session.background()
        await session.waitForCameraUpdate()
        XCTAssertEqual(capture.calls.last, .init(enabled: false, deviceID: "external"))
        session.foreground()
        await session.waitForCameraUpdate()
        XCTAssertEqual(capture.calls.last, .init(enabled: true, deviceID: "external"))
        session.disconnect()
        session.connected = true
        session.setCam(true)
        await session.waitForCameraUpdate()
        XCTAssertEqual(capture.calls.last, .init(enabled: true, deviceID: "external"))
        XCTAssertFalse(session.micOn)
        session.disconnect()
    }

    @MainActor
    func testFailureCanRetryWithoutDroppingRoomOrSavedSelection() async throws {
        let domain = "CameraTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let capture = MockCameraCapture()
        capture.fail = true
        let session = session(capture, defaults)
        await session.refreshCameras()
        session.connected = true
        session.selectCamera("external")
        await session.waitForCameraUpdate()
        XCTAssertTrue(session.cameraFailed)
        XCTAssertTrue(session.connected)
        XCTAssertEqual(session.selectedCameraID, "external")
        capture.fail = false
        session.selectCamera("built-in")
        await session.waitForCameraUpdate()
        XCTAssertFalse(session.cameraFailed)
        XCTAssertTrue(session.camUsable)
        session.disconnect()
    }

    @MainActor
    func testQueuedCameraSelectionCannotStartAfterBoardDisconnect() async throws {
        let domain = "CameraTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let capture = MockCameraCapture()
        let session = session(capture, defaults)
        await session.refreshCameras()
        session.connected = true
        capture.suspendNext = true
        session.selectCamera("external")
        for _ in 0..<100 where capture.suspended == nil { await Task.yield() }
        XCTAssertNotNil(capture.suspended)
        session.selectCamera("built-in")
        session.disconnect()
        capture.suspended?.resume()
        await session.waitForCameraUpdate()
        XCTAssertEqual(capture.calls, [.init(enabled: true, deviceID: "external")])
        XCTAssertFalse(session.connected)
    }
}
