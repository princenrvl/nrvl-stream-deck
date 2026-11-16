import Foundation

/// TLS trust for the hub's private CA. With an anchor, only certificates issued by that CA (and matching the
/// hostname) are accepted. Without one it accepts anything: used solely to download the CA certificate during
/// pairing, where the caller authenticates the download by its SHA-256 fingerprint.
public final class TrustDelegate: NSObject, URLSessionDelegate {
    let anchor: SecCertificate?
    public init(anchorDER: Data?) throws {
        if let der = anchorDER {
            guard let cert = SecCertificateCreateWithData(nil, der as CFData) else { throw AgentError("Stored hub certificate is corrupt. Pair again.") }
            anchor = cert
        } else {
            anchor = nil
        }
    }

    public func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                           completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else { return completionHandler(.performDefaultHandling, nil) }
        if let anchor {
            SecTrustSetAnchorCertificates(trust, [anchor] as CFArray)
            SecTrustSetAnchorCertificatesOnly(trust, true)
            guard SecTrustEvaluateWithError(trust, nil) else { return completionHandler(.cancelAuthenticationChallenge, nil) }
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}

/// Authenticated WebSocket link to the hub with heartbeat and automatic reconnect. Runs entirely on the main queue.
public final class HubClient {
    private var config: AgentConfig
    private let session: URLSession
    private var task: URLSessionWebSocketTask?
    private var generation = 0 // bumped on every (re)connect so callbacks from old sockets are ignored
    private var backoff = 1.0
    private var authenticated = false
    private var lastRx = Date()
    private var lastStatus: Status?
    private var replay = ReplayGuard()

    public init(config: AgentConfig) throws {
        self.config = config
        session = URLSession(configuration: .ephemeral, delegate: try TrustDelegate(anchorDER: config.caDER), delegateQueue: .main)
    }

    private var capabilities: [String] {
        Actions.supported.filter { config.allowedActions?.contains($0) ?? true }
    }

    public func start() {
        connect()
        Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.pushStatus() }
        Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            guard let self, self.task != nil else { return }
            // A Wi-Fi drop often leaves the socket half-open, and URLSession can sit on a connect attempt
            // while the hub is down; silence means the socket is dead. Unauthenticated attempts get less patience.
            if Date().timeIntervalSince(self.lastRx) > (self.authenticated ? 20 : 6) { return self.reconnect(self.generation, "heartbeat timeout") }
            self.send(["t": "ping"])
        }
    }

    private func connect() {
        generation += 1
        let gen = generation
        guard var comps = URLComponents(string: config.hubURL) else { return }
        comps.scheme = "wss"
        comps.path = "/ws"
        let t = session.webSocketTask(with: comps.url!)
        task = t
        lastRx = Date()
        t.resume()
        send(["t": "hello", "v": 1, "deviceId": config.deviceId, "token": config.token])
        receive(gen)
    }

    private func receive(_ gen: Int) {
        task?.receive { [weak self] result in
            guard let self, gen == self.generation else { return }
            switch result {
            case .failure(let error):
                self.reconnect(gen, error.localizedDescription)
            case .success(let message):
                self.lastRx = Date()
                if case .string(let text) = message { self.handle(text) }
                self.receive(gen)
            }
        }
    }

    private func reconnect(_ gen: Int, _ reason: String) {
        guard gen == generation else { return }
        generation += 1
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        authenticated = false
        logEvent("warn", "hub.disconnected", ["reason": reason, "retryIn": backoff])
        DispatchQueue.main.asyncAfter(deadline: .now() + backoff) { [weak self] in self?.connect() }
        backoff = min(backoff * 2, 15)
    }

    private func send(_ obj: [String: Any]) {
        guard let task, let data = try? JSONSerialization.data(withJSONObject: obj), let text = String(data: data, encoding: .utf8) else { return }
        let gen = generation
        task.send(.string(text)) { [weak self] error in
            if let error { self?.reconnect(gen, error.localizedDescription) }
        }
    }

    private func pushStatus(force: Bool = false) {
        guard authenticated else { return }
        let s = Actions.status()
        guard force || s != lastStatus else { return }
        lastStatus = s
        send(["t": "status", "capabilities": capabilities,
              "status": ["volume": s.volume as Any? ?? NSNull(), "muted": s.muted as Any? ?? NSNull(), "micMuted": s.micMuted as Any? ?? NSNull(),
                         "apps": Array(s.apps.prefix(300)).map { String($0.prefix(200)) }, "scripts": (config.scripts ?? [:]).keys.sorted().prefix(50).map { $0 }]])
    }

    private func handle(_ text: String) {
        guard let msg = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any], let t = msg["t"] as? String else { return }
        switch t {
        case "welcome":
            backoff = 1
            authenticated = true
            if let token = msg["newToken"] as? String {
                config.token = token
                do { try config.save() } catch { logEvent("error", "token.save_failed", ["message": "\(error)"]) }
            }
            logEvent("info", "hub.connected", ["hub": config.hubURL])
            pushStatus(force: true)
        case "execute":
            guard let id = msg["id"] as? String else { return }
            let result = execute(msg)
            var reply: [String: Any] = ["t": "result", "id": id, "ok": result == nil]
            if let result { reply["error"] = result }
            send(reply)
            pushStatus()
        case "error":
            if msg["error"] as? String == "unauthorized" {
                logEvent("error", "hub.unauthorized", ["hint": "This computer was removed from the hub. Pair it again."])
                exit(0) // clean exit so launchd does not restart a rejected agent in a loop
            }
        default: break
        }
    }

    /// Returns nil on success, or the error message to report. Never reports success unless the handler returned.
    private func execute(_ msg: [String: Any]) -> String? {
        guard let id = msg["id"] as? String, let ts = msg["ts"] as? Double,
              let action = msg["action"] as? [String: Any], let type = action["type"] as? String,
              let params = action["params"] as? [String: Any] else { return "Malformed command" }
        guard replay.accept(id: id, ts: ts, now: Date().timeIntervalSince1970 * 1000) else {
            return "Rejected a stale or repeated command. Check that both computers' clocks are correct."
        }
        guard capabilities.contains(type) else { return "This action is not permitted on this computer" }
        do {
            try Actions.perform(type: type, params: params, scripts: config.scripts ?? [:])
            logEvent("info", "action.ok", ["action": type])
            return nil
        } catch {
            logEvent("warn", "action.failed", ["action": type, "error": "\(error)"])
            return "\(error)"
        }
    }
}
