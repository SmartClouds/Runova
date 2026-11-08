using Runova.Website.Api.Notifications;
using Runova.Website.Data.Dependencies;
using Runova.Website.Data.Notifications;

namespace Runova.Website.Tests.Mapping;

public class NotificationMapperTests
{
    private static readonly DateTimeOffset _at = new(2026, 11, 1, 8, 0, 0, TimeSpan.Zero);

    [Theory]
    [InlineData("dependency-updates", NotificationCategories.Dependencies)]
    [InlineData("monitor-down", NotificationCategories.Monitors)]
    [InlineData("monitor-recovered", NotificationCategories.Monitors)]
    [InlineData("monitor-plan", NotificationCategories.Monitors)]
    [InlineData("plan", NotificationCategories.Account)]
    [InlineData("agent-needs-input", NotificationCategories.AgentNeedsInput)]
    public void A_notification_carries_its_category(string kind, string category)
    {
        var dto = NotificationMapper.ToDto(new UserNotification { Id = 7, UserId = 1, Kind = kind, Title = "t", Body = "", CreatedAt = _at });

        Assert.Equal(category, dto.Category);
        Assert.Equal(kind, dto.Kind);
    }

    [Fact]
    public void A_preference_is_its_category_and_whether_it_is_on()
    {
        var dto = NotificationMapper.ToDto(NotificationCategories.All[0], enabled: false);

        Assert.Equal(new NotificationPreferenceDto(NotificationCategories.AgentNeedsInput, "Agent needs input", false), dto);
        Assert.Empty(SecretProperties.In(typeof(NotificationPreferenceDto)));
    }

    [Fact]
    public void A_push_device_never_shows_its_token()
    {
        var device = new PushDevice { Id = 3, UserId = 9, SessionId = 4, Platform = "android", PushToken = "secret-token", UpdatedAt = _at };

        var dto = NotificationMapper.ToDto(device);

        Assert.Equal(new PushDeviceDto(3, "android", _at), dto);
        Assert.Empty(SecretProperties.In(typeof(PushDeviceDto)));
    }
}
