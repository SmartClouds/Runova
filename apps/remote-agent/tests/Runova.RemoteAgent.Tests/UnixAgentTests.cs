using System.Runtime.Versioning;
using System.Text.Json.Nodes;
using Runova.RemoteAgent.Core;
using Runova.RemoteAgent.Linux;
using Runova.RemoteAgent.Mac;
using SkiaSharp;

namespace Runova.RemoteAgent.Tests;

/// <summary>The agent on macOS and Linux (E65): input, finding the screen, and setting itself up.</summary>
public class UnixAgentTests
{
    private static JsonObject Event(string json) => JsonNode.Parse(json)!.AsObject();

    [Fact]
    public void X11_pointer_events_land_in_pixels_with_the_right_button()
    {
        Assert.Equal([new X11Step.Move(960, 540)], X11Input.Steps(Event("""{"k":"move","x":0.5,"y":0.5}"""), 1920, 1080));
        Assert.Equal(
            [new X11Step.Move(1919, 1079), new X11Step.Button(3, true)],
            X11Input.Steps(Event("""{"k":"down","x":1,"y":1,"button":"right"}"""), 1920, 1080));
        Assert.Equal(
            [new X11Step.Move(0, 0), new X11Step.Button(1, false)],
            X11Input.Steps(Event("""{"k":"up","x":0,"y":0}"""), 1920, 1080));
    }

    [Fact]
    public void X11_wheel_notches_are_button_clicks()
    {
        Assert.Equal(
            [new X11Step.Button(5, true), new X11Step.Button(5, false), new X11Step.Button(5, true), new X11Step.Button(5, false)],
            X11Input.Steps(Event("""{"k":"wheel","x":0,"y":0,"dx":0,"dy":2}"""), 10, 10));
        Assert.Equal(
            [new X11Step.Button(4, true), new X11Step.Button(4, false)],
            X11Input.Steps(Event("""{"k":"wheel","x":0,"y":0,"dx":0,"dy":-1}"""), 10, 10));
    }

    [Fact]
    public void X11_keys_use_keysyms_and_text_goes_by_code_point()
    {
        Assert.Equal([new X11Step.Key(0xff0d, true)], X11Input.Steps(Event("""{"k":"key","code":"Enter","down":true}"""), 10, 10));
        Assert.Empty(X11Input.Steps(Event("""{"k":"key","code":"MediaPlayPause","down":true}"""), 10, 10));
        Assert.Equal(
            [new X11Step.Text(0x68), new X11Step.Text(0xe9), new X11Step.Text(0x1f600)],
            X11Input.Steps(Event("""{"k":"text","text":"hé😀"}"""), 10, 10));
    }

    private const string GdmServer = "/usr/lib/xorg/Xorg\0vt1\0-displayfd\0003\0-auth\0/run/user/120/gdm/Xauthority\0-background\0none\0";
    private const string LightDmServer = "/usr/lib/xorg/Xorg\0:0\0-seat\0seat0\0-auth\0/var/run/lightdm/root/:0\0-nolisten\0tcp\0vt7\0-novtswitch\0";

    [Fact]
    public void An_x_server_command_line_gives_its_auth_file_terminal_and_display()
    {
        Assert.Equal(new XServer("/run/user/120/gdm/Xauthority", 1, null), XServerDiscovery.Parse(GdmServer));
        Assert.Equal(new XServer("/var/run/lightdm/root/:0", 7, ":0"), XServerDiscovery.Parse(LightDmServer));
    }

    [Theory]
    [InlineData("/usr/bin/bash\0-c\0Xorg\0")]
    [InlineData("/usr/bin/Xwayland\0:1024\0-auth\0/run/user/120/.mutter-Xwaylandauth\0")]
    [InlineData("/usr/lib/xorg/Xorg\0vt1\0")]
    [InlineData("")]
    public void Anything_else_is_not_an_x_server_we_can_use(string commandLine) =>
        Assert.Null(XServerDiscovery.Parse(commandLine));

    [Fact]
    public void The_server_on_the_active_terminal_wins()
    {
        var greeter = new XServer("/a", 1, null);
        var desktop = new XServer("/b", 2, null);

        Assert.Equal(desktop, XServerDiscovery.Pick([greeter, desktop], "tty2\n"));
        Assert.Equal(greeter, XServerDiscovery.Pick([greeter, desktop], "tty1"));
        Assert.Equal(greeter, XServerDiscovery.Pick([greeter], "tty4"));
        Assert.Null(XServerDiscovery.Pick([greeter, desktop], "tty4"));
        Assert.Null(XServerDiscovery.Pick([], "tty1"));
    }

