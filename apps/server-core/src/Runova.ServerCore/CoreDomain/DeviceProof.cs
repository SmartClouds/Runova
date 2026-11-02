using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.CoreDomain;

/// <summary>
/// The core domain behind Cloudflare's proxy (E44, Cloudflare mode). Cloudflare ends TLS at its
/// edge, so the device certificate never reaches nginx. Instead the app signs each request with
/// the device key it signs in with, in one header:
/// <c>v1.&lt;device id&gt;.&lt;unix ms&gt;.&lt;nonce&gt;.&lt;signature&gt;</c>. The signature covers the method, the
/// path with its query, the domain, the time and the nonce, so a proof is good for one request on
/// one server and never again. The text is built the same way by the desktop's
/// <c>coreDomainProofMessage</c>.
/// </summary>
internal static class DeviceProof
{
    public const string Version = "v1";

    public const string Prefix = "runova-core/core-domain-request";

    /// <summary>How far the computer's clock may be from the server's.</summary>
    public static readonly TimeSpan MaxSkew = TimeSpan.FromMinutes(5);

    /// <summary>A nonce is remembered for longer than any proof could still pass the time check.</summary>
    public static readonly TimeSpan NonceLifetime = MaxSkew * 2;

    /// <summary>A header is well under 300 bytes; anything longer is not one.</summary>
    private const int MaxHeader = 512;

    public static string Message(Guid deviceId, string method, string pathAndQuery, string domain, long unixMs, string nonce) =>
        string.Join(
            '\n',
            Prefix,
            Version,
            deviceId.ToString("D"),
            method.ToUpperInvariant(),
            pathAndQuery,
            domain.ToLowerInvariant(),
            unixMs.ToString(CultureInfo.InvariantCulture),
            nonce);

    /// <summary>The header's parts, or null when it is not a proof's shape.</summary>
    public static Parsed? Parse(string? header)
    {
        if (string.IsNullOrEmpty(header) || header.Length > MaxHeader)
        {
            return null;
        }

        var parts = header.Split('.');
        if (parts.Length != 5 || parts[0] != Version
            || !Guid.TryParseExact(parts[1], "D", out var device)
            || !long.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out var unixMs)
            || !IsNonce(parts[3]))
        {
            return null;
        }

        byte[] signature;
        try
        {
            signature = Convert.FromBase64String(parts[4]);
        }
        catch (FormatException)
        {
            return null;
        }

        return signature.Length == 64 ? new Parsed(device, unixMs, parts[3], signature) : null;
    }

    public static bool Verify(byte[] publicKey, Parsed proof, string method, string pathAndQuery, string domain)
    {
        ArgumentNullException.ThrowIfNull(proof);
        var message = Message(proof.DeviceId, method, pathAndQuery, domain, proof.UnixMs, proof.Nonce);
        return DeviceKeys.Verify(publicKey, Encoding.UTF8.GetBytes(message), proof.Signature);
    }

    /// <summary>16 to 64 base64url characters: at least 96 random bits, and nothing that needs escaping.</summary>
    private static bool IsNonce(string nonce) =>
        nonce.Length is >= 16 and <= 64 && nonce.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');

    internal sealed record Parsed(Guid DeviceId, long UnixMs, string Nonce, byte[] Signature);
}

/// <summary>Why a proof was refused, for the app to act on.</summary>
internal enum DeviceProofRefusal
{
    None,

    /// <summary>Missing, malformed, a wrong signature, or a device that is unknown or revoked.</summary>
    Invalid,

    /// <summary>The time in the proof is too far from the server's: the computer's clock is off.</summary>
    ClockSkew,

    /// <summary>The nonce was used before.</summary>
    Replayed,
}

/// <summary>
/// The nonces of proofs the core accepted, each kept until no proof with its time could pass any
/// more. Memory only: a restart forgets them, and the time check alone still stops anything older
/// than the skew. Bounded, and when full it refuses rather than forgets.
/// </summary>
internal sealed class DeviceProofNonces(TimeProvider time)
{
    /// <summary>Far more than every device's requests in ten minutes, and a bound on memory.</summary>
    internal const int Capacity = 100_000;

    private readonly ConcurrentDictionary<string, long> _seen = new(StringComparer.Ordinal);

    private readonly Lock _pruneGate = new();

    public long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    /// <summary>Whether the proof's time is close enough to the server's.</summary>
    public bool Fresh(long unixMs) => Math.Abs(Now - unixMs) <= (long)DeviceProof.MaxSkew.TotalMilliseconds;

    /// <summary>Records the nonce; false when it was used before, or nothing more fits.</summary>
    public bool TryUse(Guid device, string nonce)
    {
        var now = Now;
        if (_seen.Count >= Capacity)
        {
            Prune(now);
            if (_seen.Count >= Capacity)
            {
                return false;
            }
        }

        return _seen.TryAdd($"{device:N}:{nonce}", now + (long)DeviceProof.NonceLifetime.TotalMilliseconds);
    }

    private void Prune(long now)
    {
        lock (_pruneGate)
        {
            foreach (var (nonce, until) in _seen)
            {
                if (until <= now)
                {
                    _seen.TryRemove(nonce, out _);
                }
            }
        }
    }
}
