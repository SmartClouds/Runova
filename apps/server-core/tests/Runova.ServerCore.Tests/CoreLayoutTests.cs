using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.Tests;

/// <summary>Where an installed core keeps its program, state, socket and unit.</summary>
public sealed class CoreLayoutTests
{
    [Fact]
    public void The_layout_names_its_paths()
    {
        var layout = CoreLayout.Current;
        Assert.Equal("/opt/runova-core/current/runova-core", layout.BinaryPath);
        Assert.Equal("/run/runova-core/core.sock", layout.SocketPath);
        Assert.Equal("/etc/runova-core/core.json", layout.ConfigFile);
        Assert.Equal("/var/lib/runova-core", layout.DataDirectory);
        Assert.Equal("runova", layout.Group);
        Assert.Equal("/etc/systemd/system/runova-core.service", layout.UnitPath);
        Assert.Equal("runova-core-1.64.0-linux-x64.tar.gz", layout.TarballName("1.64.0", "linux-x64"));
    }

    [Fact]
    public void The_core_answers_to_its_own_host_name() =>
        Assert.Equal("runova-core", CoreApplication.AllowedHosts[0]);
}
