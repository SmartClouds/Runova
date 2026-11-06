using System.Net;

namespace Runova.Monitoring.Core.Net;

/// <summary>
/// Thrown when a connection would go to an address that is not public, such as loopback, a
/// private network or the cloud metadata service. The message is a plain sentence that is safe to
/// show the monitor's owner.
/// </summary>
public sealed class BlockedAddressException : Exception
{
    public BlockedAddressException()
        : this("The address is not a public address. Runova only checks public addresses.")
    {
    }

    public BlockedAddressException(string message)
        : base(message)
    {
        Host = "";
        Reason = "";
    }

    public BlockedAddressException(string message, Exception innerException)
        : base(message, innerException)
    {
        Host = "";
        Reason = "";
    }

    /// <param name="host">The host the URL named, a name or an IP literal.</param>
    /// <param name="address">The address it came to, which was refused.</param>
    /// <param name="reason">What the address is, from <see cref="PublicAddressGuard.WhyBlocked"/>.</param>
    public BlockedAddressException(string host, IPAddress address, string reason)
        : base(Describe(host, address, reason))
    {
        Host = host;
        Address = address;
        Reason = reason;
    }

    public string Host { get; }
    public IPAddress? Address { get; }
    public string Reason { get; }

    private static string Describe(string host, IPAddress address, string reason)
    {
        ArgumentNullException.ThrowIfNull(host);
        ArgumentNullException.ThrowIfNull(address);
        var literal = IPAddress.TryParse(host.Trim('[', ']'), out var parsed) && parsed.Equals(address);
        var subject = literal ? $"{address} is" : $"{host} resolves to {address}, which is";
        return $"{subject} not a public address (it is {reason}). Runova only checks public addresses.";
    }
}
