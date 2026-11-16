import XCTest
@testable import AgentCore

final class AgentCoreTests: XCTestCase {
    func testPairingStringRoundTrip() throws {
        let fp = String(repeating: "ab", count: 32)
        let json = #"{"u":"https://my-mac.local:8443","c":"ABCDE-FGHJK","f":"\#(fp)"}"#
        let b64 = Data(json.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let info = try PairingInfo("nrvl1." + b64)
        XCTAssertEqual(info.hubURL.absoluteString, "https://my-mac.local:8443")
        XCTAssertEqual(info.code, "ABCDE-FGHJK")
        XCTAssertEqual(info.caFingerprint, fp)
    }

    func testPairingStringRejectsGarbageAndPlainHTTP() {
        XCTAssertThrowsError(try PairingInfo("hello"))
        XCTAssertThrowsError(try PairingInfo("nrvl1.!!!"))
        let http = Data(#"{"u":"http://x:1","c":"A","f":"\#(String(repeating: "a", count: 64))"}"#.utf8).base64EncodedString()
        XCTAssertThrowsError(try PairingInfo("nrvl1." + http))
    }

    func testReplayGuard() {
        var g = ReplayGuard()
        XCTAssertTrue(g.accept(id: "a", ts: 1000, now: 1000))
        XCTAssertFalse(g.accept(id: "a", ts: 1000, now: 1500), "same id replayed")
        XCTAssertFalse(g.accept(id: "b", ts: 1000, now: 40000), "stale timestamp")
        XCTAssertFalse(g.accept(id: "c", ts: 90000, now: 1000), "timestamp from the future")
        XCTAssertTrue(g.accept(id: "d", ts: 40000, now: 40000))
    }

    func testShortcutParsing() throws {
        let s = try Actions.shortcut(["key": "4", "modifiers": ["cmd", "shift"]])
        XCTAssertEqual(s.code, 21)
        XCTAssertEqual(s.flags, [.maskCommand, .maskShift])
        XCTAssertThrowsError(try Actions.shortcut(["key": "nope", "modifiers": []]))
        XCTAssertThrowsError(try Actions.shortcut(["key": "a", "modifiers": ["hyper"]]))
        XCTAssertThrowsError(try Actions.shortcut(["key": "a"]))
    }

    func testParameterValidation() throws {
        XCTAssertEqual(try Actions.volumeLevel(["level": 35]), 35)
        XCTAssertThrowsError(try Actions.volumeLevel(["level": 101]))
        XCTAssertThrowsError(try Actions.volumeLevel(["level": 3.5]))
        XCTAssertThrowsError(try Actions.volumeLevel(["level": "50"]))
        XCTAssertNoThrow(try Actions.httpURL(["url": "https://example.com/x"]))
        XCTAssertThrowsError(try Actions.httpURL(["url": "file:///etc/passwd"]))
        XCTAssertThrowsError(try Actions.httpURL(["url": "javascript:alert(1)"]))
        XCTAssertEqual(try Actions.openArguments(["app": "Visual Studio Code"]), ["-a", "Visual Studio Code"])
        XCTAssertEqual(try Actions.openArguments(["app": "com.apple.Safari"]), ["-b", "com.apple.Safari"])
        XCTAssertEqual(try Actions.openArguments(["app": "Safari.app"]), ["-a", "Safari.app"])
        XCTAssertThrowsError(try Actions.openArguments(["app": "--args"]))
        XCTAssertThrowsError(try Actions.openArguments(["app": "a\nb"]))
        XCTAssertThrowsError(try Actions.perform(type: "shell.exec", params: ["cmd": "id"]))
    }

    func testMuteStateAndTypingPlan() throws {
        XCTAssertTrue(try Actions.wantedMute([:], current: false))
        XCTAssertFalse(try Actions.wantedMute(["state": "toggle"], current: true))
        XCTAssertTrue(try Actions.wantedMute(["state": "on"], current: true))
        XCTAssertFalse(try Actions.wantedMute(["state": "off"], current: true))
        XCTAssertThrowsError(try Actions.wantedMute(["state": "maybe"], current: true))
        XCTAssertEqual(try Actions.typingPlan(["text": "ab\ncd\t"]), ["ab", "\n", "cd", "\t"])
        XCTAssertThrowsError(try Actions.typingPlan(["text": ""]))
        XCTAssertThrowsError(try Actions.typingPlan(["text": "a\u{1B}b"]), "escape character")
        XCTAssertThrowsError(try Actions.typingPlan(["text": String(repeating: "x", count: 501)]))
    }

    func testScriptsMustBeAllowListedLocally() throws {
        let scripts = ["ok": "/bin/ls", "missing": "/no/such/file", "relative": "bin/ls"]
        XCTAssertEqual(try Actions.scriptPath(["name": "ok"], scripts: scripts), "/bin/ls")
        XCTAssertThrowsError(try Actions.scriptPath(["name": "/bin/ls"], scripts: scripts), "a path is not a name")
        XCTAssertThrowsError(try Actions.scriptPath(["name": "missing"], scripts: scripts))
        XCTAssertThrowsError(try Actions.scriptPath(["name": "relative"], scripts: scripts))
        XCTAssertThrowsError(try Actions.scriptPath(["name": "ok"], scripts: [:]))
        XCTAssertEqual(try Actions.run("/usr/bin/true", [], timeout: 5), 0)
        XCTAssertEqual(try Actions.run("/usr/bin/false", [], timeout: 5), 1)
        XCTAssertThrowsError(try Actions.run("/bin/sleep", ["5"], timeout: 0.3), "timeout stops the process")
    }

    func testEveryKeyInTheSharedContractHasAKeyCode() {
        // Mirrors KEYS in packages/shared/src/index.ts.
        let keys = "abcdefghijklmnopqrstuvwxyz0123456789".map(String.init) + (1...12).map { "f\($0)" }
            + ["space", "enter", "tab", "escape", "backspace", "delete", "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
               "minus", "equal", "comma", "period", "slash", "semicolon", "quote", "leftbracket", "rightbracket", "backslash", "grave"]
        for k in keys { XCTAssertNotNil(Actions.keyCodes[k], "missing key code for \(k)") }
    }
}
