// nrvl-agent pair <pairing-string> [--name <name>] | run | install | uninstall | status
using System.Diagnostics;
using System.Net.Http.Json;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Microsoft.Win32;
using NrvlAgent;

const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
const string RunValue = "NRVLStreamDeckAgent";

// Built as a windowless app, so borrow the launching terminal for output. Fails harmlessly at login (no terminal).
Native.AttachConsole(-1);

try
{
    switch (args.FirstOrDefault())
    {
        case "pair" when args.Length >= 2:
            var nameIndex = Array.IndexOf(args, "--name") + 1;
            await PairAsync(args[1], nameIndex > 0 && nameIndex < args.Length ? args[nameIndex] : Environment.MachineName);
            return 0;

        case "run":
            // One agent per user session: a second copy would fight the first for the hub connection.
            using (var single = new Mutex(true, @"Local\NRVLStreamDeckAgent", out var first))
            {
                if (!first) { Console.WriteLine("The agent is already running."); return 0; }
                var config = AgentConfig.Load();
                var logDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NRVLStreamDeck");
                Directory.CreateDirectory(logDir);
                var logFile = Path.Combine(logDir, "agent.log");
                // shortcut: the log is simply restarted once it passes 5 MB; add rotation if history ever matters.
                if (File.Exists(logFile) && new FileInfo(logFile).Length > 5_000_000) File.Delete(logFile);
                Log.FilePath = logFile;
                var stop = new CancellationTokenSource(); // not disposed: the exit handler below may fire late
                AppDomain.CurrentDomain.ProcessExit += (_, _) => stop.Cancel();
                Log.Event("info", "agent.started");
                await new HubClient(config).RunAsync(stop.Token);
                Log.Event("info", "agent.stopped");
                return 0;
            }

        case "install":
            AgentConfig.Load(); // refuse to auto-start an unpaired agent
            var exe = Environment.ProcessPath ?? throw new AgentException("Cannot locate the agent executable");
            using (var key = Registry.CurrentUser.CreateSubKey(RunKey)) key.SetValue(RunValue, $"\"{exe}\" run");
            Process.Start(new ProcessStartInfo(exe, "run") { UseShellExecute = false })?.Dispose();
            Console.WriteLine($"Installed. The agent is running and will start when you sign in.\nKeep this file where it is: {exe}");
            return 0;

        case "uninstall":
            using (var key = Registry.CurrentUser.CreateSubKey(RunKey)) key.DeleteValue(RunValue, throwOnMissingValue: false);
            Console.WriteLine($"Auto-start removed. Pairing is kept; delete {AgentConfig.Dir} to remove it. A running agent stops at sign-out.");
            return 0;

        case "status":
            var current = AgentConfig.Load();
            using (var key = Registry.CurrentUser.OpenSubKey(RunKey))
            {
                var (volume, muted) = Audio.Status();
                Console.WriteLine($"Hub:         {current.HubUrl}\nDevice ID:   {current.DeviceId}\nAuto-start:  {(key?.GetValue(RunValue) is null ? "not installed" : "installed")}\nAudio:       {(volume is null ? "no output device" : $"{volume}%{(muted == true ? " (muted)" : "")}")}");
            }
            return 0;

        default:
            Console.WriteLine("Usage: nrvl-agent pair <pairing-string> [--name <name>] | run | install | uninstall | status");
            return args.Length == 0 ? 0 : 64;
    }
}
catch (AgentException e)
{
    Console.Error.WriteLine($"Error: {e.Message}");
    return 1;
}

static async Task PairAsync(string pairingString, string name)
{
    var info = PairingInfo.Parse(pairingString);
    try
    {
        // 1. Fetch the hub's CA certificate. This one request accepts any certificate, because the download itself
        //    is authenticated against the fingerprint from the pairing string.
        using var bootstrap = new HttpClient(new HttpClientHandler { ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator });
        using var ca = new X509Certificate2(await bootstrap.GetByteArrayAsync(new Uri(info.HubUrl, "/ca.crt")));
        if (Trust.Fingerprint(ca) != info.CaFingerprint)
            throw new AgentException("The hub's certificate does not match the pairing string. Pairing aborted.");

        // 2. Redeem the one-time code over a connection that now only trusts that CA.
        using var http = new HttpClient(new HttpClientHandler { ServerCertificateCustomValidationCallback = (_, cert, _, errors) => Trust.Validate(ca, cert, errors) });
        using var response = await http.PostAsync(new Uri(info.HubUrl, "/api/pair"), JsonContent.Create(new { code = info.Code, name, os = "windows" }));
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        if (!response.IsSuccessStatusCode)
            throw new AgentException($"Pairing failed: {(body.RootElement.TryGetProperty("error", out var error) ? error.GetString() : $"HTTP {(int)response.StatusCode}")}");

        new AgentConfig
        {
            HubUrl = info.HubUrl.GetLeftPart(UriPartial.Authority),
            DeviceId = body.RootElement.GetProperty("deviceId").GetString()!,
            Token = body.RootElement.GetProperty("token").GetString()!,
            CaDer = Convert.ToBase64String(ca.RawData),
        }.Save();
        Console.WriteLine($"Paired as “{name}”. Start the agent with `nrvl-agent run`, or `nrvl-agent install` to start it at sign-in.");
    }
    catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException or KeyNotFoundException or System.Security.Cryptography.CryptographicException)
    {
        throw new AgentException($"Cannot reach the hub at {info.HubUrl}: {e.Message}");
    }
}
