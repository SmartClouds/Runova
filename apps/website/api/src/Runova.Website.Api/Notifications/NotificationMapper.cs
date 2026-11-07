using Riok.Mapperly.Abstractions;
using Runova.Website.Data.Dependencies;

namespace Runova.Website.Api.Notifications;

[Mapper]
internal static partial class NotificationMapper
{
    public static partial UserNotificationDto ToDto(UserNotification notification);
}
