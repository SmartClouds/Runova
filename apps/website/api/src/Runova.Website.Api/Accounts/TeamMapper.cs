using Riok.Mapperly.Abstractions;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Accounts;

/// <summary>A membership joined with its account.</summary>
internal sealed record TeamMemberRow
{
    public required TeamMember Member { get; init; }

    public required AppUser User { get; init; }
}

/// <summary>An invitation joined with its team and the account that sent it.</summary>
internal sealed record MyInvitationRow
{
    public required TeamInvitation Invitation { get; init; }

    public required Team Team { get; init; }

    public required AppUser Inviter { get; init; }
}

[Mapper]
internal static partial class TeamMapper
{
    /// <summary>The caller's role, the member count and the team's sync scope come from other tables.</summary>
    public static partial TeamDto ToDto(Team team, string role, int memberCount, long scopeId);

    public static partial IQueryable<TeamMemberDto> ProjectToDto(this IQueryable<TeamMemberRow> rows);

    [MapProperty([nameof(TeamMemberRow.User), nameof(AppUser.Id)], nameof(TeamMemberDto.UserId))]
    [MapProperty([nameof(TeamMemberRow.User), nameof(AppUser.Email)], nameof(TeamMemberDto.Email), Use = nameof(OrEmpty))]
    [MapProperty([nameof(TeamMemberRow.User), nameof(AppUser.DisplayName)], nameof(TeamMemberDto.DisplayName))]
    [MapProperty([nameof(TeamMemberRow.Member), nameof(TeamMember.Role)], nameof(TeamMemberDto.Role))]
    [MapProperty([nameof(TeamMemberRow.Member), nameof(TeamMember.JoinedAt)], nameof(TeamMemberDto.JoinedAt))]
    public static partial TeamMemberDto ToDto(TeamMemberRow row);

    public static partial IQueryable<TeamInvitationDto> ProjectToDto(this IQueryable<TeamInvitation> invitations);

    public static partial TeamInvitationDto ToDto(TeamInvitation invitation);

    public static partial IQueryable<MyInvitationDto> ProjectToDto(this IQueryable<MyInvitationRow> rows);

    [MapProperty([nameof(MyInvitationRow.Invitation), nameof(TeamInvitation.Id)], nameof(MyInvitationDto.Id))]
    [MapProperty([nameof(MyInvitationRow.Team), nameof(Team.Id)], nameof(MyInvitationDto.TeamId))]
    [MapProperty([nameof(MyInvitationRow.Team), nameof(Team.Name)], nameof(MyInvitationDto.TeamName))]
    [MapProperty([nameof(MyInvitationRow.Invitation), nameof(TeamInvitation.Role)], nameof(MyInvitationDto.Role))]
    [MapProperty([nameof(MyInvitationRow.Inviter), nameof(AppUser.DisplayName)], nameof(MyInvitationDto.InvitedBy))]
    [MapProperty([nameof(MyInvitationRow.Invitation), nameof(TeamInvitation.ExpiresAt)], nameof(MyInvitationDto.ExpiresAt))]
    private static partial MyInvitationDto ToDto(MyInvitationRow row);

    [UserMapping(Default = false)]
    private static string OrEmpty(string? value) => value ?? "";
}
