using System.Net;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Api.Dependencies;
using Runova.Website.Data;
using Runova.Website.Data.Identity;
using Runova.Website.IntegrationTests.Infrastructure;
using static Runova.Website.IntegrationTests.Infrastructure.TestDependencies;

namespace Runova.Website.IntegrationTests.Dependencies;

/// <summary>The daily check: what it finds, who it tells, and that nobody hears the same news twice.</summary>
public sealed class DependencyCheckJobTests(PostgresFixture postgres) : IAsyncLifetime
{
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 11, 6, 9, 0, 0, TimeSpan.Zero));
    private readonly FakePackageRegistries _registries = new();
    private WebsiteApiFactory _factory = null!;

    // A database of its own: the job checks every inventory that is due, and goes by the fake clock.
    public async ValueTask InitializeAsync()
    {
        _factory = new WebsiteApiFactory(await postgres.CreateDatabaseAsync(), time: _time, services: services =>
        {
            _registries.Register(services);
            services.AddSingleton<CheckSchedule>(new FixedSchedule(_time));
        });
        _registries
            .Has("npm", "lodash", "5.0.0")
            .Has("npm", "express", "4.19.0")
            .Has("npm", "request", "2.88.2", deprecated: "request has been deprecated, see https://github.com/request/request/issues/3142")
            .Has("nuget", "Serilog", "4.0.0")
            .Advisory("GHSA-35jh-r3h4-6jhm", "npm", "lodash", "high", "Command injection in lodash", "4.17.21", "4.17.20");
    }

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    private static object Shop(string lodash = "4.17.20") => Inventory(
        "Shop",
        Package("lodash", lodash),
        Package("express", "4.18.0"),
        Package("request", "2.88.2"),
        Package("Serilog", "4.0.0", "nuget"));

    private AppUser _sam = null!;

    private async Task<(ApiClient Client, long Scope)> SamWithShopAsync()
    {
        var (sam, client) = await AccountAsync(_factory);
        _sam = sam;
        var scope = await PersonalScopeAsync(client);
        await UploadedAsync(client, scope, "p-shop", Shop());
        return (client, scope);
    }

    /// <summary>A day on, the session from before has run out, so Sam signs in again.</summary>
    private Task<ApiClient> NextDayAsync()
    {
        _time.Advance(TimeSpan.FromHours(25));
        return TestAccounts.SignedInClientAsync(_factory, _sam);
    }

    private static async Task<JsonElement> FindingsAsync(ApiClient client) =>
        await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/dependency-findings"), HttpStatusCode.OK);

    private static async Task<JsonElement[]> NotificationsAsync(ApiClient client) =>
        [.. (await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/notifications"), HttpStatusCode.OK)).GetProperty("items").EnumerateArray()];

    private static async Task PatchSettingsAsync(ApiClient client, object patch)
    {
        var current = await client.GetAsync("/api/v1/accounts/me/dependency-alert-settings");
        var changed = await client.SendAsync(HttpMethod.Patch, "/api/v1/accounts/me/dependency-alert-settings", patch, ifMatch: current.Headers.ETag!.Tag);
        Assert.Equal(HttpStatusCode.OK, changed.StatusCode);
    }

    [Fact]
    public async Task The_check_finds_each_kind_and_tells_what_the_defaults_ask_for_in_one_message()
    {
        var (client, _) = await SamWithShopAsync();
        _time.Advance(TimeSpan.FromHours(1));

        await RunChecksAsync(_factory);

        var findings = await FindingsAsync(client);
        var shop = findings.GetProperty("items").EnumerateArray().Single();
        Assert.Equal("Shop", shop.GetProperty("projectName").GetString());
        Assert.Equal("high", shop.GetProperty("worstSeverity").GetString());
        var counts = shop.GetProperty("counts");
        Assert.Equal((1, 1, 1, 0, 0), (counts.GetProperty("security").GetInt32(), counts.GetProperty("deprecated").GetInt32(), counts.GetProperty("major").GetInt32(), counts.GetProperty("minor").GetInt32(), counts.GetProperty("patch").GetInt32()));
        Assert.Equal(3, findings.GetProperty("total").GetInt32());
        var security = shop.GetProperty("findings")[0];
        Assert.Equal(("security", "lodash", "4.17.21", "GHSA-35jh-r3h4-6jhm"), (security.GetProperty("kind").GetString(), security.GetProperty("name").GetString(), security.GetProperty("targetVersion").GetString(), security.GetProperty("advisoryId").GetString()));

        var notification = Assert.Single(await NotificationsAsync(client));
        Assert.Equal("3 package updates for Shop", notification.GetProperty("title").GetString());
        Assert.Equal("high", notification.GetProperty("severity").GetString());
        Assert.Equal("p-shop", notification.GetProperty("itemId").GetString());
        Assert.StartsWith("lodash 4.17.20 to 4.17.21: high security issue", notification.GetProperty("body").GetString(), StringComparison.Ordinal);
        Assert.Null(notification.GetProperty("readAt").GetString());
    }

    [Fact]
    public async Task Python_Rust_Android_and_iOS_packages_are_checked_like_the_rest()
    {
        _registries
            .Has("pypi", "django", "5.1.0")
            .Has("crates", "serde", "2.0.0")
            .Has("maven", "com.google.guava:guava", "33.0.0")
            .Has("swift", "github.com/Alamofire/Alamofire", "6.0.0")
            .Has("pods", "Firebase", "11.0.0")
            .Advisory("GHSA-py", "pypi", "django", "high", "SQL injection in Django", "4.2.0", "4.0.0")
            .Advisory("GHSA-sw", "swift", "github.com/Alamofire/Alamofire", "high", "Bad redirect", "5.9.0", "5.0.0");
        var (_, client) = await AccountAsync(_factory);
        var scope = await PersonalScopeAsync(client);
        await UploadedAsync(client, scope, "p-mobile", Inventory(
            "Mobile",
            Package("Django", "4.0.0", "pypi"),
            Package("serde", "1.0.0", "crates"),
            Package("com.google.guava:guava", "32.0.0", "maven"),
            Package("github.com/Alamofire/Alamofire", "5.0.0", "swift"),
            Package("Firebase", "10.0.0", "pods")));
        _time.Advance(TimeSpan.FromHours(1));

        await RunChecksAsync(_factory);

        var mobile = (await FindingsAsync(client)).GetProperty("items").EnumerateArray().Single();
        var counts = mobile.GetProperty("counts");
        Assert.Equal(2, counts.GetProperty("security").GetInt32());
        Assert.Equal(5, counts.GetProperty("major").GetInt32());
        // The name goes back as it was uploaded, which is what the Packages tab looks it up by.
        var names = mobile.GetProperty("findings").EnumerateArray().Select(f => f.GetProperty("name").GetString()).ToHashSet();
        Assert.Contains("Django", names);
        Assert.Contains("github.com/Alamofire/Alamofire", names);
        Assert.Contains("Firebase", names);
        // OSV has no CocoaPods database, so asking it about a pod would only be refused.
        Assert.DoesNotContain(_registries.OsvEcosystems, e => e == "CocoaPods");
    }

    [Fact]
    public async Task Nothing_is_told_twice_and_the_next_check_is_a_day_later()
    {
        await SamWithShopAsync();
        _time.Advance(TimeSpan.FromHours(1));
        await RunChecksAsync(_factory);
        DateTimeOffset next;
        using (var read = _factory.Services.CreateScope())
        {
            next = (await read.ServiceProvider.GetRequiredService<AppDbContext>().PackageInventories.SingleAsync(TestContext.Current.CancellationToken)).NextCheckAt;
        }

        var client = await NextDayAsync();
        await RunChecksAsync(_factory);

        Assert.Equal(_time.GetUtcNow().AddHours(-25).AddDays(1), next);
        Assert.Single(await NotificationsAsync(client));
    }

    [Fact]
    public async Task A_new_release_of_a_package_is_told_again()
    {
        await SamWithShopAsync();
        _time.Advance(TimeSpan.FromHours(1));
        await RunChecksAsync(_factory);

        _registries.Has("npm", "lodash", "6.0.0");
        var client = await NextDayAsync();
        await RunChecksAsync(_factory);

        var notifications = await NotificationsAsync(client);
        Assert.Equal(2, notifications.Length);
        Assert.Equal("lodash 6.0.0 is out for Shop", notifications[0].GetProperty("title").GetString());
    }

    [Fact]
    public async Task A_check_that_is_not_due_yet_asks_nothing()
    {
        await SamWithShopAsync();

        await RunChecksAsync(_factory);

        Assert.Empty(_registries.Requests);
    }

    [Fact]
    public async Task The_security_threshold_and_each_kind_follow_the_settings()
    {
        var (client, _) = await SamWithShopAsync();
        await PatchSettingsAsync(client, new { securityMinSeverity = "critical", deprecated = false, minor = true });
        _time.Advance(TimeSpan.FromHours(1));

        await RunChecksAsync(_factory);

        var shop = (await FindingsAsync(client)).GetProperty("items")[0];
        Assert.Equal(["major", "minor"], shop.GetProperty("findings").EnumerateArray().Select(f => f.GetProperty("kind").GetString()).Order());
        Assert.Equal("2 package updates for Shop", Assert.Single(await NotificationsAsync(client)).GetProperty("title").GetString());
    }

    [Fact]
    public async Task A_muted_project_is_found_but_never_told()
    {
        var (client, _) = await SamWithShopAsync();
        var inventory = (await FindingsAsync(client)).GetProperty("items")[0].GetProperty("inventoryId").GetInt64();
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(HttpMethod.Put, $"/api/v1/accounts/me/muted-projects/{inventory}")).StatusCode);
        _time.Advance(TimeSpan.FromHours(1));

        await RunChecksAsync(_factory);

        Assert.Empty(await NotificationsAsync(client));
        var shop = (await FindingsAsync(client)).GetProperty("items")[0];
        Assert.True(shop.GetProperty("muted").GetBoolean());
        Assert.Equal(0, shop.GetProperty("total").GetInt32());
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(HttpMethod.Delete, $"/api/v1/accounts/me/muted-projects/{inventory}")).StatusCode);
        Assert.Equal(3, (await FindingsAsync(client)).GetProperty("total").GetInt32());
    }

    [Fact]
    public async Task Turning_alerts_off_drops_the_accounts_own_packages_and_tells_nothing()
    {
        var (client, _) = await SamWithShopAsync();

        await PatchSettingsAsync(client, new { enabled = false });
        _time.Advance(TimeSpan.FromHours(1));
        await RunChecksAsync(_factory);

        var findings = await FindingsAsync(client);
        Assert.False(findings.GetProperty("enabled").GetBoolean());
        Assert.Empty(await NotificationsAsync(client));
        using var check = _factory.Services.CreateScope();
        Assert.False(await check.ServiceProvider.GetRequiredService<AppDbContext>().PackageInventories.AnyAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task An_update_that_fixes_the_advisory_clears_its_finding()
    {
        var (client, scope) = await SamWithShopAsync();
        _time.Advance(TimeSpan.FromHours(1));
        await RunChecksAsync(_factory);

        await UploadedAsync(client, scope, "p-shop", Shop(lodash: "4.17.21"));
        _time.Advance(TimeSpan.FromHours(1));
        await RunChecksAsync(_factory);

        var kinds = (await FindingsAsync(client)).GetProperty("items")[0].GetProperty("findings").EnumerateArray().Select(f => f.GetProperty("kind").GetString());
        Assert.DoesNotContain("security", kinds);
    }

    [Fact]
    public async Task A_registry_that_is_down_keeps_what_it_said_last()
    {
        await SamWithShopAsync();
        _time.Advance(TimeSpan.FromHours(1));
        await RunChecksAsync(_factory);

        _registries.IsDown("npm");
        _registries.IsDown("osv");
        var client = await NextDayAsync();
        await RunChecksAsync(_factory);

        Assert.Equal(3, (await FindingsAsync(client)).GetProperty("total").GetInt32());
        Assert.Single(await NotificationsAsync(client));
    }

    [Fact]
    public async Task A_package_many_projects_use_is_asked_about_once()
    {
        var (client, scope) = await SamWithShopAsync();
        await UploadedAsync(client, scope, "p-blog", Inventory("Blog", Package("lodash", "4.17.20")));
        _time.Advance(TimeSpan.FromHours(1));

        await RunChecksAsync(_factory);

        Assert.Equal(1, _registries.Requests.Count(r => r == "npm GET /lodash"));
        Assert.Equal(2, (await NotificationsAsync(client)).Length);
    }
}
