using System.Net.WebSockets;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

namespace NrvlAgent;

/// <summary>Authenticated WebSocket link to the hub with heartbeat and automatic reconnect.</summary>
public sealed class HubClient(AgentConfig config)
{
    private sealed class UnauthorizedException : Exception;

    private readonly X509Certificate2 _ca = new(Convert.FromBase64String(config.CaDer));
    private readonly ReplayGuard _replay = new();
    private readonly SemaphoreSlim _sendLock = new(1, 1); // ClientWebSocket allows one send at a time
    private double _backoffSeconds = 1;

    private string[] Capabilities => Actions.Supported.Where(a => config.AllowedActions?.Contains(a) ?? true).ToArray();

    /// <summary>Runs until cancelled, or until the hub says this computer was removed.</summary>
    public async Task RunAsync(CancellationToken stop)
    {
        while (!stop.IsCancellationRequested)
        {
            try
            {
                await SessionAsync(stop);
                Log.Event("warn", "hub.disconnected", ("reason", "closed by hub"), ("retryIn", _backoffSeconds));
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { return; }
            catch (UnauthorizedException)
            {
                Log.Event("error", "hub.unauthorized", ("hint", "This computer was removed from the hub. Pair it again."));
                return;
            }
            catch (Exception e)
            {
                Log.Event("warn", "hub.disconnected", ("reason", e.Message), ("retryIn", _backoffSeconds));
            }
            try { await Task.Delay(TimeSpan.FromSeconds(_backoffSeconds), stop); }
            catch (OperationCanceledException) { return; }
            _backoffSeconds = Math.Min(_backoffSeconds * 2, 15);
        }
    }

    /// <summary>One connection, from connect to disconnect. Returns or throws when the connection ends.</summary>
    private async Task SessionAsync(CancellationToken stop)
    {
        using var ws = new ClientWebSocket();
        ws.Options.RemoteCertificateValidationCallback = (_, cert, _, errors) => Trust.Validate(_ca, cert, errors);
        var uri = new UriBuilder(config.HubUrl) { Scheme = "wss", Path = "/ws" }.Uri;

        using (var connectTimeout = CancellationTokenSource.CreateLinkedTokenSource(stop))
        {
            connectTimeout.CancelAfter(TimeSpan.FromSeconds(6));
            await ws.ConnectAsync(uri, connectTimeout.Token);
        }
        await SendAsync(ws, new { t = "hello", v = 1, deviceId = config.DeviceId, token = config.Token }, stop);

        var authenticated = false;
        var lastRx = DateTime.UtcNow;
        var lastStatus = "";

        async Task PushStatusAsync(bool force)
        {
            if (!authenticated) return;
            var (volume, muted) = Audio.Status();
            var micMuted = Audio.MicMuted();
            var apps = Actions.RunningApps();
            var scripts = (config.Scripts?.Keys ?? Enumerable.Empty<string>()).Order().Take(50).ToArray();
            var key = $"{volume}|{muted}|{micMuted}|{string.Join('\n', apps)}|{string.Join('\n', scripts)}";
            if (!force && key == lastStatus) return;
            lastStatus = key;
            await SendAsync(ws, new { t = "status", capabilities = Capabilities, status = new { volume, muted, micMuted, apps, scripts } }, stop);
        }

        // Ticker: status every 3 s when it changed, a ping every 6 s, and a watchdog. A Wi-Fi drop often leaves the
        // socket half-open, so silence means it is dead; aborting makes the receive loop below throw and reconnect.
        using var sessionEnd = CancellationTokenSource.CreateLinkedTokenSource(stop);
        var ticker = Task.Run(async () =>
        {
            try
            {
                for (var tick = 1; ; tick++)
                {
                    await Task.Delay(TimeSpan.FromSeconds(3), sessionEnd.Token);
                    if (DateTime.UtcNow - lastRx > TimeSpan.FromSeconds(authenticated ? 20 : 6)) { ws.Abort(); return; }
                    await PushStatusAsync(force: false);
                    if (tick % 2 == 0) await SendAsync(ws, new { t = "ping" }, sessionEnd.Token);
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception) { ws.Abort(); }
        });

        try
        {
            var buffer = new byte[16 * 1024];
            while (await ReceiveTextAsync(ws, buffer, stop) is { } text)
            {
                lastRx = DateTime.UtcNow;
                using var doc = JsonDocument.Parse(text);
                var msg = doc.RootElement;
                if (msg.ValueKind != JsonValueKind.Object || !msg.TryGetProperty("t", out var t) || t.ValueKind != JsonValueKind.String) continue;
                switch (t.GetString())
                {
                    case "welcome":
                        authenticated = true;
                        _backoffSeconds = 1;
                        if (msg.TryGetProperty("newToken", out var newToken) && newToken.ValueKind == JsonValueKind.String)
                        {
                            config.Token = newToken.GetString()!;
                            try { config.Save(); }
                            catch (Exception e) { Log.Event("error", "token.save_failed", ("message", e.Message)); }
                        }
                        Log.Event("info", "hub.connected", ("hub", config.HubUrl));
                        await PushStatusAsync(force: true);
                        break;
                    case "execute":
                        if (!msg.TryGetProperty("id", out var idEl) || idEl.ValueKind != JsonValueKind.String) break;
                        var error = Execute(msg);
                        var reply = new Dictionary<string, object?> { ["t"] = "result", ["id"] = idEl.GetString(), ["ok"] = error is null };
                        if (error is not null) reply["error"] = error.Length > 500 ? error[..500] : error;
                        await SendAsync(ws, reply, stop);
                        await PushStatusAsync(force: false);
                        break;
                    case "error":
                        if (msg.TryGetProperty("error", out var err) && err.ValueKind == JsonValueKind.String && err.GetString() == "unauthorized")
                            throw new UnauthorizedException();
                        break;
                }
            }
        }
        finally
        {
            sessionEnd.Cancel();
            await ticker;
        }
    }

    /// <summary>Returns null on success, or the error message to report. Never reports success unless the handler returned.</summary>
    private string? Execute(JsonElement msg)
    {
        if (!msg.TryGetProperty("id", out var idEl) || idEl.ValueKind != JsonValueKind.String
            || !msg.TryGetProperty("ts", out var tsEl) || tsEl.ValueKind != JsonValueKind.Number
            || !msg.TryGetProperty("action", out var action) || action.ValueKind != JsonValueKind.Object
            || !action.TryGetProperty("type", out var typeEl) || typeEl.ValueKind != JsonValueKind.String
            || !action.TryGetProperty("params", out var parameters) || parameters.ValueKind != JsonValueKind.Object)
            return "Malformed command";
        var type = typeEl.GetString()!;
        if (!_replay.Accept(idEl.GetString()!, tsEl.GetDouble(), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()))
            return "Rejected a stale or repeated command. Check that both computers' clocks are correct.";
        if (!Capabilities.Contains(type)) return "This action is not permitted on this computer";
        try
        {
            Actions.Perform(type, parameters, config.Scripts);
            Log.Event("info", "action.ok", ("action", type));
            return null;
        }
        catch (AgentException e)
        {
            Log.Event("warn", "action.failed", ("action", type), ("error", e.Message));
            return e.Message;
        }
        catch (Exception e)
        {
            // Unexpected failures are logged in full locally but not sent over the network.
            Log.Event("error", "action.crashed", ("action", type), ("error", e.ToString()));
            return "The action failed unexpectedly. See the agent log on that computer.";
        }
    }

    private async Task SendAsync(ClientWebSocket ws, object message, CancellationToken cancel)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message);
        await _sendLock.WaitAsync(cancel);
        try { await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, cancel); }
        finally { _sendLock.Release(); }
    }

    /// <summary>Next complete text message, or null when the hub closed the connection.</summary>
    private static async Task<string?> ReceiveTextAsync(ClientWebSocket ws, byte[] buffer, CancellationToken cancel)
    {
        using var message = new MemoryStream();
        while (true)
        {
            var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), cancel);
            if (result.MessageType == WebSocketMessageType.Close) return null;
            message.Write(buffer, 0, result.Count);
            if (message.Length > 256 * 1024) throw new InvalidDataException("Message from hub too large");
            if (result.EndOfMessage) return Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length);
        }
    }
}
