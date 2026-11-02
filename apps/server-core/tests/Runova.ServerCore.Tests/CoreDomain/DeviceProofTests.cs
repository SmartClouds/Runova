using System.Security.Cryptography;
using System.Text;
using Runova.ServerCore.CoreDomain;

namespace Runova.ServerCore.Tests.CoreDomainTests;

/// <summary>
/// The device proof for the core domain behind Cloudflare: the text both sides sign (the same
/// vector as the desktop's proof.test.ts), the header's shape, and the nonces kept once each.
/// </summary>
public sealed class DeviceProofTests
{
    private static readonly Guid _device = Guid.Parse("0f8fad5b-d9cb-469f-a165-70867728950e");

    [Fact]
    public void The_message_matches_the_apps()
    {
        var message = DeviceProof.Message(
            _device,
            "get",
            Uri.UnescapeDataString("/api/v1/files?path=%2Fsrv%2Fmy%20app"),
            "Core.Example.com",
            1_767_225_600_000,
            "AAAAAAAAAAAAAAAAAAAAAA");

        Assert.Equal(
            string.Join(
                '\n',
                "runova-core/core-domain-request",
                "v1",
                "0f8fad5b-d9cb-469f-a165-70867728950e",
                "GET",
                "/api/v1/files?path=/srv/my app",
                "core.example.com",
                "1767225600000",
                "AAAAAAAAAAAAAAAAAAAAAA"),
            message);
    }

    [Fact]
    public void A_header_parses_only_in_its_own_shape()
    {
        var signature = Convert.ToBase64String(new byte[64]);

        Assert.NotNull(DeviceProof.Parse($"v1.{_device:D}.1000.AAAAAAAAAAAAAAAAAAAAAA.{signature}"));
        Assert.Null(DeviceProof.Parse(null));
        Assert.Null(DeviceProof.Parse($"v2.{_device:D}.1000.AAAAAAAAAAAAAAAAAAAAAA.{signature}"));
        Assert.Null(DeviceProof.Parse($"v1.not-a-guid.1000.AAAAAAAAAAAAAAAAAAAAAA.{signature}"));
        Assert.Null(DeviceProof.Parse($"v1.{_device:D}.-5.AAAAAAAAAAAAAAAAAAAAAA.{signature}"));
        Assert.Null(DeviceProof.Parse($"v1.{_device:D}.1000.short.{signature}"));
        Assert.Null(DeviceProof.Parse($"v1.{_device:D}.1000.AAAAAAAAAAAAAAAAAAAAAA.{Convert.ToBase64String(new byte[32])}"));
        Assert.Null(DeviceProof.Parse($"v1.{_device:D}.1000.AAAAAAAAAAAAAAAAAAAAAA.{signature}.extra"));
    }

    [Fact]
    public void A_signature_verifies_only_for_the_request_it_was_made_for()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var publicKey = key.ExportSubjectPublicKeyInfo();
        var message = DeviceProof.Message(_device, "GET", "/api/v1/health", "core.example.com", 1000, "AAAAAAAAAAAAAAAAAAAAAA");
        var signature = key.SignData(Encoding.UTF8.GetBytes(message), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        var proof = DeviceProof.Parse($"v1.{_device:D}.1000.AAAAAAAAAAAAAAAAAAAAAA.{Convert.ToBase64String(signature)}")!;

        Assert.True(DeviceProof.Verify(publicKey, proof, "GET", "/api/v1/health", "core.example.com"));
        Assert.False(DeviceProof.Verify(publicKey, proof, "POST", "/api/v1/health", "core.example.com"));
        Assert.False(DeviceProof.Verify(publicKey, proof, "GET", "/api/v1/health?x=1", "core.example.com"));
        Assert.False(DeviceProof.Verify(publicKey, proof, "GET", "/api/v1/health", "other.example.com"));
    }

    [Fact]
    public void A_nonce_is_taken_once_per_device_and_the_time_has_to_be_close()
    {
        var clock = new Microsoft.Extensions.Time.Testing.FakeTimeProvider(DateTimeOffset.FromUnixTimeMilliseconds(10_000_000));
        var nonces = new DeviceProofNonces(clock);
        var other = Guid.NewGuid();

        Assert.True(nonces.TryUse(_device, "AAAAAAAAAAAAAAAAAAAAAA"));
        Assert.False(nonces.TryUse(_device, "AAAAAAAAAAAAAAAAAAAAAA"));
        Assert.True(nonces.TryUse(other, "AAAAAAAAAAAAAAAAAAAAAA"));
        Assert.True(nonces.Fresh(10_000_000 - (4 * 60_000)));
        Assert.False(nonces.Fresh(10_000_000 - (6 * 60_000)));
        Assert.False(nonces.Fresh(10_000_000 + (6 * 60_000)));
    }
}