    private static readonly FileOwner _rootFile = new(0, (UnixFileMode)0b111_101_101);

    private sealed record FakeProcess(string CommandLine, string Executable, FileOwner Binary, int Uid);

    /// <summary>A Linux computer as discovery sees it, with GDM's greeter user (120) on seat0.</summary>
    private sealed class FakeProbe : IXServerProbe
    {
        public Dictionary<int, FakeProcess> Processes { get; } = [];

        public Dictionary<string, FileOwner> Folders { get; } = new()
        {
            ["/"] = _rootFile,
            ["/usr"] = _rootFile,
            ["/usr/lib"] = _rootFile,
            ["/usr/lib/xorg"] = _rootFile,
            ["/usr/bin"] = _rootFile,
        };

        /// <summary>The auth files on disk and who owns them.</summary>
        public Dictionary<string, FileOwner> Files { get; } = new()
        {
            ["/run/user/120/gdm/Xauthority"] = new FileOwner(120, (UnixFileMode)0b110_000_000),
        };

        public int? Seat { get; set; } = 120;

        public string Active { get; set; } = "tty1";

        public List<string> SocketNames { get; } = [];

        public Dictionary<string, int[]> Peers { get; } = [];

        public IEnumerable<int> ProcessIds() => Processes.Keys.Order();

        public string? CommandLine(int pid) => Processes.GetValueOrDefault(pid)?.CommandLine;

        public string? Executable(int pid) => Processes.GetValueOrDefault(pid)?.Executable;

        public FileOwner? ExecutableFile(int pid) => Processes.GetValueOrDefault(pid)?.Binary;

        public FileOwner? Folder(string path) => Folders.GetValueOrDefault(path);

        public FileOwner? FileAt(string path) => Files.GetValueOrDefault(path);

        public int? EffectiveUid(int pid) => Processes.GetValueOrDefault(pid)?.Uid;

        public int? SeatUser() => Seat;

        public string ActiveTerminal() => Active;

        public IEnumerable<string> Sockets() => SocketNames;

        public IReadOnlyList<int> SocketPeers(string display) => Peers.GetValueOrDefault(display) ?? [];
    }

    private static FakeProcess RealGdmServer => new(GdmServer, "/usr/lib/xorg/Xorg", _rootFile, 120);

    [Fact]
    public void The_display_managers_own_xorg_is_found_with_its_process()
    {
        var probe = new FakeProbe { Processes = { [29] = RealGdmServer } };

        Assert.Equal(new XServer("/run/user/120/gdm/Xauthority", 1, null, 29), XServerDiscovery.Current(probe));

        probe.Processes[29] = RealGdmServer with { Uid = 0, Executable = "/usr/lib/xorg/Xorg (deleted)" };
        Assert.Equal(29, XServerDiscovery.Current(probe)?.Pid);
    }

    [Fact]
    public void A_forged_command_line_on_the_active_terminal_loses_to_the_real_server()
    {
        // Another local user names Xorg, a display and an auth file of their own, with a lower pid.
        var forged = new FakeProcess("Xorg\0-auth\0/tmp/evil\0vt1\0:7\0", "/usr/bin/Xvfb", new FileOwner(0, (UnixFileMode)0b111_101_101), 1000);
        var probe = new FakeProbe { Processes = { [26] = forged, [29] = RealGdmServer } };

        Assert.Equal(29, XServerDiscovery.Current(probe)?.Pid);

        probe.Processes.Remove(29);
        Assert.Null(XServerDiscovery.Current(probe));
    }

    private static FakeProcess Forged(string how) => how switch
    {
        "real Xorg run by a user not on seat0" => RealGdmServer with { Uid = 1001 },
        "not Xorg" => RealGdmServer with { Executable = "/usr/bin/Xvfb", Uid = 0 },
        "the user's own Xorg" => RealGdmServer with { Executable = "/home/eve/Xorg", Binary = new FileOwner(1001, (UnixFileMode)0b111_101_101) },
        "root binary anyone can write" => RealGdmServer with { Binary = new FileOwner(0, (UnixFileMode)0b111_111_111) },
        "binary owned by someone else" => RealGdmServer with { Binary = new FileOwner(1001, (UnixFileMode)0b111_101_101) },
        "exe cannot be read" => RealGdmServer with { Executable = null! },
        _ => throw new ArgumentOutOfRangeException(nameof(how)),
    };

