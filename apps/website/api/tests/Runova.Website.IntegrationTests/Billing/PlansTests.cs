using System.Net;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Api.Billing;
using Runova.Website.Core.Billing;
using Runova.Website.Core.Identity;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Billing;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Billing;

/// <summary>Which type an account and a scope get (E53), what an Admin can give, and when it ends.</summary>
public sealed class PlansTests(PostgresFixture postgres) : IAsyncLifetime
{
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 11, 6, 9, 0, 0, TimeSpan.Zero));
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync() => _factory = new(await postgres.CreateDatabaseAsync(), time: _time);

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    private async Task<ApiClient> AdminAsync() => await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Admin));

    private static Task<HttpResponseMessage> GrantAsync(ApiClient admin, long userId, long typeId, DateTimeOffset? endsAt = null) =>
        admin.SendAsync(HttpMethod.Put, $"/api/v1/users/{userId}/subscriptions/current", new { accountTypeId = typeId, endsAt });

    private async Task<T> InScopeAsync<T>(Func<IServiceProvider, Task<T>> run)
    {
        using var scope = _factory.Services.CreateScope();
        return await run(scope.ServiceProvider);
    }

    [Fact]
    public async Task An_account_with_nothing_is_on_free()
    {
        var account = await TestAccounts.SignedInClientAsync(_factory, await TestAccounts.CreateAsync(_factory.Services));

        var plan = await TestBilling.PlanAsync(account);

        Assert.Equal("free", plan.GetProperty("accountType").GetProperty("key").GetString());
        Assert.Equal(JsonValueKind.Null, plan.GetProperty("subscription").ValueKind);
        Assert.False(plan.GetProperty("cardPayments").GetBoolean());
        Assert.False(plan.GetProperty("cryptoPayments").GetBoolean());
    }

    [Fact]
    public async Task An_admin_gives_a_type_until_a_day_and_it_ends_then()
    {
        var admin = await AdminAsync();
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var account = await TestAccounts.SignedInClientAsync(_factory, user);

        var granted = await ApiClient.ReadJsonAsync(await GrantAsync(admin, user.Id, TestBilling.ProId, _time.GetUtcNow().AddDays(10)), HttpStatusCode.OK);
        Assert.Equal("pro", granted.GetProperty("accountType").GetProperty("key").GetString());
        Assert.Equal("pro", await TestBilling.PlanKeyAsync(account));
        Assert.Equal("manual", (await TestBilling.PlanAsync(account)).GetProperty("subscription").GetProperty("provider").GetString());

        _time.Advance(TimeSpan.FromDays(10) + TimeSpan.FromMinutes(1));
        await InScopeAsync(async s =>
        {
            await s.GetRequiredService<SubscriptionExpiryJob>().RunAsync(TestContext.Current.CancellationToken);
            return 0;
        });

        var after = await InScopeAsync(async s =>
        {
            var db = s.GetRequiredService<AppDbContext>();
            var subscription = await db.Subscriptions.AsNoTracking().SingleAsync(x => x.UserId == user.Id, TestContext.Current.CancellationToken);
            var notice = await db.UserNotifications.AsNoTracking().Where(n => n.UserId == user.Id && n.Kind == BillingNotices.Kind).OrderBy(n => n.Id).LastAsync(TestContext.Current.CancellationToken);
            return (subscription.Status, notice.Title);
        });
        Assert.Equal(SubscriptionStatuses.Expired, after.Status);
        Assert.Equal("Your plan ended", after.Title);
    }

    [Fact]
    public async Task A_second_grant_replaces_the_first_and_removing_it_goes_back_to_free()
    {
        var admin = await AdminAsync();
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var account = await TestAccounts.SignedInClientAsync(_factory, user);

        await ApiClient.ReadJsonAsync(await GrantAsync(admin, user.Id, TestBilling.GoId), HttpStatusCode.OK);
        await ApiClient.ReadJsonAsync(await GrantAsync(admin, user.Id, TestBilling.UltraId), HttpStatusCode.OK);
        Assert.Equal("ultra", await TestBilling.PlanKeyAsync(account));

        Assert.Equal(HttpStatusCode.NoContent, (await admin.SendAsync(HttpMethod.Delete, $"/api/v1/users/{user.Id}/subscriptions/current")).StatusCode);
        Assert.Equal("free", await TestBilling.PlanKeyAsync(account));
        Assert.Equal(HttpStatusCode.NotFound, (await admin.SendAsync(HttpMethod.Delete, $"/api/v1/users/{user.Id}/subscriptions/current")).StatusCode);

        var actions = await InScopeAsync(s => s.GetRequiredService<AppDbContext>().AuditEntries.Where(e => e.TargetType == "subscription").Select(e => e.Action).ToListAsync(TestContext.Current.CancellationToken));
        Assert.Equal(["subscription.assign", "subscription.assign", "subscription.remove"], actions.Order());
    }

    [Fact]
    public async Task A_grant_needs_a_paid_type_and_a_future_end()
    {
        var admin = await AdminAsync();
        var user = await TestAccounts.CreateAsync(_factory.Services);

        var free = await GrantAsync(admin, user.Id, 1);
        var past = await GrantAsync(admin, user.Id, TestBilling.GoId, _time.GetUtcNow().AddDays(-1));
        var nobody = await GrantAsync(admin, 999_999, TestBilling.GoId);

        Assert.Equal(HttpStatusCode.BadRequest, free.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, past.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, nobody.StatusCode);
    }

    [Fact]
    public async Task A_team_scope_gets_the_best_type_of_its_owners_not_its_members()
    {
        var admin = await AdminAsync();
        var owner = await TestAccounts.CreateAsync(_factory.Services);
        var member = await TestAccounts.CreateAsync(_factory.Services);
        await ApiClient.ReadJsonAsync(await GrantAsync(admin, member.Id, TestBilling.UltraId), HttpStatusCode.OK);
        var scopeId = await InScopeAsync(async s =>
        {
            var db = s.GetRequiredService<AppDbContext>();
            var team = new Team { Name = "Agency", CreatedAt = _time.GetUtcNow(), CreatedBy = owner.Id };
            db.Teams.Add(team);
            await db.SaveChangesAsync(TestContext.Current.CancellationToken);
            db.TeamMembers.Add(new TeamMember { TeamId = team.Id, UserId = owner.Id, Role = TeamRoles.Owner, JoinedAt = _time.GetUtcNow() });
            db.TeamMembers.Add(new TeamMember { TeamId = team.Id, UserId = member.Id, Role = TeamRoles.Admin, JoinedAt = _time.GetUtcNow() });
            var scope = new SyncScope { Kind = SyncScopeKinds.Team, TeamId = team.Id, CreatedAt = _time.GetUtcNow() };
            db.SyncScopes.Add(scope);
            await db.SaveChangesAsync(TestContext.Current.CancellationToken);
            return scope.Id;
        });

        var before = await InScopeAsync(s => s.GetRequiredService<Entitlements>().ForScopeAsync(scopeId, TestContext.Current.CancellationToken));
        await ApiClient.ReadJsonAsync(await GrantAsync(admin, owner.Id, TestBilling.ProId), HttpStatusCode.OK);
        var after = await InScopeAsync(s => s.GetRequiredService<Entitlements>().ForScopeAsync(scopeId, TestContext.Current.CancellationToken));

        Assert.Equal("free", before.Key);
        Assert.Equal("pro", after.Key);
        Assert.Equal(50, after.MaxCloudMonitors);
    }

    [Fact]
    public async Task A_prepaid_plan_is_reminded_a_week_and_a_day_before_it_ends_once_each()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        await InScopeAsync(async s =>
        {
            var db = s.GetRequiredService<AppDbContext>();
            db.Subscriptions.Add(new Subscription
            {
                UserId = user.Id,
                AccountTypeId = TestBilling.GoId,
                Provider = BillingProviders.NowPayments,
                Status = SubscriptionStatuses.Active,
                StartedAt = _time.GetUtcNow(),
                CurrentPeriodEnd = _time.GetUtcNow().AddDays(6),
            });
            return await db.SaveChangesAsync(TestContext.Current.CancellationToken);
        });

        async Task<List<string>> RunAsync()
        {
            await InScopeAsync(async s =>
            {
                await s.GetRequiredService<RenewalReminderJob>().RunAsync(TestContext.Current.CancellationToken);
                return 0;
            });
            return await InScopeAsync(s => s.GetRequiredService<AppDbContext>().UserNotifications
                .Where(n => n.UserId == user.Id).OrderBy(n => n.Id).Select(n => n.Title).ToListAsync(TestContext.Current.CancellationToken));
        }

        Assert.Equal(["Your Go plan ends in a week"], await RunAsync());
        Assert.Equal(["Your Go plan ends in a week"], await RunAsync());
        _time.Advance(TimeSpan.FromDays(5.5));
        Assert.Equal(["Your Go plan ends in a week", "Your Go plan ends tomorrow"], await RunAsync());
        Assert.Equal(2, (await RunAsync()).Count);

        var emails = await TestAccounts.EmailsToAsync(_factory.Services, user.Email!);
        Assert.Equal(2, emails.Count(e => e.Kind == "plan-ending"));
    }
}
