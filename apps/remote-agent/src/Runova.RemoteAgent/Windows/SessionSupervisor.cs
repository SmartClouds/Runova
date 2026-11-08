using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Runova.RemoteAgent.Windows;

/// <summary>
/// The Windows service side of the agent (E64). A service runs in session 0, which has no screen,
/// so it starts `RunovaAgent run` as SYSTEM inside the session at the physical console, keeps it
/// alive, and starts it again in the new session when the console moves (a user signs in, switches
/// or signs out). That helper is what talks to the website and captures the screen.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed partial class SessionSupervisor(ILogger<SessionSupervisor> logger) : BackgroundService
{
    private static readonly TimeSpan _checkEvery = TimeSpan.FromSeconds(2);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        uint session = uint.MaxValue;
        System.Diagnostics.Process? helper = null;
        using var timer = new PeriodicTimer(_checkEvery);
        do
        {
            var console = NativeMethods.WTSGetActiveConsoleSessionId();
            if (console == 0xFFFFFFFF)
            {
                continue;
            }

            if (console != session || helper is null || helper.HasExited)
            {
                Stop(helper);
                helper = null;
                try
                {
                    helper = StartInSession(console);
                    session = console;
                    LogStarted(logger, console);
                }
                catch (Win32Exception e)
                {
                    LogFailed(logger, console, e.Message);
                }
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));

        Stop(helper);
    }

    private static System.Diagnostics.Process StartInSession(uint session)
    {
        if (!NativeMethods.OpenProcessToken(NativeMethods.GetCurrentProcess(), NativeMethods.TokenAllAccess, out var own))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        try
        {
            if (!NativeMethods.DuplicateTokenEx(own, NativeMethods.TokenAllAccess, 0, NativeMethods.SecurityImpersonation, NativeMethods.TokenPrimary, out var token))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            try
            {
                if (!NativeMethods.SetTokenInformation(token, NativeMethods.TokenSessionId, ref session, sizeof(uint)))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }

                var exe = Environment.ProcessPath ?? throw new InvalidOperationException("The agent does not know its own path.");
                var desktop = Marshal.StringToHGlobalUni("winsta0\\default");
                try
                {
                    var startup = new NativeMethods.StartupInfo { Cb = Marshal.SizeOf<NativeMethods.StartupInfo>(), Desktop = desktop };
                    if (!NativeMethods.CreateProcessAsUser(token, exe, $"\"{exe}\" run", 0, 0, false, NativeMethods.CreateNoWindow | NativeMethods.CreateUnicodeEnvironment, 0, null, ref startup, out var info))
                    {
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    }

                    NativeMethods.CloseHandle(info.Thread);
                    NativeMethods.CloseHandle(info.Process);
                    return System.Diagnostics.Process.GetProcessById(info.ProcessId);
                }
                finally
                {
                    Marshal.FreeHGlobal(desktop);
                }
            }
            finally
            {
                NativeMethods.CloseHandle(token);
            }
        }
        finally
        {
            NativeMethods.CloseHandle(own);
        }
    }

    private static void Stop(System.Diagnostics.Process? helper)
    {
        if (helper is null)
        {
            return;
        }

        try
        {
            if (!helper.HasExited)
            {
                helper.Kill();
            }
        }
        catch (InvalidOperationException)
        {
        }

        helper.Dispose();
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Started the agent in console session {Session}")]
    private static partial void LogStarted(ILogger logger, uint session);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Could not start the agent in console session {Session}: {Reason}")]
    private static partial void LogFailed(ILogger logger, uint session, string reason);
}
