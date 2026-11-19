using System.Net;
using System.Text.Json;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>The passkey ceremonies (E115) as a browser runs them, with a <see cref="SoftwarePasskey"/>.</summary>
internal static class TestPasskeys
{
    public const string Challenges = "/api/v1/passkey-challenges";
    public const string SignIns = "/api/v1/passkey-sign-ins";
    public const string Mine = "/api/v1/users/me/passkeys";

    public sealed record Challenge(string Id, JsonElement Options);

    public static async Task<Challenge> ChallengeAsync(ApiClient client, string purpose)
    {
        var body = await ApiClient.ReadJsonAsync(await client.SendAsync(HttpMethod.Post, Challenges, new { purpose }), HttpStatusCode.Created);
        return new(body.GetProperty("id").GetString()!, body.GetProperty("options"));
    }

    /// <summary>Adds the passkey to the signed-in account, confirming with the password.</summary>
    public static async Task<JsonElement> AddAsync(ApiClient client, SoftwarePasskey passkey, string name = "Laptop", string password = TestAccounts.Password)
    {
        var response = await SendAddAsync(client, passkey, name, password);
        return await ApiClient.ReadJsonAsync(response, HttpStatusCode.Created);
    }

    public static async Task<HttpResponseMessage> SendAddAsync(ApiClient client, SoftwarePasskey passkey, string name = "Laptop", string? password = TestAccounts.Password)
    {
        var challenge = await ChallengeAsync(client, "register");
        return await client.SendAsync(HttpMethod.Post, Mine, new { challengeId = challenge.Id, credential = passkey.Create(challenge.Options), name, password });
    }

    /// <summary>Signs a fresh client in with the passkey, the way the sign-in page does.</summary>
    public static async Task<HttpResponseMessage> SignInAsync(ApiClient client, SoftwarePasskey passkey)
    {
        await client.RefreshAntiforgeryTokenAsync();
        var challenge = await ChallengeAsync(client, "sign-in");
        var response = await client.SendAsync(HttpMethod.Post, SignIns, new { challengeId = challenge.Id, credential = passkey.Get(challenge.Options) });
        if (response.IsSuccessStatusCode)
        {
            await client.RefreshAntiforgeryTokenAsync();
        }

        return response;
    }
}
