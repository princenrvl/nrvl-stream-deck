using System.Text;
using System.Text.Json;
using NrvlAgent;
using Xunit;

public class AgentTests
{
    private static JsonElement J(string json) => JsonDocument.Parse(json).RootElement;

    private static string Pairing(string json) =>
        "nrvl1." + Convert.ToBase64String(Encoding.UTF8.GetBytes(json)).Replace('+', '-').Replace('/', '_').TrimEnd('=');

    [Fact]
    public void PairingStringRoundTrip()
    {
        var fp = new string('a', 32) + new string('B', 32);
        var info = PairingInfo.Parse(Pairing($$"""{"u":"https://my-mac.local:8443","c":"ABCDE-FGHJK","f":"{{fp}}"}"""));
        Assert.Equal("https://my-mac.local:8443/", info.HubUrl.AbsoluteUri);
        Assert.Equal("ABCDE-FGHJK", info.Code);
        Assert.Equal(fp.ToLowerInvariant(), info.CaFingerprint);
    }

    [Theory]
    [InlineData("hello")]
    [InlineData("nrvl1.!!!")]
    [InlineData("nrvl1.e30")] // {}
    public void PairingStringRejectsGarbage(string text) => Assert.Throws<AgentException>(() => PairingInfo.Parse(text));

    [Fact]
    public void PairingStringRejectsPlainHttp() =>
        Assert.Throws<AgentException>(() => PairingInfo.Parse(Pairing($$"""{"u":"http://x:1","c":"A","f":"{{new string('a', 64)}}"}""")));

    [Fact]
    public void ReplayGuardRejectsRepeatsAndStaleCommands()
    {
        var guard = new ReplayGuard();
        Assert.True(guard.Accept("a", 1000, 1000));
        Assert.False(guard.Accept("a", 1000, 1500)); // same id replayed
        Assert.False(guard.Accept("b", 1000, 40000)); // stale
        Assert.False(guard.Accept("c", 90000, 1000)); // from the future
        Assert.True(guard.Accept("d", 40000, 40000));
    }

    [Fact]
    public void ShortcutParsing()
    {
        var (key, mods) = Actions.Shortcut(J("""{"key":"4","modifiers":["cmd","shift","cmd"]}"""));
        Assert.Equal(0x34, key);
        Assert.Equal(new ushort[] { 0x5B, 0x10 }, mods);
        Assert.Throws<AgentException>(() => Actions.Shortcut(J("""{"key":"nope","modifiers":[]}""")));
        Assert.Throws<AgentException>(() => Actions.Shortcut(J("""{"key":"a","modifiers":["hyper"]}""")));
        Assert.Throws<AgentException>(() => Actions.Shortcut(J("""{"key":"a"}""")));
    }

    [Fact]
    public void EveryKeyInTheSharedContractHasAKeyCode()
    {
        // Mirrors KEYS in packages/shared/src/index.ts.
        var keys = "abcdefghijklmnopqrstuvwxyz0123456789".Select(c => c.ToString())
            .Concat(Enumerable.Range(1, 12).Select(n => $"f{n}"))
            .Concat(["space", "enter", "tab", "escape", "backspace", "delete", "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
                "minus", "equal", "comma", "period", "slash", "semicolon", "quote", "leftbracket", "rightbracket", "backslash", "grave"]);
        foreach (var k in keys) Assert.True(Actions.KeyCode(k) is not null, $"missing key code for {k}");
        Assert.Equal((ushort)0x41, Actions.KeyCode("a"));
        Assert.Equal((ushort)0x46, Actions.KeyCode("f")); // the letter, not a function key
        Assert.Equal((ushort)0x7B, Actions.KeyCode("f12"));
        Assert.Null(Actions.KeyCode("f13"));
        Assert.Null(Actions.KeyCode("A"));
    }

