namespace Runova.Website.Core.Accounts;

/// <summary>
/// The signed-in Runova account, as the account panel and the desktop app see it. Never carries a
/// password hash, stamp, key, code or token.
/// </summary>
public sealed record AccountDto(
    long Id,
    string Email,
    string DisplayName,
    bool EmailConfirmed,
    bool HasPassword,
    bool TwoFactorEnabled,
    IReadOnlyList<string> Logins,
    bool Staff,
    DateTimeOffset CreatedAt,
    DateTimeOffset? LastSignInAt,
    string Version);

/// <summary>A form the captcha protects while it is on: the widget's token comes with the request.</summary>
public interface ICaptchaProtected
{
    string? CaptchaToken { get; }
}

public sealed record RegisterRequest(string? Email, string? Password, string? DisplayName, string? CaptchaToken = null) : ICaptchaProtected;

public sealed record EmailRequest(string? Email, string? CaptchaToken = null) : ICaptchaProtected;

public sealed record TokenRequest(string? Token);

public sealed record EmailVerificationDto(bool SignedIn);
