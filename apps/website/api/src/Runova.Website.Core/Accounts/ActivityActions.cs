namespace Runova.Website.Core.Accounts;

/// <summary>What an account activity entry records. The contract lists them.</summary>
public static class ActivityActions
{
    public const string SignIn = "sign-in";
    public const string SignInFailed = "sign-in-failed";
    public const string SignOut = "sign-out";
    public const string DeviceSignIn = "device-sign-in";
    public const string SessionEnded = "session-ended";
    public const string SessionsEnded = "sessions-ended";
    public const string RefreshTokenReused = "refresh-token-reused";
    public const string EmailVerified = "email-verified";
    public const string PasswordChanged = "password-changed";
    public const string PasswordReset = "password-reset";
    public const string TwoFactorOn = "two-factor-on";
    public const string TwoFactorOff = "two-factor-off";
    public const string LoginLinked = "login-linked";
    public const string LoginUnlinked = "login-unlinked";
    public const string AccountUpdated = "account-updated";
    public const string KeySet = "key-set";
    public const string KeyChanged = "key-changed";
    public const string KeyReset = "key-reset";
    public const string SyncReset = "sync-reset";
    public const string TeamCreated = "team-created";
    public const string TeamUpdated = "team-updated";
    public const string TeamDeleted = "team-deleted";
    public const string MemberInvited = "member-invited";
    public const string MemberJoined = "member-joined";
    public const string MemberRemoved = "member-removed";
    public const string MemberRoleChanged = "member-role-changed";
    public const string TeamLeft = "team-left";
}

public sealed record SessionDto(
    long Id,
    string Kind,
    string DeviceName,
    string Platform,
    string? AppVersion,
    string? Ip,
    DateTimeOffset CreatedAt,
    DateTimeOffset LastSeenAt,
    bool Current);

public sealed record SessionListDto(IReadOnlyList<SessionDto> Items);

public sealed record ActivityDto(
    long Id,
    string Action,
    long? TeamId,
    string? Ip,
    string? Device,
    DateTimeOffset At,
    IReadOnlyDictionary<string, object?>? Details);

/// <summary>Proof the person at the keyboard is the owner: the password, or a two-factor code for an account with none.</summary>
public sealed record StepUpRequest(string? Password, string? Code);
