using System.Security.Claims;
using System.Security.Cryptography;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace Runova.Website.Api.Accounts;

/// <summary>
/// Apple's client secret: not a saved string but a short ES256 JWT the website signs with its
/// Sign in with Apple key (the .p8 file) each time it talks to Apple's token endpoint.
/// </summary>
internal static class AppleClientSecret
{
    public const string Audience = "https://appleid.apple.com";

    /// <summary>Apple allows up to six months; a few minutes is all one exchange needs.</summary>
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(5);

    /// <summary>Whether <paramref name="pem"/> is a P-256 private key, which is what a .p8 file holds.</summary>
    public static bool IsPrivateKey(string pem)
    {
        try
        {
            using var key = ECDsa.Create();
            key.ImportFromPem(pem);
            return key.KeySize == 256;
        }
        catch (Exception e) when (e is ArgumentException or CryptographicException)
        {
            return false;
        }
    }

    /// <summary>A secret for <paramref name="clientId"/> (the Services ID, or the app's bundle id for the phone).</summary>
    public static string Create(string teamId, string keyId, string clientId, string privateKeyPem, DateTimeOffset now)
    {
        using var key = ECDsa.Create();
        key.ImportFromPem(privateKeyPem);
        var credentials = new SigningCredentials(new ECDsaSecurityKey(key) { KeyId = keyId }, SecurityAlgorithms.EcdsaSha256)
        {
            // The key is disposed with this call, so the token handler must not keep it.
            CryptoProviderFactory = new CryptoProviderFactory { CacheSignatureProviders = false },
        };
        return new JsonWebTokenHandler { SetDefaultTimesOnTokenCreation = false }.CreateToken(new SecurityTokenDescriptor
        {
            Issuer = teamId,
            Audience = Audience,
            Subject = new ClaimsIdentity([new Claim("sub", clientId)]),
            IssuedAt = now.UtcDateTime,
            Expires = (now + Lifetime).UtcDateTime,
            SigningCredentials = credentials,
        });
    }
}
