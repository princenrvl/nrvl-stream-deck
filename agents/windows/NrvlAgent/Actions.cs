using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace NrvlAgent;

/// <summary>
/// Execution handlers for the action IDs defined in packages/shared. Every handler validates its own parameters
/// (the hub validates too, but the agent never trusts the network) and throws on any failure.
/// </summary>
public static class Actions
{
    public static readonly string[] Supported =
    [
        "app.launch", "url.open", "keyboard.shortcut", "text.type", "mouse.click",
        "volume.set", "volume.up", "volume.down", "volume.mute", "mic.mute",
        "media.playpause", "media.next", "media.previous",
        "system.lock", "system.sleep", "script.run",
    ]; // brightness.* is not offered: Windows has no dependency-free API for it

    // Windows virtual-key codes for the key names in KEYS (packages/shared/src/index.ts).
    private static readonly Dictionary<string, ushort> NamedKeys = new()
    {
        ["space"] = 0x20, ["enter"] = 0x0D, ["tab"] = 0x09, ["escape"] = 0x1B, ["backspace"] = 0x08, ["delete"] = 0x2E,
        ["up"] = 0x26, ["down"] = 0x28, ["left"] = 0x25, ["right"] = 0x27, ["home"] = 0x24, ["end"] = 0x23,
        ["pageup"] = 0x21, ["pagedown"] = 0x22, ["minus"] = 0xBD, ["equal"] = 0xBB, ["comma"] = 0xBC, ["period"] = 0xBE,
        ["slash"] = 0xBF, ["semicolon"] = 0xBA, ["quote"] = 0xDE, ["leftbracket"] = 0xDB, ["rightbracket"] = 0xDD,
        ["backslash"] = 0xDC, ["grave"] = 0xC0,
    };
    // cmd maps to the Windows key so one profile works on both operating systems.
    private static readonly Dictionary<string, ushort> ModifierKeys = new() { ["cmd"] = 0x5B, ["ctrl"] = 0x11, ["alt"] = 0x12, ["shift"] = 0x10 };
    // Keys on the navigation cluster must be flagged "extended" or Windows treats them as numpad keys.
    private static readonly HashSet<ushort> ExtendedKeys = [0x2E, 0x26, 0x28, 0x25, 0x27, 0x24, 0x23, 0x21, 0x22, 0x5B];

    private const ushort MediaPlayPause = 0xB3, MediaNext = 0xB0, MediaPrevious = 0xB1, Return = 0x0D, Tab = 0x09;

    /// <summary>The mute state wanted, given the current one: "on", "off", or toggle when absent.</summary>
    public static bool WantedMute(JsonElement p, bool current)
    {
        if (p.ValueKind != JsonValueKind.Object || !p.TryGetProperty("state", out _)) return !current;
        return Str(p, "state") switch
        {
            "on" => true,
            "off" => false,
            "toggle" => !current,
            _ => throw new AgentException("Invalid mute state"),
        };
    }

    public static string TypingText(JsonElement p)
    {
        if (Str(p, "text") is { Length: > 0 and <= 500 } text && text.All(c => c is '\n' or '\t' || !char.IsControl(c))) return text;
        throw new AgentException("Invalid text");
    }

    /// <summary>The executable allow-listed under this name in agent.json. Nothing from the network ever becomes a path.</summary>
    public static string ScriptPath(JsonElement p, IReadOnlyDictionary<string, string> scripts)
    {
        if (Str(p, "name") is not { } name || !scripts.TryGetValue(name, out var path))
            throw new AgentException("No script with that name is allowed on this computer");
        if (!Path.IsPathFullyQualified(path) || !File.Exists(path)) throw new AgentException("The script file is missing");
        return path;
    }

