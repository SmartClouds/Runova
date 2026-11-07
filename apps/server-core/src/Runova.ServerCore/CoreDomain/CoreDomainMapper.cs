using Riok.Mapperly.Abstractions;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.CoreDomain;

/// <summary>The core domain settings and the file they are kept in.</summary>
[Mapper]
internal static partial class CoreDomainMapper
{
    public static partial CoreDomainSettings.Stored ToStored(CoreDomainSettings settings);

    /// <summary>
    /// A stored file the caller has checked. Whether it is on and its sources come from that check;
    /// a file from before modes existed reads as Direct.
    /// </summary>
    [MapperIgnoreSource(nameof(CoreDomainSettings.Stored.Enabled))]
    [MapperIgnoreSource(nameof(CoreDomainSettings.Stored.Sources))]
    [MapProperty(nameof(CoreDomainSettings.Stored.Mode), nameof(CoreDomainSettings.Mode), Use = nameof(ModeOrDirect))]
    public static partial CoreDomainSettings ToSettings(CoreDomainSettings.Stored stored, bool enabled, string[] sources);

    private static CoreDomainMode ModeOrDirect(CoreDomainMode? mode) => mode ?? CoreDomainMode.Direct;
}
