using System.Buffers.Binary;
using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>
/// A passkey held in memory, standing in for a phone or a security key: it answers the server's
/// WebAuthn options the way a browser and an authenticator would, with a P-256 key, a "none"
/// attestation, and a signature over each assertion. Its origin and flags can be set wrong on
/// purpose.
/// </summary>
internal sealed class SoftwarePasskey : IDisposable
{
    /// <summary>The site the tests' API believes it is (Website:SiteUrl's default).</summary>
    public const string SiteOrigin = "https://runovahq.com";

    public const string SiteRpId = "runovahq.com";

    private readonly ECDsa _key = ECDsa.Create(ECCurve.NamedCurves.nistP256);

    public byte[] CredentialId { get; } = RandomNumberGenerator.GetBytes(16);

    public string Id => Base64Url.EncodeToString(CredentialId);

    /// <summary>The user handle the server gave at registration, sent back with each assertion.</summary>
    public byte[]? UserHandle { get; set; }

    public uint SignCount { get; set; }

    public string Origin { get; set; } = SiteOrigin;

    public string RpId { get; set; } = SiteRpId;

    public bool UserVerified { get; set; } = true;

    public void Dispose() => _key.Dispose();

    /// <summary>The answer to <c>PublicKeyCredentialCreationOptions</c>, as <c>PublicKeyCredential.toJSON()</c> gives it.</summary>
    public JsonElement Create(JsonElement options)
    {
        UserHandle = Base64Url.DecodeFromChars(options.GetProperty("user").GetProperty("id").GetString());
        var clientData = ClientData("webauthn.create", options.GetProperty("challenge").GetString()!);
        var authData = AuthenticatorData(attested: true);
        var attestation = Cbor.Map(
            ("fmt", Cbor.Text("none")),
            ("attStmt", Cbor.Map()),
            ("authData", Cbor.Bytes(authData)));

        return Json(new JsonObject
        {
            ["id"] = Id,
            ["rawId"] = Id,
            ["type"] = "public-key",
            ["authenticatorAttachment"] = "platform",
            ["clientExtensionResults"] = new JsonObject(),
            ["response"] = new JsonObject
            {
                ["clientDataJSON"] = Base64Url.EncodeToString(clientData),
                ["attestationObject"] = Base64Url.EncodeToString(attestation),
                ["transports"] = new JsonArray("internal", "hybrid"),
            },
        });
    }

    /// <summary>The answer to <c>PublicKeyCredentialRequestOptions</c>, signed, with the next sign count.</summary>
    public JsonElement Get(JsonElement options)
    {
        SignCount++;
        var clientData = ClientData("webauthn.get", options.GetProperty("challenge").GetString()!);
        var authData = AuthenticatorData(attested: false);
        var signature = _key.SignData([.. authData, .. SHA256.HashData(clientData)], HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);

        return Json(new JsonObject
        {
            ["id"] = Id,
            ["rawId"] = Id,
            ["type"] = "public-key",
            ["authenticatorAttachment"] = "platform",
            ["clientExtensionResults"] = new JsonObject(),
            ["response"] = new JsonObject
            {
                ["clientDataJSON"] = Base64Url.EncodeToString(clientData),
                ["authenticatorData"] = Base64Url.EncodeToString(authData),
                ["signature"] = Base64Url.EncodeToString(signature),
                ["userHandle"] = UserHandle is null ? null : Base64Url.EncodeToString(UserHandle),
            },
        });
    }

    private byte[] ClientData(string type, string challenge) =>
        Encoding.UTF8.GetBytes(new JsonObject
        {
            ["type"] = type,
            ["challenge"] = challenge,
            ["origin"] = Origin,
            ["crossOrigin"] = false,
        }.ToJsonString());

    private byte[] AuthenticatorData(bool attested)
    {
        const byte UserPresent = 0x01, Verified = 0x04, BackupEligible = 0x08, BackedUp = 0x10, Attested = 0x40;
        var flags = (byte)(UserPresent | BackupEligible | BackedUp | (UserVerified ? Verified : 0) | (attested ? Attested : 0));
        var data = new List<byte>(SHA256.HashData(Encoding.UTF8.GetBytes(RpId))) { flags };
        var count = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(count, SignCount);
        data.AddRange(count);
        if (attested)
        {
            data.AddRange(new byte[16]);
            var length = new byte[2];
            BinaryPrimitives.WriteUInt16BigEndian(length, (ushort)CredentialId.Length);
            data.AddRange(length);
            data.AddRange(CredentialId);
            data.AddRange(PublicKey());
        }

        return [.. data];
    }

    // A COSE EC2 key: kty 2, alg -7 (ES256), crv 1 (P-256), x, y.
    private byte[] PublicKey()
    {
        var point = _key.ExportParameters(includePrivateParameters: false).Q;
        return Cbor.Map(
            (1, Cbor.Int(2)),
            (3, Cbor.Int(-7)),
            (-1, Cbor.Int(1)),
            (-2, Cbor.Bytes(point.X!)),
            (-3, Cbor.Bytes(point.Y!)));
    }

    private static JsonElement Json(JsonObject json) => JsonElement.Parse(json.ToJsonString());

    /// <summary>Just enough CBOR (RFC 8949) for an attestation object and a COSE key.</summary>
    private static class Cbor
    {
        public static byte[] Int(long value) => value >= 0 ? Head(0, (ulong)value) : Head(1, (ulong)(-1 - value));

        public static byte[] Bytes(byte[] value) => [.. Head(2, (ulong)value.Length), .. value];

        public static byte[] Text(string value)
        {
            var bytes = Encoding.UTF8.GetBytes(value);
            return [.. Head(3, (ulong)bytes.Length), .. bytes];
        }

        public static byte[] Map(params (string Key, byte[] Value)[] entries) =>
            [.. Head(5, (ulong)entries.Length), .. entries.SelectMany(e => Text(e.Key).Concat(e.Value))];

        public static byte[] Map(params (long Key, byte[] Value)[] entries) =>
            [.. Head(5, (ulong)entries.Length), .. entries.SelectMany(e => Int(e.Key).Concat(e.Value))];

        public static byte[] Map() => Head(5, 0);

        private static byte[] Head(int major, ulong value)
        {
            var type = (byte)(major << 5);
            return value switch
            {
                < 24 => [(byte)(type | (byte)value)],
                <= byte.MaxValue => [(byte)(type | 24), (byte)value],
                <= ushort.MaxValue => [(byte)(type | 25), (byte)(value >> 8), (byte)value],
                _ => [(byte)(type | 26), (byte)(value >> 24), (byte)(value >> 16), (byte)(value >> 8), (byte)value],
            };
        }
    }
}