    [Theory]
    [InlineData("real Xorg run by a user not on seat0")]
    [InlineData("not Xorg")]
    [InlineData("the user's own Xorg")]
    [InlineData("root binary anyone can write")]
    [InlineData("binary owned by someone else")]
    [InlineData("exe cannot be read")]
    public void An_x_server_that_is_not_the_systems_own_is_never_used(string how)
    {
        var probe = new FakeProbe { Processes = { [26] = Forged(how) } };

        Assert.False(XServerDiscovery.Trusted(26, probe, probe.Seat));
        Assert.Null(XServerDiscovery.Current(probe));
    }

    [Fact]
    public void Xorg_in_a_folder_others_can_write_is_not_trusted()
    {
        var probe = new FakeProbe { Processes = { [29] = RealGdmServer } };
        probe.Folders["/usr/lib/xorg"] = new FileOwner(0, (UnixFileMode)0b111_111_101);

        Assert.Null(XServerDiscovery.Current(probe));

        probe.Folders["/usr/lib/xorg"] = new FileOwner(1001, (UnixFileMode)0b111_101_101);
        Assert.Null(XServerDiscovery.Current(probe));

        probe.Folders.Remove("/usr/lib/xorg");
        Assert.Null(XServerDiscovery.Current(probe));
    }

    [Fact]
    public void An_auth_file_of_another_account_is_never_read_for_a_server()
    {
        // The seat0 user starts the real Xorg binary themselves and names someone else's cookie
        // file; the agent, as root, would read it and hand the cookie to that user's server.
        var probe = new FakeProbe
        {
            Processes = { [29] = RealGdmServer with { CommandLine = "/usr/lib/xorg/Xorg\0vt1\0-displayfd\03\0-auth\0/home/bob/.Xauthority\0" } },
        };
        probe.Files["/home/bob/.Xauthority"] = new FileOwner(1001, (UnixFileMode)0b110_000_000);

        Assert.Null(XServerDiscovery.Current(probe));

        // Nor one that is missing, nor root's (another server's cookie); a server root runs may name any.
        probe.Files.Remove("/home/bob/.Xauthority");
        Assert.Null(XServerDiscovery.Current(probe));
        probe.Files["/home/bob/.Xauthority"] = new FileOwner(0, (UnixFileMode)0b110_000_000);
        Assert.Null(XServerDiscovery.Current(probe));
        probe.Processes[29] = probe.Processes[29] with { Uid = 0 };
        Assert.Equal(29, XServerDiscovery.Current(probe)?.Pid);
    }

    [Fact]
    public void A_rootless_xorg_counts_only_for_the_user_on_seat0()
    {
        var probe = new FakeProbe { Seat = 1000, Processes = { [29] = RealGdmServer } };
        Assert.Null(XServerDiscovery.Current(probe));

        probe.Seat = null;
        Assert.Null(XServerDiscovery.Current(probe));

        probe.Processes[29] = RealGdmServer with { Uid = 0 };
        Assert.Equal(29, XServerDiscovery.Current(probe)?.Pid);
    }

    [Fact]
    public void Only_displays_whose_sockets_lead_to_the_server_are_tried()
    {
        var server = new XServer("/run/user/120/gdm/Xauthority", 1, null, 29);
        var probe = new FakeProbe
        {
            SocketNames = { "X2", "X1", "X0", "X3" },
            Peers =
            {
                [":0"] = [26, 26],
                [":1"] = [29, 29],
                [":2"] = [26, 29],
                [":3"] = [],
            },
        };

        Assert.Equal([":1"], XServerDiscovery.Candidates(server, probe));
        Assert.Empty(XServerDiscovery.Candidates(server with { Display = ":0" }, probe));
        Assert.Equal([":1"], XServerDiscovery.Candidates(server with { Display = ":1" }, probe));
    }

    [Fact]
    public void The_seat_user_and_a_processs_effective_user_are_read_from_their_files()
    {
        Assert.Equal(1000, XServerDiscovery.SeatUser("# This is private data. Do not parse.\nIS_SEAT0=1\nACTIVE=2\nACTIVE_UID=1000\nSESSIONS=2 c1\n"));
        Assert.Null(XServerDiscovery.SeatUser("IS_SEAT0=1\nCAN_GRAPHICAL=1\n"));
        Assert.Equal(0, XServerDiscovery.EffectiveUid("Name:\tXorg\nUmask:\t0022\nUid:\t1000\t0\t0\t0\nGid:\t1000\t1000\t1000\t1000\n"));
        Assert.Null(XServerDiscovery.EffectiveUid("Name:\tgone\n"));
    }

