using Riok.Mapperly.Abstractions;
using Runova.Website.Data.Email;

namespace Runova.Website.Api.Email;

[Mapper]
internal static partial class EmailMapper
{
    [MapProperty(nameof(EmailMessage.TextBody), nameof(OutgoingEmail.TextBody), Use = nameof(OrEmpty))]
    public static partial OutgoingEmail ToOutgoing(EmailMessage message);

    [UserMapping(Default = false)]
    private static string OrEmpty(string? value) => value ?? "";
}
