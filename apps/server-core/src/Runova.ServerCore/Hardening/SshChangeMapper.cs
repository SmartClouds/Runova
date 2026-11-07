using Riok.Mapperly.Abstractions;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Hardening;

[Mapper]
internal static partial class SshChangeMapper
{
    /// <summary>
    /// A change as the app sees it. Its state comes from the decision, and when and how it ended
    /// from the rollback result, if there is one. The old drop-in stays on the server.
    /// </summary>
    public static partial SshHardeningChangeInfo ToInfo(SshChangeSnapshot snapshot, SshHardeningState state, long? finishedAtUnixMs, string? error);
}
