namespace Runova.Website.Data.Accounts;

/// <summary>
/// The Admin's switches and keys for sign-in (E52, E116): the Turnstile captcha, Google, Apple and
/// Microsoft. One row, id 1, made by the migration. Secrets are sealed with Data Protection and
/// never leave the API.
/// </summary>
public sealed class SignInSettings
{
    public const int SingletonId = 1;

    public const string DefaultAppleBundleId = "com.runovahq.app";

    public int Id { get; set; } = SingletonId;

    public bool CaptchaEnabled { get; set; }

    public string? TurnstileSiteKey { get; set; }

    public string? TurnstileSecretSealed { get; set; }

    /// <summary>On unless an Admin turned it off; Google still needs a client id and secret to show.</summary>
    public bool GoogleEnabled { get; set; } = true;

    public string? GoogleClientId { get; set; }

    public string? GoogleClientSecretSealed { get; set; }

    /// <summary>On unless an Admin turned it off; Apple still needs its four keys to show (E116).</summary>
    public bool AppleEnabled { get; set; } = true;

    /// <summary>The Services ID the website signs in as, which is the client id Apple knows it by.</summary>
    public string? AppleServicesId { get; set; }

    public string? AppleTeamId { get; set; }

    /// <summary>The id of the Sign in with Apple key the client secret is signed with.</summary>
    public string? AppleKeyId { get; set; }

    /// <summary>The .p8 key itself, sealed.</summary>
    public string? ApplePrivateKeySealed { get; set; }

    /// <summary>The phone app's bundle id, the audience of the tokens Sign in with Apple gives the app (E117).</summary>
    public string AppleBundleId { get; set; } = DefaultAppleBundleId;

    /// <summary>On unless an Admin turned it off; Microsoft still needs a client id and secret to show (E116).</summary>
    public bool MicrosoftEnabled { get; set; } = true;

    public string? MicrosoftClientId { get; set; }

    public string? MicrosoftClientSecretSealed { get; set; }

    public DateTimeOffset? UpdatedAt { get; set; }

    public uint Version { get; set; }
}
