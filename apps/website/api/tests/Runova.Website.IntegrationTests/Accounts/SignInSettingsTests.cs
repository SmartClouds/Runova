using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Runova.Website.Api.Accounts;
using Runova.Website.Core.Identity;
using Runova.Website.Data;
using Runova.Website.Data.Identity;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

/// <summary>The Admin's switches and keys for the captcha and Google sign-in (E52).</summary>
public sealed class SignInSettingsTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string Path = TestSignInSettings.Path;
    private const string GoogleSecret = "GOCSPX-never-shown-anywhere";

    private readonly FakeTurnstile _turnstile = new();
    private string _connectionString = null!;
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync()
    {
        _connectionString = await postgres.CreateDatabaseAsync();
        _factory = new(_connectionString, services: _turnstile.Register);
    }

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    private Task<ApiClient> AdminAsync() => TestSignInSettings.AdminAsync(_factory);

    private static async Task<JsonElement> GetAsync(ApiClient admin) => await ApiClient.ReadJsonAsync(await admin.GetAsync(Path), HttpStatusCode.OK);

    [Fact]
    public async Task An_admin_reads_the_defaults()
    {
        var admin = await AdminAsync();

        var response = await admin.GetAsync(Path);
        var body = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);

        Assert.False(body.GetProperty("captchaEnabled").GetBoolean());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("turnstileSiteKey").ValueKind);
        Assert.False(body.GetProperty("hasTurnstileSecret").GetBoolean());
        Assert.True(body.GetProperty("googleEnabled").GetBoolean());
        Assert.False(body.GetProperty("googleActive").GetBoolean());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("googleClientId").ValueKind);
        Assert.False(body.GetProperty("hasGoogleClientSecret").GetBoolean());
        Assert.False(body.GetProperty("googleFromEnvironment").GetBoolean());
        Assert.Equal("https://runovahq.com/api/oauth/google/callback", body.GetProperty("googleCallbackUrl").GetString());
        Assert.Equal(0, body.GetProperty("googleOnlyAccounts").GetInt32());
        Assert.NotNull(response.Headers.ETag);
        Assert.Equal("private, no-store", response.Headers.NonValidated["Cache-Control"].ToString());
    }

    [Theory]
    [InlineData(Roles.Editor)]
    [InlineData(null)]
    public async Task Only_an_admin_may_read_or_change_them(string? role)
    {
        var user = role is null ? await TestAccounts.CreateAsync(_factory.Services) : await TestUsers.CreateAsync(_factory.Services, role);
        var client = role is null ? await TestAccounts.SignedInClientAsync(_factory, user) : await TestUsers.SignedInClientAsync(_factory, user);

        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(Path)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(HttpMethod.Patch, Path, new { googleEnabled = false }, ifMatch: "\"1\"")).StatusCode);
    }

    [Fact]
    public async Task Nobody_signed_in_gets_401()
    {
        Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateApiClient().GetAsync(Path)).StatusCode);
    }

    [Fact]
    public async Task Google_keys_saved_by_an_admin_turn_google_on_and_the_secret_never_comes_back()
    {
        var admin = await AdminAsync();

        var response = await TestSignInSettings.PatchAsync(admin, new { googleClientId = "web.apps.googleusercontent.com", googleClientSecret = GoogleSecret });
        var text = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        var body = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);

        Assert.Equal("web.apps.googleusercontent.com", body.GetProperty("googleClientId").GetString());
        Assert.True(body.GetProperty("hasGoogleClientSecret").GetBoolean());
        Assert.True(body.GetProperty("googleActive").GetBoolean());
        Assert.DoesNotContain(GoogleSecret, text, StringComparison.Ordinal);
        Assert.DoesNotContain(GoogleSecret, (await GetAsync(admin)).GetRawText(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Secrets_are_sealed_in_the_database()
    {
        var admin = await AdminAsync();
        await TestSignInSettings.PatchAsync(admin, new { googleClientId = "id", googleClientSecret = GoogleSecret });
        await TestSignInSettings.TurnOnCaptchaAsync(admin, _turnstile);

        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using var command = new NpgsqlCommand("SELECT row_to_json(s)::text FROM \"SignInSettings\" s", connection);
        var row = (string)(await command.ExecuteScalarAsync(TestContext.Current.CancellationToken))!;

        Assert.DoesNotContain(GoogleSecret, row, StringComparison.Ordinal);
        Assert.DoesNotContain(FakeTurnstile.Secret, row, StringComparison.Ordinal);
        Assert.Contains(FakeTurnstile.SiteKey, row, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_write_needs_the_current_version()
    {
        var admin = await AdminAsync();
        var stale = await TestSignInSettings.ETagAsync(admin);
        await TestSignInSettings.PatchAsync(admin, new { googleEnabled = false });

        var conflict = await admin.SendAsync(HttpMethod.Patch, Path, new { googleEnabled = true }, ifMatch: stale);
        var missing = await admin.SendAsync(HttpMethod.Patch, Path, new { googleEnabled = true });

        await ProblemAssert.IsProblemAsync(conflict, HttpStatusCode.PreconditionFailed, ProblemAssert.Type("precondition-failed"), Path);
        await ProblemAssert.IsProblemAsync(missing, (HttpStatusCode)428, ProblemAssert.Type("precondition-required"), Path);
    }

    [Fact]
    public async Task An_unknown_field_is_refused()
    {
        var admin = await AdminAsync();

        var response = await TestSignInSettings.PatchAsync(admin, new { recaptchaEnabled = true });

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Path);
        Assert.True(problem.GetProperty("errors").TryGetProperty("recaptchaEnabled", out _));
    }

    [Fact]
    public async Task Captcha_can_not_be_turned_on_without_its_keys()
    {
        var admin = await AdminAsync();

        var response = await TestSignInSettings.PatchAsync(admin, new { captchaEnabled = true, captchaToken = _turnstile.Issue(CaptchaActions.SettingsCheck) });

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Path);
        Assert.True(problem.GetProperty("errors").TryGetProperty("captchaEnabled", out _));
    }

    [Fact]
    public async Task Turning_captcha_on_needs_a_check_passed_with_the_new_keys()
    {
        var admin = await AdminAsync();
        var keys = new { captchaEnabled = true, turnstileSiteKey = FakeTurnstile.SiteKey, turnstileSecret = FakeTurnstile.Secret };

        var noProof = await TestSignInSettings.PatchAsync(admin, keys);
        var otherSecret = await TestSignInSettings.PatchAsync(admin, new
        {
            keys.captchaEnabled, keys.turnstileSiteKey, keys.turnstileSecret,
            captchaToken = _turnstile.Issue(CaptchaActions.SettingsCheck, secret: "0x4AAAAAAAoldsecret"),
        });
        var otherForm = await TestSignInSettings.PatchAsync(admin, new
        {
            keys.captchaEnabled, keys.turnstileSiteKey, keys.turnstileSecret,
            captchaToken = _turnstile.Issue(CaptchaActions.SignIn),
        });

        foreach (var refused in new[] { noProof, otherSecret, otherForm })
        {
            var problem = await ProblemAssert.IsProblemAsync(refused, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Path);
            Assert.True(problem.GetProperty("errors").TryGetProperty("captchaToken", out _));
        }

        Assert.False((await GetAsync(admin)).GetProperty("captchaEnabled").GetBoolean());

        await TestSignInSettings.TurnOnCaptchaAsync(admin, _turnstile);

        var on = await GetAsync(admin);
        Assert.True(on.GetProperty("captchaEnabled").GetBoolean());
        Assert.Equal(FakeTurnstile.SiteKey, on.GetProperty("turnstileSiteKey").GetString());
        Assert.True(on.GetProperty("hasTurnstileSecret").GetBoolean());
    }

    [Fact]
    public async Task New_keys_while_captcha_is_on_need_a_new_check()
    {
        var admin = await AdminAsync();
        await TestSignInSettings.TurnOnCaptchaAsync(admin, _turnstile);

        var refused = await TestSignInSettings.PatchAsync(admin, new { turnstileSecret = "0x4AAAAAAAnewsecret" });
        var accepted = await TestSignInSettings.PatchAsync(admin, new
        {
            turnstileSecret = "0x4AAAAAAAnewsecret",
            captchaToken = _turnstile.Issue(CaptchaActions.SettingsCheck, secret: "0x4AAAAAAAnewsecret"),
        });

        await ProblemAssert.IsProblemAsync(refused, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Path);
        await ApiClient.ReadJsonAsync(accepted, HttpStatusCode.OK);
    }

    [Fact]
    public async Task Turning_captcha_off_needs_no_check_and_keeps_the_keys()
    {
        var admin = await AdminAsync();
        await TestSignInSettings.TurnOnCaptchaAsync(admin, _turnstile);

        var body = await ApiClient.ReadJsonAsync(await TestSignInSettings.PatchAsync(admin, new { captchaEnabled = false }), HttpStatusCode.OK);

        Assert.False(body.GetProperty("captchaEnabled").GetBoolean());
        Assert.Equal(FakeTurnstile.SiteKey, body.GetProperty("turnstileSiteKey").GetString());
        Assert.True(body.GetProperty("hasTurnstileSecret").GetBoolean());
    }

    [Fact]
    public async Task A_secret_set_to_null_is_removed()
    {
        var admin = await AdminAsync();
        await TestSignInSettings.PatchAsync(admin, new { googleClientId = "id", googleClientSecret = GoogleSecret });

        var body = await ApiClient.ReadJsonAsync(await TestSignInSettings.PatchAsync(admin, new { googleClientSecret = (string?)null }), HttpStatusCode.OK);

        Assert.False(body.GetProperty("hasGoogleClientSecret").GetBoolean());
        Assert.False(body.GetProperty("googleActive").GetBoolean());
        Assert.Equal("id", body.GetProperty("googleClientId").GetString());
    }

    [Fact]
    public async Task The_captcha_secret_can_not_be_removed_while_captcha_is_on()
    {
        var admin = await AdminAsync();
        await TestSignInSettings.TurnOnCaptchaAsync(admin, _turnstile);

        var response = await TestSignInSettings.PatchAsync(admin, new { turnstileSecret = (string?)null });

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Path);
    }

    [Fact]
    public async Task Keys_that_are_too_long_are_refused()
    {
        var admin = await AdminAsync();

        var response = await TestSignInSettings.PatchAsync(admin, new { googleClientId = new string('a', 301), turnstileSiteKey = new string('b', 101) });

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Path);
        var errors = problem.GetProperty("errors");
        Assert.True(errors.TryGetProperty("googleClientId", out _));
        Assert.True(errors.TryGetProperty("turnstileSiteKey", out _));
    }

    [Fact]
    public async Task A_change_writes_an_audit_entry_that_names_fields_but_holds_no_secret()
    {
        var admin = await AdminAsync();
        await TestSignInSettings.PatchAsync(admin, new { googleClientId = "id", googleClientSecret = GoogleSecret });
        await TestSignInSettings.PatchAsync(admin, new { googleClientId = "id" });

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var entries = await db.AuditEntries.AsNoTracking().Where(e => e.Action == "sign-in-settings.update").ToListAsync(TestContext.Current.CancellationToken);

        var entry = Assert.Single(entries);
        Assert.Equal("sign-in-settings", entry.TargetType);
        var changes = entry.Changes!;
        Assert.Contains("googleClientSecret", changes, StringComparison.Ordinal);
        Assert.Contains("googleClientId", changes, StringComparison.Ordinal);
        Assert.DoesNotContain(GoogleSecret, changes, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Accounts_that_only_have_google_are_counted()
    {
        var admin = await AdminAsync();
        var withPassword = await TestAccounts.CreateAsync(_factory.Services);
        using (var scope = _factory.Services.CreateScope())
        {
            var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
            var email = TestAccounts.NewEmail();
            var googleOnly = new AppUser { UserName = email, Email = email, EmailConfirmed = true, DisplayName = "G", CreatedAt = DateTimeOffset.UtcNow };
            Assert.True((await users.CreateAsync(googleOnly)).Succeeded);
            Assert.True((await users.AddLoginAsync(googleOnly, new UserLoginInfo("Google", "sub-only", "Google"))).Succeeded);
            var both = (await users.FindByIdAsync(withPassword.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)))!;
            Assert.True((await users.AddLoginAsync(both, new UserLoginInfo("Google", "sub-both", "Google"))).Succeeded);
        }

        Assert.Equal(1, (await GetAsync(admin)).GetProperty("googleOnlyAccounts").GetInt32());
    }
}
