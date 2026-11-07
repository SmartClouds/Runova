using Runova.Website.Api.Accounts;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Identity;

namespace Runova.Website.Tests.Mapping;

public class TeamMapperTests
{
    private static readonly DateTimeOffset _at = new(2026, 10, 1, 8, 0, 0, TimeSpan.Zero);

    private static readonly AppUser _sam = new() { Id = 3, Email = "sam@example.com", DisplayName = "Sam", PasswordHash = "hash" };

    [Fact]
    public void A_team_takes_the_role_count_and_scope_from_the_caller()
    {
        var team = new Team { Id = 2, Name = "Ops", CreatedAt = _at, CreatedBy = 3, Version = 9 };

        Assert.Equal(new TeamDto(2, "Ops", "owner", 4, 5, _at), TeamMapper.ToDto(team, "owner", 4, 5));
    }

    [Fact]
    public void A_member_takes_the_account_from_the_user_and_the_role_from_the_membership()
    {
        var member = new TeamMember { TeamId = 2, UserId = 3, Role = TeamRoles.Admin, JoinedAt = _at };
        var row = new TeamMemberRow { Member = member, User = _sam };
        var noEmail = new TeamMemberRow { Member = member, User = new AppUser { Id = 4, Email = null, DisplayName = "Kim" } };

        Assert.Equal(new TeamMemberDto(3, "sam@example.com", "Sam", "admin", _at), TeamMapper.ToDto(row));
        Assert.Equal(new TeamMemberDto(4, "", "Kim", "admin", _at), TeamMapper.ToDto(noEmail));
        Assert.Equal(
            [new TeamMemberDto(3, "sam@example.com", "Sam", "admin", _at), new TeamMemberDto(4, "", "Kim", "admin", _at)],
            new[] { row, noEmail }.AsQueryable().ProjectToDto().ToList());
    }

    [Fact]
    public void An_invitation_maps_alone_in_a_query_and_with_its_team_and_sender()
    {
        var invitation = new TeamInvitation
        {
            Id = 6,
            TeamId = 2,
            Email = "kim@example.com",
            NormalizedEmail = "KIM@EXAMPLE.COM",
            Role = TeamRoles.Member,
            InvitedBy = 3,
            CreatedAt = _at,
            ExpiresAt = _at.AddDays(7),
        };
        var expected = new TeamInvitationDto(6, "kim@example.com", "member", _at, _at.AddDays(7));
        var mine = new MyInvitationRow { Invitation = invitation, Team = new Team { Id = 2, Name = "Ops" }, Inviter = _sam };

        Assert.Equal(expected, TeamMapper.ToDto(invitation));
        Assert.Equal(expected, Assert.Single(new[] { invitation }.AsQueryable().ProjectToDto()));
        Assert.Equal(new MyInvitationDto(6, 2, "Ops", "member", "Sam", _at.AddDays(7)), Assert.Single(new[] { mine }.AsQueryable().ProjectToDto()));
    }

    [Fact]
    public void The_dtos_carry_no_secret()
    {
        Assert.Empty(SecretProperties.In(typeof(TeamDto)));
        Assert.Empty(SecretProperties.In(typeof(TeamMemberDto)));
        Assert.Empty(SecretProperties.In(typeof(TeamInvitationDto)));
        Assert.Empty(SecretProperties.In(typeof(MyInvitationDto)));
    }
}
