using System.Security.Cryptography;
using System.Text.Json;
using Runova.RemoteAgent.Core;

namespace Runova.RemoteAgent.Tests;

/// <summary>
/// The agent speaks the same protocol as the app, byte for byte: these replay the vectors the
/// app's protocol package writes (packages/protocol/test-vectors), with each side's randomness as
/// it was recorded there.
/// </summary>
public class VectorsTests
{
    private static readonly JsonElement _vectors = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Vectors", "anywhere-v1.json"))).RootElement;

    private static byte[] Hex(string value) => Convert.FromHexString(value);

    private static string Hex(byte[] value) => Convert.ToHexStringLower(value);

    private static Func<int, byte[]> Recorded(JsonElement list)
    {
        var queue = new Queue<byte[]>(list.EnumerateArray().Select(e => Hex(e.GetString()!)));
        return n =>
        {
            var next = queue.Dequeue();
            Assert.Equal(n, next.Length);
            return next;
        };
    }

    public static TheoryData<string> Modes => ["ask", "password"];

    private static JsonElement Handshake(string mode) => _vectors.GetProperty("handshake").EnumerateArray().Single(h => h.GetProperty("mode").GetString() == mode);

    private static async Task<byte[]?> SecretAsync(JsonElement v, byte[] hostPublicKey)
    {
        if (v.GetProperty("password").ValueKind == JsonValueKind.Null)
        {
            return null;
        }

        var secret = await Task.Run(() => Handshakes.DerivePasswordSecret(v.GetProperty("password").GetString()!, Bytes.ToB64u(hostPublicKey)));
        Assert.Equal(v.GetProperty("passwordSecret").GetString(), Hex(secret));
        return secret;
    }

    [Theory]
    [MemberData(nameof(Modes))]
    public async Task The_host_answers_the_app_exactly_as_the_app_would(string mode)
    {
        var v = Handshake(mode);
        var host = Identity.FromSeed(Hex(v.GetProperty("hostSeed").GetString()!));
        var controller = Identity.FromSeed(Hex(v.GetProperty("controllerSeed").GetString()!));
        var hello = JsonSerializer.Deserialize<HandshakeMessage>(v.GetProperty("hello").GetRawText())!;
        var finish = JsonSerializer.Deserialize<HandshakeMessage>(v.GetProperty("finish").GetRawText())!;

        var side = new HostHandshake(
            v.GetProperty("sessionId").GetString()!,
            mode,
            host,
            controller.PublicKey,
            await SecretAsync(v, host.PublicKey),
            v.GetProperty("hostFingerprint").GetString()!,
            v.GetProperty("controllerFingerprint").GetString()!,
            Recorded(v.GetProperty("hostRandom")));
        var reply = side.Respond(hello);
        var keys = side.Complete(finish);

        Assert.Equal(Compact(v.GetProperty("reply")), JsonSerializer.Serialize(reply));
        Assert.Equal(v.GetProperty("hostToController").GetString(), Hex(keys.Send));
        Assert.Equal(v.GetProperty("controllerToHost").GetString(), Hex(keys.Receive));
        Assert.Equal(v.GetProperty("safetyCode").GetString(), keys.SafetyCode);
        Assert.Equal(v.GetProperty("transcript").GetString(), Hex(keys.Transcript));
    }

    [Theory]
    [MemberData(nameof(Modes))]
    public async Task The_controller_asks_the_app_exactly_as_the_app_would(string mode)
    {
        var v = Handshake(mode);
        var host = Identity.FromSeed(Hex(v.GetProperty("hostSeed").GetString()!));
        var controller = Identity.FromSeed(Hex(v.GetProperty("controllerSeed").GetString()!));
        var reply = JsonSerializer.Deserialize<HandshakeMessage>(v.GetProperty("reply").GetRawText())!;

        var side = new ControllerHandshake(
            v.GetProperty("sessionId").GetString()!,
            mode,
            controller,
            host.PublicKey,
            await SecretAsync(v, host.PublicKey),
            v.GetProperty("controllerFingerprint").GetString()!,
            v.GetProperty("hostFingerprint").GetString()!,
            Recorded(v.GetProperty("controllerRandom")));
        var (finish, keys) = side.Complete(reply);

        Assert.Equal(Compact(v.GetProperty("hello")), JsonSerializer.Serialize(side.Hello));
        Assert.Equal(Compact(v.GetProperty("finish")), JsonSerializer.Serialize(finish));
        Assert.Equal(v.GetProperty("controllerToHost").GetString(), Hex(keys.Send));
        Assert.Equal(v.GetProperty("safetyCode").GetString(), keys.SafetyCode);
    }

