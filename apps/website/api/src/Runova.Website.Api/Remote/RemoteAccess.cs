using Runova.Website.Data.Remote;

namespace Runova.Website.Api.Remote;

/// <summary>How the account asking stands to the computer's owner.</summary>
public enum RemoteRelation
{
    Own,
    Teammate,
    Other,
}

/// <summary>
/// Which requests the server passes on to a computer (E60). It only turns away what the
/// computer would refuse anyway, so a stranger can not ring someone's screen; the computer still
/// decides on everything it is sent.
/// </summary>
internal static class RemoteAccess
{
    public static RemoteRelation RelationOf(long callerUserId, long ownerUserId, bool sharesVisibleTeam) =>
        callerUserId == ownerUserId ? RemoteRelation.Own
        : sharesVisibleTeam ? RemoteRelation.Teammate
        : RemoteRelation.Other;

    /// <summary>
    /// Asking is for the owner's own computers and for teammates in a team the computer is shown
    /// to. The password is for anyone, but only on a computer that has one.
    /// </summary>
    public static bool MayRequest(RemoteRelation relation, string mode, bool unattendedEnabled) => mode switch
    {
        RemoteAccessModes.Ask => relation is RemoteRelation.Own or RemoteRelation.Teammate,
        RemoteAccessModes.Password => unattendedEnabled,
        _ => false,
    };

    /// <summary>Whether the caller may learn that the computer exists and is online.</summary>
    public static bool MayLearnOnline(RemoteRelation relation, bool unattendedEnabled) =>
        relation is RemoteRelation.Own or RemoteRelation.Teammate || unattendedEnabled;

    public static string WireName(RemoteRelation relation) => relation switch
    {
        RemoteRelation.Own => "own",
        RemoteRelation.Teammate => "teammate",
        _ => "other",
    };
}