    [Fact]
    public void The_systemd_unit_restarts_the_agent_and_gives_it_somewhere_to_unpack()
    {
        var unit = LinuxInstaller.Unit;

        Assert.Contains("ExecStart=/opt/runova-agent/RunovaAgent run", unit, StringComparison.Ordinal);
        Assert.Contains("Restart=always", unit, StringComparison.Ordinal);
        Assert.Contains("Environment=DOTNET_BUNDLE_EXTRACT_BASE_DIR=/var/lib/runova-agent", unit, StringComparison.Ordinal);
        Assert.Contains("StateDirectory=runova-agent", unit, StringComparison.Ordinal);
        Assert.Contains("WantedBy=multi-user.target", unit, StringComparison.Ordinal);
    }

    [Fact]
    public void Mac_pointer_events_drag_while_a_button_is_held()
    {
        var held = new MacButtons();

        Assert.Equal([new MacStep.Mouse(5, 720, 450, 0)], MacInput.Steps(Event("""{"k":"move","x":0.5,"y":0.5}"""), 1440, 900, held));
        Assert.Equal([new MacStep.Mouse(1, 0, 0, 0)], MacInput.Steps(Event("""{"k":"down","x":0,"y":0}"""), 1440, 900, held));
        Assert.Equal([new MacStep.Mouse(6, 720, 450, 0)], MacInput.Steps(Event("""{"k":"move","x":0.5,"y":0.5}"""), 1440, 900, held));
        Assert.Equal([new MacStep.Mouse(2, 720, 450, 0)], MacInput.Steps(Event("""{"k":"up","x":0.5,"y":0.5}"""), 1440, 900, held));
        Assert.Equal([new MacStep.Mouse(5, 0, 0, 0)], MacInput.Steps(Event("""{"k":"move","x":0,"y":0}"""), 1440, 900, held));
    }

    [Fact]
    public void Mac_right_and_middle_buttons_have_their_own_event_types()
    {
        var held = new MacButtons();

        Assert.Equal([new MacStep.Mouse(3, 0, 0, 1)], MacInput.Steps(Event("""{"k":"down","x":0,"y":0,"button":"right"}"""), 10, 10, held));
        Assert.Equal([new MacStep.Mouse(4, 0, 0, 1)], MacInput.Steps(Event("""{"k":"up","x":0,"y":0,"button":"right"}"""), 10, 10, held));
        Assert.Equal([new MacStep.Mouse(25, 0, 0, 2)], MacInput.Steps(Event("""{"k":"down","x":0,"y":0,"button":"middle"}"""), 10, 10, held));
    }

    [Fact]
    public void Mac_keys_use_virtual_codes_and_text_stays_whole()
    {
        var held = new MacButtons();

        Assert.Equal([new MacStep.Key(36, true)], MacInput.Steps(Event("""{"k":"key","code":"Enter","down":true}"""), 10, 10, held));
        Assert.Empty(MacInput.Steps(Event("""{"k":"key","code":"MediaPlayPause","down":true}"""), 10, 10, held));
        Assert.Equal([new MacStep.Text("hé")], MacInput.Steps(Event("""{"k":"text","text":"hé"}"""), 10, 10, held));
        Assert.Equal([new MacStep.Scroll(-2, 0)], MacInput.Steps(Event("""{"k":"wheel","x":0,"y":0,"dx":0,"dy":2}"""), 10, 10, held));
    }

    [Fact]
    public void The_login_window_agent_runs_only_there_and_stays_up()
    {
        var plist = MacInstaller.Plist;

        Assert.Contains("<key>LimitLoadToSessionType</key>\n  <string>LoginWindow</string>", plist, StringComparison.Ordinal);
        Assert.Contains("<string>/Library/Application Support/Runova/Agent/RunovaAgent</string>\n    <string>run</string>", plist, StringComparison.Ordinal);
        Assert.Contains("<key>KeepAlive</key>\n  <true/>", plist, StringComparison.Ordinal);
        Assert.Contains("<key>DOTNET_BUNDLE_EXTRACT_BASE_DIR</key>", plist, StringComparison.Ordinal);
    }