    /// <summary>Names of programs that have a window, so an app button can show whether its app is running.</summary>
    public static string[] RunningApps()
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                try
                {
                    if (process.MainWindowHandle == IntPtr.Zero) continue;
                    names.Add(process.ProcessName);
                    // The friendly name ("Visual Studio Code") is unreadable for elevated processes; that is fine.
                    if (process.MainModule?.FileVersionInfo.FileDescription is { Length: > 0 and <= 200 } description) names.Add(description);
                }
                catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException or NotSupportedException) { }
            }
        }
        return names.Order(StringComparer.OrdinalIgnoreCase).Take(300).ToArray();
    }

    public static ushort? KeyCode(string key)
    {
        if (key.Length == 1 && key[0] is (>= 'a' and <= 'z') or (>= '0' and <= '9')) return char.ToUpperInvariant(key[0]);
        if (key.Length is 2 or 3 && key[0] == 'f' && key.Skip(1).All(char.IsAsciiDigit) && int.TryParse(key.AsSpan(1), out var n) && n is >= 1 and <= 12) return (ushort)(0x6F + n);
        return NamedKeys.TryGetValue(key, out var vk) ? vk : null;
    }

    private static string? Str(JsonElement p, string name) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    /// <summary>Parsed keyboard shortcut. Separate from sending so it can be unit-tested.</summary>
    public static (ushort Key, ushort[] Modifiers) Shortcut(JsonElement p)
    {
        if (Str(p, "key") is not { } key || KeyCode(key) is not { } vk) throw new AgentException("Unknown key");
        if (!p.TryGetProperty("modifiers", out var mods) || mods.ValueKind != JsonValueKind.Array) throw new AgentException("Invalid modifiers");
        var list = new List<ushort>();
        foreach (var m in mods.EnumerateArray())
        {
            if (m.ValueKind != JsonValueKind.String || !ModifierKeys.TryGetValue(m.GetString()!, out var mvk)) throw new AgentException("Unknown modifier");
            if (!list.Contains(mvk)) list.Add(mvk);
        }
        return (vk, list.ToArray());
    }

    public static int VolumeLevel(JsonElement p)
    {
        if (p.ValueKind == JsonValueKind.Object && p.TryGetProperty("level", out var v) && v.ValueKind == JsonValueKind.Number
            && v.TryGetInt32(out var n) && n is >= 0 and <= 100) return n;
        throw new AgentException("Volume must be a whole number from 0 to 100");
    }

    public static Uri HttpUrl(JsonElement p)
    {
        if (Str(p, "url") is { } s && Uri.TryCreate(s, UriKind.Absolute, out var url) && (url.Scheme == Uri.UriSchemeHttp || url.Scheme == Uri.UriSchemeHttps) && url.Host != "")
            return url;
        throw new AgentException("Only http(s) URLs can be opened");
    }

    /// <summary>
    /// Turns an app name into the single file Windows should start. Only three things can ever be started:
    /// a Start Menu shortcut with that name, an existing .exe given by full path, or a bare program name
    /// (forced to end in .exe, resolved by Windows through App Paths and PATH). Documents, scripts, URLs and
    /// command-line arguments are impossible by construction.
    /// </summary>
    public static string ResolveApp(JsonElement p, IEnumerable<string> startMenuShortcuts)
    {
        if (Str(p, "app") is not { Length: > 0 and <= 200 } app || app.StartsWith('-') || app.Any(char.IsControl))
            throw new AgentException("Invalid app name");
        var shortcut = startMenuShortcuts.FirstOrDefault(f => string.Equals(Path.GetFileNameWithoutExtension(f), app, StringComparison.OrdinalIgnoreCase));
        if (shortcut is not null) return shortcut;
        var isExe = app.EndsWith(".exe", StringComparison.OrdinalIgnoreCase);
        if (Path.IsPathFullyQualified(app))
            return isExe && File.Exists(app) ? app : throw new AgentException($"Could not find “{app}”. Use a Start Menu name or the full path of an .exe.");
        if (app.IndexOfAny(['\\', '/', ':', '"', '<', '>', '|', '?', '*']) >= 0) throw new AgentException("Invalid app name");
        return isExe ? app : app + ".exe";
    }

    public static IEnumerable<string> StartMenuShortcuts()
    {
        var options = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true };
        return new[] { Environment.SpecialFolder.Programs, Environment.SpecialFolder.CommonPrograms }
            .Select(Environment.GetFolderPath)
            .Where(Directory.Exists)
            .SelectMany(dir => Directory.EnumerateFiles(dir, "*.lnk", options));
    }

    private static readonly Dictionary<string, string> NoScripts = new();

    public static void Perform(string type, JsonElement p, IReadOnlyDictionary<string, string>? scripts = null)
    {
        switch (type)
        {
            case "app.launch":
                ShellOpen(ResolveApp(p, StartMenuShortcuts()), $"Could not open “{Str(p, "app")}”. Check the app name.");
                break;
            case "url.open":
                ShellOpen(HttpUrl(p).AbsoluteUri, "Could not open the URL");
                break;
            case "keyboard.shortcut":
                var (key, modifiers) = Shortcut(p);
                SendKeys(key, modifiers);
                break;
            case "volume.set": SetVolume(VolumeLevel(p)); break;
            case "volume.up": SetVolume(Math.Min(100, CurrentVolume() + 6)); break;
            case "volume.down": SetVolume(Math.Max(0, CurrentVolume() - 6)); break;
            case "volume.mute":
            case "mic.mute":
            {
                var mic = type == "mic.mute";
                bool? Current() => mic ? Audio.MicMuted() : Audio.Status().Muted;
                if (Current() is not { } before) throw new AgentException(mic ? "No microphone is available" : "No audio output device is available");
                var want = WantedMute(p, before);
                Audio.SetMute(want, mic);
                if (Current() != want) throw new AgentException("Mute did not change");
                break;
            }
            case "text.type":
                foreach (var c in TypingText(p))
                {
                    var down = c switch { '\n' => Native.Key(Return, true, false), '\t' => Native.Key(Tab, true, false), _ => Native.Unicode(c, true) };
                    var up = c switch { '\n' => Native.Key(Return, false, false), '\t' => Native.Key(Tab, false, false), _ => Native.Unicode(c, false) };
                    Send([down, up]);
                }
                break;
            case "mouse.click":
                var button = Str(p, "button");
                if (button is not ("left" or "right")) throw new AgentException("Invalid mouse button");
                Send([Native.Mouse(button == "left" ? Native.LeftDown : Native.RightDown), Native.Mouse(button == "left" ? Native.LeftUp : Native.RightUp)]);
                break;
            case "system.lock":
                if (!Native.LockWorkStation()) throw new AgentException("Windows refused to lock the screen");
                break;
            case "system.sleep":
                // Sleep a moment later so the result reaches the hub before the network goes down.
                _ = Task.Delay(1000).ContinueWith(_ => Native.SetSuspendState(false, false, false));
                break;
            case "script.run":
                RunScript(ScriptPath(p, scripts ?? NoScripts));
                break;
            case "media.playpause": SendKeys(MediaPlayPause, []); break;
            case "media.next": SendKeys(MediaNext, []); break;
            case "media.previous": SendKeys(MediaPrevious, []); break;
            default: throw new AgentException("Unsupported action");
        }
    }

    private static int CurrentVolume() => Audio.Status().Volume ?? throw new AgentException("No audio output device is available");

    private static void SetVolume(int level)
    {
        Audio.SetVolume(level);
        // Read back so a silent no-op is never reported as success.
        if (Audio.Status().Volume is not { } now || Math.Abs(now - level) > 2) throw new AgentException("Volume did not change");
    }

    private static void ShellOpen(string target, string failure)
    {
        try
        {
            // UseShellExecute with a file name only: Windows resolves and opens exactly one target, with no arguments.
            using var process = Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or FileNotFoundException or InvalidOperationException)
        {
            throw new AgentException(failure);
        }
    }

    private static void RunScript(string path)
    {
        try
        {
            // No shell and no arguments: exactly the allow-listed file runs (.exe, .bat or .cmd).
            using var process = Process.Start(new ProcessStartInfo(path) { UseShellExecute = false, CreateNoWindow = true })
                ?? throw new AgentException("The script could not be started");
            if (!process.WaitForExit(8000))
            {
                process.Kill(entireProcessTree: true);
                throw new AgentException("Did not finish within 8 seconds and was stopped");
            }
            if (process.ExitCode != 0) throw new AgentException($"Script exited with code {process.ExitCode}");
        }
        catch (System.ComponentModel.Win32Exception)
        {
            throw new AgentException("The script could not be started");
        }
    }

    private static void Send(Native.INPUT[] inputs)
    {
        var sent = Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Native.INPUT>());
        // Windows silently drops injected input aimed at a window running as administrator (UIPI) and on the lock screen.
        if (sent != inputs.Length) throw new AgentException("Windows blocked the input. An administrator window or the lock screen may be in front.");
    }

    private static void SendKeys(ushort key, ushort[] modifiers)
    {
        var inputs = new List<Native.INPUT>();
        foreach (var m in modifiers) inputs.Add(Native.Key(m, down: true, ExtendedKeys.Contains(m)));
        inputs.Add(Native.Key(key, down: true, ExtendedKeys.Contains(key)));
        inputs.Add(Native.Key(key, down: false, ExtendedKeys.Contains(key)));
        foreach (var m in Enumerable.Reverse(modifiers)) inputs.Add(Native.Key(m, down: false, ExtendedKeys.Contains(m)));
        Send(inputs.ToArray());
    }
}

