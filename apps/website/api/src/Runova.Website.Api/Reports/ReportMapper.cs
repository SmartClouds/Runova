using Riok.Mapperly.Abstractions;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Reports;

/// <summary>A user with whether they hold any staff role, worked out in SQL.</summary>
internal sealed record NewUserRow
{
    public required AppUser User { get; init; }

    public required bool Staff { get; init; }
}

[Mapper]
internal static partial class ReportMapper
{
    public static partial IQueryable<NewUserDto> ProjectToDto(this IQueryable<NewUserRow> rows);

    [MapNestedProperties(nameof(NewUserRow.User))]
    [MapProperty([nameof(NewUserRow.User), nameof(AppUser.Email)], nameof(NewUserDto.Email), Use = nameof(GivenEmail))]
    private static partial NewUserDto ToDto(NewUserRow row);

    // Every account signs up with an email. Inlined into the SQL as the column itself.
    [UserMapping(Default = false)]
    private static string GivenEmail(string? email) => email!;
}
