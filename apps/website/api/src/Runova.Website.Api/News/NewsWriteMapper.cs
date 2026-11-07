using Riok.Mapperly.Abstractions;
using Runova.Website.Core.News;

namespace Runova.Website.Api.News;

/// <summary>An item as it would be written, for the audit entry's before and after.</summary>
[Mapper]
internal static partial class NewsWriteMapper
{
    public static partial NewsItemWriteDto ToWriteDto(NewsItem item);

    private static partial AffectedTechnologyWriteDto ToWriteDto(AffectedTechnology technology);

    private static partial SourceLinkWriteDto ToWriteDto(SourceLink link);
}
