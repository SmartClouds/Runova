using System.Globalization;
using Riok.Mapperly.Abstractions;

namespace Runova.ServerCore.Backups.Destinations;

[Mapper]
internal static partial class DestinationMapper
{
    /// <summary>A file kept in a Telegram chat, named by the message that holds it.</summary>
    [MapProperty(nameof(TelegramDocument.MessageId), nameof(CloudFile.Id), Use = nameof(IdOf))]
    [MapProperty(nameof(TelegramDocument.FileName), nameof(CloudFile.Name))]
    public static partial CloudFile ToCloudFile(TelegramDocument document);

    private static string IdOf(int messageId) => messageId.ToString(CultureInfo.InvariantCulture);
}
