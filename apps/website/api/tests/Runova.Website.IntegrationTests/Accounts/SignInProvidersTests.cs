using System.Net;
using System.Text.Json;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

/// <summary>What the sign-in pages are told to show, and Google, once an Admin changed the settings (E52).</summary>
public sealed class SignInProvidersTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string Providers = "/api/v1/sign-in-providers";
    private const string StartGoogle = "/api/v1/external-sign-ins/google?returnUrl=%2Faccount";

    private readonly FakeGoogle _google = new() { Email = TestAccounts.NewEmail(), Subject = Guid.NewGuid().ToString("N") };
    private readonly FakeTurnstile _turnstile = new();
    private readonly List<WebsiteApiFactory> _factories = [];
    private string _connectionString = null!;

    public async ValueTask InitializeAsync() => _connectionString = await postgres.CreateDatabaseAsync();

    public ValueTask DisposeAsync()
    {
        _factories.ForEach(f => f.Dispose());
        return ValueTask.CompletedTask;
    }

    private WebsiteApiFactory Factory(bool googleFromEnvironment)
    {
        var factory = new WebsiteApiFactory(
            _connectionString,
            settings: googleFromEnvironment ? FakeGoogle.Settings : null,
            services: services =>
            {
                _google.Register(services);
                _turnstile.Register(services);
            });
        _factories.Add(factory);
        return factory;
    }

    private static async Task<JsonElement> ProvidersAsync(WebsiteApiFactory factory) =>
        await ApiClient.ReadJsonAsync(await factory.CreateApiClient().GetAsync(Providers), HttpStatusCode.OK);

    private static string[] Items(JsonElement providers) => [.. providers.GetProperty("items").EnumerateArray().Select(p => p.GetString()!)];

    [Fact]
    public async Task Google_keys_an_admin_saves_turn_google_on_without_a_restart()
    {
        var factory = Factory(googleFromEnvironment: false);
        Assert.Empty(Items(await ProvidersAsync(factory)));
        var admin = await TestSignInSettings.AdminAsync(factory);

        await TestSignInSettings.PatchAsync(admin, new { googleClientId = "saved-client.apps.googleusercontent.com", googleClientSecret = "saved-secret" });

        Assert.Equal(["google"], Items(await ProvidersAsync(factory)));
        var start = await factory.CreateApiClient().GetAsync(StartGoogle);
        Assert.Equal(HttpStatusCode.Redirect, start.StatusCode);
        Assert.Contains("client_id=saved-client.apps.googleusercontent.com", start.Headers.Location!.Query, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Someone_signs_in_with_google_using_the_saved_keys()
    {
        var factory = Factory(googleFromEnvironment: false);
        var admin = await TestSignInSettings.AdminAsync(factory);
        await TestSignInSettings.PatchAsync(admin, new { googleClientId = "saved-client", googleClientSecret = "saved-secret" });
        var client = factory.CreateApiClient();

        var done = await FakeGoogle.SignInAsync(client);

        Assert.Equal("/account", done.Headers.Location!.OriginalString);
        var me = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/accounts/me"), HttpStatusCode.OK);
        Assert.Equal(_google.Email, me.GetProperty("email").GetString());
    }

    [Fact]
    public async Task Saved_keys_win_over_the_environment()
    {
        var factory = Factory(googleFromEnvironment: true);
        var admin = await TestSignInSettings.AdminAsync(factory);
        var before = await factory.CreateApiClient().GetAsync(StartGoogle);
        Assert.Contains("client_id=" + FakeGoogle.ClientId, before.Headers.Location!.Query, StringComparison.Ordinal);

        await TestSignInSettings.PatchAsync(admin, new { googleClientId = "saved-client", googleClientSecret = "saved-secret" });

        var after = await factory.CreateApiClient().GetAsync(StartGoogle);
        Assert.Contains("client_id=saved-client", after.Headers.Location!.Query, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Google_turned_off_by_an_admin_is_gone_even_with_keys_in_the_environment()
    {
        var factory = Factory(googleFromEnvironment: true);
        var admin = await TestSignInSettings.AdminAsync(factory);
        var settings = await ApiClient.ReadJsonAsync(await admin.GetAsync(TestSignInSettings.Path), HttpStatusCode.OK);
        Assert.True(settings.GetProperty("googleFromEnvironment").GetBoolean());
        Assert.True(settings.GetProperty("googleActive").GetBoolean());

        await TestSignInSettings.PatchAsync(admin, new { googleEnabled = false });

        Assert.Empty(Items(await ProvidersAsync(factory)));
        var start = await factory.CreateApiClient().GetAsync(StartGoogle);
        await ProblemAssert.IsProblemAsync(start, HttpStatusCode.NotFound, ProblemAssert.Type("not-found"), "/api/v1/external-sign-ins/google");
    }

    [Fact]
    public async Task The_providers_name_no_captcha_while_it_is_off()
    {
        var providers = await ProvidersAsync(Factory(googleFromEnvironment: false));

        Assert.Equal(JsonValueKind.Null, providers.GetProperty("captcha").ValueKind);
    }

    [Fact]
    public async Task The_providers_carry_the_site_key_once_the_captcha_is_on()
    {
        var factory = Factory(googleFromEnvironment: false);
        await TestSignInSettings.TurnOnCaptchaAsync(await TestSignInSettings.AdminAsync(factory), _turnstile);

        var captcha = (await ProvidersAsync(factory)).GetProperty("captcha");

        Assert.Equal("turnstile", captcha.GetProperty("provider").GetString());
        Assert.Equal(FakeTurnstile.SiteKey, captcha.GetProperty("siteKey").GetString());
        Assert.Equal(["provider", "siteKey"], captcha.EnumerateObject().Select(p => p.Name));
    }
}
