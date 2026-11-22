using System.Text.Json;
using System.Text.RegularExpressions;
using Runova.Website.Api.Accounts;
using Runova.Website.Api.Notifications;
using Runova.Website.Api.Remote;
using Runova.Website.Tests.Mapping;

namespace Runova.Website.Tests.Accounts;

public sealed partial class DemoDataTests
{
    private static readonly DateTimeOffset _now = new(2026, 11, 22, 9, 0, 0, TimeSpan.Zero);

    [GeneratedRegex(@"^0\d{8}$")]
    private static partial Regex DemoRemoteId();

    [Fact]
    public void Reachable_devices_are_the_three_the_phone_s_own_fake_computer_knows()
    {
        var directory = DemoData.ReachableDevices(_now);

        Assert.Equal(
            [
                (-11L, "000000001", "Demo workstation", "windows", "app", true, false, "receive-files"),
                (-12L, "000000002", "Demo laptop", "macos", "app", false, false, ""),
            ],
            directory.Mine.Select(Shape));
        Assert.Equal(
            [(-13L, "000000003", "Northwind build box", "linux", "agent", true, false, "")],
            directory.Teammates.Select(Shape));
        Assert.Empty(directory.Phones);
        Assert.All(directory.Mine, d => Assert.Equal(-1, d.Owner.UserId));
        Assert.Equal("Northwind", Assert.Single(Assert.Single(directory.Teammates).Teams).Name);
    }

    [Fact]
    public void A_demo_remote_id_never_looks_like_a_real_one()
    {
        var directory = DemoData.ReachableDevices(_now);
        var phone = DemoData.Phone(_now, "Pixel", "android", "key");

        Assert.All(
            [.. directory.Mine, .. directory.Teammates, .. directory.Phones],
            d => Assert.Matches(DemoRemoteId(), d.RemoteId));
        Assert.Matches(DemoRemoteId(), phone.RemoteId);
        Assert.Equal(-1, phone.Id);
        Assert.Equal("phone", phone.Kind);
    }

    [Fact]
    public void No_text_in_the_demo_has_an_em_dash()
    {
        var json = JsonSerializer.Serialize(DemoData.Everything(_now), JsonSerializerOptions.Web);

        Assert.DoesNotContain('\u2014', json);
    }

    [Fact]
    public void The_demo_carries_no_secret()
    {
        // Flags that say whether a secret is set are allowed; the secrets themselves are not.
        string[] flags = ["HasPassword", "HasSecret", "SecretChangedAt"];

        foreach (var answer in DemoData.Everything(_now))
        {
            Assert.All(SecretProperties.In(answer.GetType()), name => Assert.Contains(name.Split('.')[^1], flags));
        }

        Assert.All(DemoData.CloudMonitors(_now).Items, m =>
        {
            Assert.False(m.HasSecret);
            Assert.Null(m.SecretChangedAt);
        });
    }

    [Fact]
    public void Every_time_is_recent_and_never_in_the_future_except_an_expiry()
    {
        var notifications = DemoData.Notifications(_now);
        var activities = DemoData.Activities(_now);

        Assert.InRange(notifications.Count, 6, 12);
        Assert.InRange(activities.Count, 8, 15);
        Assert.All(notifications, n => Assert.InRange(n.CreatedAt, _now.AddDays(-30), _now));
        Assert.All(activities, a => Assert.InRange(a.At, _now.AddDays(-60), _now));
        Assert.Equal(activities.OrderByDescending(a => a.At).Select(a => a.Id), activities.Select(a => a.Id));
        Assert.Equal(notifications.OrderByDescending(n => n.CreatedAt).Select(n => n.Id), notifications.Select(n => n.Id));
        Assert.All(DemoData.MyInvitations(_now).Items, i => Assert.True(i.ExpiresAt > _now));
    }

    [Fact]
    public void A_notification_s_category_is_the_one_its_kind_falls_under()
    {
        var notifications = DemoData.Notifications(_now);

        Assert.All(notifications, n => Assert.Equal(NotificationCategories.OfKind(n.Kind), n.Category));
        Assert.Contains(notifications, n => n.Category == "deploys");
        Assert.Contains(notifications, n => n.Category == "monitors");
        Assert.Contains(notifications, n => n.Category == "pipelines");
        Assert.Contains(notifications, n => n.Category == "account");
        Assert.Contains(notifications, n => n.ReadAt is null);
        Assert.Contains(notifications, n => n.ReadAt is not null);
    }

    [Fact]
    public void The_team_has_its_owner_three_others_and_one_pending_invitation()
    {
        var team = Assert.Single(DemoData.Teams(_now).Items);
        var members = DemoData.Members(_now).Items;

        Assert.Equal("Northwind", team.Name);
        Assert.Equal("owner", team.Role);
        Assert.Equal(members.Count, team.MemberCount);
        Assert.Equal(4, members.Count);
        Assert.Contains(members, m => m.UserId == -1 && m.Role == "owner");
        Assert.Single(DemoData.TeamInvitations(_now).Items);
        Assert.Equal(3, DemoData.Sessions(_now).Items.Count);
        Assert.Single(DemoData.Sessions(_now).Items, s => s.Current);
    }

    [Fact]
    public void The_monitors_are_a_mix_of_states()
    {
        var verdicts = DemoData.CloudMonitors(_now).Items.Select(m => m.Status.Verdict).ToList();

        Assert.InRange(verdicts.Count, 4, 6);
        Assert.Contains("up", verdicts);
        Assert.Contains("down", verdicts);
        Assert.Contains("paused", verdicts);
    }

    private static (long, string, string, string, string, bool, bool, string) Shape(RemoteDirectoryEntryDto d) =>
        (d.Id, d.RemoteId, d.Name, d.Platform, d.Kind, d.Online, d.UnattendedEnabled, string.Join(",", d.Features));
}
