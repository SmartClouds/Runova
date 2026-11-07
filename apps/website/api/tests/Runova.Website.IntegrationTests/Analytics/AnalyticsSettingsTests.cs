using System.Net;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Core.Identity;
using Runova.Website.Data;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Analytics;

/// <summary>
/// The tracking tags and verifications an Admin sets for the public site (E59), and what the site
/// reads of them. A test that changes them needs a database of its own: every API on the shared
/// database would see the tags.
/// </summary>
public sealed class AnalyticsSettingsTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string Path = "/api/v1/analytics-settings";
    private const string PublicPath = "/api/v1/site-analytics";

    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync() => _factory = new(await postgres.CreateDatabaseAsync());

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    private async Task<ApiClient> AdminAsync() =>
        await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Admin));

    private static async Task<HttpResponseMessage> PatchAsync(ApiClient admin, object body)
    {
        var current = await admin.GetAsync(Path);
        Assert.Equal(HttpStatusCode.OK, current.StatusCode);
        return await admin.SendAsync(HttpMethod.Patch, Path, body, ifMatch: current.Headers.ETag!.Tag);
    }

    private static async Task<JsonElement> SaveAsync(ApiClient admin, object body) =>
        await ApiClient.ReadJsonAsync(await PatchAsync(admin, body), HttpStatusCode.OK);

    private async Task<JsonElement> SiteAsync() =>
        await ApiClient.ReadJsonAsync(await _factory.CreateApiClient().GetAsync(PublicPath), HttpStatusCode.OK);

    private static string[] Strings(JsonElement list) => [.. list.EnumerateArray().Select(e => e.GetString()!)];

    private static async Task<JsonElement> RefusedAsync(ApiClient admin, object body) =>
        await ProblemAssert.IsProblemAsync(await PatchAsync(admin, body), HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Path);

    [Fact]
    public async Task Everything_starts_off_and_only_the_site_may_read_it_signed_out()
    {
        var admin = await AdminAsync();

        var response = await admin.GetAsync(Path);
        var body = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);
        var site = await _factory.CreateApiClient().GetAsync(PublicPath);
        var siteBody = await ApiClient.ReadJsonAsync(site, HttpStatusCode.OK);

        Assert.False(body.GetProperty("tagsEnabled").GetBoolean());
        Assert.Empty(Strings(body.GetProperty("googleAnalyticsIds")));
        Assert.Empty(Strings(body.GetProperty("googleAdsIds")));
        foreach (var name in new[] { "googleTagManagerId", "clarityProjectId", "bingUetTagId", "googleSiteVerification", "bingSiteVerification" })
        {
            Assert.Equal(JsonValueKind.Null, body.GetProperty(name).ValueKind);
            Assert.Equal(JsonValueKind.Null, siteBody.GetProperty(name).ValueKind);
        }

        Assert.False(body.GetProperty("consentBannerEnabled").GetBoolean());
        Assert.Equal("private, no-store", response.Headers.NonValidated["Cache-Control"].ToString());
        Assert.False(siteBody.GetProperty("consentRequired").GetBoolean());
        Assert.Equal("public, max-age=60, stale-while-revalidate=300", site.Headers.NonValidated["Cache-Control"].ToString());
        Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateApiClient().GetAsync(Path)).StatusCode);
    }

    [Theory]
    [InlineData(Roles.Editor)]
    [InlineData(null)]
    public async Task Only_an_admin_may_read_or_change_them(string? role)
    {
        var user = role is null ? await TestAccounts.CreateAsync(_factory.Services) : await TestUsers.CreateAsync(_factory.Services, role);
        var client = role is null ? await TestAccounts.SignedInClientAsync(_factory, user) : await TestUsers.SignedInClientAsync(_factory, user);

        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(Path)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(HttpMethod.Patch, Path, new { tagsEnabled = false }, ifMatch: "\"1\"")).StatusCode);
    }

    [Fact]
    public async Task Saved_tags_reach_the_site_while_they_are_on_and_the_verifications_always_do()
    {
        var admin = await AdminAsync();

        var saved = await SaveAsync(admin, new
        {
            tagsEnabled = true,
            googleAnalyticsIds = new[] { " g-abc123xyz9 ", "G-SECOND1234", "G-ABC123XYZ9", "" },
            googleAdsIds = new[] { "aw-123456789" },
            googleTagManagerId = "gtm-abc1234",
            clarityProjectId = "ABCD1234EF",
            bingUetTagId = "187654321",
            googleSiteVerification = "/google1234567890abcdef.html",
            bingSiteVerification = "0123456789ABCDEF0123456789ABCDEF",
            consentBannerEnabled = true,
        });
        var whileOn = await SiteAsync();
        await SaveAsync(admin, new { tagsEnabled = false });
        var whileOff = await SiteAsync();

        Assert.Equal(["G-ABC123XYZ9", "G-SECOND1234"], Strings(saved.GetProperty("googleAnalyticsIds")));
        Assert.Equal(["AW-123456789"], Strings(saved.GetProperty("googleAdsIds")));
        Assert.Equal("GTM-ABC1234", saved.GetProperty("googleTagManagerId").GetString());
        Assert.Equal("abcd1234ef", saved.GetProperty("clarityProjectId").GetString());
        Assert.Equal("google1234567890abcdef", saved.GetProperty("googleSiteVerification").GetString());

        Assert.Equal(["G-ABC123XYZ9", "G-SECOND1234"], Strings(whileOn.GetProperty("googleAnalyticsIds")));
        Assert.Equal(["AW-123456789"], Strings(whileOn.GetProperty("googleAdsIds")));
        Assert.Equal("GTM-ABC1234", whileOn.GetProperty("googleTagManagerId").GetString());
        Assert.Equal("abcd1234ef", whileOn.GetProperty("clarityProjectId").GetString());
        Assert.Equal("187654321", whileOn.GetProperty("bingUetTagId").GetString());
        Assert.True(whileOn.GetProperty("consentRequired").GetBoolean());

        // The save clears the API's copy, so the site sees the tags go off at once; verifying the site has nothing to do with tracking.
        Assert.Empty(Strings(whileOff.GetProperty("googleAnalyticsIds")));
        Assert.Empty(Strings(whileOff.GetProperty("googleAdsIds")));
        Assert.Equal(JsonValueKind.Null, whileOff.GetProperty("clarityProjectId").ValueKind);
        Assert.False(whileOff.GetProperty("consentRequired").GetBoolean());
        Assert.Equal("google1234567890abcdef", whileOff.GetProperty("googleSiteVerification").GetString());
        Assert.Equal("0123456789ABCDEF0123456789ABCDEF", whileOff.GetProperty("bingSiteVerification").GetString());

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var entries = await db.AuditEntries.AsNoTracking()
            .Where(e => e.Action == "analytics-settings.update")
            .OrderBy(e => e.Id)
            .ToListAsync(TestContext.Current.CancellationToken);
        Assert.Equal(2, entries.Count);
        Assert.All(entries, e => Assert.Equal("analytics-settings", e.TargetType));
        Assert.Contains("clarityProjectId", entries[0].Changes!, StringComparison.Ordinal);
        Assert.DoesNotContain("clarityProjectId", entries[1].Changes!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Only_ids_of_the_right_shape_are_taken()
    {
        var admin = await AdminAsync();
        var wrong = new (string Field, object Body)[]
        {
            ("googleAnalyticsIds", new { googleAnalyticsIds = new[] { "UA-12345-1" } }),
            ("googleAnalyticsIds", new { googleAnalyticsIds = new[] { "G-ABC123\"><script>" } }),
            ("googleAnalyticsIds", new { googleAnalyticsIds = new[] { "G-AAAA1", "G-AAAA2", "G-AAAA3", "G-AAAA4", "G-AAAA5", "G-AAAA6" } }),
            ("googleAdsIds", new { googleAdsIds = new[] { "AW-ABCDEFG" } }),
            ("googleTagManagerId", new { googleTagManagerId = "G-ABC123XYZ9" }),
            ("clarityProjectId", new { clarityProjectId = "abc/../x" }),
            ("bingUetTagId", new { bingUetTagId = "12a45" }),
            ("googleSiteVerification", new { googleSiteVerification = "../../etc/passwd" }),
            ("bingSiteVerification", new { bingSiteVerification = "<user>x</user>" }),
            ("tagsEnabled", new { tagsEnabled = true, bingSiteVerification = "0123456789ABCDEF" }),
            ("gtmContainer", new { gtmContainer = "GTM-ABC1234" }),
        };

        foreach (var (field, body) in wrong)
        {
            var problem = await RefusedAsync(admin, body);
            Assert.True(problem.GetProperty("errors").TryGetProperty(field, out _), field);
        }

        Assert.Empty(Strings((await SiteAsync()).GetProperty("googleAnalyticsIds")));
    }

    [Fact]
    public async Task A_write_needs_the_current_version()
    {
        var admin = await AdminAsync();
        var stale = (await admin.GetAsync(Path)).Headers.ETag!.Tag;
        await SaveAsync(admin, new { googleAnalyticsIds = new[] { "G-ABC123XYZ9" } });

        var conflict = await admin.SendAsync(HttpMethod.Patch, Path, new { tagsEnabled = true }, ifMatch: stale);
        var missing = await admin.SendAsync(HttpMethod.Patch, Path, new { tagsEnabled = true });

        await ProblemAssert.IsProblemAsync(conflict, HttpStatusCode.PreconditionFailed, ProblemAssert.Type("precondition-failed"), Path);
        await ProblemAssert.IsProblemAsync(missing, (HttpStatusCode)428, ProblemAssert.Type("precondition-required"), Path);
    }
}
