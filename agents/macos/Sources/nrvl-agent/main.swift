import AgentCore
import Foundation

let label = "com.nrvl.streamdeck.agent"
let plistURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/\(label).plist")
let installedBinary = AgentConfig.dir.appendingPathComponent("nrvl-agent")

func request(_ req: URLRequest, anchorDER: Data?) throws -> (Data, Int) {
    let session = URLSession(configuration: .ephemeral, delegate: try TrustDelegate(anchorDER: anchorDER), delegateQueue: nil)
    let done = DispatchSemaphore(value: 0)
    var out: Result<(Data, Int), Error> = .failure(AgentError("No response"))
    session.dataTask(with: req) { data, response, error in
        if let data, let http = response as? HTTPURLResponse { out = .success((data, http.statusCode)) }
        else { out = .failure(AgentError("Cannot reach the hub: \(error?.localizedDescription ?? "unknown error")")) }
        done.signal()
    }.resume()
    done.wait()
    return try out.get()
}

func pair(_ pairingString: String, name: String) throws {
    let info = try PairingInfo(pairingString)
    // 1. Fetch the hub's CA certificate and authenticate it against the fingerprint from the pairing string.
    let (caData, _) = try request(URLRequest(url: info.hubURL.appendingPathComponent("ca.crt")), anchorDER: nil)
    guard let der = certificateDER(caData), sha256Hex(der) == info.caFingerprint else {
        throw AgentError("The hub's certificate does not match the pairing string. Pairing aborted.")
    }
    // 2. Redeem the one-time code over a connection that now only trusts that CA.
    var req = URLRequest(url: info.hubURL.appendingPathComponent("api/pair"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "content-type")
    req.httpBody = try JSONSerialization.data(withJSONObject: ["code": info.code, "name": name, "os": "macos"])
    let (body, status) = try request(req, anchorDER: der)
    let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
    guard status == 200, let deviceId = obj?["deviceId"] as? String, let token = obj?["token"] as? String else {
        throw AgentError("Pairing failed: \(obj?["error"] as? String ?? "HTTP \(status)")")
    }
    try AgentConfig(hubURL: info.hubURL.absoluteString, deviceId: deviceId, token: token, caDER: der).save()
    print("Paired as “\(name)”. Start the agent with `nrvl-agent run`, or `nrvl-agent install` to start it at login.")
}

func launchctl(_ args: String...) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    p.arguments = args
    p.standardError = FileHandle.nullDevice
    try? p.run()
    p.waitUntilExit()
    return p.terminationStatus
}

func install() throws {
    _ = try AgentConfig.load()
    let fm = FileManager.default
    guard let current = Bundle.main.executableURL else { throw AgentError("Cannot locate the agent binary") }
    // Copy to a stable path so rebuilding the project does not break auto-start or the Accessibility grant.
    if current.standardizedFileURL != installedBinary.standardizedFileURL {
        try? fm.removeItem(at: installedBinary)
        try fm.copyItem(at: current, to: installedBinary)
    }
    let logs = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/nrvl-agent.log").path
    let plist: [String: Any] = [
        "Label": label, "ProgramArguments": [installedBinary.path, "run"], "RunAtLoad": true,
        "KeepAlive": ["SuccessfulExit": false], "ProcessType": "Interactive",
        "StandardOutPath": logs, "StandardErrorPath": logs,
    ]
    try fm.createDirectory(at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: plistURL)
    let domain = "gui/\(getuid())"
    _ = launchctl("bootout", "\(domain)/\(label)")
    guard launchctl("bootstrap", domain, plistURL.path) == 0 else { throw AgentError("launchctl could not load \(plistURL.path)") }
    print("Installed. The agent is running and will start at login.\nLogs: \(logs)\nFor keyboard shortcuts and media keys, enable \(installedBinary.path) in System Settings → Privacy & Security → Accessibility.")
}

var signalSources: [DispatchSourceSignal] = []
let args = Array(CommandLine.arguments.dropFirst())
do {
    switch args.first {
    case "pair" where args.count >= 2:
        let nameIdx = args.firstIndex(of: "--name").map { $0 + 1 }
        let name = nameIdx.flatMap { $0 < args.count ? args[$0] : nil } ?? Host.current().localizedName ?? "Mac"
        try pair(args[1], name: name)
    case "run":
        setvbuf(stdout, nil, _IOLBF, 0)
        let client = try HubClient(config: try AgentConfig.load())
        for sig in [SIGINT, SIGTERM] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler { logEvent("info", "agent.stopping"); exit(0) }
            src.resume()
            signalSources.append(src)
        }
        logEvent("info", "agent.started", ["accessibility": Actions.accessibilityGranted])
        client.start()
        RunLoop.main.run()
    case "install":
        try install()
    case "uninstall":
        _ = launchctl("bootout", "gui/\(getuid())/\(label)")
        try? FileManager.default.removeItem(at: plistURL)
        print("Auto-start removed. Pairing is kept; delete \(AgentConfig.dir.path) to remove it.")
    case "status":
        let config = try AgentConfig.load()
        print("Hub:            \(config.hubURL)\nDevice ID:      \(config.deviceId)\nAccessibility:  \(Actions.accessibilityGranted ? "granted" : "NOT granted (keyboard shortcuts and media keys will fail)")\nAuto-start:     \(FileManager.default.fileExists(atPath: plistURL.path) ? "installed" : "not installed")")
    default:
        print("Usage: nrvl-agent pair <pairing-string> [--name <name>] | run | install | uninstall | status")
        exit(args.isEmpty ? 0 : 64)
    }
} catch {
    FileHandle.standardError.write(Data("Error: \(error)\n".utf8))
    exit(1)
}
