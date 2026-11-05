namespace Runova.Website.Data.Accounts;

/// <summary>
/// The Admin's switches and keys for sign-in (E52): the Turnstile captcha and Google. One row, id
/// 1, made by the migration. Secrets are sealed with Data Protection and never leave the API.
/// </summary>
public sealed class SignInSettings
{
    public const int SingletonId = 1;

    public int Id { get; set; } = SingletonId;

    public bool CaptchaEnabled { get; set; }

    public string? TurnstileSiteKey { get; set; }

    public string? TurnstileSecretSealed { get; set; }

    /// <summary>On unless an Admin turned it off; Google still needs a client id and secret to show.</summary>
    public bool GoogleEnabled { get; set; } = true;

    public string? GoogleClientId { get; set; }

    public string? GoogleClientSecretSealed { get; set; }

    public DateTimeOffset? UpdatedAt { get; set; }

    public uint Version { get; set; }
}
