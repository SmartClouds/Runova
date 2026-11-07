using Runova.Website.Api.Accounts;
using Runova.Website.Core.Accounts;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Identity;

namespace Runova.Website.Tests.Mapping;

public class AccountMapperTests
{
    private static readonly DateTimeOffset _at = new(2026, 10, 1, 8, 0, 0, TimeSpan.Zero);

    [Fact]
    public void An_account_takes_what_identity_says_from_the_caller()
    {
        var user = new AppUser
        {
            Id = 3,
            Email = "sam@example.com",
            DisplayName = "Sam",
            EmailConfirmed = true,
            TwoFactorEnabled = true,
            PasswordHash = "hash",
            SecurityStamp = "stamp",
            CreatedAt = _at,
            LastSignInAt = _at.AddDays(1),
            Version = 41,
        };

        var dto = AccountMapper.ToDto(user, hasPassword: true, ["github", "google"], staff: false);

        Assert.Equal(new AccountDto(3, "sam@example.com", "Sam", true, true, true, dto.Logins, false, _at, _at.AddDays(1), "41"), dto);
        Assert.Equal(["github", "google"], dto.Logins);
    }

    [Fact]
    public void An_account_with_no_email_shows_an_empty_one()
    {
        Assert.Equal("", AccountMapper.ToDto(new AppUser { Email = null }, false, [], false).Email);
    }

    [Fact]
    public void A_session_projects_with_its_last_address_and_whether_it_is_this_one()
    {
        var session = new AccountSession
        {
            Id = 9,
            UserId = 3,
            Kind = "desktop",
            DeviceName = "Work laptop",
            Platform = "windows",
            AppVersion = "3.3.0",
            CreatedIp = "203.0.113.1",
            LastIp = "203.0.113.2",
            CreatedAt = _at,
            LastSeenAt = _at.AddHours(2),
            RefreshTokenHash = [1, 2, 3],
        };

        var dto = Assert.Single(new[] { new SessionRow { Session = session, Current = true } }.AsQueryable().ProjectToDto());

        Assert.Equal(new SessionDto(9, "desktop", "Work laptop", "windows", "3.3.0", "203.0.113.2", _at, _at.AddHours(2), true), dto);
    }

    [Fact]
    public void An_activity_reads_its_details_from_json()
    {
        var activity = new AccountActivity
        {
            Id = 4,
            UserId = 3,
            TeamId = 8,
            Action = "sign-in",
            Ip = "203.0.113.2",
            Device = "Firefox",
            At = _at,
            Details = """{"count":2}""",
        };

        var dto = AccountMapper.ToDto(activity);

        Assert.Equal((4L, "sign-in", (long?)8, "203.0.113.2", "Firefox", _at), (dto.Id, dto.Action, dto.TeamId, dto.Ip, dto.Device, dto.At));
        Assert.Equal("2", dto.Details!["count"]!.ToString());
        Assert.Null(AccountMapper.ToDto(new AccountActivity()).Details);
    }

    [Fact]
    public void The_dtos_carry_no_secret()
    {
        // A flag saying a password is set, never the hash.
        Assert.Equal(["HasPassword"], SecretProperties.In(typeof(AccountDto)));
        Assert.Empty(SecretProperties.In(typeof(SessionDto)));
        Assert.Empty(SecretProperties.In(typeof(ActivityDto)));
    }
}
