using System.Buffers.Text;
using System.Globalization;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Runova.Website.Api.Http;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Accounts;

/// <summary>
/// What ties passkeys to the site and to the phone apps (E115). <c>Website:Passkeys:AndroidCertFingerprints</c>
/// lists the SHA-256 fingerprints of the certificates the Android app is signed with (release and,
/// on a test site, debug), and <c>Website:Passkeys:AppleAppIds</c> the iOS app as
/// <c>TEAMID.com.runovahq.app</c>. Either may hold several, split by commas or spaces. Both are
/// empty by default, which leaves passkeys working on the website only.
/// </summary>
internal sealed record PasskeySettings(string RpId, string SiteOrigin, IReadOnlyList<string> AndroidCertFingerprints, IReadOnlyList<string> AppleAppIds)
{
    public const string Section = "Website:Passkeys";

    public const string AndroidPackage = "com.runovahq.app";

    /// <summary>The origin Android's Credential Manager reports for an app: its signing certificate's hash.</summary>
    public IReadOnlyList<string> AndroidOrigins { get; } =
        [.. AndroidCertFingerprints.Select(f => "android:apk-key-hash:" + Base64Url.EncodeToString(Convert.FromHexString(f.Replace(":", "", StringComparison.Ordinal))))];

    public static PasskeySettings From(IConfiguration configuration)
    {
        var site = new Uri(SiteUrl.From(configuration));
        return new(
            site.Host,
            site.GetLeftPart(UriPartial.Authority),
            [.. Split(configuration[$"{Section}:AndroidCertFingerprints"]).Where(IsFingerprint).Select(Normalize)],
            [.. Split(configuration[$"{Section}:AppleAppIds"])]);
    }

    /// <summary>The site itself, never inside another site's frame, or the Android app.</summary>
    public bool Allows(PasskeyOriginValidationContext context) =>
        (context.Origin == SiteOrigin && !context.CrossOrigin) || AndroidOrigins.Contains(context.Origin, StringComparer.Ordinal);

    private static string[] Split(string? value) =>
        (value ?? "").Split([',', ' ', ';', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    // Upper case with colons, as keytool prints it and as Digital Asset Links expects it.
    private static string Normalize(string fingerprint) =>
        string.Join(':', Convert.FromHexString(fingerprint.Replace(":", "", StringComparison.Ordinal)).Select(b => b.ToString("X2", CultureInfo.InvariantCulture)));

    // 32 bytes as hex, with or without colons, as keytool and the Play Console print them.
    private static bool IsFingerprint(string value)
    {
        var hex = value.Replace(":", "", StringComparison.Ordinal);
        return hex.Length == 64 && hex.All(Uri.IsHexDigit);
    }
}

/// <summary>
/// The files Android and iOS fetch from the site before they let the phone app use its passkeys
/// (E115). Not part of the API's description: they live at fixed paths outside /api/v1. Caddy
/// sends both paths here.
/// </summary>
internal static class AppSiteAssociation
{
    private static readonly string[] _relations = ["delegate_permission/common.get_login_creds"];

    public static IEndpointRouteBuilder MapAppSiteAssociation(this IEndpointRouteBuilder app)
    {
        app.MapGet("/.well-known/assetlinks.json", AssetLinks).AllowAnonymous().ExcludeFromDescription();
        app.MapGet("/.well-known/apple-app-site-association", AppleAssociation).AllowAnonymous().ExcludeFromDescription();
        return app;
    }

    private static IResult AssetLinks(PasskeySettings settings) =>
        settings.AndroidCertFingerprints.Count == 0
            ? Results.NotFound()
            : Results.Json(new object[]
            {
                new
                {
                    relation = _relations,
                    target = new
                    {
                        @namespace = "android_app",
                        package_name = PasskeySettings.AndroidPackage,
                        sha256_cert_fingerprints = settings.AndroidCertFingerprints,
                    },
                },
            });

    private static IResult AppleAssociation(PasskeySettings settings) =>
        settings.AppleAppIds.Count == 0
            ? Results.NotFound()
            : Results.Json(new { webcredentials = new { apps = settings.AppleAppIds } });
}

internal static class PasskeysSetup
{
    /// <summary>Identity's passkey handler, held to this site's relying party id and origins, and the ceremonies on it.</summary>
    public static IServiceCollection AddWebsitePasskeys(this IServiceCollection services)
    {
        services.AddSingleton(provider => PasskeySettings.From(provider.GetRequiredService<IConfiguration>()));
        services.AddOptions<IdentityPasskeyOptions>().Configure<PasskeySettings>((options, settings) =>
        {
            options.ServerDomain = settings.RpId;
            options.UserVerificationRequirement = "required";
            options.ResidentKeyRequirement = "required";
            options.ValidateOrigin = context => ValueTask.FromResult(settings.Allows(context));
        });
        services.TryAddScoped<IPasskeyHandler<AppUser>, PasskeyHandler<AppUser>>();
        services.AddScoped<PasskeyCeremonies>();
        return services;
    }
}
