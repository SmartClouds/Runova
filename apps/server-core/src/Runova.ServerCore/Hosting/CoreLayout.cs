namespace Runova.ServerCore.Hosting;

/// <summary>
/// Where an installed core lives: its program, releases, state, configuration, socket, unit and
/// group.
/// </summary>
internal sealed record CoreLayout
{
    /// <summary>The prefix of every transient unit the core starts.</summary>
    public const string TransientUnitPrefix = "runova-";

    /// <summary>The Host header that means the core.</summary>
    public const string HostName = "runova-core";

    /// <summary>The layout this process runs in.</summary>
    public static CoreLayout Current { get; } = new()
    {
        Root = "/opt/runova-core",
        DataDirectory = "/var/lib/runova-core",
        ConfigDirectory = "/etc/runova-core",
        RuntimeDirectory = "/run/runova-core",
        Unit = "runova-core",
        Binary = "runova-core",
        Group = "runova",
        TarballPrefix = "runova-core-",
        NeedrestartOverridePath = "/etc/needrestart/conf.d/runova-core.conf",
    };

    /// <summary>The program's folder: releases/, the current link and the update staging folder.</summary>
    public required string Root { get; init; }

    /// <summary>systemd's StateDirectory: created for root only (0700) before the core starts.</summary>
    public required string DataDirectory { get; init; }

    public required string ConfigDirectory { get; init; }

    /// <summary>systemd's RuntimeDirectory, which holds the socket.</summary>
    public required string RuntimeDirectory { get; init; }

    public required string Unit { get; init; }

    /// <summary>The program's file name inside a release.</summary>
    public required string Binary { get; init; }

    /// <summary>The group whose members may open the socket.</summary>
    public required string Group { get; init; }

    /// <summary>Release tarballs are named &lt;prefix&gt;&lt;version&gt;-&lt;rid&gt;.tar.gz.</summary>
    public required string TarballPrefix { get; init; }

    public required string NeedrestartOverridePath { get; init; }

    public string Releases => Root + "/releases";

    public string CurrentLink => Root + "/current";

    public string Staging => Root + "/update";

    /// <summary>The program as the unit starts it, through the current link.</summary>
    public string BinaryPath => CurrentLink + "/" + Binary;

    public string ConfigFile => ConfigDirectory + "/core.json";

    public string SocketPath => RuntimeDirectory + "/core.sock";

    public string UnitFile => Unit + ".service";

    public string UnitPath => "/etc/systemd/system/" + UnitFile;

    public string TarballName(string version, string rid) => $"{TarballPrefix}{version}-{rid}.tar.gz";
}
