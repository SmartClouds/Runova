using Riok.Mapperly.Abstractions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Releases;

[Mapper(RequiredMappingStrategy = RequiredMappingStrategy.Target)]
internal static partial class ReleaseTokenMapper
{
    /// <summary>What the app sees of a stored release token: never the token.</summary>
    [MapProperty(nameof(ReleaseTokenRecord.CreatedAt), nameof(ReleaseTokenInfo.CreatedAtUnixMs))]
    [MapProperty(nameof(ReleaseTokenRecord.UpdatedAt), nameof(ReleaseTokenInfo.UpdatedAtUnixMs))]
    [MapProperty(nameof(ReleaseTokenRecord.LastUsedAt), nameof(ReleaseTokenInfo.LastUsedAtUnixMs))]
    public static partial ReleaseTokenInfo ToInfo(ReleaseTokenRecord row);
}
