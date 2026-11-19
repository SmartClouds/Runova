using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Primitives;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;

namespace Runova.Website.Api.Accounts;

/// <summary>
/// The sign-in settings in force: the Admin's row, with each provider's keys falling back to
/// <c>Authentication__Google__*</c>, <c>Authentication__Apple__*</c> or
/// <c>Authentication__Microsoft__*</c> when the row has none, so a host set up with those keeps working.
/// </summary>
internal sealed record SignInSnapshot(
    bool CaptchaEnabled,
    string? TurnstileSiteKey,
    string? TurnstileSecret,
    bool GoogleEnabled,
    string? GoogleClientId,
    string? GoogleClientSecret,
    bool GoogleFromEnvironment)
{
    public bool AppleEnabled { get; init; }

    public string? AppleServicesId { get; init; }

    public string? AppleTeamId { get; init; }

    public string? AppleKeyId { get; init; }

    /// <summary>The .p8 key in PEM, unsealed.</summary>
    public string? ApplePrivateKey { get; init; }

    public string AppleBundleId { get; init; } = SignInSettings.DefaultAppleBundleId;

    public bool AppleFromEnvironment { get; init; }

    public bool MicrosoftEnabled { get; init; }

    public string? MicrosoftClientId { get; init; }

    public string? MicrosoftClientSecret { get; init; }

    public bool MicrosoftFromEnvironment { get; init; }

    /// <summary>The captcha is checked only when it is on and both keys are there.</summary>
    public bool CaptchaActive => CaptchaEnabled && TurnstileSiteKey is not null && TurnstileSecret is not null;

    public bool GoogleActive => GoogleEnabled && GoogleClientId is not null && GoogleClientSecret is not null;

    public bool AppleActive =>
        AppleEnabled && AppleServicesId is not null && AppleTeamId is not null && AppleKeyId is not null && ApplePrivateKey is not null;

    public bool MicrosoftActive => MicrosoftEnabled && MicrosoftClientId is not null && MicrosoftClientSecret is not null;
}

/// <summary>Seals the settings' secrets for the database and opens them again. Neither ever leaves the API.</summary>
internal sealed class SignInSecrets(IDataProtectionProvider provider)
{
    public const string Purpose = "Runova.SignInSettings.v1";

    private readonly IDataProtector _protector = provider.CreateProtector(Purpose);

    public string Seal(string secret) => Base64Url.EncodeToString(_protector.Protect(Encoding.UTF8.GetBytes(secret)));

    /// <summary>The secret, or null when there is none or it was sealed by another key ring.</summary>
    public string? Unseal(string? sealedSecret)
    {
        if (string.IsNullOrEmpty(sealedSecret))
        {
            return null;
        }

        try
        {
            return Encoding.UTF8.GetString(_protector.Unprotect(Base64Url.DecodeFromChars(sealedSecret)));
        }
        catch (Exception e) when (e is CryptographicException or FormatException)
        {
            return null;
        }
    }
}

