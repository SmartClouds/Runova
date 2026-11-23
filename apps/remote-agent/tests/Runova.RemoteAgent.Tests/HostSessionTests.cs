using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Runova.RemoteAgent.Core;

namespace Runova.RemoteAgent.Tests;

/// <summary>A session the agent hosts, from the secure handshake to screen tiles and input.</summary>
public class HostSessionTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>Two link transports wired to each other.</summary>
    private sealed class Pipe : ILinkTransport
    {
        public Channel<byte[]> Inbox { get; } = Channel.CreateUnbounded<byte[]>();

        public Pipe? Other { get; set; }

        public List<byte[]> Sent { get; } = [];

        public async Task SendAsync(byte[] frame, CancellationToken ct)
        {
            Sent.Add(frame);
            await Other!.Inbox.Writer.WriteAsync(frame, ct);
        }

        public async Task<byte[]?> ReceiveAsync(CancellationToken ct) =>
            await Inbox.Reader.WaitToReadAsync(ct) && Inbox.Reader.TryRead(out var frame) ? frame : null;

        public ValueTask DisposeAsync()
        {
            Inbox.Writer.TryComplete();
            Other?.Inbox.Writer.TryComplete();
            return ValueTask.CompletedTask;
        }

        public static (Pipe A, Pipe B) Create()
        {
            var a = new Pipe();
            var b = new Pipe { Other = a };
            a.Other = b;
            return (a, b);
        }
    }

    private sealed class FakeScreen : IScreenSource
    {
        public int Width { get; set; } = 64;

        public int Height { get; set; } = 32;

        public byte Shade { get; set; } = 10;

        public ScreenFrame? Capture() => new(Width, Height, Width * 4, Enumerable.Repeat(Shade, Width * Height * 4).ToArray());
    }

    private sealed class FakeEncoder : ITileEncoder
    {
        public byte[] Encode(ScreenFrame frame, TileRect rect) => Encoding.ASCII.GetBytes($"jpeg {rect.X},{rect.Y} {rect.W}x{rect.H} {frame.Pixels[0]}");
    }

    private sealed class FakeInput : IInputSink
    {
        public List<string> Applied { get; } = [];

        public void Apply(JsonObject inputEvent) => Applied.Add(inputEvent.ToJsonString());
    }

    private sealed class Controller(AgentLink link)
    {
        public AgentLink Link { get; } = link;

        public async Task<JsonObject> NextControlAsync(string t)
        {
            await foreach (var message in Link.ReadAsync(Ct))
            {
                if (message.Kind == LinkFraming.Text && JsonNode.Parse(message.Payload)!.AsObject() is var obj && obj["t"]!.GetValue<string>() == t)
                {
                    return obj;
                }
            }

            throw new InvalidOperationException($"no {t}");
        }

        public async Task<byte[]> NextBinaryAsync()
        {
            await foreach (var message in Link.ReadAsync(Ct))
            {
                if (message.Kind == LinkFraming.Binary)
                {
                    return message.Payload;
                }
            }

            throw new InvalidOperationException("no binary");
        }

        public Task SendAsync(object message) => Link.SendControlAsync(JsonSerializer.SerializeToNode(message)!.AsObject(), Ct);
    }

    private static async Task<(Controller Controller, Task Session, FakeInput Input, FakeScreen Screen)> ConnectAsync(SessionPermissions permissions, string intent = "control")
    {
        var host = Identity.Create();
        var controllerId = Identity.Create();
        var (hostPipe, controllerPipe) = Pipe.Create();
        var hostHandshake = new HostHandshake("s1", "ask", host, controllerId.PublicKey, null, "", "", RandomNumberGenerator.GetBytes);
        var controllerHandshake = new ControllerHandshake("s1", "ask", controllerId, host.PublicKey, null, "", "", RandomNumberGenerator.GetBytes);
        var accepting = AgentLink.AcceptAsync(hostPipe, hostHandshake, sealFrames: true, TimeSpan.FromSeconds(10), Ct);
        var connecting = AgentLink.ConnectAsync(controllerPipe, controllerHandshake, sealFrames: true, TimeSpan.FromSeconds(10), Ct);
        var hostLink = await accepting;
        var controllerLink = await connecting;
        Assert.Equal(hostLink.SafetyCode, controllerLink.SafetyCode);

        var screen = new FakeScreen();
        var input = new FakeInput();
        var session = new HostSession(hostLink, "SAM-DESK", screen, new FakeEncoder(), input, new SessionOptions(permissions, intent, TimeSpan.FromMilliseconds(20)));
        return (new Controller(controllerLink), session.RunAsync(Ct), input, screen);
    }

    private static readonly SessionPermissions _all = new(Control: true, Clipboard: true, Files: true);

    [Fact]
    public async Task The_controller_is_let_in_and_told_the_screen_size()
    {
        var (controller, _, _, _) = await ConnectAsync(_all);

        var authOk = await controller.NextControlAsync("auth-ok");

        Assert.Equal("SAM-DESK", authOk["deviceName"]!.GetValue<string>());
        Assert.Equal(64, authOk["screen"]!["width"]!.GetValue<int>());
        Assert.Equal(32, authOk["screen"]!["height"]!.GetValue<int>());
    }

    [Fact]
    public async Task Video_is_declined_so_the_controller_uses_tiles()
    {
        var (controller, _, _, _) = await ConnectAsync(_all);
        await controller.NextControlAsync("auth-ok");

        await controller.SendAsync(new { t = "rtc-request" });

        Assert.Equal("rtc-unavailable", (await controller.NextControlAsync("rtc-unavailable"))["t"]!.GetValue<string>());
    }

    [Fact]
    public async Task Starting_control_streams_the_screen_as_tiles_and_only_what_changed_after()
    {
        var (controller, _, _, screen) = await ConnectAsync(_all);
        await controller.NextControlAsync("auth-ok");

        await controller.SendAsync(new { t = "control-start" });
        var first = await controller.NextBinaryAsync();
        screen.Shade = 99;
        byte[] changed;
        do
        {
            changed = await controller.NextBinaryAsync();
        }
        while (!Encoding.ASCII.GetString(changed[13..]).EndsWith(" 99", StringComparison.Ordinal));

        Assert.Equal(0x01, first[0]);
        Assert.Equal("jpeg 0,0 64x32 10", Encoding.ASCII.GetString(first[13..]));
        Assert.Equal("jpeg 0,0 64x32 99", Encoding.ASCII.GetString(changed[13..]));
    }

    [Fact]
    public async Task Input_is_applied_only_when_the_session_may_control()
    {
        var (controller, _, input, _) = await ConnectAsync(_all);
        await controller.NextControlAsync("auth-ok");
        await controller.SendAsync(new { t = "input", @event = new { k = "text", text = "hi" } });
        await controller.SendAsync(new { t = "ping" });
        await controller.NextControlAsync("pong");

        var (viewer, _, viewOnly, _) = await ConnectAsync(_all with { Control = false });
        await viewer.NextControlAsync("auth-ok");
        await viewer.SendAsync(new { t = "input", @event = new { k = "text", text = "hi" } });
        await viewer.SendAsync(new { t = "ping" });
        await viewer.NextControlAsync("pong");

        Assert.Equal(["{\"k\":\"text\",\"text\":\"hi\"}"], input.Applied);
        Assert.Empty(viewOnly.Applied);
    }

    [Fact]
    public async Task Files_are_refused_plainly()
    {
        var (controller, _, _, _) = await ConnectAsync(_all);
        await controller.NextControlAsync("auth-ok");

        await controller.SendAsync(new { t = "fm-list", reqId = "r1", path = (string?)null });
        await controller.SendAsync(new { t = "file-offer", transferId = "t1", name = "x", size = 1, partSize = 1, partCount = 1 });

        Assert.Contains("sign-in screen", (await controller.NextControlAsync("fm-list-reply"))["error"]!.GetValue<string>(), StringComparison.Ordinal);
        Assert.Equal("t1", (await controller.NextControlAsync("file-error"))["transferId"]!.GetValue<string>());
    }

    [Fact]
    public async Task Saying_bye_ends_the_session()
    {
        var (controller, session, _, _) = await ConnectAsync(_all);
        await controller.NextControlAsync("auth-ok");

        await controller.SendAsync(new { t = "bye", reason = "done" });

        await session.WaitAsync(TimeSpan.FromSeconds(10), Ct);
    }

    [Fact]
    public async Task Anything_before_the_handshake_is_refused()
    {
        var host = Identity.Create();
        var (hostPipe, controllerPipe) = Pipe.Create();
        var handshake = new HostHandshake("s1", "ask", host, Identity.Create().PublicKey, null, "", "", RandomNumberGenerator.GetBytes);
        var accepting = AgentLink.AcceptAsync(hostPipe, handshake, sealFrames: true, TimeSpan.FromSeconds(10), Ct);

        await controllerPipe.SendAsync([.. LinkFraming.Encode(LinkFraming.Text, Encoding.UTF8.GetBytes("{\"t\":\"input\"}"), 1)[0]], Ct);

        Assert.Equal(HandshakeFailure.Protocol, (await Assert.ThrowsAsync<HandshakeException>(() => accepting)).Reason);
    }

    private static readonly AgentSettings _settings = new(AllowOwnDevices: false, AlwaysAllow: [], DefaultPermissions: _all);

    private static IncomingRequest PasswordRequest(Identity controller) =>
        new("s1", "password", "other", "control", new IncomingController(9, "Mallory", "m@example.com", null, null, null, Bytes.ToB64u(controller.PublicKey)), []);

    private static byte[] Frame(HandshakeMessage message) => LinkFraming.Encode(LinkFraming.Text, JsonSerializer.SerializeToUtf8Bytes(message), 1)[0];

    [Theory]
    [InlineData("hang-up")]
    [InlineData("signature")]
    [InlineData("protocol")]
    public async Task A_wrong_password_counts_even_when_the_controller_never_owns_up_to_it(string ending)
    {
        var now = DateTimeOffset.UnixEpoch;
        var lockout = new PasswordLockout(() => now);
        var host = Identity.Create();
        var controllerId = Identity.Create();
        Assert.True(AgentService.Admits(PasswordRequest(controllerId), hasPasswordSecret: true, _settings, lockout, () => true));

        var (hostPipe, controllerPipe) = Pipe.Create();
        var hostHandshake = new HostHandshake("s1", "password", host, controllerId.PublicKey, RandomNumberGenerator.GetBytes(32), "", "", RandomNumberGenerator.GetBytes);
        var accepting = AgentService.HandshakeAsync(hostPipe, hostHandshake, lockout, TimeSpan.FromSeconds(10), Ct);

        // The controller learns from the host's reply alone that its guess is wrong, then leaves
        // without the hs-abort "wrong-password" an honest controller would send.
        var guess = new ControllerHandshake("s1", "password", controllerId, host.PublicKey, RandomNumberGenerator.GetBytes(32), "", "", RandomNumberGenerator.GetBytes);
        await controllerPipe.SendAsync(Frame(guess.Hello), Ct);
        var reply = JsonSerializer.Deserialize<HandshakeMessage>((await controllerPipe.ReceiveAsync(Ct))!.AsSpan(1))!;
        Assert.Equal("hs-reply", reply.T);
        Assert.Equal(HandshakeFailure.WrongPassword, Assert.Throws<HandshakeException>(() => guess.Complete(reply)).Reason);
        if (ending == "hang-up")
        {
            await controllerPipe.DisposeAsync();
        }
        else
        {
            await controllerPipe.SendAsync(Frame(new HandshakeMessage { T = "hs-abort", Reason = ending }), Ct);
        }

        await Assert.ThrowsAsync<HandshakeException>(() => accepting);
        Assert.True(lockout.Wait() > TimeSpan.Zero);
        Assert.False(AgentService.Admits(PasswordRequest(controllerId), hasPasswordSecret: true, _settings, lockout, () => true));
    }

    [Fact]
    public async Task The_right_password_takes_back_the_guess_it_was_charged()
    {
        var now = DateTimeOffset.UnixEpoch;
        var lockout = new PasswordLockout(() => now);
        var host = Identity.Create();
        var controllerId = Identity.Create();
        var secret = RandomNumberGenerator.GetBytes(32);
        Assert.True(AgentService.Admits(PasswordRequest(controllerId), hasPasswordSecret: true, _settings, lockout, () => true));
        Assert.True(lockout.Locked());

        var (hostPipe, controllerPipe) = Pipe.Create();
        var hostHandshake = new HostHandshake("s1", "password", host, controllerId.PublicKey, secret, "", "", RandomNumberGenerator.GetBytes);
        var controllerHandshake = new ControllerHandshake("s1", "password", controllerId, host.PublicKey, secret, "", "", RandomNumberGenerator.GetBytes);
        var accepting = AgentService.HandshakeAsync(hostPipe, hostHandshake, lockout, TimeSpan.FromSeconds(10), Ct);
        await using var controllerLink = await AgentLink.ConnectAsync(controllerPipe, controllerHandshake, sealFrames: true, TimeSpan.FromSeconds(10), Ct);
        await using var hostLink = await accepting;

        Assert.Equal(TimeSpan.Zero, lockout.Wait());
    }
}
