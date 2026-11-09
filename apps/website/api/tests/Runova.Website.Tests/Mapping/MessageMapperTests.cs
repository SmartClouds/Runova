using Runova.Website.Api.Email;
using Runova.Website.Api.Notifications;
using Runova.Website.Api.Reports;
using Runova.Website.Data.Dependencies;
using Runova.Website.Data.Email;
using Runova.Website.Data.Identity;

namespace Runova.Website.Tests.Mapping;

/// <summary>The notification, email and report mappers, one small mapping each.</summary>
public class MessageMapperTests
{
    private static readonly DateTimeOffset _at = new(2026, 10, 1, 8, 0, 0, TimeSpan.Zero);

    [Fact]
    public void A_notification_maps_to_its_dto()
    {
        var notification = new UserNotification
        {
            Id = 3,
            UserId = 4,
            Kind = "dependency",
            Title = "New findings",
            Body = "Two packages need a look.",
            Severity = "high",
            ScopeId = 5,
            ItemId = "proj-1",
            InventoryId = 2,
            CreatedAt = _at,
            ReadAt = null,
        };

        Assert.Equal(
            new UserNotificationDto(3, "dependency", "New findings", "Two packages need a look.", "high", 5, "proj-1", 2, _at, null, NotificationCategories.Account, null),
            NotificationMapper.ToDto(notification));
        Assert.Empty(SecretProperties.In(typeof(UserNotificationDto)));
    }

    [Fact]
    public void An_email_goes_out_with_an_empty_text_body_when_it_has_none()
    {
        var message = new EmailMessage { Id = 1, To = "sam@example.com", Kind = "welcome", Subject = "Hi", TextBody = null, HtmlBody = "<p>Hi</p>" };

        Assert.Equal(new OutgoingEmail("sam@example.com", "welcome", "Hi", "", "<p>Hi</p>"), EmailMapper.ToOutgoing(message));
    }

    [Fact]
    public void A_new_user_projects_with_whether_they_are_staff()
    {
        var user = new AppUser { Id = 3, DisplayName = "Sam", Email = "sam@example.com", PasswordHash = "hash", CreatedAt = _at };

        var dto = Assert.Single(new[] { new NewUserRow { User = user, Staff = true } }.AsQueryable().ProjectToDto());

        Assert.Equal(new NewUserDto(3, "Sam", "sam@example.com", true, _at), dto);
        Assert.Empty(SecretProperties.In(typeof(NewUserDto)));
    }
}