/// <summary>
/// Keeps the settings in memory: read once the host has started (after the migrations), again
/// after an Admin saves, and at most every <see cref="MaxAge"/> otherwise. Its change token fires
/// when what it read differs, so Google's handler picks up new keys without a restart.
/// </summary>
internal sealed partial class SignInSettingsStore(
    IServiceScopeFactory scopes, SignInSecrets secrets, IConfiguration configuration, TimeProvider time, ILogger<SignInSettingsStore> logger)
    : IHostedLifecycleService, IDisposable
{
    public static readonly TimeSpan MaxAge = TimeSpan.FromSeconds(30);

    private readonly Lock _lock = new();
    private SignInSnapshot? _current;
    private DateTimeOffset _readAt;
    private CancellationTokenSource _changes = new();

    /// <summary>Set when <see cref="Current"/> had to answer from the environment, so the first read tells Google's handler.</summary>
    private bool _servedFallback;

    /// <summary>The settings, read again first when they are older than <see cref="MaxAge"/>.</summary>
    public async ValueTask<SignInSnapshot> GetAsync(CancellationToken cancellationToken = default)
    {
        var current = _current;
        return current is not null && time.GetUtcNow() - _readAt < MaxAge ? current : await ReloadAsync(cancellationToken);
    }

    /// <summary>
    /// The settings for code that can not wait, such as configuring Google's handler, which every
    /// request builds. It never touches the database: before the first read it answers from the
    /// environment alone, with the captcha off, and the first read then rebuilds the handler.
    /// </summary>
    public SignInSnapshot Current
    {
        get
        {
            if (_current is { } current)
            {
                return current;
            }

            _servedFallback = true;
            return From(new SignInSettings());
        }
    }

    public IChangeToken GetChangeToken()
    {
        lock (_lock)
        {
            return new CancellationChangeToken(_changes.Token);
        }
    }

    public async Task<SignInSnapshot> ReloadAsync(CancellationToken cancellationToken = default)
    {
        SignInSettings row;
        using (var scope = scopes.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            row = await db.SignInSettings.AsNoTracking().SingleOrDefaultAsync(cancellationToken) ?? new SignInSettings();
        }

        var snapshot = From(row);
        CancellationTokenSource? changed = null;
        lock (_lock)
        {
            var previous = _current;
            _current = snapshot;
            _readAt = time.GetUtcNow();
            if ((previous is not null && previous != snapshot) || _servedFallback)
            {
                _servedFallback = false;
                changed = _changes;
                _changes = new CancellationTokenSource();
            }
        }

        if (changed is not null)
        {
            await changed.CancelAsync();
            changed.Dispose();
        }

        return snapshot;
    }

    /// <summary>The first read, once every hosted service (the migrations among them) has started.</summary>
    public async Task StartedAsync(CancellationToken cancellationToken)
    {
        try
        {
            await ReloadAsync(cancellationToken);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            // The database may not be there yet; the first request that needs the settings reads them.
            LogFirstReadFailed(logger, e);
        }
    }

    public Task StartingAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StoppingAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StoppedAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    [LoggerMessage(Level = LogLevel.Warning, Message = "Could not read the sign-in settings on start; the first request that needs them will")]
    private static partial void LogFirstReadFailed(ILogger logger, Exception exception);

    public void Dispose()
    {
        lock (_lock)
        {
            _changes.Dispose();
        }
    }

    private SignInSnapshot From(SignInSettings row)
    {
        var google = new Fallback(configuration, "Google");
        var apple = new Fallback(configuration, "Apple");
        var microsoft = new Fallback(configuration, "Microsoft");
        return new SignInSnapshot(
            row.CaptchaEnabled,
            Blank(row.TurnstileSiteKey),
            secrets.Unseal(row.TurnstileSecretSealed),
            row.GoogleEnabled,
            google.Pick(row.GoogleClientId, "ClientId"),
            google.Pick(secrets.Unseal(row.GoogleClientSecretSealed), "ClientSecret"),
            google.Used)
        {
            AppleEnabled = row.AppleEnabled,
            AppleServicesId = apple.Pick(row.AppleServicesId, "ServicesId"),
            AppleTeamId = apple.Pick(row.AppleTeamId, "TeamId"),
            AppleKeyId = apple.Pick(row.AppleKeyId, "KeyId"),
            ApplePrivateKey = apple.Pick(secrets.Unseal(row.ApplePrivateKeySealed), "PrivateKey"),
            AppleBundleId = Blank(configuration["Authentication:Apple:BundleId"]) is { } bundle && row.AppleBundleId == SignInSettings.DefaultAppleBundleId
                ? bundle
                : row.AppleBundleId,
            AppleFromEnvironment = apple.Used,
            MicrosoftEnabled = row.MicrosoftEnabled,
            MicrosoftClientId = microsoft.Pick(row.MicrosoftClientId, "ClientId"),
            MicrosoftClientSecret = microsoft.Pick(secrets.Unseal(row.MicrosoftClientSecretSealed), "ClientSecret"),
            MicrosoftFromEnvironment = microsoft.Used,
        };
    }

    /// <summary>A provider's value from the row, or else from <c>Authentication:{provider}:{key}</c>, noting when the environment filled in.</summary>
    private sealed class Fallback(IConfiguration configuration, string provider)
    {
        public bool Used { get; private set; }

        public string? Pick(string? saved, string key)
        {
            if (Blank(saved) is { } value)
            {
                return value;
            }

            var environment = Blank(configuration[$"Authentication:{provider}:{key}"]);
            Used |= environment is not null;
            return environment;
        }
    }

    private static string? Blank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
