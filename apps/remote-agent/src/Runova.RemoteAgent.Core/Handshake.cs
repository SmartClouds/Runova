using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;

namespace Runova.RemoteAgent.Core;

public sealed record Identity(byte[] PublicKey, byte[] SecretKey)
{
    public static Identity FromSeed(byte[] seed)
    {
        ArgumentNullException.ThrowIfNull(seed);
        if (seed.Length != 32)
        {
            throw new ArgumentException("An identity seed is 32 bytes.", nameof(seed));
        }

        var (pk, sk) = Sodium.SignKeyPair(seed);
        return new Identity(pk, sk);
    }

    public static Identity Create() => FromSeed(RandomNumberGenerator.GetBytes(32));
}

public enum HandshakeFailure
{
    Protocol,
    Identity,
    Fingerprint,
    Signature,
    WrongPassword,
}

public sealed class HandshakeException(HandshakeFailure reason) : Exception($"The secure handshake failed ({reason}).")
{
    public HandshakeFailure Reason { get; } = reason;

    public static string WireName(HandshakeFailure reason) => reason switch
    {
        HandshakeFailure.Identity => "identity",
        HandshakeFailure.Fingerprint => "fingerprint",
        HandshakeFailure.Signature => "signature",
        HandshakeFailure.WrongPassword => "wrong-password",
        _ => "protocol",
    };

    public static HandshakeFailure FromWire(string? name) => name switch
    {
        "identity" => HandshakeFailure.Identity,
        "fingerprint" => HandshakeFailure.Fingerprint,
        "signature" => HandshakeFailure.Signature,
        "wrong-password" => HandshakeFailure.WrongPassword,
        _ => HandshakeFailure.Protocol,
    };
}

/// <summary>One handshake message, written the way the app writes it (field order included).</summary>
public sealed record HandshakeMessage
{
    [JsonPropertyName("t")]
    public string T { get; init; } = "";

