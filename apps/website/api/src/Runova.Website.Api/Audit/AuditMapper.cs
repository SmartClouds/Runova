using Riok.Mapperly.Abstractions;
using Runova.Website.Data.Audit;

namespace Runova.Website.Api.Audit;

/// <summary>What changed stays in the database, see <see cref="AuditEntryDto"/>.</summary>
[Mapper]
internal static partial class AuditMapper
{
    public static partial IQueryable<AuditEntryDto> ProjectToDto(this IQueryable<AuditEntry> entries);
}
