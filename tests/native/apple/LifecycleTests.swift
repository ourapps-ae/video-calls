import XCTest

final class MediaLifecycleTests: XCTestCase {
    @MainActor
    func testDisplayDoesNotStartConnection() {
        let session = VideoSession(soundOn: { true }, soundChanged: { _ in }, canCapture: { false })
        session.connect(url: "wss://unused.invalid", token: "unused-fixture", roomName: "fixture")
        session.setMic(false)
        session.setCam(false)
        XCTAssertFalse(session.connected)
        XCTAssertFalse(session.canReconnect)
        XCTAssertTrue(session.micOn)
        XCTAssertTrue(session.camOn)
        session.disconnect()
    }

    @MainActor
    func testSoundCallbackAndDisconnectState() {
        var sound = true
        let session = VideoSession(soundOn: { sound }, soundChanged: { sound = $0 }, canCapture: { true })
        session.setSound(false)
        XCTAssertFalse(sound)
        session.setSound(true)
        XCTAssertTrue(sound)
        session.disconnect()
        XCTAssertFalse(session.connected)
        XCTAssertFalse(session.canReconnect)
    }
}