    [JsonPropertyName("v")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? V { get; init; }

    [JsonPropertyName("eph")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Eph { get; init; }

    [JsonPropertyName("id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Id { get; init; }

    [JsonPropertyName("nonce")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Nonce { get; init; }

    [JsonPropertyName("fp")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Fp { get; init; }

    [JsonPropertyName("cpace")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Cpace { get; init; }

    [JsonPropertyName("sig")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Sig { get; init; }

    [JsonPropertyName("confirm")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Confirm { get; init; }

    [JsonPropertyName("reason")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Reason { get; init; }
}

public sealed record SessionKeys(byte[] Send, byte[] Receive, string SafetyCode, byte[] Transcript);

/// <summary>
/// The Runova Anywhere handshake, as packages/protocol/src/secure/handshake.ts: X25519 keys signed
/// with Ed25519 identity keys over a transcript holding both DTLS fingerprints, HKDF keys per
/// direction, and CPace on ristretto255 when a password is involved.
/// </summary>
public static class Handshakes
{
    internal const string Domain = "runova-anywhere-v1";
    private const string CpaceDsi = "CPaceRistretto255";
    private const string CpaceIskDsi = "CPaceRistretto255_ISK";

    /// <summary>The secret CPace runs on, from the password and the host's identity key (scrypt N=2^15, r=8, p=1).</summary>
    public static byte[] DerivePasswordSecret(string password, string hostIdentityKey)
    {
        ArgumentNullException.ThrowIfNull(password);
        return Sodium.Scrypt(Bytes.Utf8(password.Normalize(NormalizationForm.FormKC)), Bytes.Utf8($"runova-anywhere-prs-v1|{hostIdentityKey}"), 1UL << 15, 8, 1, 32);
    }

    internal static (byte[] Scalar, byte[] Share) CpaceShare(byte[] secret, byte[] controllerId, byte[] hostId, string sessionId, Func<int, byte[]> random)
    {
        var generator = Sodium.RistrettoFromHash(SHA512.HashData(Bytes.Concat(
            Bytes.Lv(Bytes.Utf8(CpaceDsi)),
            Bytes.Lv(secret),
            Bytes.Lv(Bytes.Concat(Bytes.Lv(controllerId), Bytes.Lv(hostId))),
            Bytes.Lv(Bytes.Utf8(sessionId)))));
        for (; ; )
        {
            var scalar = Sodium.RistrettoReduce(random(64));
            if (scalar.All(b => b == 0))
            {
                continue;
            }

            return (scalar, Sodium.RistrettoMultiply(scalar, generator) ?? throw new HandshakeException(HandshakeFailure.Protocol));
        }
    }

    internal static byte[] CpaceIsk(string sessionId, byte[] scalar, byte[] peerShare, byte[] ya, byte[] yb)
    {
        var shared = Sodium.RistrettoMultiply(scalar, peerShare) ?? throw new HandshakeException(HandshakeFailure.Protocol);
        return SHA512.HashData(Bytes.Concat(Bytes.Lv(Bytes.Utf8(CpaceIskDsi)), Bytes.Lv(Bytes.Utf8(sessionId)), Bytes.Lv(shared), Bytes.Lv(ya), Bytes.Lv(yb)));
    }

    internal static byte[] Transcript(
        string sessionId, string mode, byte[] controllerId, byte[] hostId, byte[] controllerEph, byte[] hostEph,
        byte[] controllerNonce, byte[] hostNonce, string controllerFp, string hostFp, byte[]? controllerShare, byte[]? hostShare) =>
        SHA256.HashData(Bytes.Concat(
            Bytes.Lv(Bytes.Utf8(Domain)),
            Bytes.Lv(Bytes.Utf8(sessionId)),
            Bytes.Lv(Bytes.Utf8(mode)),
            Bytes.Lv(controllerId),
            Bytes.Lv(hostId),
            Bytes.Lv(controllerEph),
            Bytes.Lv(hostEph),
            Bytes.Lv(controllerNonce),
            Bytes.Lv(hostNonce),
            Bytes.Lv(Bytes.Utf8(controllerFp)),
            Bytes.Lv(Bytes.Utf8(hostFp)),
            Bytes.Lv(controllerShare ?? []),
            Bytes.Lv(hostShare ?? [])));

    internal static (byte[] ControllerToHost, byte[] HostToController, byte[] ConfirmKey) Keys(byte[] eph, byte[] peerEph, byte[]? isk, byte[] transcript)
    {
        var dh = Sodium.X25519(eph, peerEph) ?? throw new HandshakeException(HandshakeFailure.Protocol);
        var okm = HKDF.DeriveKey(HashAlgorithmName.SHA256, Bytes.Concat(dh, isk ?? []), 96, transcript, Bytes.Utf8($"{Domain} keys"));
        return (okm[..32], okm[32..64], okm[64..]);
    }

    internal static byte[] Sign(string role, byte[] transcript, byte[] secretKey) =>
        Sodium.Sign(Bytes.Concat(Bytes.Utf8($"{Domain} {role}"), transcript), secretKey);

    internal static bool Verify(string? signature, string role, byte[] transcript, byte[] publicKey)
    {
        try
        {
            return signature is not null && Sodium.Verify(Bytes.FromB64u(signature), Bytes.Concat(Bytes.Utf8($"{Domain} {role}"), transcript), publicKey);
        }
        catch (FormatException)
        {
            return false;
        }
    }

    internal static byte[] Confirm(byte[] key, string role, byte[] transcript) => HMACSHA256.HashData(key, Bytes.Concat(Bytes.Utf8(role), transcript));

    internal static bool ConfirmMatches(string? value, byte[] key, string role, byte[] transcript)
    {
        try
        {
            return value is not null && CryptographicOperations.FixedTimeEquals(Bytes.FromB64u(value), Confirm(key, role, transcript));
        }
        catch (FormatException)
        {
            return false;
        }
    }

    public static string SafetyCode(byte[] transcript)
    {
        var digest = SHA256.HashData(Bytes.Concat(Bytes.Utf8($"{Domain} safety"), transcript));
        return (BinaryPrimitives.ReadUInt32BigEndian(digest) % 1_000_000).ToString("D6", CultureInfo.InvariantCulture);
    }

    internal static byte[] Field(string? value, int length)
    {
        try
        {
            var bytes = value is null ? null : Bytes.FromB64u(value);
            return bytes?.Length == length ? bytes : throw new HandshakeException(HandshakeFailure.Protocol);
        }
        catch (FormatException)
        {
            throw new HandshakeException(HandshakeFailure.Protocol);
        }
    }

    internal static byte[] Point(string? value)
    {
        var bytes = Field(value, 32);
        return Sodium.RistrettoIsValid(bytes) && !bytes.All(b => b == 0) ? bytes : throw new HandshakeException(HandshakeFailure.Protocol);
    }
}

/// <summary>The computer being connected to: answers the hello, then checks the finish.</summary>
public sealed class HostHandshake(
    string sessionId,
    string mode,
    Identity identity,
    byte[] expectedControllerKey,
    byte[]? passwordSecret,
    string localFingerprint,
    string remoteFingerprint,
    Func<int, byte[]> random)
{
    private (byte[] Transcript, byte[] ControllerId, byte[] C2H, byte[] H2C, byte[] Confirm)? _pending;

    public HandshakeMessage Respond(HandshakeMessage hello)
    {
        ArgumentNullException.ThrowIfNull(hello);
        if (hello.T != "hs-hello" || hello.V != 1)
        {
            throw new HandshakeException(HandshakeFailure.Protocol);
        }

        var controllerEph = Handshakes.Field(hello.Eph, 32);
        var controllerId = Handshakes.Field(hello.Id, 32);
        var controllerNonce = Handshakes.Field(hello.Nonce, 16);
        if (!CryptographicOperations.FixedTimeEquals(controllerId, expectedControllerKey))
        {
            throw new HandshakeException(HandshakeFailure.Identity);
        }

        if ((hello.Fp ?? "") != remoteFingerprint)
        {
            throw new HandshakeException(HandshakeFailure.Fingerprint);
        }

        var password = mode == "password";
        if (password != (hello.Cpace is not null))
        {
            throw new HandshakeException(HandshakeFailure.Protocol);
        }

        var controllerShare = password ? Handshakes.Point(hello.Cpace) : null;
        var eph = random(32);
        var ephPublic = Sodium.X25519Public(eph);
        var nonce = random(16);
        (byte[] Scalar, byte[] Share)? cpace = password
            ? Handshakes.CpaceShare(passwordSecret ?? throw new HandshakeException(HandshakeFailure.Protocol), controllerId, identity.PublicKey, sessionId, random)
            : null;

        var transcript = Handshakes.Transcript(
            sessionId, mode, controllerId, identity.PublicKey, controllerEph, ephPublic, controllerNonce, nonce,
            hello.Fp ?? "", localFingerprint, controllerShare, cpace?.Share);
        var isk = cpace is { } c && controllerShare is not null ? Handshakes.CpaceIsk(sessionId, c.Scalar, controllerShare, controllerShare, c.Share) : null;
        var (c2h, h2c, confirmKey) = Handshakes.Keys(eph, controllerEph, isk, transcript);
        _pending = (transcript, controllerId, c2h, h2c, confirmKey);
        return new HandshakeMessage
        {
            T = "hs-reply",
            Eph = Bytes.ToB64u(ephPublic),
            Id = Bytes.ToB64u(identity.PublicKey),
            Nonce = Bytes.ToB64u(nonce),
            Fp = localFingerprint,
            Cpace = cpace is { } share ? Bytes.ToB64u(share.Share) : null,
            Sig = Bytes.ToB64u(Handshakes.Sign("host", transcript, identity.SecretKey)),
            Confirm = Bytes.ToB64u(Handshakes.Confirm(confirmKey, "host", transcript)),
        };
    }

    public SessionKeys Complete(HandshakeMessage finish)
    {
        ArgumentNullException.ThrowIfNull(finish);
        if (_pending is not { } pending || finish.T != "hs-finish")
        {
            throw new HandshakeException(finish.T == "hs-abort" ? HandshakeException.FromWire(finish.Reason) : HandshakeFailure.Protocol);
        }

        if (!Handshakes.Verify(finish.Sig, "controller", pending.Transcript, pending.ControllerId))
        {
            throw new HandshakeException(HandshakeFailure.Signature);
        }

        if (!Handshakes.ConfirmMatches(finish.Confirm, pending.Confirm, "controller", pending.Transcript))
        {
            throw new HandshakeException(mode == "password" ? HandshakeFailure.WrongPassword : HandshakeFailure.Protocol);
        }

        return new SessionKeys(pending.H2C, pending.C2H, Handshakes.SafetyCode(pending.Transcript), pending.Transcript);
    }
}

/// <summary>The computer connecting: sends the hello, then checks the reply and finishes.</summary>
public sealed class ControllerHandshake
{
    private readonly string _sessionId;
    private readonly string _mode;
    private readonly Identity _identity;
    private readonly byte[] _expectedHostKey;
    private readonly string _remoteFingerprint;
    private readonly byte[] _eph;
    private readonly byte[] _ephPublic;
    private readonly byte[] _nonce;
    private readonly (byte[] Scalar, byte[] Share)? _cpace;

    public ControllerHandshake(
        string sessionId, string mode, Identity identity, byte[] expectedHostKey, byte[]? passwordSecret,
        string localFingerprint, string remoteFingerprint, Func<int, byte[]> random)
    {
        ArgumentNullException.ThrowIfNull(identity);
        ArgumentNullException.ThrowIfNull(random);
        (_sessionId, _mode, _identity, _expectedHostKey, _remoteFingerprint) = (sessionId, mode, identity, expectedHostKey, remoteFingerprint);
        _eph = random(32);
        _ephPublic = Sodium.X25519Public(_eph);
        _nonce = random(16);
        _cpace = mode == "password"
            ? Handshakes.CpaceShare(passwordSecret ?? throw new HandshakeException(HandshakeFailure.Protocol), identity.PublicKey, expectedHostKey, sessionId, random)
            : null;
        Hello = new HandshakeMessage
        {
            T = "hs-hello",
            V = 1,
            Eph = Bytes.ToB64u(_ephPublic),
            Id = Bytes.ToB64u(identity.PublicKey),
            Nonce = Bytes.ToB64u(_nonce),
            Fp = localFingerprint,
            Cpace = _cpace is { } c ? Bytes.ToB64u(c.Share) : null,
        };
    }

    public HandshakeMessage Hello { get; }

    public (HandshakeMessage Finish, SessionKeys Keys) Complete(HandshakeMessage reply)
    {
        ArgumentNullException.ThrowIfNull(reply);
        if (reply.T != "hs-reply")
        {
            throw new HandshakeException(reply.T == "hs-abort" ? HandshakeException.FromWire(reply.Reason) : HandshakeFailure.Protocol);
        }

        var hostEph = Handshakes.Field(reply.Eph, 32);
        var hostId = Handshakes.Field(reply.Id, 32);
        var hostNonce = Handshakes.Field(reply.Nonce, 16);
        if (!CryptographicOperations.FixedTimeEquals(hostId, _expectedHostKey))
        {
            throw new HandshakeException(HandshakeFailure.Identity);
        }

        if ((reply.Fp ?? "") != _remoteFingerprint)
        {
            throw new HandshakeException(HandshakeFailure.Fingerprint);
        }

        var hostShare = _mode == "password" ? Handshakes.Point(reply.Cpace) : null;
        if (_mode != "password" && reply.Cpace is not null)
        {
            throw new HandshakeException(HandshakeFailure.Protocol);
        }

        var transcript = Handshakes.Transcript(
            _sessionId, _mode, _identity.PublicKey, hostId, _ephPublic, hostEph, _nonce, hostNonce,
            Hello.Fp ?? "", reply.Fp ?? "", _cpace?.Share, hostShare);
        if (!Handshakes.Verify(reply.Sig, "host", transcript, hostId))
        {
            throw new HandshakeException(HandshakeFailure.Signature);
        }

        var isk = _cpace is { } c && hostShare is not null ? Handshakes.CpaceIsk(_sessionId, c.Scalar, hostShare, c.Share, hostShare) : null;
        var (c2h, h2c, confirmKey) = Handshakes.Keys(_eph, hostEph, isk, transcript);
        if (!Handshakes.ConfirmMatches(reply.Confirm, confirmKey, "host", transcript))
        {
            throw new HandshakeException(_mode == "password" ? HandshakeFailure.WrongPassword : HandshakeFailure.Protocol);
        }

        var finish = new HandshakeMessage
        {
            T = "hs-finish",
            Sig = Bytes.ToB64u(Handshakes.Sign("controller", transcript, _identity.SecretKey)),
            Confirm = Bytes.ToB64u(Handshakes.Confirm(confirmKey, "controller", transcript)),
        };
        return (finish, new SessionKeys(c2h, h2c, Handshakes.SafetyCode(transcript), transcript));
    }
}
