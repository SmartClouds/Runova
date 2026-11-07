using Riok.Mapperly.Abstractions;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Assistant;

[Mapper]
internal static partial class AssistantMapper
{
    /// <summary>What the app signs to approve a command; the session and device it is bound to stay here.</summary>
    [MapProperty(nameof(IssuedExecNonce.Id), nameof(ExecApprovalNonce.NonceId))]
    [MapProperty(nameof(IssuedExecNonce.ExpiresAt), nameof(ExecApprovalNonce.ExpiresAtUnixMs))]
    public static partial ExecApprovalNonce ToNonce(IssuedExecNonce issued);

    /// <summary>A checked request; no line count means the default.</summary>
    [MapProperty(nameof(JournalRequest.Lines), nameof(JournalQuery.Lines), Use = nameof(LinesOrDefault))]
    public static partial JournalQuery ToQuery(JournalRequest request);

    private static int LinesOrDefault(int? lines) => lines ?? JournalUnits.DefaultLines;
}