internal static class Native
{
    private const uint InputMouse = 0, InputKeyboard = 1, KeyUp = 0x0002, ExtendedKey = 0x0001, UnicodeKey = 0x0004;
    public const uint LeftDown = 0x0002, LeftUp = 0x0004, RightDown = 0x0008, RightUp = 0x0010;

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public InputUnion u; }

    // The union must include MOUSEINPUT (its largest member) so the struct has the size SendInput expects.
    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }

    public static INPUT Key(ushort vk, bool down, bool extended) => new()
    {
        type = InputKeyboard,
        u = new InputUnion { ki = new KEYBDINPUT { wVk = vk, dwFlags = (down ? 0 : KeyUp) | (extended ? ExtendedKey : 0) } },
    };

    /// <summary>One UTF-16 unit typed as a character, independent of the keyboard layout.</summary>
    public static INPUT Unicode(char c, bool down) => new()
    {
        type = InputKeyboard,
        u = new InputUnion { ki = new KEYBDINPUT { wScan = c, dwFlags = UnicodeKey | (down ? 0 : KeyUp) } },
    };

    /// <summary>A mouse button event at the current pointer position.</summary>
    public static INPUT Mouse(uint flags) => new() { type = InputMouse, u = new InputUnion { mi = new MOUSEINPUT { dwFlags = flags } } };

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint count, INPUT[] inputs, int size);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool LockWorkStation();

    [DllImport("powrprof.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.U1)]
    public static extern bool SetSuspendState([MarshalAs(UnmanagedType.U1)] bool hibernate, [MarshalAs(UnmanagedType.U1)] bool force, [MarshalAs(UnmanagedType.U1)] bool disableWakeEvents);

    [DllImport("kernel32.dll")]
    public static extern bool AttachConsole(int processId);
}
