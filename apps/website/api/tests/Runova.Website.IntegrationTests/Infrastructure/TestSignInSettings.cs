using System.Net;
using Runova.Website.Api.Accounts;
using Runova.Website.Core.Identity;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>
/// The Admin's sign-in settings, changed the way the settings page does. A test that changes them
/// needs a database of its own: every API on the shared database would see captcha turn on.
/// </summary>
internal static class TestSignInSettings
{
    public const string Path = "/api/v1/sign-in-settings";

    public static async Task<ApiClient> AdminAsync(WebsiteApiFactory factory) =>
        await TestUsers.SignedInClientAsync(factory, await TestUsers.CreateAsync(factory.Services, Roles.Admin));

    /// <summary>The current ETag, for the next write's If-Match.</summary>
    public static async Task<string> ETagAsync(ApiClient admin)
    {
        var response = await admin.GetAsync(Path);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return response.Headers.ETag!.Tag;
    }

    public static async Task<HttpResponseMessage> PatchAsync(ApiClient admin, object body) =>
        await admin.SendAsync(HttpMethod.Patch, Path, body, ifMatch: await ETagAsync(admin));

    /// <summary>Turns the captcha on with the fake's keys, proved by a token for the settings check.</summary>
    public static async Task TurnOnCaptchaAsync(ApiClient admin, FakeTurnstile turnstile)
    {
        var response = await PatchAsync(admin, new
        {
            captchaEnabled = true,
            turnstileSiteKey = FakeTurnstile.SiteKey,
            turnstileSecret = FakeTurnstile.Secret,
            captchaToken = turnstile.Issue(CaptchaActions.SettingsCheck),
        });
        await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);
    }
}
