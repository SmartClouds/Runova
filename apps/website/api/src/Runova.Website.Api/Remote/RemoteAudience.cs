using System.Globalization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Remote;

namespace Runova.Website.Api.Remote;

/// <summary>
/// Who may see a computer (E60): its owner, and the members of each team it is shown to while the
/// owner is still in that team. Leaving a team hides the owner's computers from it at once,
/// since nothing is copied when a computer is shown.
/// </summary>
internal sealed class RemoteAudience(AppDbContext db, IHubContext<RemoteHub, IRemoteClient> hub)
{
    /// <summary>The teams the computer is shown to that the caller and the owner are both in.</summary>
    public async Task<IReadOnlyList<Team>> SharedTeamsAsync(RemoteDevice device, long callerUserId) =>
        await (from link in db.RemoteDeviceTeams
               join team in db.Teams on link.TeamId equals team.Id
               where link.RemoteDeviceId == device.Id
                   && db.TeamMembers.Any(m => m.TeamId == link.TeamId && m.UserId == callerUserId)
                   && db.TeamMembers.Any(m => m.TeamId == link.TeamId && m.UserId == device.UserId)
               orderby team.Name
               select team).AsNoTracking().ToListAsync();

    /// <summary>Tells everyone who may see the computer that it came online or went offline.</summary>
    public async Task PresenceAsync(RemoteDevice device, bool online)
    {
        var members = await (from link in db.RemoteDeviceTeams
                             join member in db.TeamMembers on link.TeamId equals member.TeamId
                             where link.RemoteDeviceId == device.Id
                                 && db.TeamMembers.Any(m => m.TeamId == link.TeamId && m.UserId == device.UserId)
                             select member.UserId).Distinct().ToListAsync();
        var users = members.Append(device.UserId).Distinct().Select(id => id.ToString(CultureInfo.InvariantCulture)).ToList();
        await hub.Clients.Users(users).PresenceChanged(new PresenceChangedDto(device.Id, device.RemoteId, online));
    }
}
