using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Runova.Website.Api.Health;
using Runova.Website.Api.Jobs;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests;

/// <summary>
/// <c>/_runova/health</c> held to runova-health/1: who gets the report, what it looks like, and
/// what it keeps to itself.
/// </summary>
public sealed class RunovaHealthTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string Path = RunovaHealthEndpoint.Path;
    private const string Caller = "10.20.0.1";

    private static readonly string _key = "rnh_" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(24));
    private static readonly string _keyHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(_key)));
    private static readonly string[] _statuses = ["pass", "warn", "fail"];

    private readonly FakeGitHub _github = new();
    private readonly string _media = Directory.CreateTempSubdirectory("runova-health-").FullName;
    private readonly List<WebsiteApiFactory> _factories = [];
    private string _database = null!;

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    // A database of its own, so the stored releases are known: none.
    public async ValueTask InitializeAsync()
    {
        _github.SendsRateLimit(remaining: 4999);
        _database = await postgres.CreateDatabaseAsync();
    }

    public ValueTask DisposeAsync()
    {
        foreach (var factory in _factories)
        {
            factory.Dispose();
        }

        Directory.Delete(_media, recursive: true);
        return ValueTask.CompletedTask;
    }

    [Fact]
    public async Task Without_a_key_it_answers_an_empty_401_with_the_Bearer_challenge()
    {
        var response = await GetAsync(Client(), authorization: null);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal(RunovaHealthEndpoint.Challenge, Assert.Single(response.Headers.WwwAuthenticate).ToString());
        Assert.True(response.Headers.CacheControl?.NoStore);
        Assert.Empty(await response.Content.ReadAsByteArrayAsync(Cancel));
        Assert.Null(response.Content.Headers.ContentType);
    }

    [Theory]
    [InlineData("Bearer")]
    [InlineData("Bearer ")]
    [InlineData("Bearer rnh_wrong")]
    [InlineData("Bearer {hash}")]
    [InlineData("Bearer {key}x")]
    [InlineData("Bearer {key}, Bearer {key}")]
    [InlineData("{key}")]
    [InlineData("Token {key}")]
    [InlineData("Basic {basic}")]
    public async Task Every_wrong_credential_gets_the_same_answer_as_none(string authorization)
    {
        var client = Client();
        var none = await GetAsync(client, authorization: null);

        var response = await GetAsync(client, authorization
            .Replace("{key}", _key, StringComparison.Ordinal)
            .Replace("{hash}", _keyHash, StringComparison.Ordinal)
            .Replace("{basic}", Convert.ToBase64String(Encoding.UTF8.GetBytes("runova:" + _key)), StringComparison.Ordinal));

        await AssertSameRefusalAsync(none, response);
    }

    [Fact]
    public async Task Two_Authorization_headers_are_refused_even_when_one_is_right()
    {
        var client = Client();
        using var request = Request(HttpMethod.Get, authorization: null);
        request.Headers.TryAddWithoutValidation("Authorization", ["Bearer " + _key, "Bearer rnh_wrong"]);

        var response = await client.SendAsync(request, Cancel);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Theory]
    [InlineData("?access_token={key}", null)]
    [InlineData("?key={key}", null)]
    [InlineData("", "access_token={key}")]
    [InlineData("", "runova-health={key}")]
    public async Task The_key_is_taken_only_from_the_Authorization_header(string query, string? cookie)
    {
        var client = Client();
        using var request = new HttpRequestMessage(HttpMethod.Get, Path + query.Replace("{key}", _key, StringComparison.Ordinal));
        request.Headers.Add(TestApiClients.RemoteIpHeader, Caller);
        if (cookie is not null)
        {
            request.Headers.Add("Cookie", cookie.Replace("{key}", _key, StringComparison.Ordinal));
        }

        var response = await client.SendAsync(request, Cancel);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Empty(await response.Content.ReadAsByteArrayAsync(Cancel));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not hex at all")]
    [InlineData("{hash-short}")]
    [InlineData("{hash}00")]
    public async Task Without_a_valid_hash_in_the_variable_even_the_right_key_is_refused(string? hash)
    {
        var settings = new Dictionary<string, string>();
        if (hash is not null)
        {
            settings[RunovaHealthEndpoint.TokenHashVariable] = hash
                .Replace("{hash-short}", _keyHash[..62], StringComparison.Ordinal)
                .Replace("{hash}", _keyHash, StringComparison.Ordinal);
        }

        var client = Client(keyHash: null, settings: settings);

        var response = await GetAsync(client, "Bearer " + _key);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Empty(await response.Content.ReadAsByteArrayAsync(Cancel));
    }

    [Fact]
    public async Task The_right_key_gets_the_report_in_the_protocols_shape()
    {
        var response = await GetAsync(Client(), "Bearer " + _key);
        using var report = await ReportAsync(response);
        var root = report.RootElement;

        // The tests run no Hangfire server, so that check fails and with it the report.
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("fail", root.GetProperty("status").GetString());
        Assert.Equal(typeof(Program).Assembly.GetName().Version!.ToString(3), root.GetProperty("version").GetString());
        if (root.TryGetProperty("releaseId", out var releaseId))
        {
            Assert.Matches("^[0-9a-f]{7,40}$", releaseId.GetString());
        }

        Assert.Equal("runova-website", root.GetProperty("serviceId").GetString());
        Assert.True(DateTimeOffset.TryParse(root.GetProperty("time").GetString(), out _));
        Assert.False(root.TryGetProperty("output", out _));
        var target = root.GetProperty("runova");
        Assert.Equal("runova-health/1", target.GetProperty("protocol").GetString());
        Assert.Equal("production", target.GetProperty("environment").GetString());
        Assert.False(string.IsNullOrEmpty(target.GetProperty("server").GetString()));

        var checks = root.GetProperty("checks");
        Assert.Equal(
            ["postgres:connection", "migrations:pending", "hangfire:servers", "hangfire:recurring", "releases:latest", "media:storage", "disk:free", "github:api"],
            checks.EnumerateObject().Select(c => c.Name));
        foreach (var entry in checks.EnumerateObject().SelectMany(c => c.Value.EnumerateArray()))
        {
            AssertEntryShape(entry);
        }

        var postgresCheck = Single(checks, "postgres:connection");
        Assert.Equal("pass", postgresCheck.GetProperty("status").GetString());
        Assert.Equal("datastore", postgresCheck.GetProperty("componentType").GetString());
        Assert.Equal("ms", postgresCheck.GetProperty("observedUnit").GetString());
        Assert.Equal(JsonValueKind.Number, postgresCheck.GetProperty("observedValue").ValueKind);
        Assert.Equal("pass", Single(checks, "migrations:pending").GetProperty("status").GetString());
        Assert.Equal("pass", Single(checks, "media:storage").GetProperty("status").GetString());
        Assert.Equal("pass", Single(checks, "github:api").GetProperty("status").GetString());
        Assert.Equal("percent", Single(checks, "disk:free").GetProperty("observedUnit").GetString());
        Assert.Equal("warn", Single(checks, "releases:latest").GetProperty("status").GetString());

        var servers = Single(checks, "hangfire:servers");
        Assert.Equal("fail", servers.GetProperty("status").GetString());
        Assert.Equal("No Hangfire job server is running", servers.GetProperty("output").GetString());
        Assert.False(string.IsNullOrEmpty(servers.GetProperty("runova").GetProperty("hint").GetString()));

        var recurring = checks.GetProperty("hangfire:recurring").EnumerateArray().ToList();
        Assert.Equal(RecurringJobRegistry.Schedules.Keys, recurring.Select(r => r.GetProperty("componentId").GetString()));
        Assert.All(recurring, r => Assert.Equal("pass", r.GetProperty("status").GetString()));
    }

    [Fact]
    public async Task A_database_that_does_not_answer_fails_with_details_and_without_its_password()
    {
        const string password = "Sup3rSecretPassw0rd";
        var client = Client(connectionString: $"Host=127.0.0.1;Port=1;Database=nowhere;Username=nobody;Password={password};Timeout=1");

        var response = await GetAsync(client, "Bearer " + _key);
        var text = await response.Content.ReadAsStringAsync(Cancel);
        using var report = JsonDocument.Parse(text);
        var root = report.RootElement;

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("fail", root.GetProperty("status").GetString());
        Assert.False(string.IsNullOrEmpty(root.GetProperty("output").GetString()));
        var check = Single(root.GetProperty("checks"), "postgres:connection");
        Assert.Equal("fail", check.GetProperty("status").GetString());
        Assert.False(string.IsNullOrEmpty(check.GetProperty("output").GetString()));
        var details = check.GetProperty("runova");
        foreach (var field in new[] { "errorCode", "detail", "stack", "hint", "since" })
        {
            Assert.False(string.IsNullOrEmpty(details.GetProperty(field).GetString()), field);
        }

        Assert.True(details.GetProperty("stack").GetString()!.Length <= RunovaHealthReporter.StackLimit);
        Assert.DoesNotContain(password, text, StringComparison.Ordinal);
        Assert.DoesNotContain(_key, text, StringComparison.Ordinal);
        Assert.DoesNotContain(_keyHash, text, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("POST")]
    [InlineData("PUT")]
    [InlineData("PATCH")]
    [InlineData("DELETE")]
    [InlineData("HEAD")]
    public async Task Only_GET_is_answered(string method)
    {
        var response = await Client().SendAsync(Request(new HttpMethod(method), "Bearer " + _key), Cancel);

        Assert.Equal(HttpStatusCode.MethodNotAllowed, response.StatusCode);
    }

    [Fact]
    public async Task Each_address_gets_30_requests_a_minute_and_refused_ones_count()
    {
        var client = Client();
        for (var i = 0; i < RunovaHealthEndpoint.RequestsPerMinute; i++)
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await GetAsync(client, "Bearer rnh_guess" + i)).StatusCode);
        }

        var limited = await GetAsync(client, "Bearer " + _key);
        var otherCaller = await GetAsync(client, "Bearer " + _key, caller: "10.20.0.2");

        Assert.Equal(HttpStatusCode.TooManyRequests, limited.StatusCode);
        Assert.Empty(await limited.Content.ReadAsByteArrayAsync(Cancel));
        Assert.True(limited.Headers.CacheControl?.NoStore);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, otherCaller.StatusCode);
    }

    [Fact]
    public async Task The_report_is_kept_for_a_few_seconds()
    {
        var client = Client();

        using var first = await ReportAsync(await GetAsync(client, "Bearer " + _key));
        using var second = await ReportAsync(await GetAsync(client, "Bearer " + _key));

        Assert.Equal(first.RootElement.GetProperty("time").GetString(), second.RootElement.GetProperty("time").GetString());
    }

    [Fact]
    public async Task A_check_that_takes_longer_than_2_seconds_fails_as_timed_out()
    {
        _github.Replies(_ =>
        {
            Thread.Sleep(TimeSpan.FromSeconds(3));
            return new HttpResponseMessage(HttpStatusCode.OK);
        });

        using var report = await ReportAsync(await GetAsync(Client(), "Bearer " + _key));

        var github = Single(report.RootElement.GetProperty("checks"), "github:api");
        Assert.Equal("fail", github.GetProperty("status").GetString());
        Assert.Equal("Timed out after 2 s", github.GetProperty("output").GetString());
        Assert.Equal("Timeout", github.GetProperty("runova").GetProperty("errorCode").GetString());
    }

    [Fact]
    public async Task GitHub_down_is_a_warning_since_the_site_keeps_its_stored_release()
    {
        _github.IsUnreachable();

        using var report = await ReportAsync(await GetAsync(Client(), "Bearer " + _key));

        var github = Single(report.RootElement.GetProperty("checks"), "github:api");
        Assert.Equal("warn", github.GetProperty("status").GetString());
        Assert.Equal("api.github.com could not be reached (fake).", github.GetProperty("output").GetString());
    }

    [Fact]
    public async Task The_site_check_runs_when_the_site_is_named_and_fails_when_it_does_not_answer()
    {
        var client = Client(settings: new Dictionary<string, string> { [RunovaHealthChecks.SiteUrlSetting] = "http://127.0.0.1:1/" });

        using var report = await ReportAsync(await GetAsync(client, "Bearer " + _key));

        var site = Single(report.RootElement.GetProperty("checks"), "site:http");
        Assert.Equal("fail", site.GetProperty("status").GetString());
        Assert.Equal("http", site.GetProperty("componentType").GetString());
        Assert.False(string.IsNullOrEmpty(site.GetProperty("runova").GetProperty("errorCode").GetString()));
    }

    [Theory]
    [InlineData("Host=db;Username=runova;Password=hunter2hunter2", "Host=db;Username=runova;Password=***")]
    [InlineData("connect with pwd = abc123; failed", "connect with pwd=***; failed")]
    [InlineData("sent Authorization: Bearer abcdefghijklmnop", "sent Authorization: Bearer ***")]
    [InlineData("key rnh_0123456789abcdef in a message", "key *** in a message")]
    [InlineData("GET https://user:s3cret@example.com/path", "GET https://***@example.com/path")]
    [InlineData("the token ghp_configuredtoken leaked", "the token *** leaked")]
    [InlineData("the stored password Configured9Password showed up", "the stored password *** showed up")]
    public void Redaction_takes_secrets_out_of_error_text(string text, string redacted)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["GitHub:Token"] = "ghp_configuredtoken",
            ["ConnectionStrings:Default"] = "Host=db;Username=runova;Password=Configured9Password",
        }).Build();

        Assert.Equal(redacted, new HealthRedaction(configuration).Redact(text));
    }

    private HttpClient Client(string? connectionString = null, string? keyHash = "{default}", IReadOnlyDictionary<string, string>? settings = null)
    {
        var all = new Dictionary<string, string> { ["Website:MediaPath"] = _media };
        if (keyHash is not null)
        {
            all[RunovaHealthEndpoint.TokenHashVariable] = keyHash == "{default}" ? _keyHash : keyHash;
        }

        foreach (var (key, value) in settings ?? new Dictionary<string, string>())
        {
            all[key] = value;
        }

        var factory = new WebsiteApiFactory(connectionString ?? _database, settings: all, services: _github.Register);
        _factories.Add(factory);
        return factory.CreateClient(new() { AllowAutoRedirect = false });
    }

    private static HttpRequestMessage Request(HttpMethod method, string? authorization, string caller = Caller)
    {
        var request = new HttpRequestMessage(method, Path);
        request.Headers.Add(TestApiClients.RemoteIpHeader, caller);
        request.Headers.Accept.ParseAdd(RunovaHealthReport.ContentType);
        request.Headers.UserAgent.ParseAdd("Runova-Health/1");
        if (authorization is not null)
        {
            request.Headers.TryAddWithoutValidation("Authorization", authorization);
        }

        return request;
    }

    private static async Task<HttpResponseMessage> GetAsync(HttpClient client, string? authorization, string caller = Caller)
    {
        using var request = Request(HttpMethod.Get, authorization, caller);
        return await client.SendAsync(request, Cancel);
    }

    private static async Task<JsonDocument> ReportAsync(HttpResponseMessage response)
    {
        Assert.Contains(response.StatusCode, new[] { HttpStatusCode.OK, HttpStatusCode.ServiceUnavailable });
        Assert.Equal(RunovaHealthReport.ContentType, response.Content.Headers.ContentType?.MediaType);
        Assert.True(response.Headers.CacheControl?.NoStore);
        var report = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancel));
        var status = report.RootElement.GetProperty("status").GetString();
        Assert.Equal(status == "fail" ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK, response.StatusCode);
        return report;
    }

    private static async Task AssertSameRefusalAsync(HttpResponseMessage expected, HttpResponseMessage actual)
    {
        Assert.Equal(HttpStatusCode.Unauthorized, actual.StatusCode);
        Assert.Equal(expected.Headers.WwwAuthenticate.ToString(), actual.Headers.WwwAuthenticate.ToString());
        Assert.Equal(expected.Headers.CacheControl?.ToString(), actual.Headers.CacheControl?.ToString());
        Assert.Equal(expected.Content.Headers.ContentType, actual.Content.Headers.ContentType);
        Assert.Empty(await actual.Content.ReadAsByteArrayAsync(Cancel));
    }

    private static JsonElement Single(JsonElement checks, string key) => Assert.Single(checks.GetProperty(key).EnumerateArray());

    /// <summary>Every entry has a status and a time; one that does not pass also says why and since when.</summary>
    private static void AssertEntryShape(JsonElement entry)
    {
        Assert.Contains(entry.GetProperty("status").GetString(), _statuses);
        Assert.True(DateTimeOffset.TryParse(entry.GetProperty("time").GetString(), out _));
        if (entry.GetProperty("status").GetString() == "pass")
        {
            Assert.False(entry.TryGetProperty("output", out _));
            Assert.False(entry.TryGetProperty("runova", out _));
            return;
        }

        Assert.False(string.IsNullOrEmpty(entry.GetProperty("output").GetString()));
        Assert.False(string.IsNullOrEmpty(entry.GetProperty("runova").GetProperty("detail").GetString()));
        Assert.True(DateTimeOffset.TryParse(entry.GetProperty("runova").GetProperty("since").GetString(), out _));
    }
}
