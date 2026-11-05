using System.Net;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Core.Audit;
using Runova.Website.Core.Identity;
using Runova.Website.Data;
using Runova.Website.Data.Identity;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Identity;

// Each test gets a database of its own: the Admin is found by email, and some tests restart the API on it.
public sealed class AdminFromSettingsTests(PostgresFixture postgres)
{
    private const string Email = "owner@runovahq.com";
    private const string Password = "a long admin password";

    [Fact]
    public async Task The_first_start_makes_the_admin_from_the_settings()
    {
        using var factory = Factory(await postgres.CreateDatabaseAsync(), Password, "Olive Owner");

        var signIn = await factory.CreateApiClient().SignInAsync(Email, Password);

        Assert.Equal(HttpStatusCode.NoContent, signIn.StatusCode);
        using var scope = factory.Services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
        var admin = await users.FindByEmailAsync(Email);
        Assert.NotNull(admin);
        Assert.Equal("Olive Owner", admin.DisplayName);
        Assert.True(admin.EmailConfirmed);
        Assert.Equal([Roles.Admin], await users.GetRolesAsync(admin));
        var entry = Assert.Single(await AuditAsync(factory));
        Assert.Equal((AuditActorKinds.System, AuditActions.UserInvite), (entry.ActorKind, entry.Action));
    }

    [Fact]
    public async Task The_name_is_Admin_when_the_settings_give_none()
    {
        using var factory = Factory(await postgres.CreateDatabaseAsync(), Password);

        var admin = await FindAsync(factory);

        Assert.Equal("Admin", admin.DisplayName);
    }

    [Theory]
    [InlineData("", Password)]
    [InlineData(Email, "")]
    public async Task Nothing_is_made_when_the_email_or_password_is_empty(string email, string password)
    {
        using var factory = new WebsiteApiFactory(
            await postgres.CreateDatabaseAsync(),
            settings: new Dictionary<string, string> { ["Admin:Email"] = email, ["Admin:Password"] = password });

        using var scope = factory.Services.CreateScope();

        Assert.Empty(await scope.ServiceProvider.GetRequiredService<AppDbContext>().Users.ToListAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task A_password_the_rules_refuse_makes_nothing_and_the_api_still_starts()
    {
        using var factory = Factory(await postgres.CreateDatabaseAsync(), "too short");

        var health = await factory.CreateApiClient().GetAsync("/health/live");

        Assert.Equal(HttpStatusCode.OK, health.StatusCode);
        using var scope = factory.Services.CreateScope();
        Assert.Null(await scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>().FindByEmailAsync(Email));
    }

    [Fact]
    public async Task A_restart_with_the_same_settings_changes_nothing()
    {
        var database = await postgres.CreateDatabaseAsync();
        string stamp;
        using (var first = Factory(database, Password))
        {
            stamp = (await FindAsync(first)).SecurityStamp!;
        }

        using var second = Factory(database, Password);

        Assert.Equal(stamp, (await FindAsync(second)).SecurityStamp);
        Assert.Single(await AuditAsync(second));
    }

    [Fact]
    public async Task A_new_password_in_the_settings_replaces_the_old_one_on_restart()
    {
        var database = await postgres.CreateDatabaseAsync();
        using (var first = Factory(database, Password))
        {
            await FindAsync(first);
        }

        using var second = Factory(database, "a brand new admin password");
        var client = second.CreateApiClient();

        Assert.Equal(HttpStatusCode.NoContent, (await second.CreateApiClient().SignInAsync(Email, "a brand new admin password")).StatusCode);
        Assert.NotEqual(HttpStatusCode.NoContent, (await client.SignInAsync(Email, Password)).StatusCode);
        Assert.Contains(await AuditAsync(second), e => e.Action == AuditActions.UserPasswordReset && e.ActorKind == AuditActorKinds.System);
    }

    [Fact]
    public async Task An_existing_account_with_the_email_becomes_an_admin_with_the_password()
    {
        var database = await postgres.CreateDatabaseAsync();
        long id;
        using (var before = new WebsiteApiFactory(database))
        {
            var account = await CreateAccountAsync(before, TestAccounts.Password);
            id = account.Id;
        }

        using var factory = Factory(database, Password);

        Assert.Equal(HttpStatusCode.NoContent, (await factory.CreateApiClient().SignInAsync(Email, Password)).StatusCode);
        using var scope = factory.Services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
        var admin = await users.FindByEmailAsync(Email);
        Assert.Equal(id, admin!.Id);
        Assert.Equal([Roles.Admin], await users.GetRolesAsync(admin));
        Assert.Equal(
            [AuditActions.UserUpdate, AuditActions.UserPasswordReset],
            (await AuditAsync(factory)).Select(e => e.Action));
    }

    [Fact]
    public async Task A_disabled_admin_stays_disabled()
    {
        var database = await postgres.CreateDatabaseAsync();
        using (var first = Factory(database, Password))
        {
            var admin = await FindAsync(first);
            using var scope = first.Services.CreateScope();
            var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
            var stored = (await users.FindByIdAsync(admin.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)))!;
            stored.DisabledAt = DateTimeOffset.UtcNow;
            Assert.True((await users.UpdateAsync(stored)).Succeeded);
        }

        using var second = Factory(database, Password);

        Assert.NotNull((await FindAsync(second)).DisabledAt);
    }

    private static WebsiteApiFactory Factory(string database, string password, string? name = null)
    {
        var settings = new Dictionary<string, string> { ["Admin:Email"] = Email, ["Admin:Password"] = password };
        if (name is not null)
        {
            settings["Admin:DisplayName"] = name;
        }

        return new WebsiteApiFactory(database, settings: settings);
    }

    private static async Task<AppUser> FindAsync(WebsiteApiFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        var user = await scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>().FindByEmailAsync(Email);
        Assert.NotNull(user);
        return user;
    }

    private static async Task<AppUser> CreateAccountAsync(WebsiteApiFactory factory, string password)
    {
        using var scope = factory.Services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
        var user = new AppUser { UserName = Email, Email = Email, EmailConfirmed = true, DisplayName = "Sam Account", CreatedAt = DateTimeOffset.UtcNow };
        Assert.True((await users.CreateAsync(user, password)).Succeeded);
        return user;
    }

    private static async Task<List<Data.Audit.AuditEntry>> AuditAsync(WebsiteApiFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<AppDbContext>().AuditEntries
            .OrderBy(e => e.Id).ToListAsync(TestContext.Current.CancellationToken);
    }
}
