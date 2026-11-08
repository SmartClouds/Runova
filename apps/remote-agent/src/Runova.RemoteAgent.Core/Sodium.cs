using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace Runova.RemoteAgent.Core;

/// <summary>
/// The libsodium calls the protocol needs: Ed25519 signatures, X25519, ristretto255 for CPace and
/// scrypt for the password secret. The app reaches the same primitives through @noble, and the test
/// vectors prove the two agree.
/// </summary>
internal static partial class Sodium
{
    private const string Library = "libsodium";

    static Sodium()
    {
        if (sodium_init() < 0)
        {
            throw new CryptographicException("libsodium could not start.");
        }
    }

    [LibraryImport(Library)]
    private static partial int sodium_init();

    [LibraryImport(Library)]
    private static partial int crypto_sign_seed_keypair(Span<byte> pk, Span<byte> sk, ReadOnlySpan<byte> seed);

    [LibraryImport(Library)]
    private static partial int crypto_sign_detached(Span<byte> sig, out ulong siglen, ReadOnlySpan<byte> m, ulong mlen, ReadOnlySpan<byte> sk);

    [LibraryImport(Library)]
    private static partial int crypto_sign_verify_detached(ReadOnlySpan<byte> sig, ReadOnlySpan<byte> m, ulong mlen, ReadOnlySpan<byte> pk);

    [LibraryImport(Library)]
    private static partial int crypto_scalarmult_curve25519(Span<byte> q, ReadOnlySpan<byte> n, ReadOnlySpan<byte> p);

    [LibraryImport(Library)]
    private static partial int crypto_scalarmult_curve25519_base(Span<byte> q, ReadOnlySpan<byte> n);

    [LibraryImport(Library)]
    private static partial int crypto_core_ristretto255_from_hash(Span<byte> p, ReadOnlySpan<byte> r);

    [LibraryImport(Library)]
    private static partial int crypto_core_ristretto255_is_valid_point(ReadOnlySpan<byte> p);

    [LibraryImport(Library)]
    private static partial void crypto_core_ristretto255_scalar_reduce(Span<byte> r, ReadOnlySpan<byte> s);

    [LibraryImport(Library)]
    private static partial int crypto_scalarmult_ristretto255(Span<byte> q, ReadOnlySpan<byte> n, ReadOnlySpan<byte> p);

    [LibraryImport(Library)]
    private static partial int crypto_pwhash_scryptsalsa208sha256_ll(
        ReadOnlySpan<byte> passwd, nuint passwdlen, ReadOnlySpan<byte> salt, nuint saltlen, ulong n, uint r, uint p, Span<byte> buf, nuint buflen);

    /// <summary>The Ed25519 key pair for a 32-byte seed: the public key, and libsodium's 64-byte secret key.</summary>
    public static (byte[] PublicKey, byte[] SecretKey) SignKeyPair(ReadOnlySpan<byte> seed)
    {
        var pk = new byte[32];
        var sk = new byte[64];
        Check(crypto_sign_seed_keypair(pk, sk, seed));
        return (pk, sk);
    }

    public static byte[] Sign(ReadOnlySpan<byte> message, ReadOnlySpan<byte> secretKey)
    {
        var sig = new byte[64];
        Check(crypto_sign_detached(sig, out _, message, (ulong)message.Length, secretKey));
        return sig;
    }

    public static bool Verify(ReadOnlySpan<byte> signature, ReadOnlySpan<byte> message, ReadOnlySpan<byte> publicKey) =>
        signature.Length == 64 && publicKey.Length == 32 && crypto_sign_verify_detached(signature, message, (ulong)message.Length, publicKey) == 0;

    public static byte[] X25519Public(ReadOnlySpan<byte> secret)
    {
        var q = new byte[32];
        Check(crypto_scalarmult_curve25519_base(q, secret));
        return q;
    }

    /// <summary>The shared secret, or null when the other key is a low-order point (an all-zero result).</summary>
    public static byte[]? X25519(ReadOnlySpan<byte> secret, ReadOnlySpan<byte> peerPublic)
    {
        var q = new byte[32];
        return crypto_scalarmult_curve25519(q, secret, peerPublic) == 0 ? q : null;
    }

    /// <summary>RFC 9496 element derivation from 64 uniform bytes, as @noble's deriveToCurve.</summary>
    public static byte[] RistrettoFromHash(ReadOnlySpan<byte> hash64)
    {
        var p = new byte[32];
        Check(crypto_core_ristretto255_from_hash(p, hash64));
        return p;
    }

    public static bool RistrettoIsValid(ReadOnlySpan<byte> point) => point.Length == 32 && crypto_core_ristretto255_is_valid_point(point) == 1;

    public static byte[] RistrettoReduce(ReadOnlySpan<byte> wide64)
    {
        var r = new byte[32];
        crypto_core_ristretto255_scalar_reduce(r, wide64);
        return r;
    }

    /// <summary>The scalar times the point, or null when the result is the identity.</summary>
    public static byte[]? RistrettoMultiply(ReadOnlySpan<byte> scalar, ReadOnlySpan<byte> point)
    {
        var q = new byte[32];
        return crypto_scalarmult_ristretto255(q, scalar, point) == 0 ? q : null;
    }

    public static byte[] Scrypt(ReadOnlySpan<byte> password, ReadOnlySpan<byte> salt, ulong n, uint r, uint p, int length)
    {
        var buf = new byte[length];
        Check(crypto_pwhash_scryptsalsa208sha256_ll(password, (nuint)password.Length, salt, (nuint)salt.Length, n, r, p, buf, (nuint)length));
        return buf;
    }

    private static void Check(int result)
    {
        if (result != 0)
        {
            throw new CryptographicException("A libsodium call failed.");
        }
    }
}
