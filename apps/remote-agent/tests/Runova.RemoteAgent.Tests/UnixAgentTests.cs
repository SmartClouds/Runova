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
        // CI and the Docker check run this under Xvfb with a solid colored root window.
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
        using var x = X11Display.Open(display, authFile: null);
        Assert.NotNull(x);

        var frame = x.Capture();
        Assert.NotNull(frame);
        Assert.Equal(1024, frame.Width);
        Assert.Equal(768, frame.Height);
        Assert.Equal(frame.Stride * frame.Height, frame.Pixels.Length);
        var center = (frame.Stride * 384) + (512 * 4);
        Assert.Equal(0xff, frame.Pixels[center + 2]); // xsetroot -solid red, BGRA

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
