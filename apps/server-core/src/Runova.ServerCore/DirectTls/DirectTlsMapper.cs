using Riok.Mapperly.Abstractions;

namespace Runova.ServerCore.DirectTls;

/// <summary>The direct TLS settings and the file they are kept in.</summary>
[Mapper]
internal static partial class DirectTlsMapper
{
    public static partial DirectTlsSettings.Stored ToStored(DirectTlsSettings settings);

    /// <summary>A stored file whose sources the caller has checked and normalized.</summary>
    [MapperIgnoreSource(nameof(DirectTlsSettings.Stored.Sources))]
    public static partial DirectTlsSettings ToSettings(DirectTlsSettings.Stored stored, string[] sources);
}
