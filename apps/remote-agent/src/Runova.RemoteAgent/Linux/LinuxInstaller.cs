using System.Runtime.Versioning;

namespace Runova.RemoteAgent.Linux;

/// <summary>Registers the agent as a systemd service that starts with the computer, as root (E65).</summary>
public static class LinuxInstaller
{
    private const string ServiceName = "runova-anywhere-agent";
    private const string Folder = "/opt/runova-agent";
    private const string UnitFile = $"/etc/systemd/system/{ServiceName}.service";

    /// <summary>
    /// A single-file build unpacks its native libraries somewhere, and a service has no home folder
    /// for that. /tmp stays shared: the X sockets live there.
    /// </summary>
    public static string Unit =>
        $"""
        [Unit]
        Description=Runova Anywhere agent
        Wants=network-online.target
        After=network-online.target display-manager.service

        [Service]
        ExecStart={Folder}/RunovaAgent run
        Restart=always
        RestartSec=2
        StateDirectory=runova-agent
        StateDirectoryMode=0700
        Environment=DOTNET_BUNDLE_EXTRACT_BASE_DIR=/var/lib/runova-agent
        NoNewPrivileges=yes
        ProtectSystem=full
        ProtectHome=read-only

        [Install]
        WantedBy=multi-user.target

        """;

    [SupportedOSPlatform("linux")]
    public static int Install()
    {
        Directory.CreateDirectory(Folder);
        File.SetUnixFileMode(Folder, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        ProcessRunner.Run("systemctl", $"stop {ServiceName}", allowFailure: true);
        var target = Path.Combine(Folder, "RunovaAgent");
        File.Copy(Environment.ProcessPath!, target, overwrite: true);
        File.SetUnixFileMode(target, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        File.WriteAllText(UnitFile, Unit);
        File.SetUnixFileMode(UnitFile, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead);
        ProcessRunner.Run("systemctl", "daemon-reload");
        ProcessRunner.Run("systemctl", $"enable --now {ServiceName}");
        return 0;
    }

    [SupportedOSPlatform("linux")]
    public static int Uninstall()
    {
        ProcessRunner.Run("systemctl", $"disable --now {ServiceName}", allowFailure: true);
        File.Delete(UnitFile);
        ProcessRunner.Run("systemctl", "daemon-reload", allowFailure: true);
        if (Directory.Exists(AgentConfigStore.Folder))
        {
            Directory.Delete(AgentConfigStore.Folder, recursive: true);
        }

        if (Directory.Exists(Folder))
        {
            Directory.Delete(Folder, recursive: true);
        }

        return 0;
    }
}
