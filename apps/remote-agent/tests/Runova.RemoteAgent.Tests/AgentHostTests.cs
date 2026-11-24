using System.Runtime.Versioning;
using System.Text.Json.Nodes;
using Runova.RemoteAgent.Core;
using Runova.RemoteAgent.Windows;

namespace Runova.RemoteAgent.Tests;

public class AgentHostTests
{
    private static JsonObject Event(string json) => JsonNode.Parse(json)!.AsObject();

    [Fact]
    public void Pointer_events_land_on_the_primary_screen_in_pixels()
    {
        Assert.Equal([new InputStep.Move(960, 540)], Win32Input.Steps(Event("""{"k":"move","x":0.5,"y":0.5}"""), 1920, 1080));
        Assert.Equal(
            [new InputStep.Move(1919, 1079), new InputStep.Mouse(0x0010, 0)],
            Win32Input.Steps(Event("""{"k":"up","x":1,"y":1,"button":"right"}"""), 1920, 1080));
        Assert.Equal([new InputStep.Mouse(0x0800, -240)], Win32Input.Steps(Event("""{"k":"wheel","x":0,"y":0,"dx":0,"dy":2}"""), 1920, 1080));
    }

    [Fact]
    public void Keys_use_virtual_key_codes_and_text_goes_as_unicode()
    {
        Assert.Equal([new InputStep.Key(0x25, false, true)], Win32Input.Steps(Event("""{"k":"key","code":"ArrowLeft","down":false}"""), 10, 10));
        Assert.Equal([new InputStep.Key(0x0d, true, false)], Win32Input.Steps(Event("""{"k":"key","code":"Enter","down":true}"""), 10, 10));
        Assert.Empty(Win32Input.Steps(Event("""{"k":"key","code":"MediaPlayPause","down":true}"""), 10, 10));
        Assert.Equal([new InputStep.Unicode('h'), new InputStep.Unicode('é')], Win32Input.Steps(Event("""{"k":"text","text":"hé"}"""), 10, 10));
    }

    [Fact]
    public void The_relay_address_follows_the_site_scheme()
    {
        Assert.Equal("wss://runovahq.com/relay/remote/s1?ticket=a%20b", RelayTransport.UrlFor("https://runovahq.com", "/relay/remote/s1", "a b").AbsoluteUri);
        Assert.Equal("ws://127.0.0.1:5000/relay/remote/s1?ticket=t", RelayTransport.UrlFor("http://127.0.0.1:5000", "/relay/remote/s1", "t").AbsoluteUri);
    }

    [Fact]
    public void The_config_is_sealed_on_disk_and_reads_back_whole()
    {
        // A folder of its own: on Unix the store locks its folder down to the owner, which it may
        // not do to a shared /tmp.
        var file = Path.Combine(Path.GetTempPath(), $"runova-agent-{Guid.NewGuid():N}", "agent.bin");
        var config = new AgentConfig
        {
            SiteUrl = "https://runovahq.com",
            RemoteId = "482193775",
            DeviceId = 7,
            DeviceName = "SAM-DESK",
            IdentitySeed = Bytes.ToB64u(new byte[32]),
            AgentSecret = "ras1.secret-value",
            PasswordSecret = Bytes.ToB64u(new byte[32]),
            AllowOwnDevices = true,
            AlwaysAllow = [4],
            DefaultPermissions = new SessionPermissions(true, true, false),
        };
        try
        {
            AgentConfigStore.Save(config, file);

            var onDisk = File.ReadAllText(file);
            if (OperatingSystem.IsWindows())
            {
                Assert.DoesNotContain("ras1.secret-value", onDisk, StringComparison.Ordinal);
            }

            var back = AgentConfigStore.Load(file);
            Assert.Equal(config with { AlwaysAllow = back.AlwaysAllow }, back);
            Assert.Equal([4L], back.AlwaysAllow);
            Assert.Equal(Identity.FromSeed(new byte[32]).PublicKey, back.Identity.PublicKey);
        }
        finally
        {
            Directory.Delete(Path.GetDirectoryName(file)!, recursive: true);
        }
    }

    /// <summary>
    /// The sealed config can be opened by any local account (DPAPI machine scope), so the folder's
    /// access list is all that guards it, from the first byte written. A standard user can make the
    /// ProgramData folder first and give themselves access to it.
    /// </summary>
    [Fact]
    [SupportedOSPlatform("windows")]
    public void The_config_folder_is_locked_down_before_the_config_is_written()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var folder = Path.Combine(Path.GetTempPath(), $"runova-agent-{Guid.NewGuid():N}");
        var everyone = new System.Security.Principal.SecurityIdentifier(System.Security.Principal.WellKnownSidType.WorldSid, null);
        var planted = new System.Security.AccessControl.DirectorySecurity();
        planted.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
            everyone,
            System.Security.AccessControl.FileSystemRights.FullControl,
            System.Security.AccessControl.InheritanceFlags.ContainerInherit | System.Security.AccessControl.InheritanceFlags.ObjectInherit,
            System.Security.AccessControl.PropagationFlags.None,
            System.Security.AccessControl.AccessControlType.Allow));
        System.IO.FileSystemAclExtensions.Create(new DirectoryInfo(folder), planted);
        var file = Path.Combine(folder, "agent.bin");
        try
        {
            AgentConfigStore.Save(
                new AgentConfig
                {
                    SiteUrl = "https://runovahq.com",
                    RemoteId = "1",
                    DeviceId = 1,
                    DeviceName = "PC",
                    IdentitySeed = Bytes.ToB64u(new byte[32]),
                    AgentSecret = "ras1.x",
                    AllowOwnDevices = false,
                    AlwaysAllow = [],
                    DefaultPermissions = new SessionPermissions(true, true, false),
                },
                file);

            static bool GrantsEveryone(System.Security.AccessControl.FileSystemSecurity security, System.Security.Principal.SecurityIdentifier everyone) =>
                security.GetAccessRules(true, true, typeof(System.Security.Principal.SecurityIdentifier))
                    .OfType<System.Security.AccessControl.FileSystemAccessRule>()
                    .Any(rule => rule.IdentityReference.Equals(everyone));
            var folderSecurity = new DirectoryInfo(folder).GetAccessControl();
            Assert.True(folderSecurity.AreAccessRulesProtected);
            Assert.False(GrantsEveryone(folderSecurity, everyone));
            Assert.False(GrantsEveryone(new FileInfo(file).GetAccessControl(), everyone));
            Assert.Equal("ras1.x", AgentConfigStore.Load(file).AgentSecret);
        }
        finally
        {
            Directory.Delete(folder, recursive: true);
        }
    }

    [Fact]
    public void This_desktop_can_be_captured_and_encoded_as_jpeg_tiles()
    {
        if (OperatingSystem.IsWindows())
        {
            CaptureAndEncode();
        }
        else
        {
            Assert.Skip("GDI capture is Windows only.");
        }
    }

    [SupportedOSPlatform("windows")]
    private static void CaptureAndEncode()
    {
        using var desktop = new DesktopThread();
        using var encoder = new JpegTileEncoder();
        var frame = new GdiScreenSource(desktop).Capture();

        Assert.NotNull(frame);
        Assert.True(frame.Width > 0 && frame.Height > 0);
        Assert.Equal(frame.Width * frame.Height * 4, frame.Pixels.Length);
        var tile = HostSession.Tiles(frame.Width, frame.Height).First();
        var jpeg = encoder.Encode(frame, tile);
        Assert.Equal([0xFF, 0xD8], jpeg[..2]);
    }
}
