using System.Diagnostics;

namespace Runova.RemoteAgent;

/// <summary>Runs the system's own tools while the agent sets itself up.</summary>
internal static class ProcessRunner
{
    public static void Run(string program, string arguments, bool allowFailure = false)
    {
        using var process = Process.Start(new ProcessStartInfo(program, arguments) { UseShellExecute = false, CreateNoWindow = true })
            ?? throw new InvalidOperationException($"{program} did not start.");
        process.WaitForExit();
        if (process.ExitCode != 0 && !allowFailure)
        {
            throw new InvalidOperationException($"{program} {arguments} failed with {process.ExitCode}.");
        }
    }
}
