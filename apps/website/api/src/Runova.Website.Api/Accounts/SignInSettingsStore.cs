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
/// The sign-in settings in force: the Admin's row, with Google's keys falling back to
/// <c>Authentication__Google__*</c> when the row has none, so a host set up before E52 keeps working.
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
    /// <summary>The captcha is checked only when it is on and both keys are there.</summary>
    public bool CaptchaActive => CaptchaEnabled && TurnstileSiteKey is not null && TurnstileSecret is not null;

    public bool GoogleActive => GoogleEnabled && GoogleClientId is not null && GoogleClientSecret is not null;
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
        var environmentId = Blank(configuration["Authentication:Google:ClientId"]);
        var environmentSecret = Blank(configuration["Authentication:Google:ClientSecret"]);
        var clientId = Blank(row.GoogleClientId);
        var clientSecret = secrets.Unseal(row.GoogleClientSecretSealed);
        return new SignInSnapshot(
            row.CaptchaEnabled,
            Blank(row.TurnstileSiteKey),
            secrets.Unseal(row.TurnstileSecretSealed),
            row.GoogleEnabled,
            clientId ?? environmentId,
            clientSecret ?? environmentSecret,
            (clientId is null && environmentId is not null) || (clientSecret is null && environmentSecret is not null));
    }

    private static string? Blank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
