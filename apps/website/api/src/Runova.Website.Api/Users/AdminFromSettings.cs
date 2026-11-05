using Microsoft.AspNetCore.Identity;
using Runova.Website.Api.Audit;
using Runova.Website.Core.Audit;
using Runova.Website.Core.Identity;
using Runova.Website.Data;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Users;

/// <summary>
/// The Admin named in the settings (<c>Admin__Email</c> and <c>Admin__Password</c>, which compose
/// fills from <c>ADMIN_EMAIL</c> and <c>ADMIN_PASSWORD</c> in the env file). On every start, after
/// the migrations, the account is made when it is missing, given the Admin role when it lost it,
/// and given the password from the settings when that is no longer its password. So the env file
/// stays the one place that password lives, and changing it there and restarting is how it changes.
/// Nothing happens when either setting is empty. A disabled account stays disabled: an Admin who
/// turned it off on the site meant it.
/// </summary>
internal sealed partial class AdminFromSettings(IServiceProvider services, IConfiguration configuration, ILogger<AdminFromSettings> logger)
    : IHostedLifecycleService
{
    public const string DefaultDisplayName = "Admin";

    public async Task StartingAsync(CancellationToken cancellationToken)
    {
        var email = configuration["Admin:Email"]?.Trim();
        var password = configuration["Admin:Password"];
        if (string.IsNullOrEmpty(email) || string.IsNullOrEmpty(password))
        {
            return;
        }

        var displayName = configuration["Admin:DisplayName"]?.Trim() is { Length: > 0 } name ? name : DefaultDisplayName;
        using var scope = services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var audit = scope.ServiceProvider.GetRequiredService<AuditLog>();

        // A bad password in the env file is logged, not thrown: the public site still starts.
        foreach (var validator in users.PasswordValidators)
        {
            var valid = await validator.ValidateAsync(users, new AppUser(), password);
            if (!valid.Succeeded)
            {
                LogBadPassword(logger, email, string.Join(" ", valid.Errors.Select(e => e.Description)));
                return;
            }
        }

        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        var user = await users.FindByEmailAsync(email);
        if (user is null)
        {
            user = new AppUser
            {
                UserName = email,
                Email = email,
                EmailConfirmed = true,
                DisplayName = displayName,
                CreatedAt = scope.ServiceProvider.GetRequiredService<TimeProvider>().GetUtcNow(),
            };
            Succeeded(await users.CreateAsync(user, password));
            Succeeded(await users.AddToRoleAsync(user, Roles.Admin));
            audit.AddBySystem(AuditActions.UserInvite, AuditTargetTypes.User, user.Id, new { email, displayName, roles = new[] { Roles.Admin }, from = "settings" });
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            LogCreated(logger, email);
            return;
        }

        if (!await users.IsInRoleAsync(user, Roles.Admin))
        {
            Succeeded(await users.AddToRoleAsync(user, Roles.Admin));
            audit.AddBySystem(AuditActions.UserUpdate, AuditTargetTypes.User, user.Id, new { roles = await users.GetRolesAsync(user), from = "settings" });
            LogRoleGiven(logger, email);
        }

        if (!await users.CheckPasswordAsync(user, password))
        {
            // Setting a password changes the security stamp, which ends the account's sessions.
            if (await users.HasPasswordAsync(user))
            {
                Succeeded(await users.RemovePasswordAsync(user));
            }

            Succeeded(await users.AddPasswordAsync(user, password));
            if (!user.EmailConfirmed)
            {
                user.EmailConfirmed = true;
                Succeeded(await users.UpdateAsync(user));
            }

            audit.AddBySystem(AuditActions.UserPasswordReset, AuditTargetTypes.User, user.Id, new { from = "settings" });
            LogPasswordSet(logger, email);
        }

        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StartedAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StoppingAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StoppedAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    [LoggerMessage(Level = LogLevel.Error, Message = "ADMIN_PASSWORD is not a valid password, so the Admin {Email} was left as it is: {Errors}")]
    private static partial void LogBadPassword(ILogger logger, string email, string errors);

    [LoggerMessage(Level = LogLevel.Information, Message = "Created the Admin {Email} from the settings")]
    private static partial void LogCreated(ILogger logger, string email);

    [LoggerMessage(Level = LogLevel.Information, Message = "Gave {Email} the Admin role from the settings")]
    private static partial void LogRoleGiven(ILogger logger, string email);

    [LoggerMessage(Level = LogLevel.Information, Message = "Set the password of the Admin {Email} from the settings")]
    private static partial void LogPasswordSet(ILogger logger, string email);

    private static void Succeeded(IdentityResult result)
    {
        if (!result.Succeeded)
        {
            throw new InvalidOperationException(
                "Could not set up the Admin from the settings: " + string.Join(" ", result.Errors.Select(e => e.Description)));
        }
    }
}
