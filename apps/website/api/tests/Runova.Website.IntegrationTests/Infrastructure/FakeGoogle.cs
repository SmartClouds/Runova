using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authentication.Google;
using Microsoft.Extensions.DependencyInjection;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>
/// Google's token and user info endpoints for the API's Google handler, plus the browser's side of
/// the flow: start, follow the redirect to Google, come back to the callback with a code, and
/// finish. Who Google says is signing in is set per test.
/// </summary>
internal sealed partial class FakeGoogle : HttpMessageHandler
{
    public const string ClientId = "test-client.apps.googleusercontent.com";

    public string Subject { get; set; } = "google-sub-1";

    public string Email { get; set; } = "sam@example.test";

    public bool EmailVerified { get; set; } = true;

    public string Name { get; set; } = "Sam Google";

    public static IReadOnlyDictionary<string, string> Settings => new Dictionary<string, string>
    {
        ["Authentication:Google:ClientId"] = ClientId,
        ["Authentication:Google:ClientSecret"] = "test-secret",
    };

    public void Register(IServiceCollection services) =>
        // The handler makes its HTTP client before a test's post-configure runs, so replace the client itself.
        services.PostConfigure<GoogleOptions>(GoogleDefaults.AuthenticationScheme, options => options.Backchannel = new HttpClient(this));

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var url = request.RequestUri!.ToString();
        object body = url.Contains("token", StringComparison.Ordinal)
            ? new { access_token = "fake-access", token_type = "Bearer", expires_in = 3600 }
            : new { sub = Subject, email = Email, email_verified = EmailVerified, name = Name };
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
        });
    }

    /// <summary>
    /// Runs the browser's side from <paramref name="startPath"/> and returns the last response,
    /// the redirect the API sends the browser to when it is done.
    /// </summary>
    public static async Task<HttpResponseMessage> SignInAsync(ApiClient client, string startPath = "/api/v1/external-sign-ins/google?returnUrl=%2Faccount")
    {
        var start = await client.GetAsync(startPath);
        Assert.Equal(HttpStatusCode.Redirect, start.StatusCode);
        var toGoogle = start.Headers.Location!;
        Assert.Equal("accounts.google.com", toGoogle.Host);
        var state = StateParameter().Match(toGoogle.Query).Groups[1].Value;
        var redirectUri = Uri.UnescapeDataString(RedirectParameter().Match(toGoogle.Query).Groups[1].Value);

        var callback = await client.GetAsync($"{new Uri(redirectUri).PathAndQuery}?code=fake-code&state={state}");
        Assert.Equal(HttpStatusCode.Redirect, callback.StatusCode);

        return await client.GetAsync(callback.Headers.Location!.OriginalString);
    }

    /// <summary>The browser coming back from Google with an error, as when the person presses Cancel.</summary>
    public static async Task<HttpResponseMessage> CancelAsync(ApiClient client)
    {
        var start = await client.GetAsync("/api/v1/external-sign-ins/google?returnUrl=%2Faccount");
        var toGoogle = start.Headers.Location!;
        var state = StateParameter().Match(toGoogle.Query).Groups[1].Value;
        var redirectUri = Uri.UnescapeDataString(RedirectParameter().Match(toGoogle.Query).Groups[1].Value);
        return await client.GetAsync($"{new Uri(redirectUri).PathAndQuery}?error=access_denied&state={state}");
    }

    [GeneratedRegex("[?&]state=([^&]+)")]
    private static partial Regex StateParameter();

    [GeneratedRegex("[?&]redirect_uri=([^&]+)")]
    private static partial Regex RedirectParameter();
}