    [Fact]
    public void ParameterValidation()
    {
        Assert.Equal(35, Actions.VolumeLevel(J("""{"level":35}""")));
        Assert.Throws<AgentException>(() => Actions.VolumeLevel(J("""{"level":101}""")));
        Assert.Throws<AgentException>(() => Actions.VolumeLevel(J("""{"level":3.5}""")));
        Assert.Throws<AgentException>(() => Actions.VolumeLevel(J("""{"level":"50"}""")));
        Assert.Equal("https://example.com/x", Actions.HttpUrl(J("""{"url":"https://example.com/x"}""")).AbsoluteUri);
        Assert.Throws<AgentException>(() => Actions.HttpUrl(J("""{"url":"file:///C:/Windows/win.ini"}""")));
        Assert.Throws<AgentException>(() => Actions.HttpUrl(J("""{"url":"javascript:alert(1)"}""")));
        Assert.Throws<AgentException>(() => Actions.Perform("shell.exec", J("""{"cmd":"whoami"}""")));
    }

    [Fact]
    public void MuteStateTypingTextAndScripts()
    {
        Assert.True(Actions.WantedMute(J("{}"), current: false));
        Assert.False(Actions.WantedMute(J("""{"state":"toggle"}"""), current: true));
        Assert.True(Actions.WantedMute(J("""{"state":"on"}"""), current: true));
        Assert.False(Actions.WantedMute(J("""{"state":"off"}"""), current: true));
        Assert.Throws<AgentException>(() => Actions.WantedMute(J("""{"state":"maybe"}"""), current: true));

        Assert.Equal("ab\ncd\t", Actions.TypingText(J("""{"text":"ab\ncd\t"}""")));
        Assert.Throws<AgentException>(() => Actions.TypingText(J("""{"text":""}""")));
        Assert.Throws<AgentException>(() => Actions.TypingText(J("""{"text":"a\u001bb"}""")));
        Assert.Throws<AgentException>(() => Actions.TypingText(J(JsonSerializer.Serialize(new { text = new string('x', 501) }))));

        var cmd = Path.Combine(Environment.SystemDirectory, "cmd.exe");
        var scripts = new Dictionary<string, string> { ["ok"] = cmd, ["missing"] = @"C:\no\such\file.exe", ["relative"] = "cmd.exe" };
        Assert.Equal(cmd, Actions.ScriptPath(J("""{"name":"ok"}"""), scripts));
        Assert.Throws<AgentException>(() => Actions.ScriptPath(J(JsonSerializer.Serialize(new { name = cmd })), scripts)); // a path is not a name
        Assert.Throws<AgentException>(() => Actions.ScriptPath(J("""{"name":"missing"}"""), scripts));
        Assert.Throws<AgentException>(() => Actions.ScriptPath(J("""{"name":"relative"}"""), scripts));
        Assert.Throws<AgentException>(() => Actions.ScriptPath(J("""{"name":"ok"}"""), new Dictionary<string, string>()));
    }

    [Fact]
    public void AppResolutionOnlyEverYieldsAShortcutOrAnExe()
    {
        string[] menu = [@"C:\Menu\Visual Studio Code.lnk", @"C:\Menu\Tools\Paint.NET.lnk"];
        string Resolve(string app) => Actions.ResolveApp(J(JsonSerializer.Serialize(new { app })), menu);

        Assert.Equal(@"C:\Menu\Visual Studio Code.lnk", Resolve("visual studio code")); // Start Menu name, case-insensitive
        Assert.Equal(@"C:\Menu\Tools\Paint.NET.lnk", Resolve("Paint.NET"));
        Assert.Equal("notepad.exe", Resolve("notepad")); // bare name is forced to .exe
        Assert.Equal("chrome.exe", Resolve("chrome.exe"));
        Assert.Equal("evil.bat.exe", Resolve("evil.bat")); // a script name can never be started as a script

        foreach (var bad in new[] { "--help", "a\nb", "", @"..\..\evil", "https://example.com", @"C:\Windows\win.ini", @"C:\does\not\exist.exe", "a|b", "cmd /c calc" + new string('x', 200) })
            Assert.Throws<AgentException>(() => Resolve(bad));
    }
}
