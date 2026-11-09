using Riok.Mapperly.Abstractions;
using Runova.Website.Data.Dependencies;
using Runova.Website.Data.Notifications;

namespace Runova.Website.Api.Notifications;

[Mapper]
internal static partial class NotificationMapper
{
    [MapProperty(nameof(UserNotification.Kind), nameof(UserNotificationDto.Category), Use = nameof(CategoryOf))]
    [MapProperty(nameof(UserNotification.Sealed), nameof(UserNotificationDto.Sealed), Use = nameof(ReadSealed))]
    public static partial UserNotificationDto ToDto(UserNotification notification);

    public static partial SealedCopyDto ToDto(SealedCopyWrite copy);

    [MapProperty(nameof(NotificationCategory.Id), nameof(NotificationPreferenceDto.Category))]
    public static partial NotificationPreferenceDto ToDto(NotificationCategory category, bool enabled);

    public static partial PushDeviceDto ToDto(PushDevice device);

    [UserMapping(Default = false)]
    private static string CategoryOf(string kind) => NotificationCategories.OfKind(kind);

    [UserMapping(Default = false)]
    private static IReadOnlyList<SealedCopyDto>? ReadSealed(string? stored) => SealedCopies.Read(stored);
}
