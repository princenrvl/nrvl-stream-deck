using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;

namespace NrvlAgent;

/// <summary>An error whose message is safe and useful to show to the user (on the iPad or the console).</summary>
public sealed class AgentException(string message) : Exception(message);

public static class Log
{
    /// <summary>When set, events are appended to this file instead of the console (background mode).</summary>
    public static string? FilePath;
    private static readonly object Gate = new();

    public static void Event(string level, string name, params (string Key, object? Value)[] data)
    {
        var obj = new Dictionary<string, object?> { ["ts"] = DateTime.UtcNow.ToString("o"), ["level"] = level, ["event"] = name };
        foreach (var (key, value) in data) obj[key] = value;
        var line = JsonSerializer.Serialize(obj);
        lock (Gate)
        {
            try
            {
                if (FilePath is null) Console.WriteLine(line);
                else File.AppendAllText(FilePath, line + Environment.NewLine);
            }
            catch (IOException) { /* logging must never take the agent down */ }
        }
    }
}

/// <summary>
/// Decoded <c>nrvl1.&lt;base64url JSON&gt;</c> string printed by the hub: where the hub is, a one-time code, and the
/// SHA-256 of the hub's CA certificate so the very first connection can be authenticated.
/// </summary>
public sealed record PairingInfo(Uri HubUrl, string Code, string CaFingerprint)
{
    public static PairingInfo Parse(string text)
    {
        try
        {
            if (!text.StartsWith("nrvl1.", StringComparison.Ordinal)) throw new FormatException();
            var b64 = text[6..].Replace('-', '+').Replace('_', '/');
            b64 = b64.PadRight(b64.Length + (4 - b64.Length % 4) % 4, '=');
            using var doc = JsonDocument.Parse(Convert.FromBase64String(b64));
            var url = new Uri(doc.RootElement.GetProperty("u").GetString()!);
            var code = doc.RootElement.GetProperty("c").GetString();
            var fingerprint = doc.RootElement.GetProperty("f").GetString();
            if (url.Scheme != Uri.UriSchemeHttps || string.IsNullOrEmpty(code) || fingerprint is not { Length: 64 }) throw new FormatException();
            return new PairingInfo(url, code, fingerprint.ToLowerInvariant());
        }
        catch (Exception)
        {
            throw new AgentException("Invalid pairing string. Copy the whole value printed by the hub.");
        }
    }
}

public sealed class AgentConfig
{
    public string HubUrl { get; set; } = "";
    public string DeviceId { get; set; } = "";
    public string Token { get; set; } = "";
    /// <summary>The hub's CA certificate, DER, base64.</summary>
    public string CaDer { get; set; } = "";
    /// <summary>Action IDs this computer permits. null = everything the agent supports.</summary>
    public string[]? AllowedActions { get; set; }
    /// <summary>
    /// Scripts this computer allows script.run to start: button-visible name -> full path of an .exe, .bat or .cmd.
    /// Only the name ever travels over the network.
    /// </summary>
    public Dictionary<string, string>? Scripts { get; set; }

    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public static string Dir =>
        Environment.GetEnvironmentVariable("NRVL_AGENT_DIR")
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "NRVLStreamDeck");
    private static string FilePath => Path.Combine(Dir, "agent.json");

    public static AgentConfig Load()
    {
        if (!File.Exists(FilePath)) throw new AgentException("Not paired yet. Run: nrvl-agent pair <pairing-string>");
        var config = JsonSerializer.Deserialize<AgentConfig>(File.ReadAllText(FilePath), Json);
        if (config is null || config.HubUrl == "" || config.DeviceId == "" || config.Token == "" || config.CaDer == "")
            throw new AgentException($"{FilePath} is corrupt. Pair again.");
        return config;
    }

    // shortcut: the token is a plain file under %APPDATA% (readable only by this Windows user by default), not DPAPI;
    // wrap it with ProtectedData once the agent ships as an installer.
    public void Save()
    {
        Directory.CreateDirectory(Dir);
        var tmp = FilePath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(this, Json));
        File.Move(tmp, FilePath, overwrite: true); // atomic replace: a crash never leaves a half-written config
    }
}

/// <summary>Rejects commands that are stale or whose ID was already executed, so a captured command cannot be replayed.</summary>
public sealed class ReplayGuard
{
    public const double WindowMs = 30_000;
    private readonly Dictionary<string, double> _seen = new();

    public bool Accept(string id, double ts, double now)
    {
        foreach (var old in _seen.Where(kv => now - kv.Value > WindowMs).Select(kv => kv.Key).ToList()) _seen.Remove(old);
        if (Math.Abs(now - ts) > WindowMs || _seen.ContainsKey(id)) return false;
        _seen[id] = now;
        return true;
    }
}

public static class Trust
{
    public static string Fingerprint(X509Certificate2 cert) => Convert.ToHexString(SHA256.HashData(cert.RawData)).ToLowerInvariant();

    /// <summary>
    /// Accepts a server certificate only if it chains to the hub's private CA and matches the hostname.
    /// The Windows certificate store is deliberately ignored: nothing but that CA is trusted.
    /// </summary>
    public static bool Validate(X509Certificate2 ca, X509Certificate? cert, SslPolicyErrors errors)
    {
        // Chain errors are expected (the CA is private); a name mismatch or a missing certificate is not.
        if (cert is null || (errors & ~SslPolicyErrors.RemoteCertificateChainErrors) != SslPolicyErrors.None) return false;
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.Add(ca);
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        using var leaf = new X509Certificate2(cert);
        return chain.Build(leaf);
    }
}