    [Fact]
    public async Task A_wrong_password_fails_on_the_controller_and_the_host_hears_why()
    {
        var host = Identity.Create();
        var controller = Identity.Create();
        var hostKey = Bytes.ToB64u(host.PublicKey);
        var right = await Task.Run(() => Handshakes.DerivePasswordSecret("purple monkey dishwasher", hostKey));
        var wrong = await Task.Run(() => Handshakes.DerivePasswordSecret("purple monkey dishwasher!", hostKey));
        var controllerSide = new ControllerHandshake("s1", "password", controller, host.PublicKey, wrong, "", "", RandomNumberGenerator.GetBytes);
        var hostSide = new HostHandshake("s1", "password", host, controller.PublicKey, right, "", "", RandomNumberGenerator.GetBytes);

        var reply = hostSide.Respond(controllerSide.Hello);

        Assert.Equal(HandshakeFailure.WrongPassword, Assert.Throws<HandshakeException>(() => controllerSide.Complete(reply)).Reason);
        var abort = new HandshakeMessage { T = "hs-abort", Reason = "wrong-password" };
        Assert.Equal(HandshakeFailure.WrongPassword, Assert.Throws<HandshakeException>(() => hostSide.Complete(abort)).Reason);
    }

    [Fact]
    public void A_host_refuses_a_controller_the_server_did_not_announce()
    {
        var v = Handshake("ask");
        var host = Identity.FromSeed(Hex(v.GetProperty("hostSeed").GetString()!));
        var stranger = Identity.FromSeed(new byte[32]);
        var hello = JsonSerializer.Deserialize<HandshakeMessage>(v.GetProperty("hello").GetRawText())!;
        var side = new HostHandshake(v.GetProperty("sessionId").GetString()!, "ask", host, stranger.PublicKey, null, "sha-256 CC:DD", "sha-256 AA:BB", RandomNumberGenerator.GetBytes);

        Assert.Equal(HandshakeFailure.Identity, Assert.Throws<HandshakeException>(() => side.Respond(hello)).Reason);
    }

    [Fact]
    public void Link_frames_match_the_app()
    {
        var f = _vectors.GetProperty("framing");
        var text = Hex(f.GetProperty("textPayload").GetString()!);
        var big = Enumerable.Range(0, f.GetProperty("binaryLength").GetInt32()).Select(i => (byte)(i * 7 % 256)).ToArray();

        var textFrames = LinkFraming.Encode(LinkFraming.Text, text, 1);
        var binaryFrames = LinkFraming.Encode(LinkFraming.Binary, big, (uint)f.GetProperty("binaryMessageId").GetInt32());

        Assert.Equal(f.GetProperty("textFrames").EnumerateArray().Select(e => e.GetString()), textFrames.Select(Hex));
        Assert.Equal(f.GetProperty("binaryFrameHeaders").EnumerateArray().Select(e => e.GetString()), binaryFrames.Select(b => Hex(b[..10])));
        Assert.Equal(f.GetProperty("binaryFrameLengths").EnumerateArray().Select(e => e.GetInt32()), binaryFrames.Select(b => b.Length));
        Assert.Equal(f.GetProperty("binaryFrameSha256").EnumerateArray().Select(e => e.GetString()), binaryFrames.Select(b => Hex(SHA256.HashData(b))));

        var reassembler = new LinkReassembler();
        var messages = textFrames.Concat(binaryFrames).Select(reassembler.Push).Where(m => m is not null).ToList();
        Assert.Equal(text, messages[0]!.Payload);
        Assert.Equal(big, messages[1]!.Payload);
        Assert.Equal(LinkFraming.Binary, messages[1]!.Kind);
    }

    [Fact]
    public void Relay_frames_are_sealed_as_the_app_seals_them()
    {
        var c = _vectors.GetProperty("cipher");
        var key = Hex(c.GetProperty("key").GetString()!);
        using var sender = new FrameCipher(key, key);
        using var receiver = new FrameCipher(key, key);

        foreach (var (frame, sealedHex) in c.GetProperty("frames").EnumerateArray().Zip(c.GetProperty("sealed").EnumerateArray()))
        {
            var sealedFrame = sender.Seal(Hex(frame.GetString()!));
            Assert.Equal(sealedHex.GetString(), Hex(sealedFrame));
            Assert.Equal(frame.GetString(), Hex(receiver.Open(sealedFrame)));
        }
    }

    [Fact]
    public void A_relay_frame_played_again_is_refused()
    {
        var key = new byte[32];
        using var sender = new FrameCipher(key, key);
        using var receiver = new FrameCipher(key, key);
        var first = sender.Seal([1]);

        receiver.Open(first);

        Assert.Throws<CryptographicException>(() => receiver.Open(first));
    }

    private static string Compact(JsonElement element) => JsonSerializer.Serialize(element);
}
