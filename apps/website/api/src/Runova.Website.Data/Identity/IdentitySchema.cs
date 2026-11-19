using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Runova.Website.Data.Identity;

/// <summary>
/// Identity's schema version 3, which adds the passkeys table (E115). Identity reads the version
/// from <see cref="IdentityOptions"/> in the application's services when it builds the model, so
/// a context made outside the site (<c>dotnet ef</c>, the test fixtures) is handed a small
/// provider that says the same thing, or it would build the model without passkeys.
/// </summary>
public static class IdentitySchema
{
    public static readonly Version Version = IdentitySchemaVersions.Version3;

    private static readonly IServiceProvider _services = new ServiceCollection()
        .Configure<IdentityOptions>(UseVersion)
        .BuildServiceProvider();

    public static void UseVersion(IdentityOptions options) => options.Stores.SchemaVersion = Version;

    /// <summary>Options for a context made by hand rather than by the site's services.</summary>
    public static DbContextOptionsBuilder<AppDbContext> WithIdentitySchema(this DbContextOptionsBuilder<AppDbContext> options) =>
        options.UseApplicationServiceProvider(_services);
}
