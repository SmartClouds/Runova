using System.Security.Cryptography;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>Sign in with Apple keys like the .p8 file Apple hands out: a P-256 key in PKCS#8 PEM.</summary>
internal static class TestAppleKeys
{
    public static string NewPrivateKeyPem()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        return key.ExportPkcs8PrivateKeyPem();
    }

    /// <summary>The base64 between the PEM lines, which must never show up anywhere it was not saved to.</summary>
    public static string Body(string pem) =>
        pem.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Where(l => !l.StartsWith("-----", StringComparison.Ordinal)).First();
}
