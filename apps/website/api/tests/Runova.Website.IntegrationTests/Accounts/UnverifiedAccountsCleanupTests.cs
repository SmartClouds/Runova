using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Api.Accounts;
using Runova.Website.Core.Identity;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

public sealed class UnverifiedAccountsCleanupTests(PostgresFixture postgres) : IDisposable
{
    private readonly WebsiteApiFactory _factory = new(postgres.ConnectionString);

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task An_account_never_confirmed_goes_after_a_week_and_others_stay()
    {
        var stale = await TestAccounts.CreateAsync(_factory.Services, emailConfirmed: false);
        var fresh = await TestAccounts.CreateAsync(_factory.Services, emailConfirmed: false);
        var confirmed = await TestAccounts.CreateAsync(_factory.Services);
        var invitedEditor = await TestUsers.CreateAsync(_factory.Services, Roles.Editor);
        await AgeAsync(stale.Id, invitedEditor.Id, confirmed.Id);

        using (var scope = _factory.Services.CreateScope())
        {
            await scope.ServiceProvider.GetRequiredService<UnverifiedAccountsCleanupJob>().RunAsync(TestContext.Current.CancellationToken);
        }

        Assert.Null(await TestAccounts.FindAsync(_factory.Services, stale.Email!));
        Assert.NotNull(await TestAccounts.FindAsync(_factory.Services, fresh.Email!));
        Assert.NotNull(await TestAccounts.FindAsync(_factory.Services, confirmed.Email!));
        Assert.NotNull(await TestAccounts.FindAsync(_factory.Services, invitedEditor.Email!));
    }

    private async Task AgeAsync(params long[] ids)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<Data.AppDbContext>();
        foreach (var user in db.Users.Where(u => ids.Contains(u.Id)))
        {
            user.CreatedAt = DateTimeOffset.UtcNow.AddDays(-8);
            if (user.Id == ids[1])
            {
                user.EmailConfirmed = false;
            }
        }

        await db.SaveChangesAsync(TestContext.Current.CancellationToken);
    }
}
