using System.Collections.Concurrent;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Runova.Website.Api.Notifications;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>Stands in for FCM and APNs: keeps every delivery the dispatcher hands over, in order.</summary>
internal sealed class FakePush
{
    private readonly ConcurrentQueue<PushDelivery> _received = new();

    public PushSendResult Result { get; set; } = PushSendResult.Sent;

    public IReadOnlyList<PushDelivery> Received => [.. _received];

    public void Register(IServiceCollection services)
    {
        services.RemoveAll<IPushSender>();
        services.AddSingleton<IPushSender>(new Sender(this, PushPlatforms.Android));
        services.AddSingleton<IPushSender>(new Sender(this, PushPlatforms.Ios));
    }

    /// <summary>Waits for at least this many deliveries.</summary>
    public async Task<IReadOnlyList<PushDelivery>> WaitForAsync(int count)
    {
        for (var waited = 0; waited < 400; waited++)
        {
            if (_received.Count >= count)
            {
                return Received;
            }

            await Task.Delay(50, TestContext.Current.CancellationToken);
        }

        Assert.Fail($"Expected {count} deliveries, got {_received.Count}.");
        return [];
    }

    private sealed class Sender(FakePush fake, string platform) : IPushSender
    {
        public string Platform => platform;

        public Task<PushSendResult> SendAsync(PushDelivery delivery, CancellationToken cancellationToken)
        {
            fake._received.Enqueue(delivery);
            return Task.FromResult(fake.Result);
        }
    }
}

/// <summary>Signing a phone in, the way <see cref="TestDependencies.DeviceTokenAsync"/> does a computer.</summary>
internal static class TestPhones
{
    private const string Redirect = "com.runovahq.app:/auth/callback";

    public sealed record Phone(string AccessToken, long SessionId, HttpClient Client);

    public static async Task<Phone> SignInAsync(WebsiteApiFactory factory, ApiClient browser, string platform = "android")
    {
        static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var verifier = Base64Url(RandomNumberGenerator.GetBytes(32));
        var challenge = Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        var approval = await ApiClient.ReadJsonAsync(
            await browser.SendAsync(HttpMethod.Post, "/api/v1/device-authorizations", new
            {
                clientId = "runova-mobile",
                redirectUri = Redirect,
                codeChallenge = challenge,
                codeChallengeMethod = "S256",
                state = "state-1234567890",
                deviceName = "Sam's phone",
                platform,
                appVersion = "1.0.0",
                deviceId = Guid.NewGuid(),
            }),
            System.Net.HttpStatusCode.Created);
        var code = System.Web.HttpUtility.ParseQueryString(new Uri(approval.GetProperty("redirectUrl").GetString()!).Query)["code"]!;
        var tokens = await ApiClient.ReadJsonAsync(
            await factory.CreateClient().PostAsJsonAsync(
                "/api/v1/device-tokens",
                new { grantType = "authorization_code", code, codeVerifier = verifier, redirectUri = Redirect, refreshToken = (string?)null },
                TestContext.Current.CancellationToken),
            System.Net.HttpStatusCode.OK);
        var accessToken = tokens.GetProperty("accessToken").GetString()!;
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", accessToken);
        return new Phone(accessToken, tokens.GetProperty("sessionId").GetInt64(), client);
    }

    public static HttpClient BearerClient(WebsiteApiFactory factory, string token)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        return client;
    }
}
