import CryptoKit
import Foundation

public struct AgentError: Error, CustomStringConvertible {
    public let description: String
    public init(_ description: String) { self.description = description }
}

public func logEvent(_ level: String, _ event: String, _ data: [String: Any] = [:]) {
    var obj = data
    obj["ts"] = ISO8601DateFormatter().string(from: Date())
    obj["level"] = level
    obj["event"] = event
    if let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), let s = String(data: d, encoding: .utf8) {
        print(s)
        fflush(stdout)
    }
}

/// Decoded `nrvl1.<base64url JSON>` string printed by the hub: where the hub is, a one-time code, and the
/// SHA-256 of the hub's CA certificate so the very first connection can be authenticated.
public struct PairingInfo: Equatable {
    public let hubURL: URL
    public let code: String
    public let caFingerprint: String

    public init(_ string: String) throws {
        var b64 = String(string.dropFirst(6)).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        b64 += String(repeating: "=", count: (4 - b64.count % 4) % 4)
        guard string.hasPrefix("nrvl1."), let data = Data(base64Encoded: b64),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let u = obj["u"] as? String, let url = URL(string: u), url.scheme == "https", url.host != nil,
              let code = obj["c"] as? String, !code.isEmpty,
              let fp = obj["f"] as? String, fp.count == 64
        else { throw AgentError("Invalid pairing string. Copy the whole value printed by the hub.") }
        hubURL = url
        self.code = code
        caFingerprint = fp.lowercased()
    }
}

public func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

/// PEM or DER certificate bytes -> DER.
public func certificateDER(_ data: Data) -> Data? {
    if SecCertificateCreateWithData(nil, data as CFData) != nil { return data }
    guard let pem = String(data: data, encoding: .utf8) else { return nil }
    let body = pem.split(separator: "\n").filter { !$0.hasPrefix("-----") }.joined()
    return Data(base64Encoded: body)
}

public struct AgentConfig: Codable {
    public var hubURL: String
    public var deviceId: String
    public var token: String
    public var caDER: Data
    /// Action IDs this computer permits. nil = everything the agent supports.
    public var allowedActions: [String]?
    /// Scripts this computer allows `script.run` to start: button-visible name -> absolute path of an executable.
    /// Only the name ever travels over the network.
    public var scripts: [String: String]?

    public init(hubURL: String, deviceId: String, token: String, caDER: Data) {
        self.hubURL = hubURL
        self.deviceId = deviceId
        self.token = token
        self.caDER = caDER
    }

    public static var dir: URL {
        if let d = ProcessInfo.processInfo.environment["NRVL_AGENT_DIR"] { return URL(fileURLWithPath: d) }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("NRVLStreamDeck")
    }
    static var file: URL { dir.appendingPathComponent("agent.json") }

    public static func load() throws -> AgentConfig {
        guard let data = try? Data(contentsOf: file) else { throw AgentError("Not paired yet. Run: nrvl-agent pair <pairing-string>") }
        return try JSONDecoder().decode(AgentConfig.self, from: data)
    }

    // shortcut: the token lives in a 0600 file, not the Keychain, because an ad-hoc-signed binary re-prompts for
    // Keychain access after every rebuild; move it once the agent ships as a signed app.
    public func save() throws {
        try FileManager.default.createDirectory(at: Self.dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(self).write(to: Self.file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: Self.file.path)
    }
}

/// Rejects commands that are stale or whose ID was already executed, so a captured command cannot be replayed.
public struct ReplayGuard {
    public static let windowMs: Double = 30_000
    private var seen: [String: Double] = [:]
    public init() {}

    public mutating func accept(id: String, ts: Double, now: Double) -> Bool {
        seen = seen.filter { now - $0.value <= Self.windowMs }
        guard abs(now - ts) <= Self.windowMs, seen[id] == nil else { return false }
        seen[id] = now
        return true
    }
}
