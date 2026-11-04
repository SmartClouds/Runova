using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

namespace Runova.Website.Api.Releases;

/// <summary>
/// Reads the latest SmartClouds/Runova release from the GitHub REST API, conditionally: with the
/// ETag of the last answer, an unchanged release costs a 304 and none of the rate limit.
/// </summary>
internal sealed class GitHubReleasesClient(HttpClient http, IConfiguration configuration)
{
    public const string LatestPath = "repos/SmartClouds/Runova/releases/latest";
    public const string RateLimitPath = "rate_limit";

    /// <summary>GitHub's release body and the ETag it came with.</summary>
    public sealed record Latest(string Json, string? ETag);

    /// <summary>How many REST calls GitHub allows this client per hour, and how many are left.</summary>
    public sealed record RateLimit(int Limit, int Remaining, DateTimeOffset ResetsAt);

    public static void Configure(HttpClient http)
    {
        http.BaseAddress = new Uri("https://api.github.com/");
        http.Timeout = TimeSpan.FromSeconds(30);
        http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("Runova-Website", "1.0"));
        http.DefaultRequestHeaders.Add("X-GitHub-Api-Version", "2022-11-28");
    }

    /// <summary>
    /// The latest release, or null when it has not changed since <paramref name="etag"/>. Throws
    /// <see cref="HttpRequestException"/> when GitHub can not be reached or answers
    /// anything but 200 or 304. <c>GitHub__Token</c>, when set, raises the rate limit.
    /// </summary>
    public async Task<Latest?> GetLatestAsync(string? etag, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, LatestPath);
        if (etag is not null && EntityTagHeaderValue.TryParse(etag, out var tag))
        {
            request.Headers.IfNoneMatch.Add(tag);
        }

        AddToken(request);
        using var response = await http.SendAsync(request, cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotModified)
        {
            return null;
        }

        response.EnsureSuccessStatusCode();
        return new Latest(await response.Content.ReadAsStringAsync(cancellationToken), response.Headers.ETag?.ToString());
    }

    /// <summary>
    /// The rate limit the releases sync runs under. GitHub does not count this call against it, so
    /// the healthcheck can ask as often as it likes. Throws like <see cref="GetLatestAsync"/>.
    /// </summary>
    public async Task<RateLimit> GetRateLimitAsync(CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, RateLimitPath);
        AddToken(request);
        using var response = await http.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var body = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var json = await JsonDocument.ParseAsync(body, cancellationToken: cancellationToken);
        var rate = json.RootElement.GetProperty("rate");
        return new RateLimit(
            rate.GetProperty("limit").GetInt32(),
            rate.GetProperty("remaining").GetInt32(),
            DateTimeOffset.FromUnixTimeSeconds(rate.GetProperty("reset").GetInt64()));
    }

    private void AddToken(HttpRequestMessage request)
    {
        if (configuration["GitHub:Token"] is { Length: > 0 } token)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }
    }
}
