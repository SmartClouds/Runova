using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Accounts;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Dependencies;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Dependencies;

namespace Runova.Website.Api.Dependencies;

public sealed record InventoryPackageRequest(string? Ecosystem, string? Name, string? Version, bool Dev);

public sealed record InventoryRequest(string? ProjectName, IReadOnlyList<InventoryPackageRequest>? Packages);

public sealed record PackageInventoryDto(
    long Id,
    long ScopeId,
    string ItemId,
    string ProjectName,
    int PackageCount,
    DateTimeOffset UploadedAt,
    DateTimeOffset? LastCheckedAt);

/// <summary>
/// A project's packages, uploaded by the desktop app into the sync scope the project lives in
/// (E51). Whoever may write the scope may upload; the same upload again changes nothing.
/// </summary>
internal static partial class InventoryEndpoints
{
    public const int MaxPackages = 5000;
    public const int ProjectNameMax = 200;

    [GeneratedRegex("^[A-Za-z0-9_.:-]{1,64}$", RegexOptions.CultureInvariant)]
    private static partial Regex ItemId();

    // npm (@scope/name), NuGet (Dotted.Names) and pub (snake_case) names.
    [GeneratedRegex("^[A-Za-z0-9@][A-Za-z0-9@/._~-]{0,213}$", RegexOptions.CultureInvariant)]
    private static partial Regex PackageName();

    public static RouteGroupBuilder MapPackageInventories(this RouteGroupBuilder api)
    {
        var inventories = api.MapGroup("/sync-scopes/{scopeId:long}/package-inventories").RequireAuthorization(Policies.Account);
        inventories.MapPut("/{itemId}", PutAsync);
        inventories.MapDelete("/{itemId}", DeleteAsync);
        return api;
    }

    private static ProblemHttpResult NotFound() => ApiProblems.Of(ProblemTypes.NotFound, "There is no such sync scope or project for this account.");

    private static ProblemHttpResult ReadOnly() => ApiProblems.Of(ProblemTypes.Forbidden, "A Viewer can read the team's items but not change them.");

    private static async Task<Results<Created<PackageInventoryDto>, Ok<PackageInventoryDto>, ValidationProblem, ProblemHttpResult>> PutAsync(
        long scopeId,
        string itemId,
        InventoryRequest request,
        HttpContext http,
        SyncAccess access,
        AlertSettingsStore settings,
        AppDbContext db,
        CheckSchedule schedule,
        TimeProvider time)
    {
        var userId = CurrentAccount.Id(http);
        if (await access.FindAsync(userId, scopeId) is not { } found)
        {
            return NotFound();
        }

        if (!found.CanWrite)
        {
            return ReadOnly();
        }

        var errors = new Dictionary<string, string[]>();
        if (!ItemId().IsMatch(itemId))
        {
            errors["itemId"] = ["An item id is 1 to 64 letters, digits, dots, colons, dashes or underscores."];
        }

        var projectName = request.ProjectName?.Trim() ?? "";
        if (projectName.Length is 0 or > ProjectNameMax)
        {
            errors["projectName"] = [$"Name the project, up to {ProjectNameMax} characters."];
        }

        var packages = request.Packages ?? [];
        if (packages.Count > MaxPackages)
        {
            errors["packages"] = [$"Send up to {MaxPackages} packages."];
        }

        for (var i = 0; i < packages.Count && errors.Count < 20; i++)
        {
            var p = packages[i];
            if (p.Ecosystem is null || !Ecosystems.All.Contains(p.Ecosystem))
            {
                errors[$"packages[{i}].ecosystem"] = ["The ecosystem is npm, nuget or pub."];
            }

            if (p.Name is null || !PackageName().IsMatch(p.Name))
            {
                errors[$"packages[{i}].name"] = ["A package name is 1 to 214 letters, digits and @ / . _ ~ -."];
            }

            if (string.IsNullOrWhiteSpace(p.Version) || p.Version.Length > 100 || p.Version.Any(char.IsControl))
            {
                errors[$"packages[{i}].version"] = ["A version is 1 to 100 characters."];
            }
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        if (!await settings.IsEnabledAsync(userId))
        {
            return ApiProblems.Of(ProblemTypes.Conflict, "Dependency alerts are turned off for this account. Turn them on to upload packages.");
        }

        var rows = packages
            .Select(p => new InventoryPackage { Ecosystem = p.Ecosystem!, Name = p.Name!.Trim(), Version = p.Version!.Trim(), Dev = p.Dev })
            .DistinctBy(p => (p.Ecosystem, p.Name.ToLowerInvariant()))
            .ToList();
        var hash = Hash(projectName, rows);
        var now = time.GetUtcNow();

        var inventory = await db.PackageInventories.SingleOrDefaultAsync(i => i.ScopeId == scopeId && i.ItemId == itemId);
        var created = inventory is null;
        if (inventory is null)
        {
            inventory = new PackageInventory { ScopeId = scopeId, ItemId = itemId };
            db.PackageInventories.Add(inventory);
        }
        else if (inventory.ContentHash == hash)
        {
            return TypedResults.Ok(ToDto(inventory, rows.Count));
        }

        await using var transaction = await db.Database.BeginTransactionAsync();
        inventory.ProjectName = projectName;
        inventory.UploadedBy = userId;
        inventory.UploadedAt = now;
        inventory.ContentHash = hash;
        inventory.NextCheckAt = schedule.First();
        await db.SaveChangesAsync();
        await db.InventoryPackages.Where(p => p.InventoryId == inventory.Id).ExecuteDeleteAsync();
        foreach (var row in rows)
        {
            row.InventoryId = inventory.Id;
        }

        db.InventoryPackages.AddRange(rows);
        await db.SaveChangesAsync();
        await transaction.CommitAsync();

        var dto = ToDto(inventory, rows.Count);
        return created ? TypedResults.Created((string?)null, dto) : TypedResults.Ok(dto);
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> DeleteAsync(
        long scopeId, string itemId, HttpContext http, SyncAccess access, AppDbContext db)
    {
        if (await access.FindAsync(CurrentAccount.Id(http), scopeId) is not { } found)
        {
            return NotFound();
        }

        if (!found.CanWrite)
        {
            return ReadOnly();
        }

        var deleted = await db.PackageInventories.Where(i => i.ScopeId == scopeId && i.ItemId == itemId).ExecuteDeleteAsync();
        return deleted == 0 ? NotFound() : TypedResults.NoContent();
    }

    internal static PackageInventoryDto ToDto(PackageInventory inventory, int packageCount) =>
        new(inventory.Id, inventory.ScopeId, inventory.ItemId, inventory.ProjectName, packageCount, inventory.UploadedAt, inventory.LastCheckedAt);

    private static string Hash(string projectName, IEnumerable<InventoryPackage> packages)
    {
        var text = new StringBuilder(projectName).Append('\n');
        foreach (var line in packages.Select(p => $"{p.Ecosystem}|{p.Name}|{p.Version}|{(p.Dev ? 1 : 0)}").Order(StringComparer.Ordinal))
        {
            text.Append(line).Append('\n');
        }

        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text.ToString())));
    }
}
