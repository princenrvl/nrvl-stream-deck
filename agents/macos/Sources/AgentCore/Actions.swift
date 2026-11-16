import AppKit
import ApplicationServices

public struct Status: Equatable {
    public var volume: Int?
    public var muted: Bool?
    public var micMuted: Bool?
    public var apps: [String]
}

/// Execution handlers for the action IDs defined in packages/shared. Every handler validates its own
/// parameters (the hub validates too, but the agent never trusts the network) and throws on any failure.
/// To add an action: add a `case` in `perform` and its ID to `supported`.
public enum Actions {
    public static let supported = [
        "app.launch", "url.open", "keyboard.shortcut", "text.type", "mouse.click",
        "volume.set", "volume.up", "volume.down", "volume.mute", "mic.mute",
        "media.playpause", "media.next", "media.previous", "brightness.up", "brightness.down",
        "system.lock", "system.sleep", "script.run",
    ]

    static let keyCodes: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
        "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "equal": 24, "9": 25, "7": 26, "minus": 27, "8": 28,
        "0": 29, "rightbracket": 30, "o": 31, "u": 32, "leftbracket": 33, "i": 34, "p": 35, "enter": 36, "l": 37, "j": 38, "quote": 39,
        "k": 40, "semicolon": 41, "backslash": 42, "comma": 43, "slash": 44, "n": 45, "m": 46, "period": 47, "tab": 48, "space": 49,
        "grave": 50, "backspace": 51, "escape": 53, "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
        "f9": 101, "f10": 109, "f11": 103, "f12": 111, "home": 115, "pageup": 116, "delete": 117, "end": 119, "pagedown": 121,
        "left": 123, "right": 124, "down": 125, "up": 126,
    ]
    static let modifierFlags: [String: CGEventFlags] = ["cmd": .maskCommand, "ctrl": .maskControl, "alt": .maskAlternate, "shift": .maskShift]

    // ---------- parameter parsing (pure, unit-tested) ----------

    public static func shortcut(_ params: [String: Any]) throws -> (code: CGKeyCode, flags: CGEventFlags) {
        guard let key = params["key"] as? String, let code = keyCodes[key] else { throw AgentError("Unknown key") }
        guard let mods = params["modifiers"] as? [String] else { throw AgentError("Invalid modifiers") }
        var flags: CGEventFlags = []
        for m in mods {
            guard let f = modifierFlags[m] else { throw AgentError("Unknown modifier \(m)") }
            flags.insert(f)
        }
        return (code, flags)
    }

    public static func volumeLevel(_ params: [String: Any]) throws -> Int {
        guard let n = params["level"] as? NSNumber, CFNumberIsFloatType(n) == false, (0...100).contains(n.intValue) else { throw AgentError("Volume must be a whole number from 0 to 100") }
        return n.intValue
    }

    public static func httpURL(_ params: [String: Any]) throws -> URL {
        guard let s = params["url"] as? String, let url = URL(string: s), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil
        else { throw AgentError("Only http(s) URLs can be opened") }
        return url
    }

    /// Arguments for /usr/bin/open. The app value can never be read as a flag: leading "-" is rejected.
    public static func openArguments(_ params: [String: Any]) throws -> [String] {
        guard let app = params["app"] as? String, !app.isEmpty, app.count <= 200, !app.hasPrefix("-"),
              app.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) })
        else { throw AgentError("Invalid app name") }
        let isBundleID = app.range(of: #"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$"#, options: .regularExpression) != nil && !app.hasSuffix(".app")
        return [isBundleID ? "-b" : "-a", app]
    }

    /// The mute state wanted, given the current one: "on", "off", or toggle when absent.
    public static func wantedMute(_ params: [String: Any], current: Bool) throws -> Bool {
        switch params["state"] as? String ?? "toggle" {
        case "on": return true
        case "off": return false
        case "toggle": return !current
        default: throw AgentError("Invalid mute state")
        }
    }

    /// Text split into runs to type and the Return/Tab keys between them.
    public static func typingPlan(_ params: [String: Any]) throws -> [String] {
        guard let text = params["text"] as? String, !text.isEmpty, text.count <= 500,
              text.unicodeScalars.allSatisfy({ $0 == "\n" || $0 == "\t" || !CharacterSet.controlCharacters.contains($0) })
        else { throw AgentError("Invalid text") }
        var parts: [String] = []
        var run = ""
        for ch in text {
            if ch == "\n" || ch == "\t" {
                if !run.isEmpty { parts.append(run); run = "" }
                parts.append(String(ch))
            } else {
                run.append(ch)
            }
        }
        if !run.isEmpty { parts.append(run) }
        return parts
    }

    /// The executable allow-listed under this name in agent.json. Nothing from the network ever becomes a path.
    public static func scriptPath(_ params: [String: Any], scripts: [String: String]) throws -> String {
        guard let name = params["name"] as? String, let path = scripts[name] else { throw AgentError("No script with that name is allowed on this computer") }
        guard path.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: path) else { throw AgentError("The script file is missing or not executable") }
        return path
    }

    public static var accessibilityGranted: Bool { AXIsProcessTrusted() }

    // ---------- execution ----------

    /// Must be called on the main thread (AppleScript and event posting require it).
    public static func perform(type: String, params: [String: Any], scripts: [String: String] = [:]) throws {
        switch type {
        case "app.launch":
            guard try run("/usr/bin/open", try openArguments(params), timeout: 8) == 0 else { throw AgentError("Could not open “\(params["app"] ?? "")”. Check the app name.") }
        case "url.open":
            guard NSWorkspace.shared.open(try httpURL(params)) else { throw AgentError("Could not open the URL") }
        case "keyboard.shortcut":
            let (code, flags) = try shortcut(params)
            try requireAccessibility()
            try pressKey(code, flags)
        case "text.type":
            let plan = try typingPlan(params)
            try requireAccessibility()
            for part in plan {
                if part == "\n" { try pressKey(36, []) }
                else if part == "\t" { try pressKey(48, []) }
                else { try typeUnicode(part) }
            }
        case "mouse.click":
            guard let button = params["button"] as? String, ["left", "right"].contains(button) else { throw AgentError("Invalid mouse button") }
            try requireAccessibility()
            guard let at = CGEvent(source: nil)?.location else { throw AgentError("Could not read the pointer position") }
            let left = button == "left"
            for type in left ? [CGEventType.leftMouseDown, .leftMouseUp] : [.rightMouseDown, .rightMouseUp] {
                guard let ev = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: at, mouseButton: left ? .left : .right) else { throw AgentError("Could not create mouse event") }
                ev.post(tap: .cghidEventTap)
            }
        case "volume.set": try setVolume(try volumeLevel(params))
        case "volume.up": try setVolume(min(100, try currentVolume() + 6))
        case "volume.down": try setVolume(max(0, try currentVolume() - 6))
        case "volume.mute":
            guard let before = status().muted else { throw AgentError("The current output device has no mute control") }
            let want = try wantedMute(params, current: before)
            _ = try script("set volume output muted \(want)")
            guard status().muted == want else { throw AgentError("Mute did not change") }
        case "mic.mute":
            // macOS has no microphone mute switch; input volume 0 is the system-wide equivalent.
            guard let level = inputVolume() else { throw AgentError("The current input device has no volume control") }
            let want = try wantedMute(params, current: level == 0)
            if want, level > 0 { inputVolumeBeforeMute = level }
            _ = try script("set volume input volume \(want ? 0 : inputVolumeBeforeMute)")
            guard (inputVolume() == 0) == want else { throw AgentError("Microphone mute did not change") }
        case "media.playpause": try mediaKey(16) // NX_KEYTYPE_PLAY
        case "media.next": try mediaKey(17) // NX_KEYTYPE_NEXT
        case "media.previous": try mediaKey(18) // NX_KEYTYPE_PREVIOUS
        case "brightness.up": try mediaKey(2) // NX_KEYTYPE_BRIGHTNESS_UP
        case "brightness.down": try mediaKey(3) // NX_KEYTYPE_BRIGHTNESS_DOWN
        case "system.lock":
            try requireAccessibility()
            try pressKey(12, [.maskCommand, .maskControl]) // ctrl+cmd+Q, the system "Lock Screen" shortcut
        case "system.sleep":
            guard FileManager.default.isExecutableFile(atPath: "/usr/bin/pmset") else { throw AgentError("pmset is not available") }
            // Sleep a moment later so the result reaches the hub before the network goes down.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { _ = try? run("/usr/bin/pmset", ["sleepnow"], timeout: 5) }
        case "script.run":
            let code = try run(try scriptPath(params, scripts: scripts), [], timeout: 8)
            guard code == 0 else { throw AgentError("Script exited with code \(code)") }
        default: throw AgentError("Unsupported action")
        }
    }

    public static func status() -> Status {
        let v = try? script("output volume of (get volume settings)")
        let m = try? script("output muted of (get volume settings)")
        // "missing value" (e.g. HDMI output without software volume) arrives as a non-numeric descriptor.
        let volume = v.flatMap { $0.descriptorType == typeSInt32 ? Int($0.int32Value) : nil }
        let muted = m.flatMap { [typeTrue, typeFalse, typeBoolean].contains($0.descriptorType) ? $0.booleanValue : nil }
        // Apps with a Dock icon, by name and bundle ID, so an app button can show whether its app is running.
        let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
            .flatMap { [$0.localizedName, $0.bundleIdentifier].compactMap { $0 } }
        return Status(volume: volume, muted: muted, micMuted: inputVolume().map { $0 == 0 }, apps: Array(Set(apps)).sorted())
    }

    private static var inputVolumeBeforeMute = 75

    static func inputVolume() -> Int? {
        (try? script("input volume of (get volume settings)")).flatMap { $0.descriptorType == typeSInt32 ? Int($0.int32Value) : nil }
    }

    static func currentVolume() throws -> Int {
        guard let v = status().volume else { throw AgentError("The current output device has no software volume control") }
        return v
    }

    static func setVolume(_ level: Int) throws {
        _ = try currentVolume()
        _ = try script("set volume output volume \(level)")
        // Read back so a silent no-op is never reported as success. macOS quantises, hence the tolerance.
        guard let now = status().volume, abs(now - level) <= 4 else { throw AgentError("Volume did not change") }
    }

    private static var compiled: [String: NSAppleScript] = [:]

    static func script(_ source: String) throws -> NSAppleEventDescriptor {
        // The status poll runs the same three scripts every few seconds; compiling them once keeps the agent idle-cheap.
        let s = compiled[source] ?? NSAppleScript(source: source)
        if compiled.count < 64 { compiled[source] = s }
        var err: NSDictionary?
        guard let result = s?.executeAndReturnError(&err), err == nil else { throw AgentError("System script failed") }
        return result
    }

    /// Runs one executable with an argument array (never a shell) and returns its exit code. Kills it on timeout.
    static func run(_ path: String, _ arguments: [String], timeout: TimeInterval) throws -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = arguments
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        let done = DispatchSemaphore(value: 0)
        p.terminationHandler = { _ in done.signal() }
        try p.run()
        if done.wait(timeout: .now() + timeout) == .timedOut {
            p.terminate()
            throw AgentError("Did not finish within \(Int(timeout)) seconds and was stopped")
        }
        return p.terminationStatus
    }

    static func requireAccessibility() throws {
        if AXIsProcessTrusted() { return }
        // Shows the system prompt once; macOS will not show it again until the entry is removed.
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        throw AgentError("Accessibility permission needed on this Mac: System Settings → Privacy & Security → Accessibility → enable nrvl-agent")
    }

    static func pressKey(_ code: CGKeyCode, _ flags: CGEventFlags) throws {
        let src = CGEventSource(stateID: .hidSystemState)
        for down in [true, false] {
            guard let ev = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) else { throw AgentError("Could not create key event") }
            ev.flags = flags
            ev.post(tap: .cghidEventTap)
        }
    }

    static func typeUnicode(_ text: String) throws {
        let src = CGEventSource(stateID: .hidSystemState)
        let units = Array(text.utf16)
        // Key events carry at most 20 UTF-16 units each.
        for start in stride(from: 0, to: units.count, by: 20) {
            let chunk = Array(units[start..<min(start + 20, units.count)])
            for down in [true, false] {
                guard let ev = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down) else { throw AgentError("Could not create key event") }
                ev.flags = []
                ev.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                ev.post(tap: .cghidEventTap)
            }
            usleep(8000) // some apps drop characters when events arrive faster than they read them
        }
    }

    static func mediaKey(_ key: Int) throws {
        try requireAccessibility()
        for down in [true, false] {
            let state = down ? 0xA : 0xB
            guard let ev = NSEvent.otherEvent(with: .systemDefined, location: .zero, modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(state << 8)),
                                              timestamp: 0, windowNumber: 0, context: nil, subtype: 8, data1: (key << 16) | (state << 8), data2: -1),
                  let cg = ev.cgEvent else { throw AgentError("Could not create media key event") }
            cg.post(tap: .cghidEventTap)
        }
    }
}
