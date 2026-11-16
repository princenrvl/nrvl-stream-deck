using System.Runtime.InteropServices;

namespace NrvlAgent;

/// <summary>
/// Master volume and mute of the default output device, through the Windows Core Audio COM API.
/// The endpoint is looked up on every call so switching speakers/headphones is always followed.
/// </summary>
public static class Audio
{
    private const int Render = 0, Capture = 1;

    public static bool? MicMuted()
    {
        var endpoint = Endpoint(Capture);
        if (endpoint is null) return null;
        try { return endpoint.GetMute(out var mute) == 0 ? mute : null; }
        finally { Marshal.ReleaseComObject(endpoint); }
    }

    public static (int? Volume, bool? Muted) Status()
    {
        var endpoint = Endpoint(Render);
        if (endpoint is null) return (null, null);
        try
        {
            int? volume = endpoint.GetMasterVolumeLevelScalar(out var level) == 0 ? (int)Math.Round(level * 100) : null;
            bool? muted = endpoint.GetMute(out var mute) == 0 ? mute : null;
            return (volume, muted);
        }
        finally { Marshal.ReleaseComObject(endpoint); }
    }

    public static void SetVolume(int percent) => With(Render, e => e.SetMasterVolumeLevelScalar(percent / 100f, ref NoContext));

    public static void SetMute(bool mute, bool microphone = false) => With(microphone ? Capture : Render, e => e.SetMute(mute, ref NoContext));

    private static Guid NoContext = Guid.Empty;

    private static void With(int dataFlow, Func<IAudioEndpointVolume, int> call)
    {
        var endpoint = Endpoint(dataFlow) ?? throw new AgentException(dataFlow == Capture ? "No microphone is available" : "No audio output device is available");
        try
        {
            if (call(endpoint) != 0) throw new AgentException("Windows refused the volume change");
        }
        finally { Marshal.ReleaseComObject(endpoint); }
    }

    private static IAudioEndpointVolume? Endpoint(int dataFlow)
    {
        const int Multimedia = 1, ClsCtxAll = 23;
        IMMDeviceEnumerator? enumerator = null;
        IMMDevice? device = null;
        try
        {
            enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            if (enumerator.GetDefaultAudioEndpoint(dataFlow, Multimedia, out device) != 0 || device is null) return null;
            var iid = typeof(IAudioEndpointVolume).GUID;
            return device.Activate(ref iid, ClsCtxAll, IntPtr.Zero, out var obj) == 0 ? (IAudioEndpointVolume)obj : null;
        }
        catch (COMException) { return null; }
        finally
        {
            if (device is not null) Marshal.ReleaseComObject(device);
            if (enumerator is not null) Marshal.ReleaseComObject(enumerator);
        }
    }

    // ---- COM declarations. Method ORDER is the vtable layout and must not be changed. ----

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumerator { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice? device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioEndpointVolume
    {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
        [PreserveSig] int GetChannelCount(out uint count);
        [PreserveSig] int SetMasterVolumeLevel(float levelDb, ref Guid context);
        [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid context);
        [PreserveSig] int GetMasterVolumeLevel(out float levelDb);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
        [PreserveSig] int SetChannelVolumeLevel(uint channel, float levelDb, ref Guid context);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
        [PreserveSig] int GetChannelVolumeLevel(uint channel, out float levelDb);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }
}