    [Fact]
    public void A_tile_is_encoded_as_a_jpeg_of_just_that_rectangle()
    {
        // Four by four BGRA: the left half blue, the right half red.
        var pixels = new byte[4 * 4 * 4];
        for (var i = 0; i < pixels.Length; i += 4)
        {
            var left = (i / 4) % 4 < 2;
            pixels[i] = left ? (byte)255 : (byte)0;
            pixels[i + 2] = left ? (byte)0 : (byte)255;
            pixels[i + 3] = 255;
        }

        using var encoder = new JpegTileEncoder();
        var jpeg = encoder.Encode(new ScreenFrame(4, 4, 16, pixels), new TileRect(2, 0, 2, 4));

        using var decoded = SKBitmap.Decode(jpeg);
        Assert.Equal(0xff, jpeg[0]);
        Assert.Equal(0xd8, jpeg[1]);
        Assert.Equal(2, decoded.Width);
        Assert.Equal(4, decoded.Height);
        var pixel = decoded.GetPixel(0, 1);
        Assert.True(pixel.Red > 200 && pixel.Blue < 60, $"expected red, got {pixel}");
    }

    [Fact]
    public void On_unix_the_config_and_its_folder_are_for_root_alone()
    {
        if (OperatingSystem.IsWindows())
        {
            Assert.Skip("Unix file modes only.");
        }
        else
        {
            CheckModes();
        }
    }

    [UnsupportedOSPlatform("windows")]
    private static void CheckModes()
    {
        var folder = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"), "agent");
        var file = Path.Combine(folder, "agent.bin");
        try
        {
            AgentConfigStore.Save(
                new AgentConfig
                {
                    SiteUrl = "https://runovahq.com",
                    RemoteId = "482193775",
                    DeviceId = 7,
                    DeviceName = "Desk",
                    IdentitySeed = "seed",
                    AgentSecret = "ras1.secret",
                    AllowOwnDevices = true,
                    AlwaysAllow = [],
                    DefaultPermissions = new SessionPermissions(true, false, false),
                },
                file);

            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(file));
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute, File.GetUnixFileMode(folder));
            Assert.Equal("ras1.secret", AgentConfigStore.Load(file).AgentSecret);
        }
        finally
        {
            Directory.Delete(Path.GetDirectoryName(folder)!, recursive: true);
        }
    }

    [Fact]
    public void A_real_x_server_shows_its_screen_and_takes_input()
    {
        // CI and the Docker check run this under Xvfb (1024x768x24, -noreset). The test paints
        // the root red itself, so nothing besides Xvfb has to be installed.
        var display = Environment.GetEnvironmentVariable("RUNOVA_TEST_X_DISPLAY");
        if (OperatingSystem.IsLinux() && !string.IsNullOrEmpty(display))
        {
            CheckLiveDisplay(display);
        }
        else
        {
            Assert.Skip("Needs RUNOVA_TEST_X_DISPLAY on Linux.");
        }
    }

    [SupportedOSPlatform("linux")]
    private static void CheckLiveDisplay(string display)
    {
        XRootWindow.Paint(display, 0xff0000);
        using var x = X11Display.Open(display, authFile: null);
        Assert.NotNull(x);

        var frame = x.Capture();
        Assert.NotNull(frame);
        Assert.Equal(1024, frame.Width);
        Assert.Equal(768, frame.Height);
        Assert.Equal(frame.Stride * frame.Height, frame.Pixels.Length);
        var center = (frame.Stride * 384) + (512 * 4);
        // Red, in BGRA. Xvfb's own root is a black and white weave, so this also proves the paint.
        Assert.Equal([0x00, 0x00, 0xff], frame.Pixels.AsSpan(center, 3).ToArray());

        x.Apply(Event("""{"k":"move","x":0.25,"y":0.5}"""));
        Assert.Equal((256, 384), x.Pointer());

        var pressed = x.Pressing(() => x.Apply(Event("""{"k":"down","x":0.25,"y":0.5,"button":"left"}""")));
        Assert.True(pressed, "the left button should be down after a down event");
        x.Apply(Event("""{"k":"up","x":0.25,"y":0.5,"button":"left"}"""));
        x.Apply(Event("""{"k":"text","text":"aZ"}"""));
        x.Apply(Event("""{"k":"key","code":"Enter","down":true}"""));
        x.Apply(Event("""{"k":"key","code":"Enter","down":false}"""));
    }
}
