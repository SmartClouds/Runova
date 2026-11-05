using System.Globalization;
using System.Net;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Data;
using Runova.Website.Data.Email;
using Runova.Website.Data.Identity;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>Runova accounts (users with no staff role) and the emails the API queues for them.</summary>
internal static partial class TestAccounts
{
    public const string Password = TestUsers.Password;

    public static string NewEmail() => $"{Guid.NewGuid():N}@example.test";

    /// <summary>A verified account with <see cref="Password"/>, made straight through Identity.</summary>
    public static async Task<AppUser> CreateAsync(IServiceProvider services, string? displayName = null, bool emailConfirmed = true)
    {
        using var scope = services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
        var email = NewEmail();
        var user = new AppUser
        {
            UserName = email,
            Email = email,
            EmailConfirmed = emailConfirmed,
            DisplayName = displayName ?? "Sam Account",
            CreatedAt = DateTimeOffset.UtcNow,
        };
        var result = await users.CreateAsync(user, Password);
        Assert.True(result.Succeeded, string.Join("; ", result.Errors.Select(e => e.Description)));
        return user;
    }

    /// <summary>A client signed in as the account.</summary>
    public static async Task<ApiClient> SignedInClientAsync(WebsiteApiFactory factory, AppUser user, string password = Password)
    {
        var client = factory.CreateApiClient();
        var response = await client.SignInAsync(user.Email!, password);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        return client;
    }

    public static async Task<AppUser?> FindAsync(IServiceProvider services, string email)
    {
        using var scope = services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
        return await users.FindByEmailAsync(email);
    }

    public static async Task<AppUser> ReloadAsync(IServiceProvider services, long id)
    {
        using var scope = services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
        return (await users.FindByIdAsync(id.ToString(CultureInfo.InvariantCulture)))!;
    }

    /// <summary>Every email queued for an address, oldest first.</summary>
    public static async Task<IReadOnlyList<EmailMessage>> EmailsToAsync(IServiceProvider services, string to)
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return await db.EmailMessages.AsNoTracking().Where(m => m.To == to).OrderBy(m => m.Id).ToListAsync(TestContext.Current.CancellationToken);
    }

    /// <summary>The newest email to an address, which the test expects to be there.</summary>
    public static async Task<EmailMessage> LatestEmailAsync(IServiceProvider services, string to)
    {
        var emails = await EmailsToAsync(services, to);
        Assert.NotEmpty(emails);
        return emails[^1];
    }

    /// <summary>The token in the newest email's link to <paramref name="path"/>.</summary>
    public static async Task<string> TokenFromLatestEmailAsync(IServiceProvider services, string to, string path)
    {
        var email = await LatestEmailAsync(services, to);
        var match = Regex.Match(email.TextBody ?? "", Regex.Escape(path) + "#token=([A-Za-z0-9_-]+)");
        Assert.True(match.Success, $"No {path} link in: {email.TextBody}");
        return match.Groups[1].Value;
    }

    /// <summary>Registers an account through the API and returns the email it was registered with.</summary>
    public static async Task<HttpResponseMessage> RegisterAsync(ApiClient client, string email, string password = Password, string displayName = "Sam Account")
    {
        await client.RefreshAntiforgeryTokenAsync();
        return await client.SendAsync(HttpMethod.Post, "/api/v1/accounts", new { email, password, displayName });
    }
}
