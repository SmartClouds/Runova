using System.Runtime.Versioning;
using Runova.RemoteAgent;
using Runova.RemoteAgent.Core;
using Runova.RemoteAgent.Linux;
using Runova.RemoteAgent.Mac;
using Runova.RemoteAgent.Windows;

// RunovaAgent: keeps a computer reachable through Runova Anywhere while no one is signed in (E64, E65).
//
//   RunovaAgent install --config <file>   (administrator) store the app's config, register the service
//   RunovaAgent uninstall                  (administrator) remove the service and its config
//   RunovaAgent service                    what the Windows service runs: supervises the helper
//   RunovaAgent run                        the part that talks to the website and drives the screen
var command = args.FirstOrDefault() ?? "";
switch (command)
{
    case "install" when args.Length == 3 && args[1] == "--config":
        return Install(args[2]);
    case "uninstall":
        return Uninstall();
    case "service" when OperatingSystem.IsWindows():
        return await RunServiceAsync();
    case "run":
        return await RunAgentAsync();
    default:
        Console.Error.WriteLine("Usage: RunovaAgent install --config <file> | uninstall | service | run");
        return 2;
}

static async Task<int> RunAgentAsync()
{
    var config = AgentConfigStore.Load();
    var builder = Host.CreateApplicationBuilder();
    builder.Services.AddSingleton(config);
    builder.Services.AddSingleton(TimeProvider.System);
    AddPlatform(builder.Services);
    builder.Services.AddSingleton(new HttpClient { Timeout = TimeSpan.FromSeconds(30) });
    builder.Services.AddHostedService<AgentService>();
    await builder.Build().RunAsync();
    return 0;
}

static void AddPlatform(IServiceCollection services)
{
    if (OperatingSystem.IsWindows())
    {
        services.AddSingleton<IAgentPlatform, WindowsAgentPlatform>();
    }
    else if (OperatingSystem.IsMacOS())
    {
        services.AddSingleton<IAgentPlatform, MacAgentPlatform>();
    }
    else if (OperatingSystem.IsLinux())
    {
        services.AddSingleton<IAgentPlatform, LinuxAgentPlatform>();
    }
    else
    {
        throw new PlatformNotSupportedException("The Runova agent runs on Windows, macOS and Linux.");
    }
}

[SupportedOSPlatform("windows")]
static async Task<int> RunServiceAsync()
{
    var builder = Host.CreateApplicationBuilder();
    builder.Services.AddWindowsService(options => options.ServiceName = "RunovaAnywhereAgent");
    builder.Services.AddHostedService<SessionSupervisor>();
    await builder.Build().RunAsync();
    return 0;
}

static int Install(string configFile)
{
    var config = AgentConfig.Parse(File.ReadAllText(configFile));
    AgentConfigStore.Save(config);
    File.Delete(configFile);
    if (OperatingSystem.IsWindows())
    {
        return Installer.InstallWindowsService();
    }

    if (OperatingSystem.IsMacOS())
    {
        return MacInstaller.Install();
    }

    return OperatingSystem.IsLinux() ? LinuxInstaller.Install() : 3;
}

static int Uninstall()
{
    if (OperatingSystem.IsWindows())
    {
        return Installer.UninstallWindowsService();
    }

    if (OperatingSystem.IsMacOS())
    {
        return MacInstaller.Uninstall();
    }

    return OperatingSystem.IsLinux() ? LinuxInstaller.Uninstall() : 3;
}

[SupportedOSPlatform("windows")]
internal sealed class WindowsAgentPlatform : IAgentPlatform, IDisposable
{
    private readonly DesktopThread _desktop = new();
    private readonly JpegTileEncoder _encoder = new();

    public WindowsAgentPlatform()
    {
        Screen = new GdiScreenSource(_desktop);
        Input = new SendInputSink(_desktop);
    }

    public IScreenSource Screen { get; }

    public ITileEncoder Encoder => _encoder;

    public IInputSink Input { get; }

    public void Dispose()
    {
        _desktop.Dispose();
        _encoder.Dispose();
    }
}

/// <summary>Registers the agent as a Windows service that starts with the computer, as LocalSystem.</summary>
[SupportedOSPlatform("windows")]
internal static class Installer
{
    public const string ServiceName = "RunovaAnywhereAgent";

    public static string InstalledExe => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Runova", "Agent", "RunovaAgent.exe");

    public static int InstallWindowsService()
    {
        // Only SYSTEM and administrators may read the sealed config or replace the program.
        ProcessRunner.Run("icacls", $"\"{AgentConfigStore.Folder}\" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F");
        Directory.CreateDirectory(Path.GetDirectoryName(InstalledExe)!);
        ProcessRunner.Run("sc.exe", $"stop {ServiceName}", allowFailure: true);
        File.Copy(Environment.ProcessPath!, InstalledExe, overwrite: true);
        ProcessRunner.Run("icacls", $"\"{Path.GetDirectoryName(InstalledExe)}\" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *S-1-5-32-545:(OI)(CI)RX");
        ProcessRunner.Run("sc.exe", $"delete {ServiceName}", allowFailure: true);
        ProcessRunner.Run("sc.exe", $"create {ServiceName} binPath= \"\\\"{InstalledExe}\\\" service\" start= auto obj= LocalSystem DisplayName= \"Runova Anywhere agent\"");
        ProcessRunner.Run("sc.exe", $"description {ServiceName} \"Keeps this computer reachable through Runova Anywhere while no one is signed in.\"");
        ProcessRunner.Run("sc.exe", $"failure {ServiceName} reset= 86400 actions= restart/5000/restart/30000/restart/60000");
        ProcessRunner.Run("sc.exe", $"start {ServiceName}");
        return 0;
    }

    public static int UninstallWindowsService()
    {
        ProcessRunner.Run("sc.exe", $"stop {ServiceName}", allowFailure: true);
        ProcessRunner.Run("sc.exe", $"delete {ServiceName}", allowFailure: true);
        if (Directory.Exists(AgentConfigStore.Folder))
        {
            Directory.Delete(AgentConfigStore.Folder, recursive: true);
        }

        return 0;
    }
}
