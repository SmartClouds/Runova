using System.Globalization;
using System.Text.Json;
using Riok.Mapperly.Abstractions;
using Runova.Website.Core.Accounts;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Accounts;

/// <summary>A session with whether it is the one asking, worked out in SQL.</summary>
internal sealed record SessionRow
{
    public required AccountSession Session { get; init; }

    public required bool Current { get; init; }
}

[Mapper]
internal static partial class AccountMapper
{
    /// <summary>The password, the logins and the roles live in Identity's other tables, so the caller passes what they say.</summary>
    [MapProperty(nameof(AppUser.Email), nameof(AccountDto.Email), Use = nameof(OrEmpty))]
    public static partial AccountDto ToDto(AppUser user, bool hasPassword, IReadOnlyList<string> logins, bool staff);

    public static partial IQueryable<SessionDto> ProjectToDto(this IQueryable<SessionRow> rows);

    [MapProperty(nameof(AccountActivity.Details), nameof(ActivityDto.Details), Use = nameof(DetailsFromJson))]
    public static partial ActivityDto ToDto(AccountActivity activity);

    [MapNestedProperties(nameof(SessionRow.Session))]
    [MapProperty([nameof(SessionRow.Session), nameof(AccountSession.LastIp)], nameof(SessionDto.Ip))]
    private static partial SessionDto ToDto(SessionRow row);

    private static string VersionToString(uint version) => version.ToString(CultureInfo.InvariantCulture);

    [UserMapping(Default = false)]
    private static string OrEmpty(string? value) => value ?? "";

    // Mapperly wants the DTO's own type here, so the dictionary is passed on as it is, not copied.
#pragma warning disable CA1859
    [UserMapping(Default = false)]
    private static IReadOnlyDictionary<string, object?>? DetailsFromJson(string? details) =>
        details is null ? null : JsonSerializer.Deserialize<Dictionary<string, object?>>(details);
#pragma warning restore CA1859
}
